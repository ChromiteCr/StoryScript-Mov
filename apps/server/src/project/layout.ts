import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { FOLDER_RECORDS_DIR, ProjectManifest } from '@storyscript/contracts';
import { writeJsonFile } from '../config/paths.ts';
import { AppError } from '../http/errors.ts';

/**
 * On-disk layout of a project (SPEC §3). A project is a folder the user opens
 * (like a folder in VS Code): footage sits in it (A-roll/, B-roll/ …) and the
 * project's own data lives in its hidden .storyscript-mov/ folder. Projects
 * made before that layout keep project.json in the folder itself ("legacy").
 * Everything below `data` (manifest, database, derivatives, boards, exports,
 * recovery) is the same in both layouts.
 */

export interface ProjectDirs {
  /** the folder the user opened */
  folder: string;
  /** where project.json, the database and derivatives live */
  data: string;
  legacy: boolean;
}

/** Resolve an opened folder (a real path). The records folder itself is accepted too. */
export function projectDirs(real: string): ProjectDirs {
  if (basename(real) === FOLDER_RECORDS_DIR && existsSync(join(real, MANIFEST_FILE))) {
    return { folder: dirname(real), data: real, legacy: false };
  }
  if (existsSync(join(real, MANIFEST_FILE))) return { folder: real, data: real, legacy: true };
  return { folder: real, data: join(real, FOLDER_RECORDS_DIR), legacy: false };
}

/** The opened folder for a data directory (inverse of projectDirs). */
export function folderOfDataDir(data: string): string {
  return basename(data) === FOLDER_RECORDS_DIR ? dirname(data) : data;
}


export const MANIFEST_FILE = 'project.json';
export const DB_FILE = 'project.sqlite';
export const PROJECT_SUBDIRS = ['scripts', 'boards', 'derivatives/posters', 'exports', 'recovery'] as const;

export const manifestPath = (dir: string) => join(dir, MANIFEST_FILE);
export const dbPath = (dir: string) => join(dir, DB_FILE);
export const recoveryDir = (dir: string) => join(dir, 'recovery');

/** User-supplied directory → absolute path (`~` expanded). Relative paths are rejected. */
export function normalizeProjectDir(input: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) throw new AppError('VALIDATION_ERROR', '请填写项目目录的绝对路径', 400, { dir: input });
  return resolve(expanded);
}

export function readManifest(dir: string): ProjectManifest {
  const path = manifestPath(dir);
  if (!existsSync(path)) throw new AppError('NOT_FOUND', '这个文件夹还不是 StoryScript-Mov 项目', 404, { dir });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new AppError('VALIDATION_ERROR', 'project.json 已损坏，无法读取', 400, { dir });
  }
  const parsed = ProjectManifest.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'project.json 格式不正确', 400, { dir });
  return parsed.data;
}

export function writeManifest(dir: string, manifest: ProjectManifest): void {
  writeJsonFile(manifestPath(dir), ProjectManifest.parse(manifest));
}
