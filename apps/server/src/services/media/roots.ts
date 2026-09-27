import { randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { z } from 'zod';
import type { AddRootInput, RootCheckResult, SourceRoot } from '@storyscript/contracts';
import type { DbPort } from '../../db/port.ts';
import { listRootAssets, markAssetSourceChanged, setAssetAvailability } from '../../db/repos/media.ts';
import { getRoot, getRootByPath, insertRoot, listRoots } from '../../db/repos/root.ts';
import { AppError } from '../../http/errors.ts';
import { isSafeRelPath, isSameOrInside, normalizeUserDir, safeRealpathSync } from './paths.ts';

/**
 * Source roots (SPEC FR-08): user-granted folders, stored as realpath. The
 * project folder and anything inside it can never be a root, and roots never
 * overlap (a file must belong to exactly one root).
 */

export function requireRoot(db: DbPort, id: string): SourceRoot {
  const r = getRoot(db, id);
  if (!r) throw new AppError('NOT_FOUND', '素材目录不存在', 404);
  return r;
}

/** Browser roots live on a team member's computer: the server cannot scan or check them. */
export function requireServerReadable(root: SourceRoot): void {
  if (root.kind === 'browser') {
    throw new AppError('VALIDATION_ERROR', '这个素材目录在队员的电脑上，只能在浏览器里打开项目文件夹来扫描', 409, { root_id: root.id });
  }
}

export interface AddRootResult {
  root: SourceRoot;
  created: boolean;
}

export async function addRoot(db: DbPort, projectDir: string, input: z.infer<typeof AddRootInput>, now = new Date().toISOString()): Promise<AddRootResult> {
  const abs = normalizeUserDir(input.abs_path);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new AppError('VALIDATION_ERROR', '素材目录不存在，确认磁盘已接上、路径拼写正确', 400, { abs_path: abs });
  }
  const s = await stat(real);
  if (!s.isDirectory()) throw new AppError('VALIDATION_ERROR', '所选路径不是文件夹', 400, { abs_path: real });
  if (real === '/') throw new AppError('PATH_NOT_ALLOWED', '不能把整个磁盘根目录登记为素材目录', 403, { abs_path: real });
  const projectReal = safeRealpathSync(projectDir) ?? projectDir;
  if (isSameOrInside(projectReal, real)) {
    throw new AppError('PATH_NOT_ALLOWED', '素材目录不能是项目目录或它里面的文件夹', 403, { abs_path: real });
  }

  const label = input.label?.trim() || basename(real) || real;
  return db.tx(() => {
    const existing = getRootByPath(db, real);
    if (existing) return { root: existing, created: false };
    const overlap = listRoots(db).find((r) => r.kind === 'fs' && (isSameOrInside(r.abs_path, real) || isSameOrInside(real, r.abs_path)));
    if (overlap) {
      throw new AppError('VALIDATION_ERROR', `与已登记的素材目录「${overlap.label}」重叠：同一个文件只能属于一个素材目录`, 400, {
        abs_path: real,
        overlaps: overlap.abs_path,
      });
    }
    const root: SourceRoot = { id: randomUUID(), kind: 'fs', abs_path: real, label, created_at: now };
    insertRoot(db, root);
    return { root, created: true };
  });
}

type CheckOutcome = { id: string; state: 'online' | 'offline' | 'changed' };

/**
 * Existence and size/mtime check of every asset of a root (no reads of file
 * content). Missing → offline; different size/mtime (or no longer a plain
 * file) → hash_status source_changed; the recorded facts are kept as they
 * were so the change stays visible until the next scan re-indexes the file.
 */
export async function checkRoot(db: DbPort, root: SourceRoot): Promise<z.infer<typeof RootCheckResult>> {
  requireServerReadable(root);
  const assets = listRootAssets(db, root.id);
  const rootReal = safeRealpathSync(root.abs_path);
  const outcomes: CheckOutcome[] = [];
  for (const a of assets) {
    if (rootReal === null || !isSafeRelPath(a.rel_path)) {
      outcomes.push({ id: a.id, state: 'offline' });
      continue;
    }
    const l = await lstat(`${rootReal}/${a.rel_path}`).catch(() => null);
    if (!l) outcomes.push({ id: a.id, state: 'offline' });
    else if (!l.isFile() || l.size !== a.size || l.mtimeMs !== a.mtime_ms) outcomes.push({ id: a.id, state: 'changed' });
    else outcomes.push({ id: a.id, state: a.hash_status === 'source_changed' ? 'changed' : 'online' });
  }
  db.tx(() => {
    for (const o of outcomes) {
      if (o.state === 'offline') setAssetAvailability(db, o.id, 'offline');
      else if (o.state === 'changed') markAssetSourceChanged(db, o.id);
      else setAssetAvailability(db, o.id, 'online');
    }
  });
  const offline = outcomes.filter((o) => o.state === 'offline').length;
  return { online: outcomes.length - offline, offline, changed: outcomes.filter((o) => o.state === 'changed').length };
}
