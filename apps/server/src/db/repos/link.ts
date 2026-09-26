import { ShotMediaLink, SourceRange } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/**
 * shot_media_link ↔ contracts ShotMediaLink (INV-06: many-to-many; deleting
 * a row never touches files or other rows). source_range is the frozen SR
 * structure, stored as JSON of five integers.
 */

interface LinkRow {
  id: string;
  shot_id: string;
  media_asset_id: string;
  take_id: string | null;
  source_range_json: string;
  evidence: string;
  status: string;
  confirmed_at: string | null;
  revision: number;
  created_at: string;
}

const COLS = 'id, shot_id, media_asset_id, take_id, source_range_json, evidence, status, confirmed_at, revision, created_at';

function fromRow(r: LinkRow): ShotMediaLink {
  return ShotMediaLink.parse({ ...r, source_range: JSON.parse(r.source_range_json) });
}

export function listLinks(db: DbPort): ShotMediaLink[] {
  return db.all<LinkRow>(`SELECT ${COLS} FROM shot_media_link ORDER BY created_at, rowid`).map(fromRow);
}

export function getLink(db: DbPort, id: string): ShotMediaLink | null {
  const r = db.get<LinkRow>(`SELECT ${COLS} FROM shot_media_link WHERE id = ?`, id);
  return r ? fromRow(r) : null;
}

/** The link between this shot and asset, whatever its status (one per pair). */
export function findLink(db: DbPort, shotId: string, assetId: string): ShotMediaLink | null {
  const r = db.get<LinkRow>(
    `SELECT ${COLS} FROM shot_media_link WHERE shot_id = ? AND media_asset_id = ? ORDER BY created_at, rowid LIMIT 1`,
    shotId,
    assetId,
  );
  return r ? fromRow(r) : null;
}

export function insertLink(db: DbPort, l: ShotMediaLink): void {
  const x = ShotMediaLink.parse(l);
  db.run(
    `INSERT INTO shot_media_link (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.shot_id,
    x.media_asset_id,
    x.take_id,
    JSON.stringify(SourceRange.parse(x.source_range)),
    x.evidence,
    x.status,
    x.confirmed_at,
    x.revision,
    x.created_at,
  );
}

export function updateLinkRow(db: DbPort, l: ShotMediaLink): void {
  const x = ShotMediaLink.parse(l);
  db.run(
    `UPDATE shot_media_link SET take_id = ?, source_range_json = ?, evidence = ?, status = ?, confirmed_at = ?, revision = ? WHERE id = ?`,
    x.take_id,
    JSON.stringify(SourceRange.parse(x.source_range)),
    x.evidence,
    x.status,
    x.confirmed_at,
    x.revision,
    x.id,
  );
}

/** Removes exactly one link row (INV-06). */
export function deleteLink(db: DbPort, id: string): void {
  db.run('DELETE FROM shot_media_link WHERE id = ?', id);
}
