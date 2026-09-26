import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Board, BoardRevisionInput, BoardSpec, BoardView, SaveBoardInput, Shot } from '@storyscript/contracts';
import { layoutBoard, RENDERER_VERSION } from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import { adoptedRasterId, getBoard, insertBoard, latestBoard, latestBoardsByShot, listShotBoards, updateBoardBasis } from '../../db/repos/board.ts';
import { listActiveShots } from '../../db/repos/shot.ts';
import { AppError } from '../../http/errors.ts';
import { requireShot } from '../shots.ts';
import { layoutContextFor, projectBoardContext, type ProjectBoardContext } from './context.ts';

/**
 * Boards (FR-04). A shot's board is a chain of immutable versions:
 *  - v1 is laid out automatically when the shot is created (same transaction);
 *  - regenerate lays out again from the shot's current fields (user_edited=false);
 *  - save stores the user's edited spec as a new version (user_edited=true) and
 *    keeps the parent's basis_content_hash, so a stale board stays stale;
 *  - keep re-baselines the newest version on the shot's current content_hash
 *    ("保留我的调整"), bumping its revision.
 * A board is stale when basis_content_hash ≠ shot.content_hash. Board edits
 * never touch the shot (INV-09 precondition: the structure layer stays apart).
 * Every write happens inside db.tx and returns only after it committed.
 */

type Input<S extends z.ZodType> = z.infer<S>;

function layoutFor(shot: Shot, pc: ProjectBoardContext): BoardSpec {
  return layoutBoard(shot.fields, layoutContextFor(shot, pc));
}

function newBoard(shot: Shot, spec: BoardSpec, prev: Board | null, userEdited: boolean, basis: string, now: string): Board {
  return {
    id: randomUUID(),
    shot_id: shot.id,
    version: (prev?.version ?? 0) + 1,
    parent_board_id: prev?.id ?? null,
    spec,
    renderer_version: RENDERER_VERSION,
    basis_content_hash: basis,
    user_edited: userEdited,
    revision: 0,
    created_at: now,
  };
}

/**
 * Lay out v1 for shots that have no board yet. Called by shot creation and
 * breakdown apply inside their transaction. A shot the layout cannot handle is
 * skipped (it never blocks creating the shot); listBoards retries lazily.
 */
export function ensureBoard(db: DbPort, shots: Shot | readonly Shot[], now = new Date().toISOString()): void {
  const list: readonly Shot[] = Array.isArray(shots) ? (shots as readonly Shot[]) : [shots as Shot];
  if (list.length === 0) return;
  db.tx(() => {
    const pc = projectBoardContext(db);
    for (const shot of list) ensureOne(db, shot, pc, now);
  });
}

/** Pass-through for the create-shot route: `db.tx(() => ensuringBoard(db, createShot(…)))`. */
export function ensuringBoard(db: DbPort, shot: Shot): Shot {
  ensureBoard(db, shot);
  return shot;
}

/** Pass-through for the breakdown apply route: boards for every created shot, same transaction. */
export function ensuringBoards<T extends { created: readonly Shot[] }>(db: DbPort, result: T): T {
  ensureBoard(db, result.created);
  return result;
}

function ensureOne(db: DbPort, shot: Shot, pc: ProjectBoardContext, now: string): Board | null {
  const existing = latestBoard(db, shot.id);
  if (existing) return existing;
  let spec: BoardSpec;
  try {
    spec = layoutFor(shot, pc);
  } catch {
    return null;
  }
  const board = newBoard(shot, spec, null, false, shot.content_hash, now);
  insertBoard(db, board);
  return board;
}

export function toView(db: DbPort, board: Board, shot: Shot): BoardView {
  return {
    ...board,
    stale: board.basis_content_hash !== shot.content_hash,
    shot_code: shot.code,
    scene_id: shot.scene_id,
    adopted_raster_id: adoptedRasterId(db, board.id),
  };
}

