/**
 * Tiny pure raster helpers for the pencil renderer: scanline polygon fill on a
 * coarse grid (hatch culling, union silhouettes) and marching-squares contour
 * tracing (the union outline of a puppet's overlapping parts). No IO.
 */
import { chaikin, type V2 } from './math.ts';

export interface Grid {
  /** columns / rows */
  w: number;
  h: number;
  /** px of the top-left grid corner */
  x0: number;
  y0: number;
  /** cell size (px) */
  cell: number;
  data: Float32Array;
}

/** Grid covering [x0, x1] × [y0, y1] (px) with square cells. */
export function makeGrid(x0: number, y0: number, x1: number, y1: number, cell: number): Grid {
  const w = Math.max(1, Math.ceil((x1 - x0) / cell));
  const h = Math.max(1, Math.ceil((y1 - y0) / cell));
  return { w, h, x0, y0, cell, data: new Float32Array(w * h) };
}

/**
 * Fill a simple polygon (even-odd) sampling cell centres. `value` may be a
 * constant or a function of the cell centre (continuous ground tone).
 */
export function fillPolygon(g: Grid, poly: readonly V2[], value: number | ((x: number, y: number) => number)): void {
  const n = poly.length;
  if (n < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const c = g.cell;
  const j0 = Math.max(0, Math.ceil((minY - g.y0) / c - 0.5));
  const j1 = Math.min(g.h - 1, Math.floor((maxY - g.y0) / c - 0.5));
  const xs: number[] = [];
  const fn = typeof value === 'function' ? value : null;
  const k = typeof value === 'number' ? value : 0;
  for (let j = j0; j <= j1; j++) {
    const y = g.y0 + (j + 0.5) * c;
    xs.length = 0;
    for (let i = 0, m = n - 1; i < n; m = i++) {
      const a = poly[m] as V2;
      const b = poly[i] as V2;
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row = j * g.w;
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil(((xs[q] as number) - g.x0) / c - 0.5));
      const i1 = Math.min(g.w - 1, Math.floor(((xs[q + 1] as number) - g.x0) / c - 0.5));
      for (let i = i0; i <= i1; i++) g.data[row + i] = fn ? fn(g.x0 + (i + 0.5) * c, y) : k;
    }
  }
}

/** Value at a px position (0 outside). */
export function sample(g: Grid, x: number, y: number): number {
  const i = Math.floor((x - g.x0) / g.cell);
  const j = Math.floor((y - g.y0) / g.cell);
  if (i < 0 || j < 0 || i >= g.w || j >= g.h) return 0;
  return g.data[j * g.w + i] as number;
}

/** px bounding box of cells with value > thr (null when none). */
export function bandBox(g: Grid, thr: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let i0 = Infinity;
  let j0 = Infinity;
  let i1 = -1;
  let j1 = -1;
  for (let j = 0; j < g.h; j++) {
    for (let i = 0; i < g.w; i++) {
      if ((g.data[j * g.w + i] as number) <= thr) continue;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
  }
  if (i1 < 0) return null;
  return { x0: g.x0 + i0 * g.cell, y0: g.y0 + j0 * g.cell, x1: g.x0 + (i1 + 1) * g.cell, y1: g.y0 + (j1 + 1) * g.cell };
}

/** Grey-level dilation (max over a (2r+1)² window), separable. */
export function dilate(g: Grid, r: number): Grid {
  if (r <= 0) return g;
  const { w, h } = g;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let m = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(w - 1, i + r); k++) m = Math.max(m, g.data[j * w + k] as number);
      tmp[j * w + i] = m;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let m = 0;
      for (let k = Math.max(0, j - r); k <= Math.min(h - 1, j + r); k++) m = Math.max(m, tmp[k * w + i] as number);
      out[j * w + i] = m;
    }
  }
  return { ...g, data: out };
}

