import { join } from 'node:path';
import { AppError } from '../../http/errors.ts';
import type { DbPort } from '../port.ts';
import { INIT_SQL } from './001_init.ts';
import { ROOT_KIND_SQL } from './002_root_kind.ts';
import { STYLE_CAST_SQL } from './003_style_cast.ts';
import { ACTORS_SQL } from './004_actors.ts';
import { REVISIONS_SQL } from './005_revisions.ts';
import { COMMENTS_SQL } from './006_comments.ts';

/**
 * Hand-written SQL migrations, embedded as TS strings so the bundle carries them.
 * Version numbers are allocated by the lead only (AGENTS.md).
 * The latest version must equal contracts PROJECT_SCHEMA_VERSION.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001_init', sql: INIT_SQL },
  { version: 2, name: '002_root_kind', sql: ROOT_KIND_SQL },
  { version: 3, name: '003_style_cast', sql: STYLE_CAST_SQL },
  { version: 4, name: '004_actors', sql: ACTORS_SQL },
  { version: 5, name: '005_revisions', sql: REVISIONS_SQL },
  { version: 6, name: '006_comments', sql: COMMENTS_SQL },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export interface MigrateOptions {
  /** where pre-migration backups go, normally <project>/recovery/ */
  backupDir: string;
  /** injectable for tests */
  migrations?: readonly Migration[];
  now?: () => Date;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
  backup_path: string | null;
}

export function userVersion(db: DbPort): number {
  return db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
}

/** Timestamp safe for file names: 2026-09-26T08-00-00-000Z */
const fileStamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-');

/** Online backup of the whole database (works while WAL is active). */
export async function backupDatabase(db: DbPort, backupDir: string, label: string, now = new Date()): Promise<string> {
  const dest = join(backupDir, `project-${label}-${fileStamp(now)}.sqlite`);
  await db.backup(dest);
  return dest;
}

/**
 * Bring the database to the latest version.
 * - newer than we know → SCHEMA_VERSION_UNSUPPORTED (never downgrade)
 * - existing database (0 < current < latest) → sqlite.backup() first
 * - each migration runs in its own transaction together with its user_version bump
 */
export async function migrate(db: DbPort, opts: MigrateOptions): Promise<MigrateResult> {
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = migrations.length ? migrations[migrations.length - 1]!.version : 0;
  const from = userVersion(db);
  if (from > latest) {
    throw new AppError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `项目数据库版本（${from}）比当前程序支持的版本（${latest}）更新，请升级 StoryScript-Mov`,
      409,
      { db_version: from, supported: latest },
    );
  }
  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from, applied: [], backup_path: null };

  const backup_path = from > 0 ? await backupDatabase(db, opts.backupDir, `v${from}`, opts.now?.()) : null;
  for (const m of pending) {
    db.tx(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${Math.trunc(m.version)}`);
    });
  }
  return { from, to: latest, applied: pending.map((m) => m.name), backup_path };
}
