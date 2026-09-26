/**
 * Look metrics L1–L7 for the pencil renderer (docs/PLAN.md, 画风可测指标).
 * Pure functions over straight RGBA pixels (row-major) and 0/1 masks of the
 * same size; no IO, no rendering. The server test and `npm run look` rasterise
 * with resvg and call these.
 *
 *  L1 luminance k=4 clustering: ≥3 clusters of ≥3 % whose centres are ≥0.15 apart
 *  L2 max saturation ≤ 0.04
 *  L3 240 px thumbnail, binarised (Otsu over the people and a ring around them): IoU with the silhouette mask ≥ 0.7
 *  L4 mean luminance inside people by depth band: fg < mg < bg, adjacent gaps ≥ 0.08
 *  L5 gradient-orientation histogram over the toned area: main peak at the hatch angle ±8°, ≥ 50 %
 *  L6 foreground subject interior: share of near-paper pixels (luminance > 0.9) ≤ 40 %
 *  L7 contour stroke width coefficient of variation ≥ 0.25 (measured on the contour layer)
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** straight (non-premultiplied) RGBA */
  rgba: Uint8Array;
}

export interface Mask {
  width: number;
  height: number;
  /** 0 / 1 per pixel */
  data: Uint8Array;
}

export const LOOK_THRESHOLDS = {
  l1: { k: 4, minShare: 0.03, minGap: 0.15, minClusters: 3 },
  l2: { maxSaturation: 0.04 },
  l3: { minIoU: 0.7, thumbWidth: 240 },
  l4: { minGap: 0.08 },
  l5: { tolerance: 8, minShare: 0.5 },
  l6: { paper: 0.9, maxShare: 0.4 },
  l7: { minCV: 0.25 },
} as const;

/** Relative luminance of sRGB values (Rec. 709 weights, no linearisation), 0..1. */
export function luminance(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const p = img.rgba;
  for (let i = 0; i < n; i++) out[i] = (0.2126 * (p[i * 4] as number) + 0.7152 * (p[i * 4 + 1] as number) + 0.0722 * (p[i * 4 + 2] as number)) / 255;
  return out;
}

/** 0/1 mask of pixels whose luminance is above `threshold`. */
export function maskFrom(img: RgbaImage, threshold = 0.5): Mask {
  const lum = luminance(img);
  const data = new Uint8Array(lum.length);
  for (let i = 0; i < lum.length; i++) data[i] = (lum[i] as number) > threshold ? 1 : 0;
  return { width: img.width, height: img.height, data };
}

export function maskArea(m: Mask): number {
  let a = 0;
  for (let i = 0; i < m.data.length; i++) a += m.data[i] as number;
  return a;
}

/** Binary erosion with a (2r+1)² square (outside the image counts as empty). */
export function erode(m: Mask, r: number): Mask {
  if (r <= 0) return m;
  const { width: w, height: h } = m;
  const full = 2 * r + 1;
  const hor = new Uint8Array(w * h);
  const pre = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) pre[x + 1] = (pre[x] as number) + (m.data[y * w + x] as number);
    for (let x = r; x < w - r; x++) hor[y * w + x] = (pre[x + r + 1] as number) - (pre[x - r] as number) === full ? 1 : 0;
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = (pre[y] as number) + (hor[y * w + x] as number);
    for (let y = r; y < h - r; y++) out[y * w + x] = (pre[y + r + 1] as number) - (pre[y - r] as number) === full ? 1 : 0;
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// L1
// ---------------------------------------------------------------------------

export interface ToneClusters {
  centers: number[];
  shares: number[];
  /** clusters (share ≥ minShare) that are mutually ≥ minGap apart */
  distinct: number;
  pass: boolean;
}

/**
 * 1-D k-means (k = 4) on a 256-bin luminance histogram. Lloyd iterations get
 * stuck in local optima on paper-dominated frames (three centres spent on the
 * paper's vignette), so — like any k-means with several starts — it runs from
 * three deterministic seeds (quantiles, even spacing, min–max spread) and keeps
 * the clustering with the lowest within-cluster error.
 */