// Marching squares segment table: corners TL=8, TR=4, BR=2, BL=1; edges T R B L.
// Saddles (5, 10) are resolved as separate blobs.
type Edge = 0 | 1 | 2 | 3;
const MS: readonly (readonly [Edge, Edge][])[] = [
  [],
  [[3, 2]],
  [[2, 1]],
  [[3, 1]],
  [[0, 1]],
  [
    [0, 1],
    [3, 2],
  ],
  [[0, 2]],
  [[0, 3]],
  [[0, 3]],
  [[0, 2]],
  [
    [0, 3],
    [2, 1],
  ],
  [[0, 1]],
  [[3, 1]],
  [[2, 1]],
  [[3, 2]],
  [],
];

/**
 * Boundary loops of the region `value > threshold` (outside the grid counts as
 * empty), smoothed and returned in px. Loops shorter than `minLen` are dropped.
 */
export function traceLoops(g: Grid, threshold = 0.5, smooth = 2, minLen = 0): V2[][] {
  const { w, h } = g;
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && (g.data[j * w + i] as number) > threshold;
  // Edge midpoints in half-cell units: block (i, j) spans cell centres (i, j)…(i+1, j+1).
  const W2 = 2 * w + 4;
  const key = (X: number, Y: number) => (Y + 2) * W2 + (X + 2);
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const la = adj.get(a);
    if (la) la.push(b);
    else adj.set(a, [b]);
    const lb = adj.get(b);
    if (lb) lb.push(a);
    else adj.set(b, [a]);
  };
  const mid = (i: number, j: number, e: Edge): number => {
    switch (e) {
      case 0:
        return key(2 * i + 2, 2 * j + 1);
      case 1:
        return key(2 * i + 3, 2 * j + 2);
      case 2:
        return key(2 * i + 2, 2 * j + 3);
      default:
        return key(2 * i + 1, 2 * j + 2);
    }
  };
  for (let j = -1; j < h; j++) {
    for (let i = -1; i < w; i++) {
      const c = (inside(i, j) ? 8 : 0) | (inside(i + 1, j) ? 4 : 0) | (inside(i + 1, j + 1) ? 2 : 0) | (inside(i, j + 1) ? 1 : 0);
      for (const [a, b] of MS[c] as readonly [Edge, Edge][]) link(mid(i, j, a), mid(i, j, b));
    }
  }
  const toPx = (k: number): V2 => {
    const X = (k % W2) - 2;
    const Y = Math.floor(k / W2) - 2;
    return [g.x0 + (X * g.cell) / 2, g.y0 + (Y * g.cell) / 2];
  };
  const seen = new Set<number>();
  const loops: V2[][] = [];
  const keys = [...adj.keys()].sort((a, b) => a - b);
  for (const start of keys) {
    if (seen.has(start)) continue;
    const loop: number[] = [start];
    seen.add(start);
    let prev = -1;
    let cur = start;
    for (;;) {
      const nb = adj.get(cur) ?? [];
      const next = nb[0] !== prev && !(nb[0] === undefined) ? (nb[0] as number) : (nb[1] ?? -1);
      if (next < 0 || next === start || seen.has(next)) break;
      seen.add(next);
      loop.push(next);
      prev = cur;
      cur = next;
    }
    if (loop.length < 4) continue;
    let pts = loop.map(toPx);
    if (smooth > 0) pts = chaikin(pts, smooth);
    pts = simplifyClosed(pts, g.cell * 0.18);
    let len = 0;
    for (let q = 0; q < pts.length; q++) {
      const a = pts[q] as V2;
      const b = pts[(q + 1) % pts.length] as V2;
      len += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (len >= minLen) loops.push(pts);
  }
  return loops;
}

/** Ramer–Douglas–Peucker on an open polyline. */
export function simplify(pts: readonly V2[], tol: number): V2[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const pa = pts[a] as V2;
    const pb = pts[b] as V2;
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const L = Math.hypot(dx, dy) || 1e-9;
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i] as V2;
      const d = Math.abs((p[0] - pa[0]) * dy - (p[1] - pa[1]) * dx) / L;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol && bi > 0) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyClosed(pts: readonly V2[], tol: number): V2[] {
  if (pts.length < 8) return pts.slice();
  const half = Math.floor(pts.length / 2);
  const a = simplify(pts.slice(0, half + 1), tol);
  const b = simplify([...pts.slice(half), pts[0] as V2], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
