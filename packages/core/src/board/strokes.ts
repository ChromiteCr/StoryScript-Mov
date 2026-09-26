/**
 * Pencil stroke geometry: every mark is a filled polygon (tapered ends, width
 * varying along the stroke) rather than an even-width SVG stroke. Pure; all
 * randomness comes from the caller's per-element RNG.
 */
import type { V2 } from './math.ts';
import { num } from './svg.ts';

export type Rng = () => number;

/** Uniform in [-1, 1). */
export const sym = (rng: Rng): number => rng() * 2 - 1;

export function polylineLength(pts: readonly V2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot((pts[i] as V2)[0] - (pts[i - 1] as V2)[0], (pts[i] as V2)[1] - (pts[i - 1] as V2)[1]);
  return L;
}

/** Resample a polyline at ~`step` px arc-length spacing (≥ `minN` points). */
export function resample(pts: readonly V2[], step: number, minN = 2): V2[] {
  const L = polylineLength(pts);
  const n = Math.max(minN, Math.ceil(L / step) + 1);
  if (pts.length < 2 || L < 1e-9) return pts.slice();
  const out: V2[] = [];
  let seg = 0;
  let acc = 0;
  let segLen = Math.hypot((pts[1] as V2)[0] - (pts[0] as V2)[0], (pts[1] as V2)[1] - (pts[0] as V2)[1]);
  for (let k = 0; k < n; k++) {
    const s = (L * k) / (n - 1);
    while (seg < pts.length - 2 && acc + segLen < s) {
      acc += segLen;
      seg++;
      segLen = Math.hypot((pts[seg + 1] as V2)[0] - (pts[seg] as V2)[0], (pts[seg + 1] as V2)[1] - (pts[seg] as V2)[1]);
    }
    const a = pts[seg] as V2;
    const b = pts[seg + 1] as V2;
    const t = segLen > 1e-9 ? Math.min(1, Math.max(0, (s - acc) / segLen)) : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

export type WidthProfile = 'taper' | 'fade' | 'even';

export interface StrokeOptions {
  /** base width w₀ (px) */
  w0: number;
  rng: Rng;
  /** end overshoot as a fraction of the stroke length (default 0.03) */
  overshoot?: number;
  /** hand wobble amplitude (px, default 0.35) */
  wobble?: number;
  /** 'taper': w₀(0.55+0.45·sin πt); 'fade': thick → thin; 'even': constant */
  profile?: WidthProfile;
  /** ± relative per-stroke width jitter (default 0.1) */
  jitter?: number;
  /** perpendicular offset of the whole stroke (px) */
  shift?: number;
  /** resample step (px, default 6) */
  step?: number;
}

/**
 * Tapered stroke along an open polyline as a closed path "d":
 *   w(t) = w₀ (0.55 + 0.45 sin πt) (1 ± jitter), pointed tips, ends extended
 * by `overshoot`. Returns '' for degenerate input.
 */
export function taperedStroke(input: readonly V2[], o: StrokeOptions): string {
  if (input.length < 2) return '';
  const L0 = polylineLength(input);
  if (L0 < 0.5) return '';
  const rng = o.rng;
  const over = (o.overshoot ?? 0.03) * L0;
  const a0 = input[0] as V2;
  const a1 = input[1] as V2;
  const b0 = input[input.length - 1] as V2;
  const b1 = input[input.length - 2] as V2;
  const d0 = Math.hypot(a0[0] - a1[0], a0[1] - a1[1]) || 1;
  const d1 = Math.hypot(b0[0] - b1[0], b0[1] - b1[1]) || 1;
  const ext: V2[] = [
    [a0[0] + ((a0[0] - a1[0]) / d0) * over, a0[1] + ((a0[1] - a1[1]) / d0) * over],
    ...input,
    [b0[0] + ((b0[0] - b1[0]) / d1) * over, b0[1] + ((b0[1] - b1[1]) / d1) * over],
  ];
  const pts = resample(ext, o.step ?? 6, 4);
  const n = pts.length;
  const k = 1 + sym(rng) * (o.jitter ?? 0.1);
  const amp = (o.wobble ?? 0.35) * (0.5 + rng());
  const freq = 0.5 + rng() * 0.9;
  const phase = rng() * Math.PI * 2;
  const shift = o.shift ?? 0;
  const profile = o.profile ?? 'taper';
  const left: V2[] = [];
  const right: V2[] = [];
  let tipA: V2 = pts[0] as V2;
  let tipB: V2 = pts[n - 1] as V2;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = pts[i] as V2;
    const pa = pts[Math.max(0, i - 1)] as V2;
    const pb = pts[Math.min(n - 1, i + 1)] as V2;
    let tx = pb[0] - pa[0];
    let ty = pb[1] - pa[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const nx = -ty;
    const ny = tx;
    const w =
      o.w0 *
      k *
      (profile === 'taper' ? 0.55 + 0.45 * Math.sin(Math.PI * t) : profile === 'fade' ? Math.max(0.12, 1 - 0.88 * t) : 1);
    const off = shift + amp * Math.sin(2 * Math.PI * (freq * t) + phase);
    const cx = p[0] + nx * off;
    const cy = p[1] + ny * off;
    left.push([cx + (nx * w) / 2, cy + (ny * w) / 2]);
    right.push([cx - (nx * w) / 2, cy - (ny * w) / 2]);
    if (i === 0) tipA = [cx - tx * w * 0.6, cy - ty * w * 0.6];
    if (i === n - 1) tipB = [cx + tx * w * 0.6, cy + ty * w * 0.6];
  }
  let d = `M${num(tipA[0])} ${num(tipA[1])}`;
  for (const q of left) d += `L${num(q[0])} ${num(q[1])}`;
  d += `L${num(tipB[0])} ${num(tipB[1])}`;
  for (let i = right.length - 1; i >= 0; i--) d += `L${num((right[i] as V2)[0])} ${num((right[i] as V2)[1])}`;
  return `${d}Z`;
}

/**
 * One hatch mark a → b: a quick taper in, an even body, a longer flick out
 * (pointed at both ends), bowed by a centreline sagitta `sag`; `w` is the
 * body width.
 */
export function hatchMark(a: V2, b: V2, w: number, sag: number): string {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L;
  const ny = dx / L;
  const at = (t: number, off: number): string => {
    const bow = sag * 4 * t * (1 - t);
    return `${num(a[0] + dx * t + nx * (bow + off))} ${num(a[1] + dy * t + ny * (bow + off))}`;
  };
  const h = w / 2;
  return `M${at(0, 0)}L${at(0.1, h)}L${at(0.7, h * 0.85)}L${at(1, 0)}L${at(0.7, -h * 0.85)}L${at(0.1, -h)}Z`;
}

/** Split a closed loop into open runs of arc length within [minLen, maxLen]. */
export function splitLoop(loop: readonly V2[], rng: Rng, minLen: number, maxLen: number): V2[][] {
  const n = loop.length;
  if (n < 3) return [];
  const closed = [...loop, loop[0] as V2];
  const total = polylineLength(closed);
  if (total <= maxLen) return [closed];
  // start at a random vertex so joints do not line up between passes
  const s = Math.floor(rng() * n);
  const ring = [...loop.slice(s), ...loop.slice(0, s), loop[s] as V2];
  const runs: V2[][] = [];
  let cur: V2[] = [ring[0] as V2];
  let acc = 0;
  let target = minLen + rng() * (maxLen - minLen);
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i] as V2;
    const q = cur[cur.length - 1] as V2;
    acc += Math.hypot(p[0] - q[0], p[1] - q[1]);
    cur.push(p);
    if (acc >= target && ring.length - i > 2) {
      runs.push(cur);
      cur = [p];
      acc = 0;
      target = minLen + rng() * (maxLen - minLen);
    }
  }
  if (cur.length >= 2) {
    const last = runs[runs.length - 1];
    if (acc < minLen * 0.4 && last) last.push(...cur.slice(1));
    else runs.push(cur);
  }
  return runs;
}

/** Hand-drawn ellipse loop (start angle random, overshoots its start). */
export function looseLoop(cx: number, cy: number, rx: number, ry: number, rng: Rng, steps = 28): V2[] {
  const a0 = rng() * Math.PI * 2;
  const sweep = Math.PI * 2 * (1.06 + rng() * 0.05);
  const pts: V2[] = [];
  const wob = 0.035;
  const ph = rng() * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + sweep * t;
    const k = 1 + wob * Math.sin(3 * a + ph) + 0.04 * t;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return pts;
}
