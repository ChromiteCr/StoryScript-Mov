/**
 * Pencil tone plan: BoardSpec → painter-ordered tone regions (0 = paper … 3 =
 * darkest), shared by the pencil renderer, its masks and the look metrics.
 * Uses exactly the structure renderer's projection and painter order
 * (buildFrameScene), so the composition is identical.
 *
 * Tone rules (docs/PLAN.md, 分镜管线 step 5):
 *  - people by depth band: fg 3 / mg 2 / bg 1 (tone_override wins);
 *  - boxes by face vs light: lit 1, side 2, away 3 (environment shell one lighter);
 *  - ground: near → far 2 → 1 → 0 (aerial perspective), sky 0;
 *  - contact shadow under each person: 3.
 *
 * Light convention: `azimuth_deg` swings the light from behind the camera
 * (0) toward the camera's left; direction to the light =
 * (−sin az·cos el, sin el, −cos az·cos el). The layout default (45°, 40°)
 * is the illustrator's upper-left light.
 */
import type { BoardSpec } from '@storyscript/contracts';
import { NEAR_M, projectPoint, projectPolygon, toCamera, unprojectToPlane } from './camera.ts';
import { clamp, clipPolygon, clipPolygonRect, DEG, dot3, lerp, mix2, polygonArea, type V2, type V3 } from './math.ts';
import { poseTopY } from './puppets.ts';
import { fillPolygon, makeGrid, type Grid } from './raster.ts';
import { buildFrameScene, type FrameScene, type PropItem, type SubjectItem } from './scene.ts';

export type DepthBand = 'fg' | 'mg' | 'bg';
export const BAND_TONE: Record<DepthBand, number> = { fg: 3, mg: 2, bg: 1 };

export interface PencilSubjectInfo {
  id: string;
  band: DepthBand;
  tone: number;
  /** camera-space depth of the body centre (m) */
  depth: number;
}

export interface PlanFace {
  pts: V2[];
  tone: number;
  sub: number;
}

export interface PlanEdge {
  a: V2;
  b: V2;
  /** crease between two visible faces of the same box (drawn lighter) */
  crease: boolean;
  /** outward screen normal (silhouette edges) */
  n: V2;
}

export type PlanItem =
  | { type: 'prop'; key: string; item: PropItem; band: DepthBand; faces: PlanFace[]; edges: PlanEdge[] }
  | { type: 'shadow'; key: string; subjectId: string; pts: V2[] }
  | { type: 'subject'; key: string; item: SubjectItem; band: DepthBand; tone: number; parts: V2[][] };

export interface GroundPlan {
  /** ground region (frame px) */
  poly: V2[];
  /** gradient axis, far (horizon side) → near */
  from: V2;
  to: V2;
  /** continuous tone value 0..3 along the axis */
  stops: { o: number; v: number }[];
}

export interface PencilPlan {
  W: number;
  H: number;
  scene: FrameScene;
  /** world direction toward the light */
  light: V3;
  /** screen direction toward the light (unit, y down) */
  lightScreen: V2;
  /** camera depth of the reference (mid-ground) plane */
  refDepth: number;
  subjects: PencilSubjectInfo[];
  ground: GroundPlan | null;
  items: PlanItem[];
}

