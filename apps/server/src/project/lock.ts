import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../http/errors.ts';

/**
 * project.lock — single writer per project (FR-01).
 * Created atomically (write temp file, then hard-link to the lock path), so a
 * lock file is never observed half-written. A lock whose pid no longer exists
 * on this host is stale and may be taken over.
 */

export const LOCK_FILE = 'project.lock';

export const LockInfo = z.object({
  pid: z.number().int().positive(),
  hostname: z.string(),
  started_at: z.string(),
});
export type LockInfo = z.infer<typeof LockInfo>;

export interface ProjectLock {
  readonly path: string;
  readonly info: LockInfo;
  release(): void;
}

/** Locks held by this process, released on exit. */
const held = new Map<string, LockInfo>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const [path, info] of held) releaseIfOwned(path, info);
    held.clear();
  });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but belongs to another user
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(path: string): LockInfo | null {
  try {
    const parsed = LockInfo.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function releaseIfOwned(path: string, info: LockInfo): void {
  const current = readLock(path);
  if (current && current.pid === info.pid && current.started_at === info.started_at) {
    rmSync(path, { force: true });
  }
}

function tryCreate(path: string, info: LockInfo): boolean {
  const tmp = `${path}.${info.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o644 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function lockedError(existing: LockInfo, sameHost: boolean): AppError {
  const where = sameHost ? `进程 ${existing.pid}` : `主机 ${existing.hostname} 上的进程 ${existing.pid}`;
  return new AppError('PROJECT_LOCKED', `该项目正被${where}使用（自 ${existing.started_at} 起），请先关闭它`, 409, existing);
}

export function acquireLock(projectDir: string): ProjectLock {
  const path = join(projectDir, LOCK_FILE);
  const info: LockInfo = { pid: process.pid, hostname: hostname(), started_at: new Date().toISOString() };

  // at most one takeover attempt: create → inspect existing → remove stale → create
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(path, info)) {
      held.set(path, info);
      installExitHook();
      return { path, info, release: () => releaseLock(path, info) };
    }
    const existing = readLock(path);
    if (existing) {
      const sameHost = existing.hostname === info.hostname;
      if (!sameHost) throw lockedError(existing, false);
      const ownedHere = existing.pid === process.pid && held.has(path);
      if (ownedHere || (existing.pid !== process.pid && isPidAlive(existing.pid))) throw lockedError(existing, true);
    }
    // stale (dead pid, leftover from this pid, or unreadable) → take over
    rmSync(path, { force: true });
  }
  const existing = readLock(path);
  throw existing ? lockedError(existing, existing.hostname === info.hostname) : new AppError('PROJECT_LOCKED', '无法获取项目锁，请重试', 409);
}

function releaseLock(path: string, info: LockInfo): void {
  if (held.get(path) !== info) return;
  held.delete(path);
  releaseIfOwned(path, info);
}