export function l1ToneClusters(lum: Float32Array, k: number = LOOK_THRESHOLDS.l1.k): ToneClusters {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) hist[Math.min(255, Math.max(0, Math.round((lum[i] as number) * 255)))]! += 1;
  const total = lum.length || 1;
  const quantile = (q: number) => {
    let acc = 0;
    for (let b = 0; b < 256; b++) {
      acc += hist[b] as number;
      if (acc >= q * total) return b / 255;
    }
    return 1;
  };
  const lo = quantile(0.001);
  const hi = quantile(0.999);
  const seeds = [
    Array.from({ length: k }, (_, i) => quantile((i + 0.5) / k)),
    Array.from({ length: k }, (_, i) => (i + 0.5) / k),
    Array.from({ length: k }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / k),
  ];
  const nearest = (v: number, cs: readonly number[]) => {
    let best = 0;
    for (let j = 1; j < cs.length; j++) if (Math.abs(v - (cs[j] as number)) < Math.abs(v - (cs[best] as number))) best = j;
    return best;
  };
  const lloyd = (init: number[]) => {
    let centers = init.slice();
    let shares = new Array<number>(k).fill(0);
    for (let it = 0; it < 100; it++) {
      const sum = new Float64Array(k);
      const cnt = new Float64Array(k);
      for (let b = 0; b < 256; b++) {
        const c = hist[b] as number;
        if (!c) continue;
        const j = nearest(b / 255, centers);
        sum[j]! += (b / 255) * c;
        cnt[j]! += c;
      }
      const next = centers.map((c, j) => ((cnt[j] as number) > 0 ? (sum[j] as number) / (cnt[j] as number) : c));
      shares = Array.from(cnt, (c) => c / total);
      const moved = next.some((c, j) => Math.abs(c - (centers[j] as number)) > 1e-6);
      centers = next;
      if (!moved) break;
    }
    let sse = 0;
    for (let b = 0; b < 256; b++) {
      const c = hist[b] as number;
      if (c) sse += c * ((b / 255 - (centers[nearest(b / 255, centers)] as number)) ** 2);
    }
    return { centers, shares, sse };
  };
  let bestRun = lloyd(seeds[0] as number[]);
  for (const seed of seeds.slice(1)) {
    const r = lloyd(seed);
    if (r.sse < bestRun.sse - 1e-9) bestRun = r;
  }
  const { centers, shares } = bestRun;
  const order = centers.map((c, j) => ({ c, s: shares[j] as number })).sort((a, b) => a.c - b.c);
  let distinct = 0;
  let last = -Infinity;
  for (const o of order) {
    if (o.s < LOOK_THRESHOLDS.l1.minShare) continue;
    if (o.c - last >= LOOK_THRESHOLDS.l1.minGap) {
      distinct++;
      last = o.c;
    }
  }
  return {
    centers: order.map((o) => o.c),
    shares: order.map((o) => o.s),
    distinct,
    pass: distinct >= LOOK_THRESHOLDS.l1.minClusters,
  };
}

// ---------------------------------------------------------------------------
// L2
// ---------------------------------------------------------------------------

/** Maximum HSV saturation (max−min)/max over opaque pixels (near-black pixels ignored). */
export function l2MaxSaturation(img: RgbaImage): number {
  const p = img.rgba;
  let m = 0;
  for (let i = 0; i < p.length; i += 4) {
    if ((p[i + 3] as number) === 0) continue;
    const r = p[i] as number;
    const g = p[i + 1] as number;
    const b = p[i + 2] as number;
    const mx = Math.max(r, g, b);
    if (mx < 12) continue;
    const s = (mx - Math.min(r, g, b)) / mx;
    if (s > m) m = s;
  }
  return m;
}

// ---------------------------------------------------------------------------
// L3
// ---------------------------------------------------------------------------

/** Otsu threshold (0..1) of luminance values selected by `pick`. */
export function otsu(lum: Float32Array, pick?: (i: number) => boolean): number {
  const hist = new Float64Array(256);
  let n = 0;
  for (let i = 0; i < lum.length; i++) {
    if (pick && !pick(i)) continue;
    hist[Math.min(255, Math.max(0, Math.round((lum[i] as number) * 255)))]! += 1;
    n++;
  }
  if (!n) return 0.5;
  let sumAll = 0;
  for (let b = 0; b < 256; b++) sumAll += b * (hist[b] as number);
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let thr = 128;
  for (let b = 0; b < 256; b++) {
    wB += hist[b] as number;
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += b * (hist[b] as number);
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = b;
    }
  }
  return (thr + 0.5) / 255;
}

