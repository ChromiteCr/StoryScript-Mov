/**
 * Pencil tone plan: BoardSpec → painter-ordered tone regions (0 = paper … 3 =
 * darkest), shared by the pencil renderer, its masks and the look metrics.
 * Uses exactly the structure renderer's projection and painter order
 * (buildFrameScene), so the composition is identical.
 *
 * Tone rules (docs/PLAN.md, 分镜管线 step 5):
 *  - people by depth band: fg 3 / mg 2 / bg 1 (tone_override wins), each part
 *    offset by its material (S4c): skin −1½, hair +1, clothing by the
 *    character's wardrobe −½ / 0 / +½, shoes +1; a foreground figure takes
 *    only 0.3 of the offsets, so it stays a near-black silhouette;
 *  - boxes by face vs light: lit top 0 (paper), lit side 1, side 2, away 3
 *    (environment shell: lit 0, else 1);
 *  - ground: near → far 2 → 1 → 0 in laid-in blocks (aerial perspective), sky 0;
 *    looking steeply down, one light tone;
 *  - contact shadow under each person and cast shadow of furniture-scale props: 3
 *    (2.3 seen from high above).
 *
 * Light convention: `azimuth_deg` swings the light from behind the camera
 * (0) toward the camera's left; direction to the light =
 * (−sin az·cos el, sin el, −cos az·cos el). The layout default (45°, 40°)
 * is the illustrator's upper-left light.
 */
import type { BoardProp, BoardSpec } from '@storyscript/contracts';
import { NEAR_M, projectPoint, projectPolygon, toCamera, unprojectToPlane } from './camera.ts';
import { clamp, clipPolygon, clipPolygonRect, convexHull, DEG, dot3, lerp, mix2, polygonArea, type V2, type V3 } from './math.ts';
import { CLOTH_OFFSET, type FigureStyle } from './puppet-style.ts';
import { poseTopY, type PuppetMaterial } from './puppets.ts';
import { fillPolygon, makeGrid, type Grid } from './raster.ts';
import { buildFrameScene, propWorldBoxes, type FrameScene, type PropItem, type SubjectItem } from './scene.ts';

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

/**
 * One toned patch of a figure, in painter order: the lit side of a puppet
 * part at its tone ('body'), or the part in shade ('shade', one tone darker —
 * form shading per limb). A part's tone is the figure's band tone plus its
 * material's offset (`base`, fractional).
 */
export interface FigureRegion {
  pts: V2[];
  tone: number;
  kind: 'body' | 'shade';
  /** the part's own (lit) tone */
  base: number;
  material: PuppetMaterial;
  /** index of the puppet part in SubjectItem.parts */
  part: number;
}

/** How much of the material offsets a figure in each depth band takes. */
export const MATERIAL_WEIGHT: Record<DepthBand, number> = { fg: 0.3, mg: 1, bg: 1 };

/** Tone (0..3) of a figure part: band tone + material offset (+1 for a far-side limb). */
export function figurePartTone(bandTone: number, band: DepthBand, material: PuppetMaterial, style: FigureStyle, far = false): number {
  const off =
    material === 'skin' ? -1.5 : material === 'hair' || material === 'shoe' ? 1 : CLOTH_OFFSET[material === 'top' ? style.top : style.bottom];
  return clamp(bandTone + off * MATERIAL_WEIGHT[band] + (far ? 1 : 0), 0, 3);
}

export type PlanItem =
  | { type: 'prop'; key: string; item: PropItem; band: DepthBand; faces: PlanFace[]; edges: PlanEdge[] }
  | { type: 'shadow'; key: string; /** the casting subject or prop */ owner: string; pts: V2[]; tone: number }
  | {
      type: 'subject';
      key: string;
      item: SubjectItem;
      band: DepthBand;
      tone: number;
      /** filled silhouette parts (counter-clockwise, their nonzero union is the figure) */
      parts: V2[][];
      /** toned regions in painter order */
      regions: FigureRegion[];
    };

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
  // laid-in blocks (near 2, middle 1, far paper) with short blends, not a smooth ramp
  const step = (x: number, at: number, w: number) => clamp((x - (at - w)) / (2 * w), 0, 1);
  return 2 - step(rho, GROUND_BANDS[0], 0.06) - step(rho, GROUND_BANDS[1], 0.12);
}

