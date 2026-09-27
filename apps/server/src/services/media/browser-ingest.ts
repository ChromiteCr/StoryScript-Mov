import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { AssetFactsInput, BrowserFilesInput, BrowserFilesOutput, CreateBrowserRootInput, MediaAsset, MediaAssetView, SourceRoot } from '@storyscript/contracts';
import { deriveMediaFlags, MEDIA_EXTS } from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import {
  getAssetByPath,
  getAssetRecord,
  insertAsset,
  listRootAssets,
  markAssetSourceChanged,
  resetAssetFacts,
  setAssetAvailability,
  setAssetHash,
  setAssetPoster,
  setAssetProbe,
} from '../../db/repos/media.ts';
import { getRoot, insertRoot } from '../../db/repos/root.ts';
import { AppError } from '../../http/errors.ts';
import { requireAsset, toView } from './assets.ts';
import { extOf, isSafeRelPath } from './paths.ts';
import { requireRoot } from './roots.ts';

/**
 * Footage on a team member's computer (hosted server, S1b). The browser walks
 * the opened project folder, reads each file's facts locally and reports them
 * here; the server never sees a video file. The rules are the ones the server
 * scan uses (jobs/media-scan.ts): one asset per root + rel_path, a changed
 * size/mtime starts the file over, a file missing from the listing goes
 * offline. Kind and playback flags are always derived here from the probe,
 * never taken from the client.
 */

export const POSTER_MAX_BYTES = 512 * 1024;
const POSTER_DIR = 'derivatives/posters';
/** the project folder's own records; never footage */
const RECORDS_DIR = '.storyscript-mov/';

export function createBrowserRoot(db: DbPort, input: z.infer<typeof CreateBrowserRootInput>, now = new Date().toISOString()): SourceRoot {
  const id = randomUUID();
  const root: SourceRoot = { id, kind: 'browser', abs_path: `browser:${id}`, label: input.label, created_at: now };
  db.tx(() => insertRoot(db, root));
  return root;
}

function requireBrowserRoot(db: DbPort, id: string): SourceRoot {
  const root = requireRoot(db, id);
  if (root.kind !== 'browser') {
    throw new AppError('VALIDATION_ERROR', '只有在浏览器里打开的项目文件夹才能这样上报素材', 409, { root_id: id });
  }
  return root;
}

function needsOf(a: MediaAsset): z.infer<typeof BrowserFilesOutput>['assets'][number] {
  const footage = a.kind === 'video' || a.kind === 'audio';
  return {
    asset_id: a.id,
    rel_path: a.rel_path,
    size: a.size,
    mtime_ms: a.mtime_ms,
    probe: footage && a.probe === null,
    poster: a.kind === 'video' && a.poster_path === null && (a.probe === null || a.video_stream_index !== null),
    hash: a.hash_status === 'pending' || a.hash_status === 'failed',
  };
}