export interface SilhouetteIoU {
  iou: number;
  threshold: number;
  /** radius (px) of the neighbourhood ring around the silhouette */
  ring: number;
}

/** Binary dilation with a (2r+1)² square. */
export function dilate(m: Mask, r: number): Mask {
  if (r <= 0) return m;
  const { width: w, height: h } = m;
  const hor = new Uint8Array(w * h);
  const pre = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) pre[x + 1] = (pre[x] as number) + (m.data[y * w + x] as number);
    for (let x = 0; x < w; x++) hor[y * w + x] = (pre[Math.min(w, x + r + 1)] as number) - (pre[Math.max(0, x - r)] as number) > 0 ? 1 : 0;
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = (pre[y] as number) + (hor[y * w + x] as number);
    for (let y = 0; y < h; y++) out[y * w + x] = (pre[Math.min(h, y + r + 1)] as number) - (pre[Math.max(0, y - r)] as number) > 0 ? 1 : 0;
  }
  return { width: w, height: h, data: out };
}

/**
 * Silhouette readability at thumbnail size: binarise the thumbnail (dark =
 * figure) with an Otsu threshold taken over the people and a ring of their
 * immediate surroundings (radius ≈ 10 % of the silhouette's size, ≥ 3 px), and
 * compare with the silhouette mask inside that neighbourhood. A local
 * neighbourhood, not the people's bounding box: a small group in a wide room
 * must read against the floor around it, not against a wall across the frame.
 */
export function l3SilhouetteIoU(thumb: RgbaImage, sil: Mask): SilhouetteIoU | null {
  const area = maskArea(sil);
  if (!area) return null;
  const ring = Math.max(3, Math.round(0.1 * Math.sqrt(area)));
  const roi = dilate(sil, ring);
  const lum = luminance(thumb);
  const threshold = otsu(lum, (i) => roi.data[i] === 1);
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < lum.length; i++) {
    if (!roi.data[i]) continue;
    const a = (lum[i] as number) < threshold;
    const b = sil.data[i] === 1;
    if (a && b) inter++;
    if (a || b) uni++;
  }
  return { iou: uni ? inter / uni : 0, threshold, ring };
}

// ---------------------------------------------------------------------------
// L4 / L6
// ---------------------------------------------------------------------------

export function meanIn(lum: Float32Array, m: Mask): number | null {
  let s = 0;
  let n = 0;
  for (let i = 0; i < lum.length; i++)
    if (m.data[i]) {
      s += lum[i] as number;
      n++;
    }
  return n ? s / n : null;
}

export interface DepthOrder {
  means: { fg: number | null; mg: number | null; bg: number | null };
  /** smallest gap between adjacent present bands (lighter − darker) */
  minGap: number | null;
  pass: boolean;
}

/** Mean luminance inside the (eroded) people of each depth band: fg < mg < bg. */
export function l4DepthOrder(lum: Float32Array, bands: { fg?: Mask | null; mg?: Mask | null; bg?: Mask | null }, erodePx = 2): DepthOrder {
  const mean = (m?: Mask | null) => (m && maskArea(m) > 0 ? meanIn(lum, erode(m, erodePx)) : null);
  const means = { fg: mean(bands.fg), mg: mean(bands.mg), bg: mean(bands.bg) };
  const seq = [means.fg, means.mg, means.bg].filter((v): v is number => v !== null);
  if (seq.length < 2) return { means, minGap: null, pass: true };
  let minGap = Infinity;
  for (let i = 1; i < seq.length; i++) minGap = Math.min(minGap, (seq[i] as number) - (seq[i - 1] as number));
  return { means, minGap, pass: minGap >= LOOK_THRESHOLDS.l4.minGap };
}

/** Share of near-paper pixels (luminance > 0.9) inside the eroded foreground subject. */
export function l6ForegroundPaper(lum: Float32Array, fg: Mask, erodePx = 3): number | null {
  const m = erode(fg, erodePx);
  let n = 0;
  let white = 0;
  for (let i = 0; i < lum.length; i++)
    if (m.data[i]) {
      n++;
      if ((lum[i] as number) > LOOK_THRESHOLDS.l6.paper) white++;
    }
  return n ? white / n : null;
}

