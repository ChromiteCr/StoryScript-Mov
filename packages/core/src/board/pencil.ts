/**
 * Pencil renderer: BoardSpec → "loose widescreen pencil storyboard" SVG.
 * Pure, deterministic, greys only, presentation attributes only.
 *
 * Tone first, then line (docs/PLAN.md 分镜管线 step 5):
 *  1. paper ground;
 *  2. painter pass (same order as structure): flat graphite tone per region
 *     (opaque, so nearer shapes hide what is behind) with each shape's
 *     tapered contour drawn right after its fill; people carry their face,
 *     hair and clothing marks (S4c) between their own regions, so a nearer
 *     limb still covers them;
 *  3. construction lines (horizon, vanishing lines, vertical convergence);
 *  4. a blurred graphite smudge under the darkest tone;
 *  5. three frame-wide hatch fields T1 / T2 / T3 in one direction (T3
 *     crossing), each masked by the blurred union of its tone and darker —
 *     one consistent hand, not per-object hachure;
 *  6. paper grain, vignette, frame line;
 *  7. the annotation layer (optional, separate group).
 *
 * Every random quantity comes from rngFor(spec.seed, elementKey), so editing
 * one element never re-jitters another element's strokes.
 */
import type { BoardSpec } from '@storyscript/contracts';
import { contentHash } from '../util/hash.ts';
import { rngFor } from '../util/random.ts';
import { projectPoint } from './camera.ts';
import { clamp, clipPolygonRect, clipSegmentRect, lerp, type V2 } from './math.ts';
import { arrowPx } from './overlay-geom.ts';
import { paperDefs, paperIds, paperOverlay } from './paper.ts';
import { DEFAULT_PENCIL_LOOK, paperLevel, type PencilLook } from './pencil-look.ts';
import { pencilOverlaySvg } from './pencil-overlay.ts';
import {
  buildPencilPlan,
  figurePartTone,
  groundValueAt,
  toneRaster,
  type DepthBand,
  type FigureRegion,
  type PencilPlan,
  type PlanItem,
} from './pencil-plan.ts';
import { detailVisible, type PuppetMaterial } from './puppets.ts';
import { bandBox, dilate, fillPolygon, makeGrid, sample, traceLoops, type Grid } from './raster.ts';
import type { SubjectItem } from './scene.ts';
import { hatchMark, resample, splitLoop, sym, taperedStroke, type Rng } from './strokes.ts';
import { attrs, el, gray, num, polyPath } from './svg.ts';

export const PENCIL_VERSION = 'pencil-1';
/**
 * S4c: version of how a board is drawn (figures, sets). Picture caches key on
 * it; structureHash deliberately does not, so a renderer upgrade never marks
 * adopted AI redraws as stale.
 */
export const PICTURE_VERSION = 'picture-s4c';

export interface PencilRenderOptions {
  width?: number;
  overlay?: boolean;
  background?: boolean;
  /** shot number shown top-left when spec.overlay.show_code */
  code?: string | null;
  look?: PencilLook;
  /** 'contour': contours only on white (occlusion kept) — line-width measurement */
  layers?: 'all' | 'contour';
}

/**
 * Hash of everything the pencil picture layer depends on (not the overlay),
 * so a client can cache rendered pencil frames by structure_hash and redraw
 * only the annotation layer while it is being edited.
 */
export function structureHash(spec: BoardSpec, look: PencilLook = DEFAULT_PENCIL_LOOK): string {
  const movers = spec.overlay.arrows.filter((a) => a.kind === 'subject_move');
  // Frozen inputs (S4c): the v1 version string, the v1 default look, and only
  // the look fields v1 had; an unset gesture (absent or null) hashes as absent.
  const hashLook = look === DEFAULT_PENCIL_LOOK ? LOOK_HASH_V1 : pickV1(look);
  const subjects = spec.scene.subjects.map((s) => (s.gesture === null || s.gesture === undefined ? omitGesture(s) : s));
  const scene = { ...spec.scene, subjects };
  return contentHash({ v: PENCIL_VERSION, frame: spec.frame, camera: spec.camera, scene, seed: spec.seed, movers, look: hashLook });
}

function omitGesture<T extends { gesture?: unknown }>(s: T): Omit<T, 'gesture'> {
  const { gesture: _g, ...rest } = s;
  return rest;
}

/**
 * The default look as structureHash v1 saw it. Never edit: the picture may
 * change (PICTURE_VERSION), the hash of an existing board may not.
 */
