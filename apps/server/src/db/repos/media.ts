import { MediaAsset, ProbeNormalized, type Availability, type HashStatus, type MediaKind } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/**
 * media_asset ↔ contracts MediaAsset. One row per (source_root_id, rel_path);
 * rel_path uses "/" separators. search_text is the denormalised LIKE target
 * (file name + relative path); FR-09: LIKE only, no FTS.
 */

interface AssetRow {
  id: string;
  source_root_id: string;
  rel_path: string;
  size: number;
  mtime_ms: number;
  kind: string;
  probe_json: string | null;
  video_stream_index: number | null;
  playable_direct: number;
  is_vfr_suspect: number;
  has_timecode: number;
  sha256: string | null;
  hash_status: string;
  poster_path: string | null;
  availability: string;
  search_text: string;
  created_at: string;
}

const COLS =
  'id, source_root_id, rel_path, size, mtime_ms, kind, probe_json, video_stream_index, playable_direct, is_vfr_suspect, has_timecode, sha256, hash_status, poster_path, availability, search_text, created_at';
const A_COLS = COLS.split(', ')
  .map((c) => `a.${c}`)
  .join(', ');

export function assetFromRow(r: AssetRow): MediaAsset {
  return MediaAsset.parse({
    ...r,
    size: Number(r.size),
    mtime_ms: Number(r.mtime_ms),
    probe: r.probe_json === null ? null : ProbeNormalized.parse(JSON.parse(r.probe_json)),
    playable_direct: r.playable_direct === 1,
    is_vfr_suspect: r.is_vfr_suspect === 1,
    has_timecode: r.has_timecode === 1,
  });
}

/** Asset plus the counters the library view needs. */
export interface AssetRecord {
  asset: MediaAsset;
  root_label: string;
  /** confirmed links */
  link_count: number;
  candidate_count: number;
}

type RecordRow = AssetRow & { root_label: string; link_count: number; candidate_count: number };

const RECORD_SELECT = `SELECT ${A_COLS}, r.label AS root_label,
    (SELECT COUNT(*) FROM shot_media_link l WHERE l.media_asset_id = a.id AND l.status = 'confirmed') AS link_count,
    (SELECT COUNT(*) FROM shot_media_link l WHERE l.media_asset_id = a.id AND l.status = 'candidate') AS candidate_count
  FROM media_asset a JOIN source_root r ON r.id = a.source_root_id`;

const RECORD_ORDER = 'ORDER BY r.created_at, r.rowid, a.rel_path';

function recordFromRow(r: RecordRow): AssetRecord {
  return {
    asset: assetFromRow(r),
    root_label: r.root_label,
    link_count: Number(r.link_count),
    candidate_count: Number(r.candidate_count),
  };
}

export function listAssetRecords(db: DbPort): AssetRecord[] {
  return db.all<RecordRow>(`${RECORD_SELECT} ${RECORD_ORDER}`).map(recordFromRow);
}

export interface AssetSearch {
  /** LIKE pattern body (already trimmed); empty = no text filter */
  q: string;
  availability: Availability | null;
  linked: 'linked' | 'unlinked' | 'candidate' | null;
}