/** Newest board of every non-archived shot in narrative order; missing v1s are laid out now. */
export function listBoards(db: DbPort, now = new Date().toISOString()): BoardView[] {
  const shots = listActiveShots(db);
  let latest = latestBoardsByShot(db);
  if (shots.some((s) => !latest.has(s.id))) {
    db.tx(() => {
      const pc = projectBoardContext(db);
      for (const s of shots) if (!latest.has(s.id)) ensureOne(db, s, pc, now);
    });
    latest = latestBoardsByShot(db);
  }
  const out: BoardView[] = [];
  for (const s of shots) {
    const b = latest.get(s.id);
    if (b) out.push(toView(db, b, s));
  }
  return out;
}

export function shotBoardVersions(db: DbPort, shotId: string): Board[] {
  requireShot(db, shotId);
  return listShotBoards(db, shotId);
}

function requireWritableShot(db: DbPort, shotId: string): Shot {
  const shot = requireShot(db, shotId);
  if (shot.archived) throw new AppError('VALIDATION_ERROR', '镜头已归档，不能修改分镜', 409, { shot_id: shot.id });
  return shot;
}

function requireBoard(db: DbPort, id: string): Board {
  const b = getBoard(db, id);
  if (!b) throw new AppError('NOT_FOUND', '分镜不存在', 404);
  return b;
}

/**
 * The board being written must be the shot's newest version and carry the
 * revision the client last saw; anything else is a concurrent edit (409).
 */
function requireLatest(db: DbPort, board: Board, expected: number): Board {
  const latest = latestBoard(db, board.shot_id)!;
  if (latest.id !== board.id || latest.revision !== expected) {
    throw new AppError('REVISION_CONFLICT', '分镜已有更新的版本，请刷新后再保存', 409, {
      board_id: board.id,
      latest_board_id: latest.id,
      latest_version: latest.version,
      expected_revision: expected,
      current_revision: latest.revision,
    });
  }
  return latest;
}

/** New version laid out from the shot's current fields (manual edits are dropped). */
export function regenerateBoard(db: DbPort, shotId: string, now = new Date().toISOString()): BoardView {
  return db.tx(() => {
    const shot = requireWritableShot(db, shotId);
    const prev = latestBoard(db, shot.id);
    let spec: BoardSpec;
    try {
      spec = layoutFor(shot, projectBoardContext(db));
    } catch (e) {
      throw new AppError('VALIDATION_ERROR', `无法按镜头字段生成分镜：${e instanceof Error ? e.message : String(e)}`, 422);
    }
    const board = newBoard(shot, spec, prev, false, shot.content_hash, now);
    insertBoard(db, board);
    return toView(db, board, shot);
  });
}

/** The user's edited spec as a new version; basis stays the parent's (stale stays stale). */
export function saveBoard(db: DbPort, boardId: string, input: Input<typeof SaveBoardInput>, now = new Date().toISOString()): BoardView {
  return db.tx(() => {
    const board = requireBoard(db, boardId);
    const shot = requireWritableShot(db, board.shot_id);
    const latest = requireLatest(db, board, input.expected_revision);
    const next = newBoard(shot, input.spec, latest, true, latest.basis_content_hash, now);
    insertBoard(db, next);
    return toView(db, next, shot);
  });
}

/** "保留我的调整": the newest version is re-based on the shot's current content. */
export function keepBoard(db: DbPort, boardId: string, input: Input<typeof BoardRevisionInput>): BoardView {
  return db.tx(() => {
    const board = requireBoard(db, boardId);
    const shot = requireWritableShot(db, board.shot_id);
    const latest = requireLatest(db, board, input.expected_revision);
    const next: Board = { ...latest, basis_content_hash: shot.content_hash, revision: latest.revision + 1 };
    updateBoardBasis(db, next.id, next.basis_content_hash, next.revision);
    return toView(db, next, shot);
  });
}
