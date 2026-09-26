import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ProjectManifest } from '@storyscript/contracts';
import { writeJsonFile } from '../config/paths.ts';
import { AppError } from '../http/errors.ts';

/** On-disk layout of a project directory (SPEC §3). */

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
  if (!existsSync(path)) throw new AppError('NOT_FOUND', '该目录下没有 StoryScript-Mov 项目（缺少 project.json）', 404, { dir });
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
