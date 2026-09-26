/**
 * Procedural paper for the pencil board: a neutral-grey ground, two grain
 * tiles (short fibres + specks, fixed seed, inlined as <pattern>s with coprime
 * sizes so the repeat does not show) laid over the drawing with low-opacity
 * dark grey (a cheap multiply), and a soft vignette. No external files; the
 * tile is original, program-generated content.
 */
import { rngFor } from '../util/random.ts';
import type { V2 } from './math.ts';
import { attrs, el, gray, num } from './svg.ts';

const GRAIN_SEED = 0x9a9e5;

function grainTile(id: string, size: number, key: string, strength: number): string {
  const rng = rngFor(GRAIN_SEED, key);
  // bucket marks by opacity so the tile is a handful of paths
  const buckets: string[][] = [[], [], []];
  const fibreCount = Math.round((size * size) / 380);
  for (let i = 0; i < fibreCount; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = 3 + rng() * 11;
    const a = rng() * Math.PI;
    const bend = (rng() - 0.5) * len * 0.5;
    const ex = x + Math.cos(a) * len;
    const ey = y + Math.sin(a) * len;
    const mx = (x + ex) / 2 - Math.sin(a) * bend;
    const my = (y + ey) / 2 + Math.cos(a) * bend;
    (buckets[Math.floor(rng() * 3)] as string[]).push(`M${num(x)} ${num(y)}Q${num(mx)} ${num(my)} ${num(ex)} ${num(ey)}`);
  }
  const specks: string[] = [];
  const speckCount = Math.round((size * size) / 160);
  for (let i = 0; i < speckCount; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 0.35 + rng() * 0.6;
    const p: V2[] = [
      [x - r, y],
      [x, y - r],
      [x + r, y],
      [x, y + r],
    ];
    specks.push(`M${num(p[0]![0])} ${num(p[0]![1])}L${num(p[1]![0])} ${num(p[1]![1])}L${num(p[2]![0])} ${num(p[2]![1])}L${num(p[3]![0])} ${num(p[3]![1])}Z`);
  }
  const ops = [0.05, 0.08, 0.11];
  let body = '';
  buckets.forEach((b, i) => {
    if (b.length)
      body += el('path', {
        d: b.join(''),
        fill: 'none',
        stroke: gray(70),
        'stroke-width': 0.7,
        'stroke-opacity': Math.min(1, (ops[i] as number) * strength),
        'stroke-linecap': 'round',
      });
  });
  if (specks.length) body += el('path', { d: specks.join(''), fill: gray(60), 'fill-opacity': Math.min(1, 0.09 * strength) });
  return `<pattern${attrs({ id, patternUnits: 'userSpaceOnUse', x: 0, y: 0, width: size, height: size })}>${body}</pattern>`;
}

export interface PaperIds {
  grainA: string;
  grainB: string;
  vignette: string;
}

export function paperIds(prefix: string): PaperIds {
  return { grainA: `${prefix}-ga`, grainB: `${prefix}-gb`, vignette: `${prefix}-vg` };
}

/** <defs> content for the paper layers (empty when both are off). */
export function paperDefs(ids: PaperIds, grain: number, vignette: number): string {
  let out = '';
  if (grain > 0) out += grainTile(ids.grainA, 331, 'grain-a', grain);
  if (vignette > 0)
    out +=
      `<radialGradient${attrs({ id: ids.vignette, cx: 0.5, cy: 0.5, r: 0.72 })}>` +
      el('stop', { offset: 0.5, 'stop-color': gray(0), 'stop-opacity': 0 }) +
      el('stop', { offset: 0.8, 'stop-color': gray(0), 'stop-opacity': vignette * 0.45 }) +
      el('stop', { offset: 1, 'stop-color': gray(0), 'stop-opacity': vignette }) +
      '</radialGradient>';
  return out;
}

/** Grain + vignette rects laid over the drawing. */
export function paperOverlay(ids: PaperIds, W: number, H: number, grain: number, vignette: number): string {
  let out = '';
  if (grain > 0) {
    out += el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${ids.grainA})` });
  }
  if (vignette > 0) out += el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${ids.vignette})` });
  return out;
}