export function lightDirection(spec: BoardSpec): V3 {
  const az = spec.scene.light.azimuth_deg * DEG;
  const el = spec.scene.light.elevation_deg * DEG;
  return [-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/** Depth bands from the camera-axis depth ratio to the nearest person (fg 0.6 / mg 1 / bg 2 in layout). */
export function subjectBands(spec: BoardSpec, scene: FrameScene = buildFrameScene(spec)): PencilSubjectInfo[] {
  const b = scene.basis;
  const rows = spec.scene.subjects.map((s) => ({
    s,
    depth: toCamera(b, [s.x, 0.5 * poseTopY(s.pose) * s.height_m, s.z])[2],
  }));
  const ahead = rows.filter((r) => r.depth > NEAR_M);
  const dmin = ahead.length ? Math.min(...ahead.map((r) => r.depth)) : 1;
  const spread = ahead.length > 1 ? Math.max(...ahead.map((r) => r.depth)) / dmin : 1;
  return rows.map(({ s, depth }) => {
    let band: DepthBand = 'mg';
    if (spread >= 1.4) {
      const r = depth / dmin;
      band = r < 1.4 ? 'fg' : r >= 2.6 ? 'bg' : 'mg';
    }
    const tone = s.tone_override ?? BAND_TONE[band];
    return { id: s.id, band, tone, depth };
  });
}

function referenceDepth(scene: FrameScene, subjects: PencilSubjectInfo[]): number {
  const mg = subjects.filter((s) => s.band === 'mg' && s.depth > NEAR_M);
  if (mg.length) return Math.min(...mg.map((s) => s.depth));
  const fg = subjects.filter((s) => s.band === 'fg' && s.depth > NEAR_M);
  if (fg.length) return Math.min(...fg.map((s) => s.depth)) / 0.6;
  const bg = subjects.filter((s) => s.depth > NEAR_M);
  if (bg.length) return Math.min(...bg.map((s) => s.depth)) / 2;
  // no people: the non-environment prop nearest the frame centre
  let best = Infinity;
  let depth = 5;
  for (const it of scene.items) {
    if (it.type !== 'prop' || it.env) continue;
    const pts = it.faces.flatMap((f) => f.pts);
    if (!pts.length) continue;
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const d = Math.hypot(cx / scene.W - 0.5, cy / scene.H - 0.5);
    if (d < best && it.depth > NEAR_M) {
      best = d;
      depth = it.depth;
    }
  }
  return depth;
}

/** Ground tone vs depth ratio ρ = depth / refDepth. */
export function groundTone(rho: number): number {
  if (!Number.isFinite(rho) || rho <= 0) return 0;
  if (rho <= 0.5) return 2;
  if (rho <= 0.95) return lerp(2, 1, (rho - 0.5) / 0.45);
  if (rho <= 1.7) return 1;
  if (rho <= 3.2) return lerp(1, 0, (rho - 1.7) / 1.5);
  return 0;
}

function groundPlan(spec: BoardSpec, scene: FrameScene, refDepth: number): GroundPlan | null {
  const { W, H } = scene;
  const b = scene.basis;
  const frame: V2[] = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ];
  let poly: V2[];
  let from: V2;
  let to: V2;
  if (scene.horizon) {
    const [h0, h1] = scene.horizon;
    const dx = h1[0] - h0[0];
    const dy = h1[1] - h0[1];
    const l = Math.hypot(dx, dy) || 1;
    let n: V2 = [-dy / l, dx / l];
    // the ground side: where a ground point just ahead of the camera projects
    const probe = projectPoint(b, [b.pos[0] + b.fwd[0] * 3, 0, b.pos[2] + b.fwd[2] * 3]);
    const side = probe.visible ? (probe.x * W - h0[0]) * n[0] + (probe.y * H - h0[1]) * n[1] : n[1];
    if (side < 0) n = [-n[0], -n[1]];
    const f = (p: V2) => (p[0] - h0[0]) * n[0] + (p[1] - h0[1]) * n[1];
    poly = clipPolygon(frame, f, mix2);
    if (poly.length < 3) return null;
    const c: V2 = [W / 2, H / 2];
    const t = f(c);
    from = [c[0] - n[0] * t, c[1] - n[1] * t];
    const reach = Math.max(...frame.map(f));
    if (reach <= 0) return null;
    to = [from[0] + n[0] * reach, from[1] + n[1] * reach];
  } else {
    poly = frame;
    from = [W / 2, 0];
    to = [W / 2, H];
  }
  const stops: { o: number; v: number }[] = [];
  const N = 14;
  // looking steeply down, the floor is the backdrop: one light tone, no aerial ramp
  const steep = spec.camera.pitch_deg < -60;
  for (let k = 0; k <= N; k++) {
    const o = k / N;
    const p: V2 = [lerp(from[0], to[0], o), lerp(from[1], to[1], o)];
    const g = unprojectToPlane(spec.camera, spec.frame.aspect, p[0] / W, p[1] / H, 0);
    const v = steep ? 0.5 : g ? groundTone(toCamera(b, g)[2] / refDepth) : 0;
    stops.push({ o, v: Math.round(v * 1000) / 1000 });
  }
  return { poly, from, to, stops };
}

/** Continuous ground tone at a px position (gradient along from → to). */
export function groundValueAt(gp: GroundPlan, x: number, y: number): number {
  const ax = gp.to[0] - gp.from[0];
  const ay = gp.to[1] - gp.from[1];
  const L2 = ax * ax + ay * ay || 1;
  const t = clamp(((x - gp.from[0]) * ax + (y - gp.from[1]) * ay) / L2, 0, 1);
  const s = gp.stops;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1] as { o: number; v: number };
    const c = s[i] as { o: number; v: number };
    if (t <= c.o) return lerp(a.v, c.v, (t - a.o) / (c.o - a.o || 1));
  }
  return (s[s.length - 1] as { v: number }).v;
}

