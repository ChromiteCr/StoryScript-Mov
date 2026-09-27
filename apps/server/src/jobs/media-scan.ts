import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaAsset } from '@storyscript/contracts';
import { deriveMediaFlags } from '@storyscript/core';
import { hashFile } from '../adapters/media/hash.ts';
import { extractPoster } from '../adapters/media/poster.ts';
import { probeFile } from '../adapters/media/probe.ts';
import type { DbPort } from '../db/port.ts';
import { updateJobRow } from '../db/repos/job.ts';
import {
  getAssetByPath,
  insertAsset,
  listRootAssets,
  markAssetSourceChanged,
  resetAssetFacts,
  setAssetAvailability,
  setAssetHash,
  setAssetPoster,
  setAssetProbe,
} from '../db/repos/media.ts';
import { getRoot } from '../db/repos/root.ts';
import { redactSecrets } from '../adapters/llm/redact.ts';
import { detectTools, type ToolsInfo } from '../diagnostics.ts';
import { extOf, isInside, MEDIA_EXTS, resolveSourceFile, safeRealpathSync } from '../services/media/paths.ts';
import { registerRerun, type JobRunContext, type JobRunResult, type JobSpec, type RerunFactory } from './queue.ts';

/**
 * scan_root job (SPEC FR-08), strictly read-only on the source folder (INV-04):
 *   1. walk the root (skip hidden names incl. `._*`, symlinks, the project
 *      folder, anything outside the extension whitelist) and upsert one
 *      media_asset per root + rel_path; vanished files become offline
 *   2. ffprobe → normalizeProbe → deriveMediaFlags, then one poster JPEG per
 *      clip into <project>/derivatives/posters/<asset_id>.jpg
 *   3. streaming SHA-256, one file at a time (hash concurrency 1 per root),
 *      size/mtime compared before and after → source_changed on any change
 * Each asset update is its own small transaction, so the library fills in
 * while the job runs; the job's own status is committed by the queue.
 *
 * FR-11: the scan is local and idempotent (assets are upserted by root +
 * rel_path), so a scan interrupted by a restart is re-run automatically under
 * the same job id and key (`scan_root:<root id>`, see registerRerun below).
 */

export interface ScanJobDeps {
  db: DbPort;
  projectDir: string;
  rootId: string;
  ffprobe: string;
  ffmpeg: string;
  now?: () => string;
}

export interface ScanSummary {
  files: number;
  added: number;
  changed: number;
  offline: number;
  probed: number;
  probe_failed: number;
  posters: number;
  hashed: number;
  source_changed: number;
  hash_failed: number;
}

interface FoundFile {
  rel: string;
  size: number;
  mtimeMs: number;
}

const POSTER_DIR = 'derivatives/posters';

class Cancelled extends Error {}

