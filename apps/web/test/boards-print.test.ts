import { describe, expect, it } from 'vitest';
import type { BoardSpec, BoardView, FrameFormat, Shot } from '@storyscript/contracts';
import { ArrowKind, FrameFormat as FrameFormatSchema, Silhouette } from '@storyscript/contracts';
import { STANDARD_SHOTS, standardBoard } from '@storyscript/core';
import { FACING8 } from '../src/lib/board-editor.ts';
import {
  ARROW_KIND_LABEL,
  ARROW_MODE_LABEL,
  ASPECTS,
  DEPTH_BAND_LABEL,
  FACING8_LABEL,
  formatSeconds,
  RENDER_MODE_LABEL,
  SILHOUETTE_LABEL,
  versionLabel,
} from '../src/lib/labels-boards.ts';
import { boardCaption, framesPerPage, paginateBoards, paginateTopviews, pngFileName, sceneLabel } from '../src/lib/print-boards.ts';
import { wrapText } from '../src/views/boards/exportPng.ts';

/**
 * Board PDF page model (FR-10): 3 frames per page at aspect ≥ 2.2, else 2;
 * scenes start new pages; 草案 unless every shot on the page is locked and
 * current; captions carry code, action, dialogue, size · focal · movement,
 * duration. Plus the label tables and the PNG caption wrapping.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SCENE_A = id(900);
const SCENE_B = id(901);
const base: BoardSpec = standardBoard(STANDARD_SHOTS.find((s) => s.key === '05-mcu')!);

function board(n: number, sceneId: string, aspect: FrameFormat = '2.39', stale = false): BoardView {
  return {
    id: id(n),
    shot_id: id(100 + n),
    version: 1,
    parent_board_id: null,
    spec: { ...base, frame: { ...base.frame, aspect } },
    renderer_version: 'board-m2.0',
    basis_content_hash: 'h',
    user_edited: false,
    revision: 0,
    created_at: '2026-09-26T00:00:00.000Z',
    stale,
    shot_code: String(n).padStart(3, '0'),
    scene_id: sceneId,
    adopted_raster_id: null,
  };
}

function shot(n: number, sceneId: string, locked = false): Shot {
  return {
    id: id(100 + n),
    scene_id: sceneId,
    code: String(n).padStart(3, '0'),
    narrative_pos: n,
    source_anchor: null,
    manual_note: 'x',
    origin: 'manual',
    fields: { ...STANDARD_SHOTS[4]!.fields, action: `动作 ${n}`, dialogue_quote: n === 1 ? '你好' : null, est_seconds: 3.5, movement: 'push_in' },
    locked,
    archived: false,
    required_status: 'required',
    requirement_reason: null,
    setup_id: null,
    needs_relink: false,
    content_hash: 'h',
    revision: 0,
    created_at: '2026-09-26T00:00:00.000Z',
    updated_at: '2026-09-26T00:00:00.000Z',
  };
}

const scenes = [
  { id: SCENE_A, display_no: '1', heading: '内景 旧书店 日' },
  { id: SCENE_B, display_no: '2', heading: '内景 后屋 日' },
];

describe('board PDF pages', () => {
  it('frames per page by aspect', () => {
    expect(framesPerPage('2.39')).toBe(3);
    expect(framesPerPage('2.20')).toBe(3);
    expect(framesPerPage('1.90')).toBe(2);
    expect(framesPerPage('1.78')).toBe(2);
    expect(framesPerPage('1.43')).toBe(2);
  });

  it('3 per page at 2.39, 2 per page at 1.78, scenes and densities never share a page', () => {
    const boards = [
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => board(n, SCENE_A)),
      board(8, SCENE_A, '1.78'),
      board(9, SCENE_A, '1.78'),
      board(10, SCENE_A, '1.78'),
      board(11, SCENE_B),
    ];
    const shots = boards.map((_, i) => shot(i + 1, i < 10 ? SCENE_A : SCENE_B));
    const pages = paginateBoards(boards, shots, scenes);
    expect(pages.map((p) => p.cells.map((c) => c.caption.code))).toEqual([
      ['001', '002', '003'],
      ['004', '005', '006'],
      ['007'],
      ['008', '009'],
      ['010'],
      ['011'],
    ]);
    expect(pages.map((p) => p.per)).toEqual([3, 3, 3, 2, 2, 3]);
    expect(pages.map((p) => p.no)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pages[5]!.scene.label).toBe('第 2 场 · 内景 后屋 日');
    // one scene only
    expect(paginateBoards(boards, shots, scenes, SCENE_B).map((p) => p.cells.length)).toEqual([1]);
    // topview pages: 3 shots each
    expect(paginateTopviews(boards, shots, scenes).map((p) => p.cells.length)).toEqual([3, 3, 3, 1, 1]);
  });

  it('草案 unless every shot on the page is locked and its board current', () => {
    const boards = [board(1, SCENE_A), board(2, SCENE_A), board(3, SCENE_A), board(4, SCENE_A), board(5, SCENE_A, '2.39', true)];
    const shots = [shot(1, SCENE_A, true), shot(2, SCENE_A, true), shot(3, SCENE_A, true), shot(4, SCENE_A, true), shot(5, SCENE_A, true)];
    const pages = paginateBoards(boards, shots, scenes);
    expect(pages.map((p) => p.draft)).toEqual([false, true]);
    shots[0] = shot(1, SCENE_A, false);
    expect(paginateBoards(boards, shots, scenes)[0]!.draft).toBe(true);
  });

  it('caption: code, version, action, dialogue, size · focal · movement, duration', () => {
    const c = boardCaption({ ...board(1, SCENE_A), version: 3 }, shot(1, SCENE_A));
    expect(c).toMatchObject({ code: '001', version: 'v3', action: '动作 1', dialogue: '你好', duration: '3.5 秒', stale: false, locked: false });
    expect(c.grammar).toBe(`中近景 · ${Math.round(base.camera.focal_mm)}mm · 推`);
    const bare = boardCaption(board(2, SCENE_A), undefined);
    expect(bare).toMatchObject({ action: '—', dialogue: null, duration: '—' });
    expect(sceneLabel(undefined)).toBe('其他场次');
  });

  it('PNG file names are filesystem-safe', () => {
    expect(pngFileName('周末 短片/试拍', '004', 2)).toBe('周末_短片_试拍-004-v2.png');
    expect(pngFileName('', '', 1)).toBe('board-board-v1.png');
  });
});

describe('labels', () => {
  it('every option has a Chinese label', () => {
    for (const f of FACING8) expect(FACING8_LABEL[f]).toBeTruthy();
    for (const s of Silhouette.options) expect(SILHOUETTE_LABEL[s]).toBeTruthy();
    for (const k of ArrowKind.options) expect(ARROW_KIND_LABEL[k]).toBeTruthy();
    for (const m of ['anchored', 'free'] as const) expect(ARROW_MODE_LABEL[m]).toBeTruthy();
    for (const b of ['fg', 'mg', 'bg'] as const) expect(DEPTH_BAND_LABEL[b]).toBeTruthy();
    for (const m of ['structure', 'pencil', 'topview'] as const) expect(RENDER_MODE_LABEL[m]).toBeTruthy();
    expect([...ASPECTS].sort()).toEqual([...FrameFormatSchema.options].sort());
    expect(versionLabel({ version: 2, user_edited: true })).toBe('v2 · 手动调整');
    expect(formatSeconds(0)).toBe('—');
  });

  it('no banned names in the board page vocabulary (CLEANROOM)', () => {
    const text = JSON.stringify([FACING8_LABEL, SILHOUETTE_LABEL, ARROW_KIND_LABEL, ARROW_MODE_LABEL, DEPTH_BAND_LABEL, RENDER_MODE_LABEL]);
    expect(text).not.toMatch(/IMAX|诺兰|Nolan/i);
  });
});

describe('PNG caption wrapping', () => {
  const measure = (s: string) => Array.from(s).length * 10;
  it('wraps CJK text by width and ellipsises past the last line', () => {
    expect(wrapText(measure, '一二三四五六七八九十', 50, 3)).toEqual(['一二三四五', '六七八九十']);
    expect(wrapText(measure, '一二三四五六七八九十甲乙', 50, 2)).toEqual(['一二三四五', '六七八九…']);
    expect(wrapText(measure, '  短  ', 50, 2)).toEqual(['短']);
  });
});
