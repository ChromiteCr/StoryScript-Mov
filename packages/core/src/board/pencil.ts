/**
 * Pencil renderer: BoardSpec → "loose widescreen pencil storyboard" SVG.
 * Pure, deterministic, greys only, presentation attributes only.
 *
 * Tone first, then line (docs/PLAN.md 分镜管线 step 5):
 *  1. paper ground;
 *  2. painter pass (same order as structure): flat graphite tone per region
 *     (opaque, so nearer shapes hide what is behind) with each shape's
 *     tapered contour drawn right after its fill;
 *  3. construction lines (horizon, vanishing lines, vertical convergence);
 *  4. a blurred graphite smudge under the darkest tone;
 *  5. three frame-wide hatch fields T1 / T2 / T3 in one direction (T3
 *     crossing), each masked by the blurred union of its tone and darker —
 *     one consistent hand, not per-object hachure;
 *  6. head-direction guides, paper grain, vignette, frame line;
 *  7. the annotation layer (optional, separate group).
 *
 * Every random quantity comes from rngFor(spec.seed, elementKey), so editing
 * one element never re-jitters another element's strokes.
 */
import type { BoardSpec } from '@storyscript/contracts';
import { contentHash, cyrb53 } from '../util/hash.ts';
import { rngFor } from '../util/random.ts';
import { projectPoint } from './camera.ts';
import { clamp, clipPolygonRect, clipSegmentRect, lerp, type V2 } from './math.ts';
import { arrowPx } from './overlay-geom.ts';
import { paperDefs, paperIds, paperOverlay } from './paper.ts';
import { DEFAULT_PENCIL_LOOK, paperLevel, type PencilLook } from './pencil-look.ts';
import { pencilOverlaySvg } from './pencil-overlay.ts';
import {
  buildPencilPlan,
  groundValueAt,
  toneRaster,
  type DepthBand,
  type PencilPlan,
  type PlanItem,
} from './pencil-plan.ts';
import { bandBox, dilate, fillPolygon, makeGrid, sample, traceLoops, type Grid } from './raster.ts';
import type { SubjectItem } from './scene.ts';
import { hatchMark, resample, splitLoop, sym, taperedStroke, type Rng } from './strokes.ts';
import { attrs, el, gray, num, polyPath } from './svg.ts';