async function walk(rootReal: string, skipDir: string | null, signal: AbortSignal): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    if (signal.aborted) throw new Cancelled();
    const relDir = stack.pop()!;
    const absDir = relDir ? join(rootReal, ...relDir.split('/')) : rootReal;
    if (skipDir && (absDir === skipDir || isInside(skipDir, absDir))) continue;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: nothing to index there
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // hidden files/folders and AppleDouble `._*`
      if (e.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        stack.push(rel);
      } else if (e.isFile() && MEDIA_EXTS.has(extOf(e.name))) {
        const s = await lstat(join(absDir, e.name)).catch(() => null);
        if (s?.isFile()) out.push({ rel, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function posterSeconds(a: Pick<MediaAsset, 'kind' | 'probe'>): number {
  if (a.kind !== 'video') return 0;
  const d = a.probe?.duration_s ?? 0;
  return Math.max(0, Math.min(1, d / 2));
}

export async function runScanJob(ctx: JobRunContext, deps: ScanJobDeps): Promise<JobRunResult> {
  const { db, projectDir, rootId, ffprobe, ffmpeg } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const summary: ScanSummary = {
    files: 0,
    added: 0,
    changed: 0,
    offline: 0,
    probed: 0,
    probe_failed: 0,
    posters: 0,
    hashed: 0,
    source_changed: 0,
    hash_failed: 0,
  };
  const progress = (p: number) => {
    if (ctx.signal.aborted) return;
    try {
      updateJobRow(db, ctx.job_id, { progress: Math.round(Math.min(0.99, Math.max(0, p)) * 1000) / 1000 }, now());
    } catch {
      // project closed underneath the job
    }
  };

  try {
    const root = getRoot(db, rootId);
    if (!root) return { status: 'failed', attempts: 0, usage: null, error: { code: 'NOT_FOUND', message: '素材目录已不存在' } };
    let rootReal: string;
    try {
      rootReal = await realpath(root.abs_path);
    } catch {
      db.tx(() => {
        for (const a of listRootAssets(db, rootId)) setAssetAvailability(db, a.id, 'offline');
      });
      return { status: 'failed', attempts: 0, usage: null, error: { code: 'SOURCE_OFFLINE', message: '素材目录不在线：磁盘可能没有接上' } };
    }

    // 1. walk + upsert
    const found = await walk(rootReal, safeRealpathSync(projectDir), ctx.signal);
    summary.files = found.length;
    const seen = new Set(found.map((f) => f.rel));
    const needProbe: string[] = [];
    db.tx(() => {
      for (const f of found) {
        const kind = deriveMediaFlags(null, extOf(f.rel)).kind;
        const existing = getAssetByPath(db, rootId, f.rel);
        if (!existing) {
          const id = randomUUID();
          insertAsset(db, {
            id,
            source_root_id: rootId,
            rel_path: f.rel,
            size: f.size,
            mtime_ms: f.mtimeMs,
            kind,
            search_text: `${f.rel.split('/').pop() ?? f.rel} ${f.rel}`,
            created_at: now(),
          });
          summary.added++;
          needProbe.push(id);
        } else if (existing.size !== f.size || existing.mtime_ms !== f.mtimeMs || existing.hash_status === 'source_changed') {
          resetAssetFacts(db, existing.id, f.size, f.mtimeMs, kind);
          summary.changed++;
          needProbe.push(existing.id);
        } else {
          if (existing.availability !== 'online') setAssetAvailability(db, existing.id, 'online');
          if (existing.probe === null || (existing.poster_path === null && (existing.kind === 'video' || existing.kind === 'image'))) {
            needProbe.push(existing.id);
          }
        }
      }
      for (const a of listRootAssets(db, rootId)) {
        if (!seen.has(a.rel_path) && a.availability !== 'offline') {
          setAssetAvailability(db, a.id, 'offline');
          summary.offline++;
        }
      }
    });
    progress(0.05);

    const byId = () => new Map(listRootAssets(db, rootId).map((a) => [a.id, a] as const));

    // 2. probe + poster
    let assets = byId();
    for (const [i, id] of needProbe.entries()) {
      if (ctx.signal.aborted) throw new Cancelled();
      const a = assets.get(id);
      if (!a) continue;
      const file = await resolveSourceFile(rootReal, a.rel_path);
      if (!file.ok) continue;
      const ext = extOf(a.rel_path);
      let probe = a.probe;
      if (probe === null) {
        try {
          probe = await probeFile(ffprobe, file.path, ctx.signal);
          summary.probed++;
        } catch {
          if (ctx.signal.aborted) throw new Cancelled();
          probe = null;
          summary.probe_failed++;
        }
        const flags = deriveMediaFlags(probe, ext);
        db.tx(() => setAssetProbe(db, id, { probe, ...flags }));
        a.kind = flags.kind;
        a.probe = probe;
        a.video_stream_index = flags.video_stream_index;
      }
      const posterable = (a.kind === 'video' && a.video_stream_index !== null) || (a.kind === 'image' && probe !== null);
      if (posterable) {
        const rel = `${POSTER_DIR}/${id}.jpg`;
        try {
          await extractPoster(ffmpeg, file.path, join(projectDir, ...rel.split('/')), {
            allowedDir: join(projectDir, 'derivatives'),
            atSeconds: posterSeconds(a),
            streamIndex: a.kind === 'video' ? (a.video_stream_index ?? undefined) : undefined,
            signal: ctx.signal,
          });
          db.tx(() => setAssetPoster(db, id, rel));
          summary.posters++;
        } catch {
          if (ctx.signal.aborted) throw new Cancelled();
          db.tx(() => setAssetPoster(db, id, null));
        }
      }
      progress(0.05 + (0.45 * (i + 1)) / Math.max(1, needProbe.length));
    }

    // 3. SHA-256, one file at a time
    assets = byId();
    const toHash = [...assets.values()].filter(
      (a) => a.availability === 'online' && (a.hash_status === 'pending' || a.hash_status === 'failed'),
    );
    const totalBytes = toHash.reduce((n, a) => n + a.size, 0) || 1;
    let doneBytes = 0;
    for (const a of toHash) {
      if (ctx.signal.aborted) throw new Cancelled();
      const file = await resolveSourceFile(rootReal, a.rel_path);
      if (!file.ok) {
        db.tx(() => setAssetAvailability(db, a.id, 'offline'));
        continue;
      }
      try {
        const r = await hashFile(file.path, { signal: ctx.signal, expect: { size: a.size, mtimeMs: a.mtime_ms } });
        if (r.status === 'done') {
          db.tx(() => setAssetHash(db, a.id, 'done', r.sha256));
          summary.hashed++;
        } else {
          db.tx(() => markAssetSourceChanged(db, a.id));
          summary.source_changed++;
        }
      } catch {
        if (ctx.signal.aborted) throw new Cancelled();
        db.tx(() => setAssetHash(db, a.id, 'failed', null));
        summary.hash_failed++;
      }
      doneBytes += a.size;
      progress(0.5 + (0.5 * doneBytes) / totalBytes);
    }

    return { status: 'succeeded', attempts: 0, usage: null, commit: () => JSON.stringify({ root_id: rootId, ...summary }) };
  } catch (err) {
    if (err instanceof Cancelled || ctx.signal.aborted) {
      return { status: 'failed', attempts: 0, usage: null, error: { code: 'CANCELLED', message: '扫描已取消' } };
    }
    return {
      status: 'failed',
      attempts: 0,
      usage: null,
      error: { code: 'INTERNAL', message: redactSecrets(err instanceof Error ? err.message : String(err)) },
    };
  }
}

// ---------------------------------------------------------------------------
// job spec + FR-11 restart re-run
// ---------------------------------------------------------------------------

export const scanRootKey = (rootId: string) => `scan_root:${rootId}`;

/** Root id of a scan job row: from its idempotency key, else its input_hash (= root id). */
export function scanRootIdOf(job: { idempotency_key: string; input_hash: string }): string {
  const m = /^scan_root:([^~]+)(~.*)?$/.exec(job.idempotency_key);
  return m ? m[1]! : job.input_hash;
}

export function scanJobSpec(deps: ScanJobDeps): JobSpec {
  return {
    kind: 'scan_root',
    idempotency_key: scanRootKey(deps.rootId),
    input_hash: deps.rootId,
    remote: false,
    lane: 'local',
    run: (ctx) => runScanJob(ctx, deps),
  };
}

/**
 * Re-run factory for scan_root: needs the project folder, a root that still
 * exists and ffmpeg/ffprobe; otherwise the job stays interrupted.
 */
export function scanRerunFactory(resolveTools: () => Promise<ToolsInfo> = () => detectTools()): RerunFactory {
  return async ({ job, db, projectDir }) => {
    if (!projectDir) return null;
    const rootId = scanRootIdOf(job);
    if (!getRoot(db, rootId)) return null;
    const tools = await resolveTools();
    if (!tools.ffprobe.path || !tools.ffmpeg.path) return null;
    return scanJobSpec({ db, projectDir, rootId, ffprobe: tools.ffprobe.path, ffmpeg: tools.ffmpeg.path });
  };
}

registerRerun('scan_root', scanRerunFactory());
