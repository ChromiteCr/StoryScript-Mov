/**
 * Small vector / geometry helpers for the board pipeline. Pure and
 * allocation-light; no dependency on contracts.
 */

export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];

export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const add2 = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const scale2 = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
export const len2 = (a: V2): number => Math.hypot(a[0], a[1]);

/** Round to `d` decimals, normalising -0 to 0. */
export function round(v: number, d = 4): number {
  const k = 10 ** d;
  const r = Math.round(v * k) / k;
  return r === 0 ? 0 : r;
}

/** Normalise an angle in degrees to (-180, 180]. */
export function wrapDeg(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return r;
}

/** Sutherland–Hodgman clip of a polygon against the half-plane f(p) >= 0 (f linear along edges). */
export function clipPolygon<P>(poly: readonly P[], f: (p: P) => number, mix: (a: P, b: P, t: number) => P): P[] {
  const out: P[] = [];
  const n = poly.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const cur = poly[i] as P;
    const prev = poly[(i + n - 1) % n] as P;
    const fc = f(cur);
    const fp = f(prev);
    if (fc >= 0) {
      if (fp < 0) out.push(mix(prev, cur, fp / (fp - fc)));
      out.push(cur);
    } else if (fp >= 0) {
      out.push(mix(prev, cur, fp / (fp - fc)));
    }
  }
  return out;
}

/** Clip a segment against f(p) >= 0; returns null when fully outside. */
export function clipSegment<P>(a: P, b: P, f: (p: P) => number, mix: (a: P, b: P, t: number) => P): [P, P] | null {
  const fa = f(a);
  const fb = f(b);
  if (fa < 0 && fb < 0) return null;
  if (fa >= 0 && fb >= 0) return [a, b];
  const m = mix(a, b, fa / (fa - fb));
  return fa >= 0 ? [a, m] : [m, b];
}

export const mix3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const mix2 = (a: V2, b: V2, t: number): V2 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

/** Clip a 2D polygon to an axis-aligned rectangle. */
export function clipPolygonRect(poly: readonly V2[], x0: number, y0: number, x1: number, y1: number): V2[] {
  let p: V2[] = poly.slice();
  p = clipPolygon(p, (q) => q[0] - x0, mix2);
  p = clipPolygon(p, (q) => x1 - q[0], mix2);
  p = clipPolygon(p, (q) => q[1] - y0, mix2);
  p = clipPolygon(p, (q) => y1 - q[1], mix2);
  return p;
}

/** Clip a 2D segment to an axis-aligned rectangle (Liang–Barsky). */
export function clipSegmentRect(a: V2, b: V2, x0: number, y0: number, x1: number, y1: number): [V2, V2] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - x0, x1 - a[0], a[1] - y0, y1 - a[1]];
  for (let i = 0; i < 4; i++) {
    const pi = p[i] as number;
    const qi = q[i] as number;
    if (pi === 0) {
      if (qi < 0) return null;
    } else {
      const r = qi / pi;
      if (pi < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ];
}

/** Andrew's monotone chain convex hull (counter-clockwise in y-up space). */
export function convexHull(points: readonly V2[]): V2[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: V2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as V2, lower[lower.length - 1] as V2, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: V2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as V2;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as V2, upper[upper.length - 1] as V2, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Chaikin corner cutting on a closed polygon. */
export function chaikin(poly: readonly V2[], iterations = 1, ratio = 0.25): V2[] {
  let p: V2[] = poly.slice();
  for (let k = 0; k < iterations; k++) {
    const out: V2[] = [];
    const n = p.length;
    for (let i = 0; i < n; i++) {
      const a = p[i] as V2;
      const b = p[(i + 1) % n] as V2;
      out.push(mix2(a, b, ratio), mix2(a, b, 1 - ratio));
    }
    p = out;
  }
  return p;
}

/** Signed area (positive = counter-clockwise in y-up space). */
export function polygonArea(poly: readonly V2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as V2;
    const b = poly[(i + 1) % poly.length] as V2;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
