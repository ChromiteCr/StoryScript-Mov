import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PROJECT_SCHEMA_VERSION } from '@storyscript/contracts';
import { isAppError } from '../src/http/errors.ts';
import { backupDatabase, LATEST_VERSION, migrate, MIGRATIONS, userVersion, type Migration } from '../src/db/migrations/index.ts';
import { openDb, sqliteVersion, type DbPort } from '../src/db/port.ts';
import { budget } from '../../../packages/core/test/perf-budget.ts';

const EXPECTED_TABLES = [
  'project',
  'script_version',
  'scene',
  'entity',
  'shot',
  'shot_revision',
  'shot_draft',
  'technique',
  'board',
  'board_raster',
  'resource',
  'setup',
  'schedule_constraint',
  'plan',
  'take',
  'take_shot',
  'source_root',
  'media_asset',
  'shot_media_link',
  'coverage_decision',
  'job',
  'kv',
];

let root: string;
const opened: DbPort[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ssm-db-'));
  process.env.STORYSCRIPT_HOME = join(root, 'home');
});

afterAll(() => {
  for (const db of opened) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fresh(name: string): DbPort {
  const db = openDb(join(root, `${name}.sqlite`));
  opened.push(db);
  return db;
}

const tables = (db: DbPort) =>
  db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);

describe('DbPort on node:sqlite', () => {
  test('WAL, foreign keys and busy_timeout are on', () => {
    const db = fresh('pragmas');
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000);
    expect(sqliteVersion()).toMatch(/^3\.\d+\.\d+$/);
  });

  test('tx commits, rolls back, nests as savepoints and refuses async callbacks', async () => {
    const db = fresh('tx');
    db.exec('CREATE TABLE t (v INTEGER NOT NULL) STRICT');
    db.tx(() => db.run('INSERT INTO t VALUES (?)', 1));
    expect(() =>
      db.tx(() => {
        db.run('INSERT INTO t VALUES (?)', 2);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    db.tx(() => {
      db.run('INSERT INTO t VALUES (?)', 3);
      expect(() =>
        db.tx(() => {
          db.run('INSERT INTO t VALUES (?)', 4);
          throw new Error('inner');
        }),
      ).toThrow('inner');
    });
    expect(db.all<{ v: number }>('SELECT v FROM t ORDER BY v').map((r) => r.v)).toEqual([1, 3]);
    expect(() => db.tx(() => Promise.resolve(1))).toThrow(/synchronous/);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM t')?.n).toBe(2);
    // named params
    expect(db.get<{ v: number }>('SELECT v FROM t WHERE v = $v', { $v: 3 })?.v).toBe(3);
  });
});

describe('migrations', () => {
  test('latest migration equals contracts PROJECT_SCHEMA_VERSION', () => {
    expect(LATEST_VERSION).toBe(PROJECT_SCHEMA_VERSION);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  test('fresh database → user_version = 1, every v0.1 table exists, no backup', async () => {
    const db = fresh('init');
    const r = await migrate(db, { backupDir: join(root, 'recovery-init') });
    expect(r).toMatchObject({ from: 0, to: 1, applied: ['001_init'], backup_path: null });
    expect(userVersion(db)).toBe(1);
    expect(new Set(tables(db))).toEqual(new Set(EXPECTED_TABLES));
    expect(existsSync(join(root, 'recovery-init'))).toBe(false);
    // idempotent
    expect((await migrate(db, { backupDir: join(root, 'recovery-init') })).applied).toEqual([]);
    expect(db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
  });

  test('schema constraints: STRICT types, FK, UNIQUE, append-only coverage decisions', async () => {
    const db = fresh('constraints');
    await migrate(db, { backupDir: join(root, 'rc') });
    const now = new Date().toISOString();
    expect(() => db.run("INSERT INTO kv VALUES ('k', '{}', ?)", now)).not.toThrow();
    // FK: scene needs an existing script_version
    expect(() =>
      db.run("INSERT INTO scene (id, script_version_id, sort, display_no, heading, origin) VALUES (?, ?, 0, '1', 'h', 'manual')", randomUUID(), randomUUID()),
    ).toThrow(/FOREIGN KEY/);
    // STRICT: non-integer into INTEGER column
    expect(() => db.run('INSERT INTO take (id, take_no, logged_at) VALUES (?, ?, ?)', randomUUID(), 1.5, now)).toThrow();
    // UNIQUE alias
    db.run("INSERT INTO entity (id, type, alias, name, origin) VALUES (?, 'character', 'c1', '甲', 'manual')", randomUUID());
    expect(() => db.run("INSERT INTO entity (id, type, alias, name, origin) VALUES (?, 'character', 'c1', '乙', 'manual')", randomUUID())).toThrow(/UNIQUE/);
    // append-only coverage_decision
    const sv = randomUUID();
    const scene = randomUUID();
    const shot = randomUUID();
    db.run("INSERT INTO script_version (id, source_name, format, content_hash, raw_text, paragraphs_json, created_at) VALUES (?, 'a', 'paste', 'h', '', '[]', ?)", sv, now);
    db.run("INSERT INTO scene (id, script_version_id, sort, display_no, heading, origin) VALUES (?, ?, 0, '1', 'h', 'manual')", scene, sv);
    db.run(
      "INSERT INTO shot (id, scene_id, code, narrative_pos, origin, fields_json, content_hash, created_at, updated_at) VALUES (?, ?, '1-1', 1, 'manual', '{}', 'h', ?, ?)",
      shot,
      scene,
      now,
      now,
    );
    const dec = randomUUID();
    db.run("INSERT INTO coverage_decision (id, shot_id, decision, reason, basis_content_hash, at) VALUES (?, ?, 'clear', '重拍', 'h', ?)", dec, shot, now);
    expect(() => db.run("UPDATE coverage_decision SET reason = 'x' WHERE id = ?", dec)).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM coverage_decision WHERE id = ?', dec)).toThrow(/append-only/);
    expect(() => db.run("INSERT INTO coverage_decision (id, shot_id, decision, reason, basis_content_hash, at) VALUES (?, ?, 'clear', '', 'h', ?)", randomUUID(), shot, now)).toThrow();
  });

  test('database newer than the program → SCHEMA_VERSION_UNSUPPORTED, untouched', async () => {
    const db = fresh('too-new');
    db.exec('PRAGMA user_version = 99');
    await expect(migrate(db, { backupDir: join(root, 'rn') })).rejects.toSatisfy((e) => isAppError(e, 'SCHEMA_VERSION_UNSUPPORTED'));
    expect(userVersion(db)).toBe(99);
  });

  test('upgrade of an existing database backs up to recovery/ first (WAL active)', async () => {
    const db = fresh('upgrade');
    const backupDir = join(root, 'project-x', 'recovery');
    const v1: Migration = { version: 1, name: '001_t', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT;' };
    const v2: Migration = { version: 2, name: '002_u', sql: 'CREATE TABLE u (id INTEGER PRIMARY KEY) STRICT; ALTER TABLE t ADD COLUMN w TEXT;' };
    await migrate(db, { backupDir, migrations: [v1] });
    db.tx(() => {
      for (let i = 0; i < 500; i++) db.run('INSERT INTO t (v) VALUES (?)', `行 ${i}`);
    });
    // uncheckpointed pages still live in the -wal file
    expect(statSync(`${db.path}-wal`).size).toBeGreaterThan(0);

    const r = await migrate(db, { backupDir, migrations: [v1, v2], now: () => new Date('2026-09-26T08:00:00.000Z') });
    expect(r).toMatchObject({ from: 1, to: 2, applied: ['002_u'] });
    expect(r.backup_path).toBe(join(backupDir, 'project-v1-2026-09-26T08-00-00-000Z.sqlite'));
    expect(readdirSync(backupDir)).toContain('project-v1-2026-09-26T08-00-00-000Z.sqlite');
    expect(userVersion(db)).toBe(2);

    const bak = openDb(r.backup_path!, { readOnly: true });
    opened.push(bak);
    expect(userVersion(bak)).toBe(1);
    expect(bak.get<{ n: number }>('SELECT count(*) AS n FROM t')?.n).toBe(500);
    expect(tables(bak)).not.toContain('u');
    expect(bak.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
  });

  test('a failing migration rolls back completely (user_version unchanged)', async () => {
    const db = fresh('rollback');
    const backupDir = join(root, 'rb');
    const v1: Migration = { version: 1, name: '001', sql: 'CREATE TABLE a (x INTEGER) STRICT;' };
    const bad: Migration = { version: 2, name: '002_bad', sql: 'CREATE TABLE b (x INTEGER) STRICT; INSERT INTO nope VALUES (1);' };
    await migrate(db, { backupDir, migrations: [v1] });
    await expect(migrate(db, { backupDir, migrations: [v1, bad] })).rejects.toThrow(/nope/);
    expect(userVersion(db)).toBe(1);
    expect(tables(db)).not.toContain('b');
  });

  test('backupDatabase produces an openable copy while WAL is active', async () => {
    const db = fresh('bak');
    await migrate(db, { backupDir: join(root, 'unused') });
    const now = new Date().toISOString();
    db.run("INSERT INTO kv VALUES ('greeting', '\"你好\"', ?)", now);
    const dest = await backupDatabase(db, join(root, 'bak-out'), 'manual');
    const copy = openDb(dest, { readOnly: true });
    opened.push(copy);
    expect(copy.get<{ value_json: string }>("SELECT value_json FROM kv WHERE key = 'greeting'")?.value_json).toBe('"你好"');
    expect(userVersion(copy)).toBe(1);
  });
});

describe('search (FR-09: LIKE only)', () => {
  test("10k Chinese search_text rows: LIKE '%客厅%' median < 20ms", async () => {
    const db = fresh('like');
    await migrate(db, { backupDir: join(root, 'unused2') });
    const now = new Date().toISOString();
    const rootId = randomUUID();
    db.run("INSERT INTO source_root (id, abs_path, label, created_at) VALUES (?, '/Volumes/CARD_A', 'A 卡', ?)", rootId, now);
    const words = ['厨房', '卧室', '走廊', '阳台', '街道', '车内', '天台', '楼梯', '办公室', '客厅'];
    db.tx(() => {
      for (let i = 0; i < 10_000; i++) {
        const w = words[i % words.length]!;
        const rel = `DCIM/A${String(Math.floor(i / 100)).padStart(3, '0')}/C${String(i).padStart(5, '0')}.MOV`;
        db.run(
          "INSERT INTO media_asset (id, source_root_id, rel_path, size, mtime_ms, kind, search_text, created_at) VALUES (?, ?, ?, ?, ?, 'video', ?, ?)",
          randomUUID(),
          rootId,
          rel,
          1_000_000 + i,
          1_758_000_000_000 + i,
          `${rel} 第${i % 40}场 ${w} 夜景 手持 备注：演员走位与${w}道具`,
          now,
        );
      }
    });
    const sql = "SELECT id, rel_path FROM media_asset WHERE search_text LIKE ? ESCAPE '\\' ORDER BY rel_path";
    expect(db.all(sql, '%客厅%')).toHaveLength(1000);
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const t0 = performance.now();
      db.all(sql, '%客厅%');
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[10]!;
    console.log(`[measure] LIKE '%客厅%' over 10k rows (1000 hits): median ${median.toFixed(2)} ms, min ${times[0]!.toFixed(2)} ms, max ${times[20]!.toFixed(2)} ms`);
    expect(median).toBeLessThan(budget(20));
  });
});
