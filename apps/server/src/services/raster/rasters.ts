import type { BoardRaster, RasterView } from '@storyscript/contracts';
import { structureHash } from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import { demoteAdopted, getRaster, listBoardRasters, readBoard, readLatestShotBoard, setRasterStatus } from '../../db/repos/raster.ts';
import { AppError } from '../../http/errors.ts';
import { projectBoardFile } from './storage.ts';

/**
 * Candidates of a board, adopt / reject. A raster is stale when the board's
 * current structure (the shot's latest board version) no longer hashes to the
 * raster's structure_hash. Adopting touches board_raster rows only: never
 * board.spec, never shot.fields (INV-09).
 */

export const rasterImageUrl = (id: string) => `/api/v1/rasters/${id}/image`;

function currentStructureHash(db: DbPort, boardId: string): string | null {
  const board = readBoard(db, boardId);
  if (!board) return null;
  const latest = readLatestShotBoard(db, board.shot_id) ?? board;
  return structureHash(latest.spec);
}

function toView(r: BoardRaster, current: string | null): RasterView {
  return { ...r, image_url: r.file ? rasterImageUrl(r.id) : null, stale: current === null || r.structure_hash !== current };
}

export function listRasters(db: DbPort, boardId: string): RasterView[] {
  if (!readBoard(db, boardId)) throw new AppError('NOT_FOUND', '分镜不存在', 404);
  const current = currentStructureHash(db, boardId);
  return listBoardRasters(db, boardId).map((r) => toView(r, current));
}

function requireRaster(db: DbPort, id: string): BoardRaster {
  const r = getRaster(db, id);
  if (!r) throw new AppError('NOT_FOUND', 'AI 候选图不存在', 404);
  return r;
}

export function rasterView(db: DbPort, id: string): RasterView {
  const r = requireRaster(db, id);
  return toView(r, currentStructureHash(db, r.board_id));
}

/** Human adoption: this raster becomes the board's adopted one; others go back to candidate. */
export function adoptRaster(db: DbPort, id: string): RasterView {
  db.tx(() => {
    const r = requireRaster(db, id);
    if (!r.file) throw new AppError('VALIDATION_ERROR', '这条记录没有可用的图像（被拒绝、结果未知或后处理失败），不能采用', 409, { outcome: r.outcome });
    demoteAdopted(db, r.board_id, r.id);
    if (r.status !== 'adopted') setRasterStatus(db, r.id, 'adopted');
  });
  return rasterView(db, id);
}

export function rejectRaster(db: DbPort, id: string): RasterView {
  db.tx(() => {
    const r = requireRaster(db, id);
    if (r.status !== 'rejected') setRasterStatus(db, r.id, 'rejected');
  });
  return rasterView(db, id);
}

export async function rasterImageFile(db: DbPort, projectDir: string, id: string): Promise<{ path: string; size: number }> {
  const r = requireRaster(db, id);
  if (!r.file) throw new AppError('NOT_FOUND', '这条记录没有图像', 404);
  return projectBoardFile(projectDir, r.file);
}
