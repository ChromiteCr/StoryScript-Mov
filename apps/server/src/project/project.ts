import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROJECT_SCHEMA_VERSION,
  type CreateProjectInput,
  type Project,
  type ProjectManifest,
} from '@storyscript/contracts';
import { migrate, type MigrateResult } from '../db/migrations/index.ts';
import { openDb, type DbPort } from '../db/port.ts';
import { getProject, insertProject, setProjectSchemaVersion } from '../db/repos/project.ts';
import { AppError } from '../http/errors.ts';
import { acquireLock, type ProjectLock } from './lock.ts';
import {
  dbPath,
  manifestPath,
  normalizeProjectDir,
  PROJECT_SUBDIRS,
  readManifest,
  recoveryDir,
  writeManifest,
} from './layout.ts';

export const DEFAULT_LOOK_PRESET_ID = 'widescreen-pencil';
export const DEFAULT_CODE_FORMAT = 'S{scene:02}-{shot:03}-T{take:02}';

/** An open project: its directory, database handle and writer lock. */
export interface OpenedProject {
  readonly dir: string;
  readonly db: DbPort;
  readonly manifest: ProjectManifest;
  readonly lock: ProjectLock;
  readonly migration: MigrateResult;
  /** current project row */
  project(): Project;
  close(): void;
}

export interface ProjectOpOptions {
  now?: () => Date;
}

function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new AppError('VALIDATION_ERROR', `无法识别的时区：${tz}`, 400, { timezone: tz });
  }
}

function makeOpened(dir: string, db: DbPort, manifest: ProjectManifest, lock: ProjectLock, migration: MigrateResult): OpenedProject {
  let closed = false;
  return {
    dir,
    db,
    manifest,
    lock,
    migration,
    project() {
      const p = getProject(db);
      if (!p) throw new AppError('INTERNAL', '项目数据库缺少 project 记录', 500);
      return p;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        lock.release();
      }
    },
  };
}

function ensureSubdirs(dir: string): void {
  for (const sub of PROJECT_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });
}

/**
 * Create a project in `dir` (created if missing). Refuses a directory that
 * already holds a project. project.json is written last, so a failed create
 * leaves no half-initialised project behind.
 */
export async function createProject(
  dir: string,
  input: Omit<CreateProjectInput, 'dir'>,
  opts: ProjectOpOptions = {},
): Promise<OpenedProject> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const abs = normalizeProjectDir(dir);
  assertTimezone(input.timezone);
  if (existsSync(abs) && !statSync(abs).isDirectory()) {
    throw new AppError('VALIDATION_ERROR', '所选路径不是文件夹', 400, { dir: abs });
  }
  mkdirSync(abs, { recursive: true });
  const real = realpathSync(abs);
  if (existsSync(manifestPath(real)) || existsSync(dbPath(real))) {
    throw new AppError('VALIDATION_ERROR', '该目录已有项目，请直接打开或换一个空目录', 400, { dir: real, reason: 'PROJECT_EXISTS' });
  }

  const lock = acquireLock(real);
  let db: DbPort | null = null;
  try {
    ensureSubdirs(real);
    db = openDb(dbPath(real));
    const migration = await migrate(db, { backupDir: recoveryDir(real) });
    const manifest: ProjectManifest = {
      format: 'storyscript-mov-project',
      id: randomUUID(),
      schema_version: PROJECT_SCHEMA_VERSION,
      created_at: now,
    };
    insertProject(db, {
      id: manifest.id,
      name: input.name.trim(),
      timezone: input.timezone,
      default_aspect: input.default_aspect,
      target_duration_s: input.target_duration_s,
      look_preset_id: DEFAULT_LOOK_PRESET_ID,
      code_format: DEFAULT_CODE_FORMAT,
      schema_version: PROJECT_SCHEMA_VERSION,
      created_at: now,
      updated_at: now,
    });
    writeManifest(real, manifest);
    return makeOpened(real, db, manifest, lock, migration);
  } catch (err) {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath(real)}${suffix}`, { force: true });
    lock.release();
    throw err;
  }
}

/** Open an existing project: validate manifest → lock → migrate (with backup) → verify identity. */
export async function openProject(dir: string, opts: ProjectOpOptions = {}): Promise<OpenedProject> {
  const abs = normalizeProjectDir(dir);
  if (!existsSync(abs)) throw new AppError('NOT_FOUND', '项目目录不存在', 404, { dir: abs });
  const real = realpathSync(abs);
  const manifest = readManifest(real);
  if (manifest.schema_version > PROJECT_SCHEMA_VERSION) {
    throw new AppError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `该项目由更新版本的 StoryScript-Mov 创建（数据版本 ${manifest.schema_version}），请升级后再打开`,
      409,
      { project_version: manifest.schema_version, supported: PROJECT_SCHEMA_VERSION },
    );
  }
  if (!existsSync(dbPath(real))) {
    throw new AppError('VALIDATION_ERROR', '项目数据库 project.sqlite 缺失', 400, { dir: real });
  }

  const lock = acquireLock(real);
  let db: DbPort | null = null;
  try {
    db = openDb(dbPath(real));
    const migration = await migrate(db, { backupDir: recoveryDir(real) });
    const project = getProject(db);
    if (!project) throw new AppError('VALIDATION_ERROR', '项目数据库缺少 project 记录', 400, { dir: real });
    if (project.id !== manifest.id) {
      throw new AppError('VALIDATION_ERROR', 'project.json 与项目数据库不匹配', 400, { dir: real });
    }
    let current = manifest;
    if (project.schema_version !== PROJECT_SCHEMA_VERSION || manifest.schema_version !== PROJECT_SCHEMA_VERSION) {
      const now = (opts.now ?? (() => new Date()))().toISOString();
      setProjectSchemaVersion(db, project.id, PROJECT_SCHEMA_VERSION, now);
      current = { ...manifest, schema_version: PROJECT_SCHEMA_VERSION };
      writeManifest(real, current);
    }
    ensureSubdirs(real);
    return makeOpened(real, db, current, lock, migration);
  } catch (err) {
    db?.close();
    lock.release();
    throw err;
  }
}
