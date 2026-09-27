import type { BoardSpec } from '@storyscript/contracts';
import { contentHash, frameSize, renderBoard, structureHash } from '@storyscript/core';

/**
 * Layers drawn over an AI raster (FR-12): the vector annotation layer on its
 * own (badges, arrows, labels, shot code, guides — taken from the pencil
 * renderer's output, so it matches the pencil frame exactly) and the
 * "AI 生成" corner mark. Both live in frame units (1840 wide), like the
 * raster itself after the server's post-processing, so they stay aligned.
 */

/** Pencil frame line (core pencil.ts draws the same one under the overlay). */
const FRAME_LINE = '#161616';

/**
 * The annotation group of a full pencil SVG, re-wrapped in the same <svg>
 * root with the frame line under it. The renderer appends the group last
 * (`<g data-layer="overlay" …>` … right before `</svg>`), and it uses no defs.
 */
export function overlayOnlySvg(pencilSvg: string, spec: BoardSpec): string {
  const { W, H } = frameSize(spec.frame.aspect);
  const open = pencilSvg.slice(0, pencilSvg.indexOf('>') + 1);
  const at = pencilSvg.lastIndexOf('<g data-layer="overlay"');
  const end = pencilSvg.lastIndexOf('</svg>');
  const overlay = at >= 0 && end > at ? pencilSvg.slice(at, end) : '';
  const frame = `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" fill="none" stroke="${FRAME_LINE}" stroke-width="4"/>`;
  return `${open}${frame}${overlay}</svg>`;
}

export function renderOverlayOnly(spec: BoardSpec, code: string | null): string {
  return overlayOnlySvg(renderBoard(spec, 'pencil', { overlay: true, code }), spec);
}

// Blob URLs of overlay-only renders, keyed like images.ts (picture hash +
// overlay hash + code). Small LRU; the oldest URLs are revoked.
const MAX_URLS = 24;
const cache = new Map<string, string>();

export function overlayKey(spec: BoardSpec, code: string | null): string {
  return ['overlay-only', structureHash(spec), contentHash(spec.overlay), spec.frame.aspect, code ?? ''].join('|');
}

export function overlayOnlyUrl(spec: BoardSpec, code: string | null): string {
  const key = overlayKey(spec, code);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const url = URL.createObjectURL(new Blob([renderOverlayOnly(spec, code)], { type: 'image/svg+xml' }));
  cache.set(key, url);
  while (cache.size > MAX_URLS) {
    const first = cache.entries().next().value;
    if (!first) break;
    cache.delete(first[0]);
    URL.revokeObjectURL(first[1]);
  }
  return url;
}

// ------------------------------------------------------------ corner mark

export const AI_BADGE_TEXT = 'AI 生成';

export interface BadgeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** font size and baseline, frame units */
  font: number;
  baseline: number;
  /** text start */
  tx: number;
}

/** Rough advance width, same rule as the pencil labels: CJK ≈ 1 em, others ≈ 0.62 em. */
function advance(t: string, size: number): number {
  let w = 0;
  for (const ch of t) w += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? size : size * 0.62;
  return w;
}

/**
 * Top-left corner mark in frame units. The pencil overlay puts the shot code
 * on a paper tab at the top-left (baseline 44, 30 px, shifted by the overlay
 * offset); the mark sits under it when the code is shown, else in the corner.
 */
export function aiBadgeBox(spec: BoardSpec, code: string | null, text: string = AI_BADGE_TEXT): BadgeBox {
  const { W, H } = frameSize(spec.frame.aspect);
  const font = 24;
  const padX = 10;
  const h = 36;
  const w = advance(text, font) + padX * 2;
  const codeShown = spec.overlay.show_code && !!code;
  const x = 14;
  let y = 14;
  if (codeShown) {
    // code tab bottom ≈ 44 + 30·0.14 + 30·0.22 ≈ 55, plus the overlay offset
    const tabBottom = 56 + Math.max(0, spec.overlay.offset.y * H);
    const tabLeftShift = spec.overlay.offset.x * W;
    // the tab moved far right or down: the corner is free again
    y = tabLeftShift > w + 20 || tabBottom > H * 0.5 ? 14 : Math.round(tabBottom + 8);
  }
  return { x, y, w: Math.round(w * 100) / 100, h, font, baseline: y + h / 2 + font * 0.36, tx: x + padX };
}