/** `%` `_` `\` are literal in the user's query. */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function searchAssetRecords(db: DbPort, s: AssetSearch): AssetRecord[] {
  const where: string[] = [];
  const params: string[] = [];
  const words = s.q.split(/\s+/).filter(Boolean);
  for (const w of words) {
    where.push("a.search_text LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(w)}%`);
  }
  if (s.availability) {
    where.push('a.availability = ?');
    params.push(s.availability);
  }
  const confirmed = "EXISTS (SELECT 1 FROM shot_media_link l WHERE l.media_asset_id = a.id AND l.status = 'confirmed')";
  const candidate = "EXISTS (SELECT 1 FROM shot_media_link l WHERE l.media_asset_id = a.id AND l.status = 'candidate')";
  if (s.linked === 'linked') where.push(confirmed);
  if (s.linked === 'candidate') where.push(candidate);
  if (s.linked === 'unlinked') where.push(`NOT ${confirmed} AND NOT ${candidate}`);
  const sql = `${RECORD_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${RECORD_ORDER}`;
  return db.all<RecordRow>(sql, ...params).map(recordFromRow);
}

export function getAsset(db: DbPort, id: string): MediaAsset | null {
  const r = db.get<AssetRow>(`SELECT ${COLS} FROM media_asset WHERE id = ?`, id);
  return r ? assetFromRow(r) : null;
}

export function getAssetRecord(db: DbPort, id: string): AssetRecord | null {
  const r = db.get<RecordRow>(`${RECORD_SELECT} WHERE a.id = ?`, id);
  return r ? recordFromRow(r) : null;
}

export function listRootAssets(db: DbPort, rootId: string): MediaAsset[] {
  return db.all<AssetRow>(`SELECT ${COLS} FROM media_asset WHERE source_root_id = ? ORDER BY rel_path`, rootId).map(assetFromRow);
}

export function listAllAssets(db: DbPort): MediaAsset[] {
  return db.all<AssetRow>(`SELECT ${COLS} FROM media_asset ORDER BY source_root_id, rel_path`).map(assetFromRow);
}

export function getAssetByPath(db: DbPort, rootId: string, relPath: string): MediaAsset | null {
  const r = db.get<AssetRow>(`SELECT ${COLS} FROM media_asset WHERE source_root_id = ? AND rel_path = ?`, rootId, relPath);
  return r ? assetFromRow(r) : null;
}

export interface NewAsset {
  id: string;
  source_root_id: string;
  rel_path: string;
  size: number;
  mtime_ms: number;
  kind: MediaKind;
  search_text: string;
  created_at: string;
}

export function insertAsset(db: DbPort, a: NewAsset): void {
  db.run(
    `INSERT INTO media_asset (id, source_root_id, rel_path, size, mtime_ms, kind, hash_status, availability, search_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 'online', ?, ?)`,
    a.id,
    a.source_root_id,
    a.rel_path,
    a.size,
    a.mtime_ms,
    a.kind,
    a.search_text,
    a.created_at,
  );
}

/** A re-scan found different size/mtime: record the new facts and start over. */
export function resetAssetFacts(db: DbPort, id: string, size: number, mtimeMs: number, kind: MediaKind): void {
  db.run(
    `UPDATE media_asset SET size = ?, mtime_ms = ?, kind = ?, probe_json = NULL, video_stream_index = NULL,
       playable_direct = 0, is_vfr_suspect = 0, has_timecode = 0, sha256 = NULL, hash_status = 'pending',
       availability = 'online' WHERE id = ?`,
    size,
    mtimeMs,
    kind,
    id,
  );
}

export interface ProbeFacts {
  probe: ProbeNormalized | null;
  kind: MediaKind;
  video_stream_index: number | null;
  playable_direct: boolean;
  is_vfr_suspect: boolean;
  has_timecode: boolean;
}

export function setAssetProbe(db: DbPort, id: string, f: ProbeFacts): void {
  db.run(
    `UPDATE media_asset SET probe_json = ?, kind = ?, video_stream_index = ?, playable_direct = ?, is_vfr_suspect = ?, has_timecode = ?
     WHERE id = ?`,
    f.probe === null ? null : JSON.stringify(ProbeNormalized.parse(f.probe)),
    f.kind,
    f.video_stream_index,
    f.playable_direct ? 1 : 0,
    f.is_vfr_suspect ? 1 : 0,
    f.has_timecode ? 1 : 0,
    id,
  );
}

export function setAssetPoster(db: DbPort, id: string, posterPath: string | null): void {
  db.run('UPDATE media_asset SET poster_path = ? WHERE id = ?', posterPath, id);
}

export function setAssetHash(db: DbPort, id: string, status: HashStatus, sha256: string | null): void {
  db.run('UPDATE media_asset SET hash_status = ?, sha256 = ? WHERE id = ?', status, sha256, id);
}

export function setAssetAvailability(db: DbPort, id: string, availability: Availability): void {
  db.run('UPDATE media_asset SET availability = ? WHERE id = ?', availability, id);
}

/** Marks a changed source without touching the recorded size/mtime/hash (they stay the original facts). */
export function markAssetSourceChanged(db: DbPort, id: string): void {
  db.run("UPDATE media_asset SET hash_status = 'source_changed', availability = 'online' WHERE id = ?", id);
}
