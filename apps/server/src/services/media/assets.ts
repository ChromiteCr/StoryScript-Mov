import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { MediaAsset, MediaAssetView, MediaSearchInput } from '@storyscript/contracts';
import type { DbPort } from '../../db/port.ts';
import { getAsset, listAssetRecords, searchAssetRecords, setAssetAvailability, type AssetRecord } from '../../db/repos/media.ts';
import { getRoot } from '../../db/repos/root.ts';
import { AppError } from '../../http/errors.ts';
import { isInside, resolveSourceFile } from './paths.ts';

/** Library views and the two binary endpoints (poster JPEG, Range stream). */

export const posterUrl = (id: string) => `/api/v1/media/assets/${id}/poster`;
export const streamUrl = (id: string) => `/api/v1/media/assets/${id}/stream`;

export function toView(r: AssetRecord): MediaAssetView {
  const a = r.asset;
  return {
    ...a,
    root_label: r.root_label,
    poster_url: a.poster_path ? posterUrl(a.id) : null,
    stream_url: a.playable_direct ? streamUrl(a.id) : null,
    link_count: r.link_count,
    candidate_count: r.candidate_count,
  };
}

export function listAssetViews(db: DbPort): MediaAssetView[] {
  return listAssetRecords(db).map(toView);
}

export function searchAssetViews(db: DbPort, input: z.infer<typeof MediaSearchInput>): MediaAssetView[] {
  return searchAssetRecords(db, { q: input.q.trim(), availability: input.availability, linked: input.linked }).map(toView);
}

export function requireAsset(db: DbPort, id: string): MediaAsset {
  const a = getAsset(db, id);
  if (!a) throw new AppError('NOT_FOUND', '素材不存在', 404);
  return a;
}

/** Poster JPEG inside <project>/derivatives (realpath-checked). */
export async function posterFile(db: DbPort, projectDir: string, id: string): Promise<{ path: string; size: number }> {
  const a = requireAsset(db, id);
  if (!a.poster_path) throw new AppError('NOT_FOUND', '这条素材没有海报帧', 404);
  const allowed = await realpath(join(projectDir, 'derivatives')).catch(() => null);
  const real = await realpath(join(projectDir, ...a.poster_path.split('/'))).catch(() => null);
  if (!allowed || !real) throw new AppError('NOT_FOUND', '海报帧文件不存在，重新扫描可再生成', 404);
  if (!isInside(allowed, real)) throw new AppError('PATH_NOT_ALLOWED', '海报帧路径不在项目的派生目录内', 403);
  const s = await stat(real);
  if (!s.isFile()) throw new AppError('NOT_FOUND', '海报帧文件不存在', 404);
  return { path: real, size: s.size };
}

/**
 * Original clip for direct playback. Only playable_direct assets; the path is
 * realpath(root + rel_path) and must still be a file inside the root.
 */
export async function streamFile(db: DbPort, id: string): Promise<{ path: string; size: number; asset: MediaAsset }> {
  const a = requireAsset(db, id);
  if (!a.playable_direct) {
    throw new AppError('UNSUPPORTED_MEDIA', '这条素材不能在浏览器里直接播放：需代理（v0.2）', 415, { asset_id: id });
  }
  const root = getRoot(db, a.source_root_id);
  if (!root) throw new AppError('NOT_FOUND', '素材所在目录已不存在', 404);
  const file = await resolveSourceFile(root.abs_path, a.rel_path);
  if (!file.ok) {
    if (file.reason === 'not_allowed') {
      throw new AppError('PATH_NOT_ALLOWED', '素材路径指向素材目录之外，已拒绝访问', 403, { asset_id: id });
    }
    if (a.availability !== 'offline') db.tx(() => setAssetAvailability(db, a.id, 'offline'));
    throw new AppError('SOURCE_OFFLINE', '原片不在线：存放素材的磁盘可能没有接上', 409, { asset_id: id });
  }
  return { path: file.path, size: file.size, asset: a };
}