/**
 * Box faces: lit 1, side 2, turned away 3. A lit top plane is the light one
 * (the draughtsman's convention: tops lightest, then the lit side, then the
 * shadow side); otherwise the brightest visible face. The environment shell
 * (room walls, street blocks) stays paper except its shadowed planes, so
 * people and props carry the tone.
 */
function faceTones(ns: readonly V3[], L: V3, env: boolean): number[] {
  const dots = ns.map((n) => dot3(n, L));
  if (env) return dots.map((d) => (d > 0.1 ? 0 : 1));
  const top = ns.findIndex((n, i) => n[1] > 0.9 && (dots[i] as number) > 0.1);
  const max = Math.max(...dots);
  return dots.map((d, i) => (d <= 0.1 ? 3 : top >= 0 ? (i === top ? 1 : 2) : d >= max - 0.08 ? 1 : 2));
}

const edgeKey = (p: V2) => `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)}`;

function propEdges(faces: PropItem['faces']): PlanEdge[] {
  const out: PlanEdge[] = [];
  const subs = new Map<number, PropItem['faces']>();
  for (const f of faces) {
    const l = subs.get(f.sub);
    if (l) l.push(f);
    else subs.set(f.sub, [f]);
  }
  for (const [, list] of [...subs.entries()].sort((a, b) => a[0] - b[0])) {
    const count = new Map<string, number>();
    const all = list.flatMap((f) => f.pts);
    const cx = all.reduce((a, p) => a + p[0], 0) / Math.max(1, all.length);
    const cy = all.reduce((a, p) => a + p[1], 0) / Math.max(1, all.length);
    const edges: { a: V2; b: V2; k: string }[] = [];
    for (const f of list) {
      for (let i = 0; i < f.pts.length; i++) {
        const a = f.pts[i] as V2;
        const b = f.pts[(i + 1) % f.pts.length] as V2;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) continue;
        const ka = edgeKey(a);
        const kb = edgeKey(b);
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        count.set(k, (count.get(k) ?? 0) + 1);
        edges.push({ a, b, k });
      }
    }
    const done = new Set<string>();
    for (const e of edges) {
      if (done.has(e.k)) continue;
      done.add(e.k);
      const crease = (count.get(e.k) ?? 0) > 1;
      const dx = e.b[0] - e.a[0];
      const dy = e.b[1] - e.a[1];
      const l = Math.hypot(dx, dy) || 1;
      let n: V2 = [-dy / l, dx / l];
      const mx = (e.a[0] + e.b[0]) / 2 - cx;
      const my = (e.a[1] + e.b[1]) / 2 - cy;
      if (n[0] * mx + n[1] * my < 0) n = [-n[0], -n[1]];
      out.push({ a: e.a, b: e.b, crease, n });
    }
  }
  return out;
}

/** Orient every polygon counter-clockwise (screen) so one nonzero path is their union. */
export function orientAll(polys: readonly V2[][]): V2[][] {
  return polys.filter((p) => p.length >= 3).map((p) => (polygonArea(p) < 0 ? p.slice().reverse() : p));
}

