import { Board, BoardRaster, type RasterStatus } from '@storyscript/contracts';
import type { z } from 'zod';
import { actorId, actorResolver } from '../../collab/actor.ts';
import type { DbPort } from '../port.ts';

/**
 * board_raster ↔ contracts BoardRaster, plus the read-only board lookups the
 * redraw pipeline needs (the board table itself belongs to the M4 board
 * repo; nothing here writes to it — INV-09).
 */

interface RasterRow {
  id: string;
  board_id: string;
  structure_hash: string;
  dialect: string;
  host: string;
  model: string;
  preset_id: string | null;
  size: string;
  quality: string | null;
  prompt_hash: string;
  control_sha256: string;
  file: string | null;
  sha256: string | null;
  status: string;
  outcome: string;
  usage_json: string | null;
  ai_label_on: number;
  source_type: string;
  created_at: string;
  actor_id: string | null;
}

const COLS =
  'id, board_id, structure_hash, dialect, host, model, preset_id, size, quality, prompt_hash, control_sha256, file, sha256, status, outcome, usage_json, ai_label_on, source_type, created_at, actor_id';

type Who = ReturnType<typeof actorResolver>;

function fromRow(r: RasterRow, who: Who): BoardRaster {
  return BoardRaster.parse({
    ...r,
    usage: r.usage_json === null ? null : JSON.parse(r.usage_json),
    ai_label_on: r.ai_label_on === 1,
    actor: who(r.actor_id),
  });
}

export function insertRaster(db: DbPort, raster: BoardRaster): void {
  const x = BoardRaster.parse(raster);
  db.run(
    `INSERT INTO board_raster (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.board_id,
    x.structure_hash,
    x.dialect,
    x.host,
    x.model,
    x.preset_id,
    x.size,
    x.quality,
    x.prompt_hash,
    x.control_sha256,
    x.file,
    x.sha256,
    x.status,
    x.outcome,
    x.usage === null ? null : JSON.stringify(x.usage),
    x.ai_label_on ? 1 : 0,
    x.source_type,
    x.created_at,
    actorId(),
  );
}

export function getRaster(db: DbPort, id: string): BoardRaster | null {
  const r = db.get<RasterRow>(`SELECT ${COLS} FROM board_raster WHERE id = ?`, id);
  return r ? fromRow(r, actorResolver(db)) : null;
}

/** Newest first. */
export function listBoardRasters(db: DbPort, boardId: string): BoardRaster[] {
  const who = actorResolver(db);
  return db
    .all<RasterRow>(`SELECT ${COLS} FROM board_raster WHERE board_id = ? ORDER BY created_at DESC, rowid DESC`, boardId)
    .map((r) => fromRow(r, who));
}

export function countRasters(db: DbPort): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM board_raster')?.n ?? 0;
}

export function setRasterStatus(db: DbPort, id: string, status: z.infer<typeof RasterStatus>): void {
  db.run('UPDATE board_raster SET status = ? WHERE id = ?', status, id);
}

/** Every other adopted raster of the board goes back to candidate. */
export function demoteAdopted(db: DbPort, boardId: string, exceptId: string): void {
  db.run(`UPDATE board_raster SET status = 'candidate' WHERE board_id = ? AND status = 'adopted' AND id <> ?`, boardId, exceptId);
}

/** Adopted raster of a board (for BoardView.adopted_raster_id), or null. */
export function adoptedRasterId(db: DbPort, boardId: string): string | null {
  return db.get<{ id: string }>(`SELECT id FROM board_raster WHERE board_id = ? AND status = 'adopted' ORDER BY created_at DESC LIMIT 1`, boardId)?.id ?? null;
}

// ---------------------------------------------------------------------------
// board (read-only)
// ---------------------------------------------------------------------------

interface BoardRow {
  id: string;
  shot_id: string;
  version: number;
  parent_board_id: string | null;
  spec_json: string;
  renderer_version: string;
  basis_content_hash: string;
  user_edited: number;
  revision: number;
  created_at: string;
  actor_id: string | null;
}

const BOARD_COLS =
  'id, shot_id, version, parent_board_id, spec_json, renderer_version, basis_content_hash, user_edited, revision, created_at, actor_id';

function boardFromRow(r: BoardRow, who: Who): Board {
  return Board.parse({ ...r, spec: JSON.parse(r.spec_json), user_edited: r.user_edited === 1, actor: who(r.actor_id) });
}

export function readBoard(db: DbPort, id: string): Board | null {
  const r = db.get<BoardRow>(`SELECT ${BOARD_COLS} FROM board WHERE id = ?`, id);
  return r ? boardFromRow(r, actorResolver(db)) : null;
}

/** The shot's current board: highest version. */
export function readLatestShotBoard(db: DbPort, shotId: string): Board | null {
  const r = db.get<BoardRow>(`SELECT ${BOARD_COLS} FROM board WHERE shot_id = ? ORDER BY version DESC LIMIT 1`, shotId);
  return r ? boardFromRow(r, actorResolver(db)) : null;
}

// ---------------------------------------------------------------------------
// kv side records (no new columns)
// ---------------------------------------------------------------------------

export function kvRead<T>(db: DbPort, key: string): T | null {
  const r = db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key = ?', key);
  if (!r) return null;
  try {
    return JSON.parse(r.value_json) as T;
  } catch {
    return null;
  }
}

export function kvWrite(db: DbPort, key: string, value: unknown, now: string): void {
  db.run(
    'INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    key,
    JSON.stringify(value),
    now,
  );
}