export const LOOK_HASH_V1 = Object.freeze({
  angle: 38,
  cross: 108,
  paperTone: '#F3F0E8',
  outline: { fg: 2.2, mg: 1.4, bg: 0.9 },
  hatch: {
    spacing: [9, 6, 7],
    width: [1.6, 1.5, 1.5],
    opacity: [0.72, 0.78, 0.8],
    ink: [64, 48, 30],
    patchMin: 5,
    patchMax: 12,
    endJitter: 3,
    slant: 1.6,
    segMin: 40,
    segMax: 120,
    gapMin: 2,
    gapMax: 6,
    bow: 0.018,
    jitter: 0.15,
    wobble: 1.2,
  },
  maskBlur: 1.2,
  smudge: { blur: 2, opacity: 0.5, ink: 48 },
  fill: [0, 0.2, 0.34, 0.5],
  figure: [0.06, 0.26, 0.44, 0.82],
  shade: 0.6,
  litHatch: 0.5,
  contour: {
    scale: 1,
    ink: 28,
    opacity: 0.88,
    second: 0.6,
    offset: 1,
    secondOpacity: 0.5,
    secondWobble: 0.9,
    overshoot: 0.03,
    litBreak: 0.15,
    lit: 0.7,
    shade: 1.5,
  },
  construction: { stroke: '#8a8a8a', opacity: 0.35, width: 0.6 },
  grain: 1,
  tooth: 0.5,
  vignette: 0.12,
});

/** A non-default look restricted to the fields the v1 hash had (later look fields never enter it). */
function pickV1(look: PencilLook): Record<string, unknown> {
  const src = look as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(LOOK_HASH_V1)) out[k] = src[k];
  return out;
}

function svgOpen(W: number, H: number, width: number | undefined): string {
  const w = width ?? W;
  const h = (w / W) * H;
  return `<svg xmlns="http://www.w3.org/2000/svg"${attrs({ viewBox: `0 0 ${num(W)} ${num(H)}`, width: w, height: h })}>`;
}

const toneGray = (t: number) => gray((clamp(t, 0, 3) / 3) * 255);

function inFrame(pts: readonly V2[], W: number, H: number, m = 4): boolean {
  for (const p of pts) if (p[0] >= -m && p[0] <= W + m && p[1] >= -m && p[1] <= H + m) return true;
  return false;
}

// ---------------------------------------------------------------------------
// contours
// ---------------------------------------------------------------------------

interface Run {
  pts: V2[];
  /** outward screen normal (null: no lit/shadow modulation) */
  n: V2 | null;
  crease?: boolean;
}

function contourPaths(runs: readonly Run[], w0: number, rng: Rng, look: PencilLook, light: V2, ink: string): string {
  const c = look.contour;
  let out = '';
  for (const r of runs) {
    let w = w0;
    if (r.crease) w *= 0.6;
    else if (r.n) {
      const side = r.n[0] * light[0] + r.n[1] * light[1];
      if (side > 0.35) {
        if (rng() < c.litBreak) continue;
        w *= c.lit;
      } else if (side < -0.35) w *= c.shade;
    }
    const d1 = taperedStroke(r.pts, { w0: w, rng, overshoot: c.overshoot });
    const d2 = taperedStroke(r.pts, { w0: w * c.second, rng, overshoot: c.overshoot * 1.6, shift: (rng() < 0.5 ? -1 : 1) * c.offset, wobble: c.secondWobble });
    if (d1) out += el('path', { d: d1, fill: ink, 'fill-opacity': clamp(c.opacity * (1 + sym(rng) * 0.15), 0.05, 1) });
    if (d2) out += el('path', { d: d2, fill: ink, 'fill-opacity': clamp(c.secondOpacity * (1 + sym(rng) * 0.15), 0.05, 1) });
  }
  return out;
}

/** Clip a segment to the frame (with margin) so off-frame geometry never produces huge strokes. */
function clipToFrame(a: V2, b: V2, W: number, H: number): [V2, V2] | null {
  const m = 24;
  return clipSegmentRect(a, b, -m, -m, W + m, H + m);
}

// ---------------------------------------------------------------------------
// figures
// ---------------------------------------------------------------------------

interface FigureOutline {
  loops: V2[][];
  grid: Grid | null;
}

function figureOutline(parts: readonly V2[][], it: SubjectItem, W: number, H: number): FigureOutline {
  const bb = it.bbox;
  if (!bb || !parts.length) return { loops: [], grid: null };
  const m = 12;
  const x0 = Math.max(bb.x0, -m);
  const x1 = Math.min(bb.x1, W + m);
  const y0 = Math.max(bb.y0, -m);
  const y1 = Math.min(bb.y1, H + m);
  if (x1 <= x0 || y1 <= y0) return { loops: [], grid: null };
  let cell = clamp(it.heightPx / 360, 0.6, 2);
  while (((x1 - x0) / cell) * ((y1 - y0) / cell) > 500_000) cell *= 1.25;
  const g = makeGrid(x0 - 2 * cell, y0 - 2 * cell, x1 + 2 * cell, y1 + 2 * cell, cell);
  for (const p of parts) fillPolygon(g, p, 1);
  return { loops: traceLoops(g, 0.5, 2, cell * 6), grid: g };
}

