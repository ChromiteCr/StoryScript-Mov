import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { backup, DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/**
 * DbPort — the only way server code touches SQLite. Implemented on node:sqlite
 * (DatabaseSync); better-sqlite3 is the documented fallback behind the same port.
 * Rows come back as plain objects; repos parse them with zod.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;
export type NamedParams = Record<string, SqlValue>;
/** Positional values, or one named-params object ({ $id: … } / { ':id': … }). */
export type SqlParams = SqlValue[] | [NamedParams];
export type Row = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DbPort {
  /** file path (":memory:" for in-memory databases) */
  readonly path: string;
  run(sql: string, ...params: SqlParams): RunResult;
  get<T = Row>(sql: string, ...params: SqlParams): T | undefined;
  all<T = Row>(sql: string, ...params: SqlParams): T[];
  /** multi-statement SQL, no params, no results */
  exec(sql: string): void;
  /** synchronous transaction; nested calls become savepoints */
  tx<T>(fn: () => T): T;
  /** online backup (safe while WAL is active) */
  backup(destPath: string): Promise<void>;
  close(): void;
}

export interface OpenDbOptions {
  busyTimeoutMs?: number;
  readOnly?: boolean;
}

const STATEMENT_CACHE_MAX = 256;

class SqliteDb implements DbPort {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string, opts: OpenDbOptions) {
    this.path = path;
    if (path !== ':memory:' && !opts.readOnly) mkdirSync(dirname(path), { recursive: true });
    const busy = opts.busyTimeoutMs ?? 5000;
    this.db = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      readOnly: opts.readOnly ?? false,
      timeout: busy,
    });
    if (!opts.readOnly) this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${Math.trunc(busy)}; PRAGMA synchronous = NORMAL;`);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      if (this.cache.size >= STATEMENT_CACHE_MAX) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SqlParams): RunResult {
    const r = this.stmt(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get<T = Row>(sql: string, ...params: SqlParams): T | undefined {
    return this.stmt(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlParams): T[] {
    return this.stmt(sql).all(...(params as SQLInputValue[])) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  tx<T>(fn: () => T): T {
    const depth = this.depth;
    const sp = `sp_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new TypeError('DbPort.tx callback must be synchronous');
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      if (depth === 0) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
      } else {
        this.db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      }
      throw err;
    } finally {
      this.depth = depth;
    }
  }

  async backup(destPath: string): Promise<void> {
    mkdirSync(dirname(destPath), { recursive: true });
    await backup(this.db, destPath);
  }

  close(): void {
    this.cache.clear();
    if (this.db.isOpen) this.db.close();
  }
}

/** Open (and create) a database with WAL, foreign keys and busy_timeout. */
export function openDb(path: string, opts: OpenDbOptions = {}): DbPort {
  return new SqliteDb(path, opts);
}

let cachedVersion: string | null = null;

/** Linked SQLite library version (e.g. "3.53.4"). */
export function sqliteVersion(): string {
  if (cachedVersion) return cachedVersion;
  const db = new DatabaseSync(':memory:');
  try {
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    cachedVersion = row.v;
    return cachedVersion;
  } finally {
    db.close();
  }
}

/** Whether FTS5 is compiled in (v0.1 search uses LIKE only; reported by doctor). */
export function fts5Available(): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