// ---------------------------------------------------------------------------
// L5
// ---------------------------------------------------------------------------

export interface HatchDirection {
  /** stroke-direction histogram peak (deg, 0..180, counter-clockwise from screen-right) */
  peak: number;
  /** gradient-energy share within ±tolerance of the hatch angle (stroke direction) */
  share: number;
  pass: boolean;
}

/**
 * Sobel gradients inside the toned area; each pixel votes (by magnitude) for
 * the stroke direction perpendicular to its gradient. The hatch field should
 * dominate: main peak within ±8° of the hatch angle, holding ≥ 50 % of votes.
 */
export function l5HatchDirection(lum: Float32Array, width: number, height: number, toned: Mask, angle: number, minMag = 0.3): HatchDirection {
  const bins = new Float64Array(180);
  let total = 0;
  const m = erode(toned, 2);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!m.data[i]) continue;
      const L = (dx: number, dy: number) => lum[i + dy * width + dx] as number;
      const gx = L(1, -1) + 2 * L(1, 0) + L(1, 1) - L(-1, -1) - 2 * L(-1, 0) - L(-1, 1);
      const gy = L(-1, 1) + 2 * L(0, 1) + L(1, 1) - L(-1, -1) - 2 * L(0, -1) - L(1, -1);
      const mag = Math.hypot(gx, gy);
      if (mag < minMag) continue;
      // math convention (y up): gradient angle, stroke direction = gradient + 90°
      let a = (Math.atan2(-gy, gx) * 180) / Math.PI + 90;
      a = ((a % 180) + 180) % 180;
      bins[Math.min(179, Math.floor(a))]! += mag;
      total += mag;
    }
  }
  if (!total) return { peak: angle, share: 0, pass: false };
  const tol = LOOK_THRESHOLDS.l5.tolerance;
  const windowSum = (c: number) => {
    let s = 0;
    for (let d = -tol; d <= tol; d++) s += bins[(((c + d) % 180) + 180) % 180] as number;
    return s;
  };
  let peak = 0;
  let best = -1;
  for (let c = 0; c < 180; c++) {
    const s = windowSum(c);
    if (s > best) {
      best = s;
      peak = c;
    }
  }
  const target = ((Math.round(angle) % 180) + 180) % 180;
  const share = windowSum(target) / total;
  const off = Math.min(Math.abs(peak - target), 180 - Math.abs(peak - target));
  return { peak, share, pass: off <= tol && share >= LOOK_THRESHOLDS.l5.minShare };
}

// ---------------------------------------------------------------------------
// L7
// ---------------------------------------------------------------------------

export interface LineWidths {
  mean: number;
  cv: number;
  samples: number;
}

/**
 * Stroke widths on a contour-only render (dark strokes on white): at sampled
 * ink pixels the local normal comes from the structure tensor and the width
 * is the ink integrated across the stroke along that normal.
 */
export function l7LineWidthCV(lum: Float32Array, width: number, height: number, step = 3): LineWidths {
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return 0;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const v = (xx: number, yy: number) => 1 - (lum[yy * width + xx] as number);
    return (v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx) * (1 - fy) + (v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx) * fy;
  };
  const widths: number[] = [];
  for (let y = 4; y < height - 4; y += step) {
    for (let x = 4; x < width - 4; x += step) {
      if (ink(x, y) < 0.5) continue;
      let jxx = 0;
      let jyy = 0;
      let jxy = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const gx = ink(x + dx + 1, y + dy) - ink(x + dx - 1, y + dy);
          const gy = ink(x + dx, y + dy + 1) - ink(x + dx, y + dy - 1);
          jxx += gx * gx;
          jyy += gy * gy;
          jxy += gx * gy;
        }
      if (jxx + jyy < 1e-6) continue;
      const th = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
      const nx = Math.cos(th);
      const ny = Math.sin(th);
      let w = 0;
      for (let t = -8; t <= 8; t += 0.5) w += ink(x + nx * t, y + ny * t) * 0.5;
      if (w > 0.3) widths.push(w);
    }
  }
  const n = widths.length;
  if (!n) return { mean: 0, cv: 0, samples: 0 };
  const mean = widths.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(widths.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  return { mean, cv: sd / mean, samples: n };
}