function loopRuns(outline: FigureOutline, rng: Rng, heightPx: number, W: number, H: number): Run[] {
  const g = outline.grid;
  const minL = clamp(heightPx * 0.12, 16, 50);
  const maxL = clamp(heightPx * 0.34, 36, 140);
  const runs: Run[] = [];
  for (const loop of outline.loops) {
    for (const pts of splitLoop(loop, rng, minL, maxL)) {
      if (!inFrame(pts, W, H)) continue;
      const i = Math.floor(pts.length / 2);
      const p = pts[i] as V2;
      const a = pts[Math.max(0, i - 1)] as V2;
      const b = pts[Math.min(pts.length - 1, i + 1)] as V2;
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let n: V2 = [-(b[1] - a[1]) / tl, (b[0] - a[0]) / tl];
      if (g) {
        const probe = 1.5 * g.cell + 0.5;
        if (sample(g, p[0] + n[0] * probe, p[1] + n[1] * probe) > 0.5) n = [-n[0], -n[1]];
      }
      runs.push({ pts, n });
    }
  }
  return runs;
}

/**
 * Screen direction of motion per moving person: from their own subject_move
 * arrow, else (running / walking people in a motion shot) the shot's first one.
 */
function subjectMotion(spec: BoardSpec, plan: PencilPlan): Map<string, V2> {
  const out = new Map<string, V2>();
  let first: V2 | null = null;
  for (const a of spec.overlay.arrows) {
    if (a.kind !== 'subject_move') continue;
    const pts = arrowPx(spec, plan.scene, a);
    if (!pts) continue;
    const p0 = pts[0] as V2;
    const p1 = pts[pts.length - 1] as V2;
    const l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (l < 1) continue;
    const u: V2 = [(p1[0] - p0[0]) / l, (p1[1] - p0[1]) / l];
    if (!first) first = u;
    if (a.subject_id && !out.has(a.subject_id)) out.set(a.subject_id, u);
  }
  if (first) for (const s of spec.scene.subjects) if (!out.has(s.id) && (s.pose === 'run' || s.pose === 'walk')) out.set(s.id, first);
  return out;
}