export const PENCIL_VERSION = 'pencil-1';

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
  return contentHash({ v: PENCIL_VERSION, frame: spec.frame, camera: spec.camera, scene: spec.scene, seed: spec.seed, movers, look });
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
        w *= 0.85;
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
  let cell = clamp(it.heightPx / 260, 0.6, 3);
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
  // Lines come in "patches" of 5–12 neighbours laid by one sweep of the hand:
  // a patch shares a slight angle offset and pressure, while each line keeps
  // its own breaks (so no seams line up and the tone stays even at a distance).
  const prng = rngFor(seed, `hatch:${group}:patches`);
  let k = k0;
  while (k <= k1) {
    const size = 5 + Math.floor(prng() * 8);
    const pAngle = (sym(prng) * 2.2 * Math.PI) / 180;
    const pPress = sym(prng) * 0.6;
    const pWidth = 1 + sym(prng) * 0.08;
    for (let j = 0; j < size && k <= k1; j++, k++) {
      const rng = rngFor(seed, `hatch:${group}:${k}`);
      const o = (k + phase) * spacing + sym(rng) * 0.12 * spacing;
      let s = s0 - rng() * h.segMax;
      while (s < s1) {
        const L = h.segMin + Math.sqrt(rng()) * (h.segMax - h.segMin);
        const gap = h.gapMin + rng() * (h.gapMax - h.gapMin);
        const wob = pAngle + (sym(rng) * h.wobble * Math.PI) / 180;
        const off = sym(rng) * 0.6;
        const sagSign = rng() < 0.85 ? 1 : -1;
        const sag = L * h.bow * (0.4 + 0.8 * rng()) * sagSign;
        const wj = pWidth * (1 + sym(rng) * h.jitter);
        const oj = clamp(pPress + sym(rng) * 0.7, -1, 1);
        const cd: V2 = [Math.cos(theta + wob), -Math.sin(theta + wob)];
        const a: V2 = [nrm[0] * (o + off) + d[0] * s, nrm[1] * (o + off) + d[1] * s];
        const b: V2 = [a[0] + cd[0] * L, a[1] + cd[1] * L];
        s += L + gap;
        if (!keep(a, b)) continue;
        const bucket = clamp(Math.round((oj + 1) * 2), 0, 4);
        (buckets[bucket] as string[]).push(hatchMark(a, b, width * wj, sag));
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
  const id = `p${cyrb53(JSON.stringify(spec)).toString(36)}`;
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
  const guides: string[] = [];
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

  for (const it of plan.items) body.push(itemSvg(it));

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
      // decor (windows, panels, floors): thin single strokes
      const drng = rngFor(spec.seed, `decor:${it.key}`);
      for (const f of it.item.faces) {
        for (const seg of f.decor) {
          const s = clipToFrame(seg[0] as V2, seg[1] as V2, W, H);
          if (!s || !inFrame(s, W, H, 0)) continue;
          const d = taperedStroke(s, { w0: w0 * 0.5, rng: drng, overshoot: 0.02, wobble: 0.3 });
          if (d) g.push(el('path', { d, fill: ink, 'fill-opacity': clamp((env ? 0.4 : 0.6) * (1 + sym(drng) * 0.15), 0.05, 1) }));
        }
      }
      const runs: Run[] = [];
      for (const e of it.edges) {
        const s = clipToFrame(e.a, e.b, W, H);
        if (!s || !inFrame(s, W, H, 0)) continue;
        runs.push({ pts: s, n: e.crease ? null : e.n, crease: e.crease });
      }
      g.push(contourPaths(runs, w0, rng, look, plan.lightScreen, ink));
    } else if (it.type === 'shadow') {
      // contact shadow: drawn by the T3 hatch + smudge only (soft, no hard disc)
      toneMap.push(el('path', { d: polyPath(it.pts), fill: toneGray(3) }));
      return '';
    } else {
      const s = it.item;
      const rng = rngFor(spec.seed, `contour:${it.key}`);
      const w0 = W2.w(it.band);
      const outline = figureOutline(it.parts, s, W, H);
      const u = motion.get(s.id);
      if (u && !contourOnly) g.push(motionMarks(outline, s, u, w0, rngFor(spec.seed, `motion:${it.key}`), look, W, H));
      const union = it.parts.map((p) => polyPath(p)).join('');
      if (union) {
        const body = look.figure[clamp(it.tone, 0, 3)] as number;
        let fill = contourOnly ? paper : tone(body);
        if (!contourOnly && s.bbox) {
          // form: the silhouette is a little lighter on the lit side, darker on the shadow side
          const cx = (clamp(s.bbox.x0, 0, W) + clamp(s.bbox.x1, 0, W)) / 2;
          const cy = (clamp(s.bbox.y0, 0, H) + clamp(s.bbox.y1, 0, H)) / 2;
          const r = Math.max(8, Math.hypot(clamp(s.bbox.x1, 0, W) - clamp(s.bbox.x0, 0, W), clamp(s.bbox.y1, 0, H) - clamp(s.bbox.y0, 0, H)) / 2);
          const [lx, ly] = plan.lightScreen;
          const gid = `${id}-f-${s.id}`;
          defsLocal.push(
            `<linearGradient${attrs({ id: gid, gradientUnits: 'userSpaceOnUse', x1: cx + lx * r, y1: cy + ly * r, x2: cx - lx * r, y2: cy - ly * r })}>` +
              el('stop', { offset: 0, 'stop-color': tone(body * 0.8) }) +
              el('stop', { offset: 1, 'stop-color': tone(body + (1 - body) * 0.2) }) +
              '</linearGradient>',
          );
          fill = `url(#${gid})`;
        }
        g.push(el('path', { d: union, fill }));
        toneMap.push(el('path', { d: union, fill: toneGray(it.tone) }));
        if (!contourOnly) {
          // hair a little darker, the face plane a little lighter: facing reads, no features drawn
          const fit = (q: V2[]) => clipPolygonRect(q, -64, -64, W + 64, H + 64);
          const hair = s.parts.filter((p) => p.fill === 'hair').map((p) => polyPath(fit(p.pts))).join('');
          const face = s.parts.filter((p) => p.fill === 'body' && !p.silhouette).map((p) => polyPath(fit(p.pts))).join('');
          if (hair) g.push(el('path', { d: hair, fill: tone(body + (1 - body) * look.hair) }));
          if (face) g.push(el('path', { d: face, fill: tone(body * look.face) }));
        }
      }
      g.push(contourPaths(loopRuns(outline, rng, s.heightPx, W, H), w0, rng, look, plan.lightScreen, ink));
      // head-direction guide (a faint line, not a face)
      const mer = s.lines.find((l) => l.key === 'faceMeridian');
      if (mer && !contourOnly && inFrame(mer.pts, W, H, 0)) {
        const grng = rngFor(spec.seed, `guide:${it.key}`);
        const dark = (look.figure[clamp(it.tone, 0, 3)] as number) > 0.42;
        const d = taperedStroke(mer.pts, { w0: clamp(s.heightPx * 0.0045, 0.9, 3.2), rng: grng, overshoot: 0.02, wobble: 0.2 });
        if (d)
          guides.push(
            `<g${attrs({ 'data-el': `guide:${s.id}` })}>${el('path', { d, fill: dark ? paper : ink, 'fill-opacity': dark ? 0.55 : 0.45 })}</g>`,
          );
      }
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
    const inkH = gray(look.hatch.ink);
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
        paths += el('path', { d: list.join(''), fill: inkH, 'fill-opacity': o });
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
    const cl = constructionLines(spec, plan);
    if (cl.length) {
      const c = look.construction;
      out.push(
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
    out.push(smudge);
    out.push(hatch.join(''));
    out.push(guides.join(''));
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