function shadowPolygon(spec: BoardSpec, scene: FrameScene, id: string, L: V3): V2[] {
  const s = spec.scene.subjects.find((q) => q.id === id);
  if (!s) return [];
  const h = s.height_m * poseTopY(s.pose);
  let gx = -L[0];
  let gz = -L[2];
  const gl = Math.hypot(gx, gz);
  if (gl < 1e-6) {
    gx = 0;
    gz = 1;
  } else {
    gx /= gl;
    gz /= gl;
  }
  const along = 0.24 * h;
  const across = 0.12 * h;
  const cx = s.x + gx * 0.1 * h;
  const cz = s.z + gz * 0.1 * h;
  const pts: V3[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (2 * Math.PI * i) / 24;
    const u = Math.cos(a) * along;
    const v = Math.sin(a) * across;
    pts.push([cx + gx * u - gz * v, 0.002, cz + gz * u + gx * v]);
  }
  return projectPolygon(scene.basis, pts).map((p) => [p[0] * scene.W, p[1] * scene.H] as V2);
}

/** Margin (px) kept around the frame when clipping fill polygons. */
export const FILL_MARGIN = 64;

export function buildPencilPlan(spec: BoardSpec): PencilPlan {
  const scene = buildFrameScene(spec);
  const { W, H } = scene;
  // Near-plane-clipped faces can project to ~1e5 px; keep fills near the frame
  // (tiny-skia can fail on such coordinates next to filters, and they add nothing).
  const fit = (poly: readonly V2[]): V2[] => clipPolygonRect(poly, -FILL_MARGIN, -FILL_MARGIN, W + FILL_MARGIN, H + FILL_MARGIN);
  const b = scene.basis;
  const L = lightDirection(spec);
  let lx = dot3(L, b.right);
  let ly = -dot3(L, b.up);
  const ll = Math.hypot(lx, ly);
  if (ll < 0.15) {
    lx = -Math.SQRT1_2;
    ly = -Math.SQRT1_2;
  } else {
    lx /= ll;
    ly /= ll;
  }
  const subjects = subjectBands(spec, scene);
  const refDepth = referenceDepth(scene, subjects);
  const info = new Map(subjects.map((s) => [s.id, s]));
  const items: PlanItem[] = [];
  for (const it of scene.items) {
    if (it.type === 'prop') {
      const r = it.depth / refDepth;
      const band: DepthBand = it.env ? 'bg' : r < 0.75 ? 'fg' : r <= 1.8 ? 'mg' : 'bg';
      const tones = new Map<number, number[]>();
      for (const f of it.faces) if (!tones.has(f.sub)) tones.set(f.sub, faceTones(it.faces.filter((q) => q.sub === f.sub).map((q) => q.n), L, it.env));
      const seen = new Map<number, number>();
      const faces = it.faces
        .map((f) => {
          const k = seen.get(f.sub) ?? 0;
          seen.set(f.sub, k + 1);
          return { pts: fit(f.pts), tone: tones.get(f.sub)?.[k] ?? 2, sub: f.sub };
        })
        .filter((f) => f.pts.length >= 3);
      items.push({ type: 'prop', key: `prop:${it.id}`, item: it, band, faces, edges: propEdges(it.faces) });
    } else {
      const s = info.get(it.id);
      const shadow = fit(shadowPolygon(spec, scene, it.id, L));
      if (shadow.length >= 3) items.push({ type: 'shadow', key: `shadow:${it.id}`, subjectId: it.id, pts: shadow });
      const parts = orientAll(it.parts.filter((p) => p.fill !== 'none').map((p) => fit(p.pts)));
      items.push({ type: 'subject', key: `subject:${it.id}`, item: it, band: s?.band ?? 'mg', tone: s?.tone ?? 2, parts });
    }
  }
  return {
    W,
    H,
    scene,
    light: L,
    lightScreen: [lx, ly],
    refDepth,
    subjects,
    ground: groundPlan(spec, scene, refDepth),
    items,
  };
}

/** Coarse tone raster (cell px) in painter order — used to cull hatch strokes. */
export function toneRaster(plan: PencilPlan, cell = 4): Grid {
  const g = makeGrid(0, 0, plan.W, plan.H, cell);
  const gp = plan.ground;
  if (gp) fillPolygon(g, gp.poly, (x, y) => groundValueAt(gp, x, y));
  for (const it of plan.items) {
    if (it.type === 'prop') for (const f of it.faces) fillPolygon(g, f.pts, f.tone);
    else if (it.type === 'shadow') fillPolygon(g, it.pts, 3);
    else for (const p of it.parts) fillPolygon(g, p, it.tone);
  }
  return g;
}
