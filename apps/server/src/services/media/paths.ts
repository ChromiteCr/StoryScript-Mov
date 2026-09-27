import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError } from '../../http/errors.ts';

/**
 * Path rules of the media loop (SPEC §6, INV-04): originals are referenced
 * only as source_root + rel_path; every file access re-resolves the realpath
 * and checks it still lies inside the (realpath'd) root, so `..` segments and
 * symlinks that point elsewhere never reach the file system.
 */

/** Extension whitelist of the scanner (lower case, no dot). */
export { MEDIA_EXTS } from '@storyscript/core';

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** `p` is strictly inside `root` (both absolute, already normalised). */
export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function isSameOrInside(root: string, p: string): boolean {
  return resolve(root) === resolve(p) || isInside(root, p);
}

/** User-typed directory → absolute path (`~` expanded); relative input is rejected. */
export function normalizeUserDir(input: string): string {
  const t = input.trim();
  const expanded = t === '~' ? homedir() : t.startsWith('~/') ? join(homedir(), t.slice(2)) : t;
  if (!isAbsolute(expanded)) throw new AppError('VALIDATION_ERROR', '请填写素材目录的绝对路径', 400, { abs_path: input });
  return resolve(expanded);
}

/** Stored rel_path must be a plain relative path: no `..`, no empty or `.` segments, no NUL. */
export function isSafeRelPath(rel: string): boolean {
  if (rel === '' || rel.includes('\0') || isAbsolute(rel) || rel.includes('\\')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function safeRealpathSync(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export type ResolvedFile =
  | { ok: true; path: string; size: number; mtimeMs: number }
  | { ok: false; reason: 'offline' | 'not_allowed' };

/**
 * realpath(root + rel_path), accepted only when it is a regular file strictly
 * inside realpath(root). Missing root or file → offline; `..`, symlink escape
 * or a non-file → not_allowed.
 */
export async function resolveSourceFile(rootAbs: string, relPath: string): Promise<ResolvedFile> {
  if (!isSafeRelPath(relPath)) return { ok: false, reason: 'not_allowed' };
  let rootReal: string;
  try {
    rootReal = await realpath(rootAbs);
  } catch {
    return { ok: false, reason: 'offline' };
  }
  let real: string;
  try {
    real = await realpath(join(rootReal, ...relPath.split('/')));
  } catch {
    // dangling symlink or missing file: offline unless the name itself is a link
    const l = await lstat(join(rootReal, ...relPath.split('/'))).catch(() => null);
    return { ok: false, reason: l?.isSymbolicLink() ? 'not_allowed' : 'offline' };
  }
  if (!isInside(rootReal, real)) return { ok: false, reason: 'not_allowed' };
  const s = await lstat(real).catch(() => null);
  if (!s) return { ok: false, reason: 'offline' };
  if (!s.isFile()) return { ok: false, reason: 'not_allowed' };
  return { ok: true, path: real, size: s.size, mtimeMs: s.mtimeMs };
}