/** depth ratios (to the mid-ground plane) where the ground steps 2 → 1 and 1 → 0 */
export const GROUND_BANDS = [0.62, 1.35] as const;
/** ground tone when the camera looks steeply down (the floor is the backdrop) */
export const STEEP_GROUND = 0.45;

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
    const v = steep ? STEEP_GROUND : g ? groundTone(toCamera(b, g)[2] / refDepth) : 0;
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
 * Box faces, the draughtsman's convention: a lit top plane stays paper (0),
 * the brightest lit side is 1, other lit sides 2, planes turned away 3. The
 * environment shell (room walls, street blocks) stays paper except its
 * shadowed planes, so people and props carry the tone.
 */
function faceTones(ns: readonly V3[], L: V3, env: boolean): number[] {
  const dots = ns.map((n) => dot3(n, L));
  if (env) return dots.map((d) => (d > 0.1 ? 0 : 1));
  const top = ns.findIndex((n, i) => n[1] > 0.9 && (dots[i] as number) > 0.1);
  const max = Math.max(-1, ...dots.filter((_, i) => i !== top));
  return dots.map((d, i) => (i === top ? 0 : d <= 0.1 ? 3 : d >= max - 0.08 ? 1 : 2));
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
  if (s.pose === 'lie') {
    // along the body: from under the head (the subject's point) back to the feet
    const Y = s.yaw_deg * DEG;
    const F: V2 = [Math.sin(Y), -Math.cos(Y)];
    const Hm = s.height_m;
    const cx = s.x - F[0] * 0.45 * Hm;
    const cz = s.z - F[1] * 0.45 * Hm;
    const pts: V3[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (2 * Math.PI * i) / 24;
      const u = Math.cos(a) * 0.56 * Hm;
      const v = Math.sin(a) * 0.17 * Hm;
      pts.push([cx + F[0] * u - F[1] * v, 0.002, cz + F[1] * u + F[0] * v]);
    }
    return projectPolygon(scene.basis, pts).map((p) => [p[0] * scene.W, p[1] * scene.H] as V2);
  }
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
  const along = 0.2 * h;
  const across = 0.1 * h;
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

const CASTS_SHADOW = new Set<BoardProp['kind']>(['table', 'chair', 'car', 'box', 'bed', 'sofa', 'shelf', 'bag']);

/**
 * Cast shadow of a set prop on the plane it stands on (a box on a table
 * shadows the table top, the table shadows the floor): the convex hull of its
 * corners pushed along the light onto that plane, length capped for a low sun.
 */
function propShadow(spec: BoardSpec, scene: FrameScene, p: BoardProp, L: V3): V2[] {
  if (L[1] < 0.08) return [];
  const y0 = p.y;
  const reach = Math.min(Math.hypot(L[0], L[2]) / L[1], 2.5);
  const lx = L[0] / (Math.hypot(L[0], L[2]) || 1);
  const lz = L[2] / (Math.hypot(L[0], L[2]) || 1);
  const foot: V2[] = [];
  for (const box of propWorldBoxes(p, spec.camera))
    for (const c of box) {
      const up = c[1] - y0;
      foot.push([c[0] - lx * up * reach, c[2] - lz * up * reach]);
    }
  const hull = convexHull(foot);
  if (hull.length < 3) return [];
  const pts: V3[] = hull.map((q) => [q[0], y0 + 0.002, q[1]]);
  return projectPolygon(scene.basis, pts).map((q) => [q[0] * scene.W, q[1] * scene.H] as V2);
}

/** `poly` ∩ convex hull of `clip` (Sutherland–Hodgman against each hull edge). */
export function intersectConvex(poly: readonly V2[], clip: readonly V2[]): V2[] {
  const hull = convexHull(clip);
  if (hull.length < 3) return [];
  const sgn = polygonArea(hull) > 0 ? 1 : -1;
  let out: V2[] = poly.slice();
  for (let i = 0; i < hull.length && out.length >= 3; i++) {
    const a = hull[i] as V2;
    const b = hull[(i + 1) % hull.length] as V2;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    out = clipPolygon(out, (p) => sgn * (ex * (p[1] - a[1]) - ey * (p[0] - a[0])), mix2);
  }
  return out;
}

/** Minor-axis width (px) of a polygon from its vertex covariance (≈ limb thickness). */
export function minorWidth(poly: readonly V2[]): number {
  const n = poly.length;
  if (n < 3) return 0;
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const p of poly) {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  xx /= n;
  yy /= n;
  xy /= n;
  const tr = xx + yy;
  const det = xx * yy - xy * xy;
  const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  // a uniform ring of radius r has variance r²/2 per axis ⇒ width ≈ 2·√(2·λ)
  return 2 * Math.sqrt(2 * Math.max(0, l2));
}

/**
 * Lit part of a puppet part for form shading: the part intersected with a
 * copy of itself shifted toward the light by `frac` × its thickness. What is
 * left over (drawn first, one tone darker) is a crescent along the side and
 * end turned away from the light — it follows each limb, not one straight cut.
 */
export function litSide(poly: readonly V2[], light: V2, frac: number): V2[] {
  const w = minorWidth(poly);
  if (w < 2) return poly.slice();
  const d = frac * w;
  const moved = poly.map((p) => [p[0] + light[0] * d, p[1] + light[1] * d] as V2);
  const out = intersectConvex(poly, moved);
  return out.length >= 3 && Math.abs(polygonArea(out)) > 1 ? out : [];
}

/** Figure form shading: shift of the lit copy, as a fraction of the part's thickness. */
export const SHADE_SHIFT = 0.34;

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
  const steep = spec.camera.pitch_deg < -60;
  // seen from high above a shadow shows whole, right beside its owner: a little lighter
  const shadowTone = steep ? 2.3 : 3;
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
          // billboards (trees, the horizon band) and a blackboard carry a fixed tone
          return { pts: fit(f.pts), tone: f.tone ?? tones.get(f.sub)?.[k] ?? 2, sub: f.sub };
        })
        .filter((f) => f.pts.length >= 3);
      // furniture-scale set props cast a shadow; walls and buildings do not (their
      // shadow would be a stray patch far off on the paper-white ground)
      const prop = !it.env ? spec.scene.props.find((q) => q.id === it.id) : undefined;
      const casts = prop && prop.attach === 'world' && CASTS_SHADOW.has(prop.kind);
      const cast = casts ? fit(propShadow(spec, scene, prop, L)) : [];
      if (cast.length >= 3) items.push({ type: 'shadow', key: `shadow:${it.id}`, owner: it.id, pts: cast, tone: shadowTone });
      items.push({ type: 'prop', key: `prop:${it.id}`, item: it, band, faces, edges: propEdges(it.faces) });
    } else {
      const s = info.get(it.id);
      const shadow = fit(shadowPolygon(spec, scene, it.id, L));
      if (shadow.length >= 3) items.push({ type: 'shadow', key: `shadow:${it.id}`, owner: it.id, pts: shadow, tone: shadowTone });
      const tone = s?.tone ?? 2;
      const band = s?.band ?? 'mg';
      // the outline is the union of the silhouette parts; the face plane (not a
      // silhouette part) is toned as skin inside it
      const parts = orientAll(it.parts.filter((p) => p.fill !== 'none' && p.silhouette).map((p) => fit(p.pts)));
      const filled = it.parts.map((p, k) => ({ p, k })).filter(({ p }) => p.fill !== 'none');
      // Per run of one draw group and one material (a sleeve, a trouser leg,
      // the hair, the face — puppets.ts): every part's shade first, then the
      // lit sides on top. Inside a run the lit sides hide the seams, so a limb
      // shades as one form (no knee / elbow crescents); a later run — the face
      // over the hair, a hand over its sleeve — and a nearer group still cover
      // what is behind them.
      const regions: FigureRegion[] = [];
      let i = 0;
      while (i < filled.length) {
        const { group, material } = filled[i]!.p;
        let j = i;
        while (j < filled.length && filled[j]!.p.group === group && filled[j]!.p.material === material) j++;
        const shade: FigureRegion[] = [];
        const lit: FigureRegion[] = [];
        for (const { p, k } of filled.slice(i, j)) {
          const pts = orientAll([fit(p.pts)])[0];
          if (!pts) continue;
          // far-side limbs sit in the figure's own shadow: one tone darker, no split
          const base = figurePartTone(tone, band, p.material, it.style, p.far);
          const r = { base, material: p.material, part: k };
          if (base < 3) {
            // skin turns from the light softly: a full step reads as a stubble mask
            shade.push({ pts, tone: Math.min(3, base + (p.material === 'skin' ? 0.5 : 0.8)), kind: 'shade', ...r });
            // the torso is a broad, flat form: a narrow turn into shade, or it reads as a strap
            const l = litSide(pts, [lx, ly], p.group === 'torso' ? SHADE_SHIFT * 0.45 : SHADE_SHIFT);
            if (l.length >= 3) lit.push({ pts: orientAll([l])[0] ?? l, tone: base, kind: 'body', ...r });
          } else lit.push({ pts, tone: base, kind: 'body', ...r });
        }
        regions.push(...shade, ...lit);
        i = j;
      }
      items.push({ type: 'subject', key: `subject:${it.id}`, item: it, band, tone, parts, regions });
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
    else if (it.type === 'shadow') fillPolygon(g, it.pts, it.tone);
    else for (const r of it.regions) fillPolygon(g, r.pts, r.tone);
  }
  return g;
}