export function reportBrowserFiles(
  db: DbPort,
  rootId: string,
  input: z.infer<typeof BrowserFilesInput>,
  now = new Date().toISOString(),
): z.infer<typeof BrowserFilesOutput> {
  requireBrowserRoot(db, rootId);
  const seen = new Set<string>();
  for (const f of input.files) {
    if (!isSafeRelPath(f.rel_path) || f.rel_path.includes('\\') || f.rel_path.startsWith(RECORDS_DIR)) {
      throw new AppError('VALIDATION_ERROR', `不接受的文件路径：${f.rel_path}`, 400, { rel_path: f.rel_path });
    }
    if (!MEDIA_EXTS.has(extOf(f.rel_path))) {
      throw new AppError('VALIDATION_ERROR', `不是素材文件：${f.rel_path}`, 400, { rel_path: f.rel_path });
    }
    if (seen.has(f.rel_path)) throw new AppError('VALIDATION_ERROR', `文件重复：${f.rel_path}`, 400, { rel_path: f.rel_path });
    seen.add(f.rel_path);
  }

  const summary = { added: 0, changed: 0, offline: 0 };
  db.tx(() => {
    for (const f of input.files) {
      const kind = deriveMediaFlags(null, extOf(f.rel_path)).kind;
      const existing = getAssetByPath(db, rootId, f.rel_path);
      if (!existing) {
        insertAsset(db, {
          id: randomUUID(),
          source_root_id: rootId,
          rel_path: f.rel_path,
          size: f.size,
          mtime_ms: f.mtime_ms,
          kind,
          search_text: `${f.rel_path.split('/').pop() ?? f.rel_path} ${f.rel_path}`,
          created_at: now,
        });
        summary.added++;
      } else if (existing.size !== f.size || existing.mtime_ms !== f.mtime_ms || existing.hash_status === 'source_changed') {
        resetAssetFacts(db, existing.id, f.size, f.mtime_ms, kind);
        summary.changed++;
      } else if (existing.availability !== 'online') {
        setAssetAvailability(db, existing.id, 'online');
      }
    }
    for (const a of listRootAssets(db, rootId)) {
      if (!seen.has(a.rel_path) && a.availability !== 'offline') {
        setAssetAvailability(db, a.id, 'offline');
        summary.offline++;
      }
    }
  });
  const assets = listRootAssets(db, rootId)
    .filter((a) => seen.has(a.rel_path))
    .map(needsOf);
  return { ...summary, assets };
}

function requireBrowserAsset(db: DbPort, id: string): MediaAsset {
  const a = requireAsset(db, id);
  const root = getRoot(db, a.source_root_id);
  if (!root || root.kind !== 'browser') {
    throw new AppError('VALIDATION_ERROR', '只有浏览器素材目录里的素材才能由浏览器上报', 409, { asset_id: id });
  }
  return a;
}

function view(db: DbPort, id: string): MediaAssetView {
  const r = getAssetRecord(db, id);
  if (!r) throw new AppError('NOT_FOUND', '素材不存在', 404);
  return toView(r);
}

export function reportAssetFacts(db: DbPort, id: string, input: z.infer<typeof AssetFactsInput>): MediaAssetView {
  const a = requireBrowserAsset(db, id);
  if (a.size !== input.size || a.mtime_ms !== input.mtime_ms) {
    throw new AppError('VALIDATION_ERROR', '文件在扫描之后又改动过：重新打开文件夹扫描一次', 409, { asset_id: id });
  }
  db.tx(() => {
    if (input.probe !== undefined) setAssetProbe(db, id, { probe: input.probe, ...deriveMediaFlags(input.probe, extOf(a.rel_path)) });
    if (input.hash_problem === 'source_changed') markAssetSourceChanged(db, id);
    else if (input.hash_problem === 'failed') setAssetHash(db, id, 'failed', null);
    else if (input.sha256) setAssetHash(db, id, 'done', input.sha256);
  });
  return view(db, id);
}

const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** A poster JPEG the browser grabbed; stored like the server scan's posters. */
export async function saveBrowserPoster(db: DbPort, projectDir: string, id: string, bytes: Uint8Array): Promise<MediaAssetView> {
  requireBrowserAsset(db, id);
  if (bytes.length === 0) throw new AppError('VALIDATION_ERROR', '海报图是空的', 400);
  if (bytes.length > POSTER_MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', `海报图不能超过 ${POSTER_MAX_BYTES / 1024} KB`, 413, { size: bytes.length });
  }
  if (!isJpeg(bytes)) throw new AppError('UNSUPPORTED_MEDIA', '海报图不是 JPEG', 415);
  const rel = `${POSTER_DIR}/${id}.jpg`;
  const dest = join(projectDir, ...rel.split('/'));
  await mkdir(join(projectDir, ...POSTER_DIR.split('/')), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, dest);
  db.tx(() => setAssetPoster(db, id, rel));
  return view(db, id);
}