function motionMarks(outline: FigureOutline, it: SubjectItem, u: V2, w0: number, rng: Rng, look: PencilLook, W: number, H: number): string {
  const pts = outline.loops
    .flatMap((l) => resample([...l, l[0] as V2], 3))
    .filter((p) => p[0] > -20 && p[0] < W + 20 && p[1] > -20 && p[1] < H + 20);
  if (pts.length < 8) return '';
  const v: V2 = [-u[1], u[0]];
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const p of pts) {
    const d = p[0] * v[0] + p[1] * v[1];
    vmin = Math.min(vmin, d);
    vmax = Math.max(vmax, d);
  }
  const span = vmax - vmin;
  if (span < 6) return '';
  let out = '';
  // dashed after-image of the silhouette where the move started
  const back = clamp(it.heightPx * 0.26, 18, 170);
  const ghost = outline.loops
    .map((l) => l.map((p) => [p[0] - u[0] * back, p[1] - u[1] * back] as V2))
    .filter((l) => inFrame(l, W, H))
    .map((l) => polyPath(l))
    .join('');
  if (ghost)
    out += el('path', {
      d: ghost,
      fill: 'none',
      stroke: gray(look.contour.ink + 30),
      'stroke-opacity': 0.42,
      'stroke-width': clamp(w0 * 0.7, 0.7, 2),
      'stroke-dasharray': '7 6',
      'stroke-linejoin': 'round',
      'data-ghost': '1',
    });
  // tapered speed lines trailing from the back edge
  for (const f of [0.2, 0.34, 0.47, 0.6, 0.74, 0.86]) {
    const skip = rng() < 0.22;
    const lvl = vmin + (f + sym(rng) * 0.03) * span;
    const band = 0.035 * span + 1.5;
    let best: V2 | null = null;
    let bu = Infinity;
    for (const p of pts) {
      if (Math.abs(p[0] * v[0] + p[1] * v[1] - lvl) > band) continue;
      const du = p[0] * u[0] + p[1] * u[1];
      if (du < bu) {
        bu = du;
        best = p;
      }
    }
    const gap = 6 + rng() * 8;
    const len = it.heightPx * (0.22 + rng() * 0.3);
    if (!best || skip) continue;
    const s0: V2 = [best[0] - u[0] * gap, best[1] - u[1] * gap];
    const s1: V2 = [s0[0] - u[0] * len, s0[1] - u[1] * len];
    const d = taperedStroke([s0, s1], { w0: w0 * 1.15, rng, overshoot: 0, profile: 'fade', wobble: 0.4 });
    if (d) out += el('path', { d, fill: gray(look.contour.ink), 'fill-opacity': clamp(0.7 * (1 + sym(rng) * 0.15), 0.05, 1), 'data-speed': '1' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// construction lines
// ---------------------------------------------------------------------------

function constructionLines(spec: BoardSpec, plan: PencilPlan): V2[][] {
  const { W, H, scene } = plan;
  const b = scene.basis;
  const lines: V2[][] = [];
  const far = 1e4;
  const px = (p: { x: number; y: number }): V2 => [p.x * W, p.y * H];
  const extend = (a: V2, c: V2, k: number): V2[] => [a, [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k]];
  if (scene.horizon) lines.push([scene.horizon[0], scene.horizon[1]]);
  // lines to the vanishing point of the camera's horizontal forward direction
  const fl = Math.hypot(b.fwd[0], b.fwd[2]);
  if (fl > 0.2 && scene.horizon) {
    const vp = projectPoint(b, [b.pos[0] + (b.fwd[0] / fl) * far, 0, b.pos[2] + (b.fwd[2] / fl) * far]);
    if (vp.visible) {
      const V = px(vp);
      if (Math.abs(V[0] - W / 2) < 4 * W && Math.abs(V[1] - H / 2) < 4 * H) {
        const targets: V2[] = [];
        for (const it of scene.items) if (it.type === 'subject' && it.foot && inFrame([it.foot], W, H, 40) && targets.length < 2) targets.push(it.foot);
        const fall: V2[] = [
          [W * 0.1, H],
          [W * 0.9, H],
          [W * 0.5 + (V[0] < W / 2 ? W * 0.35 : -W * 0.35), H],
        ];
        for (const f of fall) if (targets.length < 3) targets.push(f);
        for (const t of targets) {
          const d = Math.hypot(t[0] - V[0], t[1] - V[1]);
          if (d < 20) continue;
          const k = (Math.hypot(W, H) * 1.5) / d;
          lines.push(extend(V, t, Math.max(1.2, k)));
        }
      }
    }
  }
  // converging verticals when the camera tilts
  const pitch = spec.camera.pitch_deg;
  if (Math.abs(pitch) > 4) {
    const s = pitch > 0 ? 1 : -1;
    const vv = projectPoint(b, [b.pos[0], b.pos[1] + s * far, b.pos[2]]);
    if (vv.visible) {
      const V = px(vv);
      const edgeY = V[1] < H / 2 ? H : 0;
      const pts: V2[] = Math.abs(pitch) > 80 ? [[0, 0], [W, 0], [W, H], [0, H]] : [[W * 0.14, edgeY], [W * 0.86, edgeY], [W * 0.5, edgeY]];
      for (const t of pts) {
        const d = Math.hypot(t[0] - V[0], t[1] - V[1]);
        if (d < 20) continue;
        lines.push(extend(V, t, Math.max(1.15, (Math.hypot(W, H) * 1.5) / d)));
      }
    }
  }
  return lines
    .map((l) => clipSegmentRect(l[0] as V2, l[1] as V2, -30, -30, W + 30, H + 30))
    .filter((l): l is [V2, V2] => !!l)
    .map((l) => [l[0], l[1]]);
}

// ---------------------------------------------------------------------------
// hatch fields
// ---------------------------------------------------------------------------

function hatchField(
  seed: number,
  group: 1 | 2 | 3,
  look: PencilLook,
  W: number,
  H: number,
  keep: (a: V2, b: V2) => boolean,
): string[][] {
  const h = look.hatch;
  const spacing = h.spacing[group - 1] as number;
  const width = h.width[group - 1] as number;
  const theta = ((group === 3 ? look.cross : look.angle) * Math.PI) / 180;
  const d: V2 = [Math.cos(theta), -Math.sin(theta)];
  const nrm: V2 = [Math.sin(theta), Math.cos(theta)];
  const corners: V2[] = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ];
  const on = corners.map((c) => c[0] * nrm[0] + c[1] * nrm[1]);
  const os = corners.map((c) => c[0] * d[0] + c[1] * d[1]);
  const k0 = Math.floor(Math.min(...on) / spacing) - 1;
  const k1 = Math.ceil(Math.max(...on) / spacing) + 1;
  const s0 = Math.min(...os) - 20;
  const s1 = Math.max(...os) + 20;
  const buckets: string[][] = [[], [], [], [], []];
  const phase = group === 2 ? 0.5 : group === 3 ? 0.25 : 0;
  // The hand lays hatching in patches: 5–12 neighbouring lines in one sweep
  // share their breaks (a slanted, slightly ragged seam), bow and pressure,
  // so the field reads as blocks of strokes rather than scattered dashes.
  // Patches, breaks and strokes are keyed by line index only — independent of
  // the picture — so editing one element never re-jitters the strokes elsewhere.
  const prng = rngFor(seed, `hatch:${group}:patches`);
  let k = k0;
  while (k <= k1) {
    const size = h.patchMin + Math.floor(prng() * (h.patchMax - h.patchMin + 1));
    const brng = rngFor(seed, `hatch:${group}:patch:${k}`);
    const breaks: { s: number; slant: number; angle: number; press: number; width: number; sag: number }[] = [];
    let s = s0 - brng() * h.segMax;
    while (s < s1 + h.segMax) {
      breaks.push({
        s,
        slant: sym(brng) * h.slant,
        angle: (sym(brng) * 2.2 * Math.PI) / 180,
        press: sym(brng) * 0.6,
        width: 1 + sym(brng) * 0.08,
        sag: h.bow * (0.4 + 0.8 * brng()) * (brng() < 0.85 ? 1 : -1),
      });
      s += h.segMin + Math.sqrt(brng()) * (h.segMax - h.segMin);
    }
    for (let j = 0; j < size && k <= k1; j++, k++) {
      const rng = rngFor(seed, `hatch:${group}:${k}`);
      const o = (k + phase) * spacing + sym(rng) * 0.12 * spacing;
      // this line's break positions: the patch seam (slanted across the patch) ± a little
      const cut = breaks.map((b) => b.s + b.slant * j + sym(rng) * h.endJitter);
      for (let i = 0; i + 1 < breaks.length; i++) {
        const b = breaks[i] as (typeof breaks)[number];
        const gap = h.gapMin + rng() * (h.gapMax - h.gapMin);
        const sa = (cut[i] as number) + gap / 2;
        const sb = (cut[i + 1] as number) - gap / 2;
        const L = sb - sa;
        if (L < 8 || sb < s0 || sa > s1) continue;
        const wob = b.angle + (sym(rng) * h.wobble * Math.PI) / 180;
        const off = sym(rng) * 0.5;
        const cd: V2 = [Math.cos(theta + wob), -Math.sin(theta + wob)];
        const a: V2 = [nrm[0] * (o + off) + d[0] * sa, nrm[1] * (o + off) + d[1] * sa];
        const e: V2 = [a[0] + cd[0] * L, a[1] + cd[1] * L];
        const wj = b.width * (1 + sym(rng) * h.jitter);
        const oj = clamp(b.press + sym(rng) * 0.7, -1, 1);
        const sag = L * b.sag * (1 + sym(rng) * 0.25);
        if (!keep(a, e)) continue;
        const bucket = clamp(Math.round((oj + 1) * 2), 0, 4);
        (buckets[bucket] as string[]).push(hatchMark(a, e, width * wj, sag));
      }
    }
  }
  return buckets;
}

// ---------------------------------------------------------------------------

export function renderPencil(spec: BoardSpec, opts: PencilRenderOptions = {}): string {
  const look = opts.look ?? DEFAULT_PENCIL_LOOK;
  const plan = buildPencilPlan(spec);
  const { W, H, scene } = plan;
  const contourOnly = opts.layers === 'contour';
  const overlay = opts.overlay !== false && !contourOnly;
  const background = opts.background !== false;
  const paperL = contourOnly ? 255 : paperLevel(look.paperTone);
  const paper = gray(paperL);
  const tone = (d: number) => (contourOnly ? gray(255) : gray(paperL * (1 - clamp(d, 0, 0.97))));
  const fillAt = (v: number) => {
    const i = clamp(Math.floor(v), 0, 2);
    return lerp(look.fill[i] as number, look.fill[i + 1] as number, clamp(v - i, 0, 1));
  };
  const ink = gray(look.contour.ink);
  // def ids from the picture's own hash: an annotation-only edit leaves the picture layer byte-identical
  const id = `p${structureHash(spec, look).slice(0, 10)}`;
  const ids = {

    tm: `${id}-tm`,
    tmg: `${id}-tmg`,
    gf: `${id}-gf`,
    sm: `${id}-sm`,
    k: (k: number) => `${id}-k${k}`,
    m: (k: number) => `${id}-m${k}`,
  };
  const pids = paperIds(id);
  const W2 = { w: (band: DepthBand) => look.outline[band] * look.contour.scale };
  const motion = subjectMotion(spec, plan);

  // ---- painter pass: fills + contours ------------------------------------
  const body: string[] = [];
  const defsLocal: string[] = [];
  const toneMap: string[] = [el('rect', { x: 0, y: 0, width: W, height: H, fill: gray(0) })];
  const gp = plan.ground;
  if (gp) {
    body.push(el('path', { d: polyPath(gp.poly), fill: contourOnly ? paper : `url(#${ids.gf})`, 'data-el': 'ground' }));
    toneMap.push(el('path', { d: polyPath(gp.poly), fill: `url(#${ids.tmg})` }));
    if (!contourOnly) {
      const rng = rngFor(spec.seed, 'ground-lines');
      const marks: string[] = [];
      for (const l of scene.ground) {
        if (l.kind === 'grid' || l.kind === 'horizon') continue;
        const seg = clipToFrame(l.pts[0], l.pts[1], W, H);
        if (!seg || !inFrame(seg, W, H, 0)) continue;
        const d = taperedStroke(seg, { w0: look.outline.bg * (l.kind === 'road' ? 1 : 0.8), rng, overshoot: 0.02, wobble: 0.3 });
        if (d) marks.push(el('path', { d, fill: ink, 'fill-opacity': clamp((l.kind === 'road' ? 0.45 : 0.3) * (1 + sym(rng) * 0.15), 0.05, 1) }));
      }
      if (marks.length) body.push(`<g data-el="ground-lines">${marks.join('')}</g>`);
    }
  }

  // construction lines: drawn first (over the ground only), running past the forms
  if (!contourOnly) {
    const cl = constructionLines(spec, plan);
    if (cl.length) {
      const c = look.construction;
      body.push(
        el('path', {
          d: cl.map((l) => polyPath(l, false)).join(''),
          fill: 'none',
          stroke: c.stroke,
          'stroke-opacity': c.opacity,
          'stroke-width': c.width,
          'data-layer': 'construction',
        }),
      );
    }
  }

  for (const it of plan.items) body.push(itemSvg(it));

  /** figure darkness at a fractional tone (piecewise linear over look.figure) */
  function figureAt(v: number): number {
    const t = clamp(v, 0, 3);
    const i = Math.min(2, Math.floor(t));
    return lerp(look.figure[i] as number, look.figure[i + 1] as number, t - i);
  }
  function figureDark(r: FigureRegion): number {
    // the shade is part-way from the lit tone to the next darker one; the hatch carries the rest
    return figureAt(r.kind === 'shade' ? lerp(r.base, r.tone, look.shade) : r.base);
  }
  /** tone the hatch masks see: lit sides a little lighter than their fill; skin stays clear of the hatch */
  function hatchTone(r: FigureRegion): number {
    if (r.material === 'skin') return Math.min(r.tone, 0.5);
    return r.kind === 'shade' ? r.tone : r.tone - look.litHatch;
  }

  /**
   * One face / hair / clothing mark: a thin tapered pencil stroke, graphite on
   * light parts and paper-light on dark ones (hair, dark cloth).
   */
  function detailMark(l: SubjectItem['lines'][number], s: SubjectItem, bandTone: number, band: DepthBand, rng: Rng): string {
    if (!inFrame(l.pts, W, H, 0)) return '';
    const on: PuppetMaterial = l.kind === 'face' || l.kind === 'faceMinor' ? 'skin' : l.kind === 'hair' ? 'hair' : (s.parts[l.after]?.material ?? 'top');
    const dark = figureAt(figurePartTone(bandTone, band, on, s.style)) > 0.5;
    const face = clamp(s.headPx * 0.026, 0.6, 2.6);
    const w0 = l.kind === 'face' ? face : l.kind === 'faceMinor' ? face * 0.7 : l.kind === 'hair' ? face * 0.8 : clamp(s.heightPx * 0.0022, 0.5, 1.6);
    const d = taperedStroke(l.pts, { w0, rng, overshoot: 0.02, wobble: Math.min(0.3, w0 * 0.2) });
    if (!d) return '';
    const o = l.kind === 'cloth' ? 0.5 : l.kind === 'hair' ? 0.45 : 0.8;
    return el('path', { d, fill: dark ? paper : ink, 'fill-opacity': clamp((dark ? o * 0.75 : o) * (1 + sym(rng) * 0.1), 0.05, 1), 'data-mark': l.key });
  }

  function itemSvg(it: PlanItem): string {
    const g: string[] = [`<g${attrs({ 'data-el': it.key })}>`];
    if (it.type === 'prop') {
      const rng = rngFor(spec.seed, `contour:${it.key}`);
      const env = it.item.env;
      for (const f of it.faces) {
        g.push(el('path', { d: polyPath(f.pts), fill: tone(look.fill[f.tone] as number) }));
        toneMap.push(el('path', { d: polyPath(f.pts), fill: toneGray(f.tone) }));
      }
      const w0 = W2.w(it.band) * (env ? 0.85 : 1);
      // decor (windows, panels, floors): thin single strokes. The set shell's
      // decor (rows of windows, leaf clumps, skirting) is many short lines: one
      // plain stroked path keeps a street frame light; set pieces keep the hand.
      const drng = rngFor(spec.seed, `decor:${it.key}`);
      let plain = '';
      for (const f of it.item.faces) {
        for (const seg of f.decor) {
          const s = clipToFrame(seg[0] as V2, seg[1] as V2, W, H);
          if (!s || !inFrame(s, W, H, 0)) continue;
          if (env) {
            plain += `M${num(s[0][0])} ${num(s[0][1])}L${num(s[1][0])} ${num(s[1][1])}`;
            continue;
          }
          const d = taperedStroke(s, { w0: w0 * 0.5, rng: drng, overshoot: 0.02, wobble: 0.3 });
          if (d) g.push(el('path', { d, fill: ink, 'fill-opacity': clamp(0.6 * (1 + sym(drng) * 0.15), 0.05, 1) }));
        }
      }
      if (plain)
        g.push(el('path', { d: plain, fill: 'none', stroke: ink, 'stroke-width': num(Math.max(0.6, w0 * 0.42)), 'stroke-opacity': 0.4, 'stroke-linecap': 'round' }));
      const runs: Run[] = [];
      for (const e of it.edges) {
        const s = clipToFrame(e.a, e.b, W, H);
        if (!s || !inFrame(s, W, H, 0)) continue;
        runs.push({ pts: s, n: e.crease ? null : e.n, crease: e.crease });
      }
      g.push(contourPaths(runs, w0, rng, look, plan.lightScreen, ink));
    } else if (it.type === 'shadow') {
      // contact shadow: drawn by the T3 hatch + smudge only (soft, no hard disc)
      toneMap.push(el('path', { d: polyPath(it.pts), fill: toneGray(it.tone) }));
      return '';
    } else {
      const s = it.item;
      const rng = rngFor(spec.seed, `contour:${it.key}`);
      // w₀ by depth band, leaned on a little harder for a figure that fills the frame
      const w0 = W2.w(it.band) * clamp(Math.sqrt(s.heightPx / 600), 0.85, 1.45);
      const outline = figureOutline(it.parts, s, W, H);
      const u = motion.get(s.id);
      if (u && !contourOnly) g.push(motionMarks(outline, s, u, w0, rngFor(spec.seed, `motion:${it.key}`), look, W, H));
      if (it.parts.length) {
        if (contourOnly) g.push(el('path', { d: it.parts.map((p) => polyPath(p)).join(''), fill: paper }));
        else {
          // painter-ordered toned regions; consecutive regions of one grey share a
          // path; a group's detail marks follow its regions
          let d = '';
          let cur = '';
          const flush = () => {
            if (d) g.push(el('path', { d, fill: cur }));
            d = '';
          };
          const marks = it.band === 'fg' ? [] : s.lines.filter((l) => detailVisible(l.kind, s.headPx, s.heightPx));
          const groupOf = (k: number) => s.parts[k]?.group ?? '';
          const done = new Set<number>();
          const lrng = rngFor(spec.seed, `marks:${it.key}`);
          const emit = (group: string | null) => {
            for (let k = 0; k < marks.length; k++) {
              const l = marks[k]!;
              if (done.has(k) || (group !== null && groupOf(l.after) !== group)) continue;
              done.add(k);
              const svg = detailMark(l, s, it.tone, it.band, lrng);
              if (svg) {
                flush();
                g.push(svg);
              }
            }
          };
          for (let k = 0; k < it.regions.length; k++) {
            const r = it.regions[k]!;
            const f = tone(figureDark(r));
            if (f !== cur) {
              flush();
              cur = f;
            }
            d += polyPath(r.pts);
            const next = it.regions[k + 1];
            if (!next || groupOf(next.part) !== groupOf(r.part)) emit(groupOf(r.part));
          }
          flush();
          emit(null);
        }
        // the hatch sees the lit side a little lighter than its fill tone: lit side sparse, shade side dense
        for (const r of it.regions) toneMap.push(el('path', { d: polyPath(r.pts), fill: toneGray(hatchTone(r)) }));
      }
      g.push(contourPaths(loopRuns(outline, rng, s.heightPx, W, H), w0, rng, look, plan.lightScreen, ink));
    }
    g.push('</g>');
    return g.join('');
  }

  // ---- defs ---------------------------------------------------------------
  const defs: string[] = [...defsLocal];

  if (gp) {
    const grad = (gid: string, color: (v: number) => string) =>
      `<linearGradient${attrs({ id: gid, gradientUnits: 'userSpaceOnUse', x1: gp.from[0], y1: gp.from[1], x2: gp.to[0], y2: gp.to[1] })}>` +
      gp.stops.map((s) => el('stop', { offset: s.o, 'stop-color': color(s.v) })).join('') +
      '</linearGradient>';
    defs.push(grad(ids.tmg, (v) => toneGray(v)));
    if (!contourOnly) defs.push(grad(ids.gf, (v) => tone(fillAt(v))));
  }
  const hatch: string[] = [];
  let smudge = '';
  if (!contourOnly) {
    defs.push(`<g${attrs({ id: ids.tm })}>${toneMap.join('')}</g>`);
    const coarse = toneRaster(plan, 4);
    // Filters and masks only cover the box of their tone band: blur cost in
    // resvg scales with the filter region, and an empty band costs nothing.
    const region = (thr: number, pad: number) => {
      const b = bandBox(coarse, thr);
      if (!b) return null;
      const x0 = Math.max(0, b.x0 - pad);
      const y0 = Math.max(0, b.y0 - pad);
      return { x: x0, y: y0, width: Math.min(W, b.x1 + pad) - x0, height: Math.min(H, b.y1 + pad) - y0 };
    };
    const blurPad = Math.ceil(look.maskBlur * 3) + 6;
    const raster = dilate(coarse, 2);
        for (const k of [1, 2, 3] as const) {
      const box = region(k - 1 + 0.02, blurPad);
      if (!box) continue;
      const c = -(k - 1);
      defs.push(
        `<filter${attrs({ id: ids.k(k), filterUnits: 'userSpaceOnUse', ...box, 'color-interpolation-filters': 'sRGB' })}>` +
          el('feColorMatrix', { type: 'matrix', values: `3 0 0 0 ${c} 3 0 0 0 ${c} 3 0 0 0 ${c} 0 0 0 0 1` }) +
          el('feGaussianBlur', { stdDeviation: look.maskBlur }) +
          '</filter>',
      );
      defs.push(
        `<mask${attrs({ id: ids.m(k), maskUnits: 'userSpaceOnUse', ...box })}>${el('use', { href: `#${ids.tm}`, filter: `url(#${ids.k(k)})` })}</mask>`,
      );
      // hatch field, culled on the coarse tone raster (the SVG mask draws the real, softened edge)
      const thr = k - 1 + 0.02;
      const keep = (a: V2, b: V2) => {
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(2, Math.ceil(L / 6));
        for (let q = 0; q <= n; q++) {
          const t = q / n;
          if (sample(raster, lerp(a[0], b[0], t), lerp(a[1], b[1], t)) > thr) return true;
        }
        return false;
      };
      const buckets = hatchField(spec.seed, k, look, W, H, keep);
      const op = look.hatch.opacity[k - 1] as number;
      let paths = '';
      buckets.forEach((list, bi) => {
        if (!list.length) return;
        const o = clamp(op * (1 + ((bi - 2) / 2) * look.hatch.jitter), 0.02, 1);
        paths += el('path', { d: list.join(''), fill: gray(look.hatch.ink[k - 1] as number), 'fill-opacity': o });
      });
      if (paths) hatch.push(`<g${attrs({ mask: `url(#${ids.m(k)})`, 'data-layer': `hatch-${k}` })}>${paths}</g>`);
    }
    const a = look.smudge.opacity;
    const sbox = a > 0 ? region(2.02, Math.ceil(look.smudge.blur * 3) + 6) : null;
    if (sbox) {
      const i = num(look.smudge.ink / 255);
      defs.push(
        `<filter${attrs({ id: ids.sm, filterUnits: 'userSpaceOnUse', ...sbox, 'color-interpolation-filters': 'sRGB' })}>` +
          el('feColorMatrix', { type: 'matrix', values: `0 0 0 0 ${i} 0 0 0 0 ${i} 0 0 0 0 ${i} ${num(3 * a)} 0 0 0 ${num(-2 * a)}` }) +
          el('feGaussianBlur', { stdDeviation: look.smudge.blur }) +
          '</filter>',
      );
      smudge = el('use', { href: `#${ids.tm}`, filter: `url(#${ids.sm})`, 'data-layer': 'smudge' });
    }
  }
  if (!contourOnly && background) defs.push(paperDefs(pids, look.grain, look.vignette));

  // ---- assemble -------------------------------------------------------------
  const out: string[] = [svgOpen(W, H, opts.width)];
  out.push(`<defs>${defs.join('')}</defs>`);
  if (background) out.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: paper }));
  out.push('<g data-layer="picture">');
  out.push(body.join(''));
  if (!contourOnly) {
    out.push(smudge);
    out.push(hatch.join(''));
    if (background) out.push(paperOverlay(pids, W, H, look.grain, look.vignette));
  }
  out.push('</g>');
  // widescreen frame line
  out.push(el('rect', { x: 1.5, y: 1.5, width: W - 3, height: H - 3, fill: 'none', stroke: gray(contourOnly ? 255 : 22), 'stroke-width': 4 }));
  if (overlay) out.push(pencilOverlaySvg(spec, scene, { paper, code: opts.code ?? null }));
  out.push('</svg>');
  return out.join('');
}

/** Ground tone value at a frame point (0..3) — exposed for tests. */
export function pencilGroundValue(spec: BoardSpec, x: number, y: number): number {
  const plan = buildPencilPlan(spec);
  return plan.ground ? groundValueAt(plan.ground, x, y) : 0;
}
