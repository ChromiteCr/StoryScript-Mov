import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { CanvasPlan } from '@storyscript/core';
import { AppError } from '../../http/errors.ts';

/**
 * Raster files live in <project>/boards/<board_id>/ (SPEC §3):
 *   raster-<id>.png   post-processed image (served to the app)
 *   raster-<id>.json  sidecar: provenance, request, usage, crop parameters
 *   raw-<id>.<ext>    the image exactly as returned
 *   control-<id>.png  the control image that was sent
 * Paths in rows and sidecars are project-relative with "/" separators.
 */

export const rasterFileRel = (boardId: string, id: string) => `boards/${boardId}/raster-${id}.png`;
export const sidecarRel = (boardId: string, id: string) => `boards/${boardId}/raster-${id}.json`;
export const rawFileRel = (boardId: string, id: string, ext: string) => `boards/${boardId}/raw-${id}.${ext}`;
export const controlFileRel = (boardId: string, id: string) => `boards/${boardId}/control-${id}.png`;

export const absPath = (projectDir: string, rel: string) => join(projectDir, ...rel.split('/'));

/** Atomic write (tmp + rename) inside the project. */
export function writeProjectFile(projectDir: string, rel: string, data: Uint8Array | string): void {
  const path = absPath(projectDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export const SIDECAR_SCHEMA = 'storyscript-mov/raster-sidecar@1';

export interface RasterSidecar {
  schema: typeof SIDECAR_SCHEMA;
  raster_id: string;
  board_id: string;
  board_version: number;
  shot_id: string;
  job_id: string;
  created_at: string;
  source_type: 'model_generated';
  ai_label: true;
  outcome: 'ok' | 'refused' | 'outcome_unknown' | 'late_after_cancel';
  provider: {
    dialect: 'openai-edits' | 'generations-ref';
    host: string;
    model: string;
    preset_id: string | null;
    preset_verified: boolean;
  };
  request: {
    size: string;
    /** what the user picked */
    requested_quality: string;
    /** what was sent (null: the dialect has no quality parameter) */
    quality: string | null;
    n: 1;
    prompt_version: string;
    prompt_lang: string;
    prompt_hash: string;
    prompt: string;
    removed_terms: string[];
    optional_params_stripped: boolean;
    attempts: number;
    cache_key: string;
  };
  structure_hash: string;
  control: { mode: string; sha256: string; file: string; width: number; height: number };
  reference: null;
  canvas: CanvasPlan;
  raw: { file: string; sha256: string; mime: string; width: number | null; height: number | null; delivery: 'b64' | 'url' } | null;
  output: { file: string; sha256: string; width: number; height: number; post_version: string } | null;
  postprocess_error: string | null;
  usage: Record<string, number> | null;
  error: { code: string; message: string } | null;
}

function isInside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r !== '' && !r.startsWith('..') && !r.startsWith(sep) && !r.includes(`..${sep}`);
}

/** A raster file inside <project>/boards (realpath-checked). */
export async function projectBoardFile(projectDir: string, rel: string): Promise<{ path: string; size: number }> {
  const allowed = await realpath(join(projectDir, 'boards')).catch(() => null);
  const real = await realpath(absPath(projectDir, rel)).catch(() => null);
  if (!allowed || !real) throw new AppError('NOT_FOUND', '图像文件不存在', 404);
  if (!isInside(allowed, real)) throw new AppError('PATH_NOT_ALLOWED', '图像路径不在项目的 boards 目录内', 403);
  const s = await stat(real);
  if (!s.isFile()) throw new AppError('NOT_FOUND', '图像文件不存在', 404);
  return { path: real, size: s.size };
}
