import type { ArrowKind, Board, BoardArrow, FrameFormat, RenderMode, Silhouette } from '@storyscript/contracts';
import type { DepthBand, Facing8 } from './board-editor.ts';

/**
 * Chinese display labels for the board page (display-only; stored values stay
 * the contracts' English enums). `test/boards-labels.test.ts` checks that
 * every option has a label.
 */

/** Screen modes of the board canvas (topview has its own panel). */
export type BoardViewMode = Exclude<RenderMode, 'topview'>;

export const RENDER_MODE_LABEL: Record<RenderMode, string> = {
  pencil: '铅笔稿',
  structure: '结构线稿',
  topview: '俯视站位',
};

export const FACING8_LABEL: Record<Facing8, string> = {
  0: '面向镜头',
  45: '3/4 朝画右',
  90: '朝画右（侧面）',
  135: '3/4 背向 · 朝画右',
  180: '背向镜头',
  [-135]: '3/4 背向 · 朝画左',
  [-90]: '朝画左（侧面）',
  [-45]: '3/4 朝画左',
};

export const SILHOUETTE_LABEL: Record<Silhouette, string> = {
  regular: '常规',
  coat: '长外套',
  dress: '长裙',
};

export const DEPTH_BAND_LABEL: Record<DepthBand, string> = {
  fg: '前景',
  mg: '中景',
  bg: '后景',
};

/** z_override choices: null = by depth. */
export const LAYER_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: '按远近（自动）' },
  { value: 1, label: '压在最前' },
  { value: -1, label: '放到最后' },
];

/** tone_override choices (pencil fill darkness); null = from the depth band. */
export const TONE_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: '按景深（自动）' },
  { value: 1, label: '浅' },
  { value: 2, label: '中' },
  { value: 3, label: '深' },
];

export const ARROW_KIND_LABEL: Record<ArrowKind, string> = {
  subject_move: '人物运动',
  camera_move: '机位运动',
  eyeline: '视线',
};

export const ARROW_MODE_LABEL: Record<BoardArrow['mode'], string> = {
  anchored: '锚定在地面',
  free: '自由（贴在画面上）',
};

/** Aspect choices in the order of the inspector (widest first). */
export const ASPECTS: readonly FrameFormat[] = ['2.39', '2.20', '1.90', '1.78', '1.43'];

/** "v2 · 手动调整" / "v1 · 自动生成". */
export function versionLabel(b: Pick<Board, 'version' | 'user_edited'>): string {
  return `v${b.version} · ${b.user_edited ? '手动调整' : '自动生成'}`;
}

export function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const v = Math.round(s * 10) / 10;
  return `${v} 秒`;
}

export function formatFocal(mm: number): string {
  return `${Math.round(mm)}mm`;
}
