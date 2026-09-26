import type { BoardView, FrameFormat, Scene, Shot } from '@storyscript/contracts';
import { formatFocal, formatSeconds } from './labels-boards.ts';
import { MOVEMENT_LABEL, SHOT_SIZE_LABEL } from './labels.ts';

/**
 * Board PDF (FR-10) — pure page model for the browser print view:
 *  - frames of aspect ≥ 2.2 print 3 per page, narrower ones 2 per page;
 *  - every scene starts a new page; a page never mixes the two densities;
 *  - header: project, scene, script version, "草案" unless every shot on the
 *    page is locked (定稿) and none of its boards is stale;
 *  - under each frame: shot code, action, dialogue, size · focal · movement, duration.
 */

export function framesPerPage(aspect: FrameFormat): 2 | 3 {
  return Number(aspect) >= 2.2 ? 3 : 2;
}

export interface BoardCaption {
  code: string;
  version: string;
  action: string;
  dialogue: string | null;
  /** "中景 · 40mm · 固定" */
  grammar: string;
  duration: string;
  stale: boolean;
  locked: boolean;
}

export function boardCaption(board: BoardView, shot: Shot | undefined): BoardCaption {
  const f = shot?.fields;
  const grammar = [f ? SHOT_SIZE_LABEL[f.shot_size] : null, formatFocal(board.spec.camera.focal_mm), f ? MOVEMENT_LABEL[f.movement] : null]
    .filter(Boolean)
    .join(' · ');
  return {
    code: board.shot_code,
    version: `v${board.version}`,
    action: f?.action.trim() || '—',
    dialogue: f?.dialogue_quote?.trim() || null,
    grammar,
    duration: f ? formatSeconds(f.est_seconds) : '—',
    stale: board.stale,
    locked: shot?.locked ?? false,
  };
}

export interface PrintCell {
  board: BoardView;
  caption: BoardCaption;
}

export interface PrintPage {
  /** 1-based, across the whole document */
  no: number;
  scene: { id: string; label: string };
  per: 2 | 3;
  cells: PrintCell[];
  draft: boolean;
}

export function sceneLabel(scene: Pick<Scene, 'display_no' | 'heading'> | undefined): string {
  if (!scene) return '其他场景';
  const no = scene.display_no.trim();
  return no ? `第 ${no} 场 · ${scene.heading}` : scene.heading;
}

/**
 * Boards in narrative order → pages. `sceneId` limits the document to one
 * scene (null = all). Boards are already ordered by the server (scene order,
 * then narrative order); scene order here follows first appearance.
 */
export function paginateBoards(
  boards: readonly BoardView[],
  shots: readonly Shot[],
  scenes: readonly Pick<Scene, 'id' | 'display_no' | 'heading'>[],
  sceneId: string | null = null,
): PrintPage[] {
  const shotById = new Map(shots.map((s) => [s.id, s]));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const pages: PrintPage[] = [];
  let cur: PrintPage | null = null;
  for (const board of boards) {
    if (sceneId && board.scene_id !== sceneId) continue;
    const per = framesPerPage(board.spec.frame.aspect);
    if (!cur || cur.scene.id !== board.scene_id || cur.per !== per || cur.cells.length >= per) {
      cur = { no: pages.length + 1, scene: { id: board.scene_id, label: sceneLabel(sceneById.get(board.scene_id)) }, per, cells: [], draft: true };
      pages.push(cur);
    }
    cur.cells.push({ board, caption: boardCaption(board, shotById.get(board.shot_id)) });
  }
  for (const p of pages) p.draft = !p.cells.every((c) => c.caption.locked && !c.caption.stale);
  return pages;
}

/** Topview pages: 3 shots per page (plan view + its frame), same scene grouping. */
export function paginateTopviews(boards: readonly BoardView[], shots: readonly Shot[], scenes: readonly Pick<Scene, 'id' | 'display_no' | 'heading'>[], sceneId: string | null = null, per = 3): PrintPage[] {
  const shotById = new Map(shots.map((s) => [s.id, s]));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const pages: PrintPage[] = [];
  let cur: PrintPage | null = null;
  for (const board of boards) {
    if (sceneId && board.scene_id !== sceneId) continue;
    if (!cur || cur.scene.id !== board.scene_id || cur.cells.length >= per) {
      cur = { no: pages.length + 1, scene: { id: board.scene_id, label: sceneLabel(sceneById.get(board.scene_id)) }, per: 3, cells: [], draft: true };
      pages.push(cur);
    }
    cur.cells.push({ board, caption: boardCaption(board, shotById.get(board.shot_id)) });
  }
  for (const p of pages) p.draft = !p.cells.every((c) => c.caption.locked && !c.caption.stale);
  return pages;
}

/** File name for a single-frame PNG: "<项目>-<镜号>-v2.png", filesystem-safe. */
export function pngFileName(projectName: string, code: string, version: number): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'board';
  return `${safe(projectName)}-${safe(code)}-v${version}.png`;
}
