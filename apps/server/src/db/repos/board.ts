import { Board } from '@storyscript/contracts';
import { actorId, actorResolver } from '../../collab/actor.ts';
import type { DbPort } from '../port.ts';

/**
 * board ↔ contracts Board. One row per board version of a shot:
 * (shot_id, version) is unique, versions only grow, a row's spec never changes
 * after insert (edits create a new version). `revision` guards the few
 * in-place updates of the newest row (keep = re-baseline basis_content_hash).
 */

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

const COLS =
  'id, shot_id, version, parent_board_id, spec_json, renderer_version, basis_content_hash, user_edited, revision, created_at, actor_id';
const B_COLS = COLS.split(', ')
  .map((c) => `b.${c}`)
  .join(', ');

type Who = ReturnType<typeof actorResolver>;

function fromRow(r: BoardRow, who: Who): Board {
  return Board.parse({ ...r, spec: JSON.parse(r.spec_json), user_edited: r.user_edited === 1, actor: who(r.actor_id) });
}

export function insertBoard(db: DbPort, b: Board): void {
  const x = Board.parse(b);
  db.run(
    `INSERT INTO board (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.shot_id,
    x.version,
    x.parent_board_id,
    JSON.stringify(x.spec),
    x.renderer_version,
    x.basis_content_hash,
    x.user_edited ? 1 : 0,
    x.revision,
    x.created_at,
    actorId(),
  );
}

export function getBoard(db: DbPort, id: string): Board | null {
  const r = db.get<BoardRow>(`SELECT ${COLS} FROM board WHERE id = ?`, id);
  return r ? fromRow(r, actorResolver(db)) : null;
}

/** Newest version of a shot's board, or null when the shot has none yet. */
export function latestBoard(db: DbPort, shotId: string): Board | null {
  const r = db.get<BoardRow>(`SELECT ${COLS} FROM board WHERE shot_id = ? ORDER BY version DESC LIMIT 1`, shotId);
  return r ? fromRow(r, actorResolver(db)) : null;
}

/** Every version of a shot's board, oldest first. */
export function listShotBoards(db: DbPort, shotId: string): Board[] {
  const who = actorResolver(db);
  return db.all<BoardRow>(`SELECT ${COLS} FROM board WHERE shot_id = ? ORDER BY version`, shotId).map((r) => fromRow(r, who));
}

/** Newest version per shot, keyed by shot id (all shots, archived or not). */
export function latestBoardsByShot(db: DbPort): Map<string, Board> {
  const rows = db.all<BoardRow>(
    `SELECT ${B_COLS} FROM board b
       JOIN (SELECT shot_id, MAX(version) AS v FROM board GROUP BY shot_id) m
         ON m.shot_id = b.shot_id AND m.v = b.version`,
  );
  const who = actorResolver(db);
  return new Map(rows.map((r) => [r.shot_id, fromRow(r, who)]));
}

/** Re-baseline the newest row on the shot's current content (the "keep my edits" choice). */
export function updateBoardBasis(db: DbPort, id: string, basisContentHash: string, revision: number): void {
  db.run('UPDATE board SET basis_content_hash = ?, revision = ? WHERE id = ?', basisContentHash, revision, id);
}

/** Adopted AI raster of this board version (written by the M8 redraw flow; none before that). */
export function adoptedRasterId(db: DbPort, boardId: string): string | null {
  const r = db.get<{ id: string }>(
    "SELECT id FROM board_raster WHERE board_id = ? AND status = 'adopted' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    boardId,
  );
  return r?.id ?? null;
}
