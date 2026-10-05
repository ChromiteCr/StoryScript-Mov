/**
 * BoardSpec → frame-space primitives (shared by the SVG renderer and lint).
 * Everything here is projected with the same pinhole model as camera.ts:
 * ground grid, boxes (back-face culled, near-plane clipped) and billboard
 * puppets whose vertices are projected in 3D (so low/high angles foreshorten).
 */
import type { BoardCamera, BoardProp, BoardSpec, BoardSubject, PropKind } from '@storyscript/contracts';
import { rngFor } from '../util/random.ts';
import {
  cameraBasis,
  horizonLine,
  NEAR_M,
  projectPoint,
  projectPolygon,
  projectSegment,
  toCamera,
  type CameraBasis,
} from './camera.ts';
import { isEnvProp, relativeYaw, STREET } from './layout.ts';
import { cross3, DEG, dot3, sub3, type V2, type V3 } from './math.ts';
import { figureStyleFor, type FigureStyle } from './puppet-style.ts';
import {
  buildPuppet,
  capsule,
  effectiveGesture,
  ellipse,
  facingBucket,
  HEAD,
  LIE_AXIS_Y,
  poseTopY,
  TOP_GLYPH,
  type PuppetFill,
  type PuppetLineKind,
  type PuppetMaterial,
  type PuppetView,
} from './puppets.ts';

export const FRAME_W = 1840;

export function frameSize(aspect: string): { W: number; H: number } {
  return { W: FRAME_W, H: Math.round((FRAME_W / Number(aspect)) * 100) / 100 };
}

export interface GroundLine {
  pts: [V2, V2];
  kind: 'grid' | 'road' | 'mark' | 'horizon';
}

export interface FacePrim {
  pts: V2[];
  decor: V2[][];
  /** world-space outward normal (pencil shading) */
  n: V3;
  /** index of the sub-box this face belongs to (in draw order, far → near) */
  sub: number;
}

export interface PropItem {
  type: 'prop';
  id: string;
  kind: PropKind;
  env: boolean;
  depth: number;
  order: number;
  /** sub-boxes, each a list of visible faces (already in draw order) */
  faces: FacePrim[];
}

export interface PuppetPrim {
  pts: V2[];
  fill: PuppetFill;
  material: PuppetMaterial;
  stroke: boolean;
  silhouette: boolean;
  /** draw group (see puppets.ts): outlines of a group go under its fills */
  group: string;
  /** far-side limb of a turned figure */
  far: boolean;
}

export interface SubjectItem {
  type: 'subject';
  id: string;
  badge: string;
  label: string;
  depth: number;
  order: number;
  view: PuppetView | 'top';
  mirror: boolean;
  parts: PuppetPrim[];
  lines: { pts: V2[]; after: number; key: string; kind: PuppetLineKind }[];
  /** projected head-top → feet length in px (stroke scaling) */
  heightPx: number;
  /** projected head height in px (which face details are drawn) */
  headPx: number;
  /** the character's look (hair, clothing values) */
  style: FigureStyle;
  /** frame-px bbox of the silhouette */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  head: V2 | null;
  foot: V2 | null;
}

export type SceneItem = PropItem | SubjectItem;

export interface FrameScene {
  W: number;
  H: number;
  basis: CameraBasis;
  ground: GroundLine[];
  horizon: [V2, V2] | null;
  items: SceneItem[];
}

// ---------------------------------------------------------------------------
// Props: composite boxes per kind (local frame: x along w, y up, z along d)
// ---------------------------------------------------------------------------

interface LocalBox {
  cx: number;
  y: number;
  cz: number;
  w: number;
  h: number;
  d: number;
  /** decorative line segments per face key, local coordinates */
  decor?: Partial<Record<FaceKey, [V3, V3][]>>;
}
type FaceKey = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

function propParts(p: BoardProp): LocalBox[] {
  const { w, h, d } = p;
  switch (p.kind) {
    case 'table': {
      const t = Math.min(0.05, h * 0.1);
      const legs: LocalBox[] = [];
      for (const sx of [-1, 1])
        for (const sz of [-1, 1])
          legs.push({ cx: sx * (w / 2 - 0.07), y: 0, cz: sz * (d / 2 - 0.07), w: 0.05, h: h - t, d: 0.05 });
      // two grain lines on the top read as a table surface in close inserts
      const grain: [V3, V3][] = [-0.22, 0.2].map((k) => [
        [-w / 2 + 0.08, h, d * k],
        [w / 2 - 0.08, h, d * k],
      ]);
      return [...legs, { cx: 0, y: h - t, cz: 0, w, h: t, d, decor: { '+y': grain } }];
    }
    case 'chair': {
      const seatY = h * 0.5;
      const t = 0.05;
      const legs: LocalBox[] = [];
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) legs.push({ cx: sx * (w / 2 - 0.04), y: 0, cz: sz * (d / 2 - 0.04), w: 0.04, h: seatY - t, d: 0.04 });
      return [
        ...legs,
        { cx: 0, y: seatY - t, cz: 0, w, h: t, d },
        { cx: 0, y: seatY, cz: -d / 2 + 0.025, w, h: h - seatY, d: 0.05 },
      ];
    }
    case 'car': {
      const k = h / 1.5;
      const bodyY = 0.3 * k;
      const bodyH = 0.62 * k;
      const wheels: LocalBox[] = [];
      for (const sx of [-1, 1])
        for (const sz of [-1, 1])
          wheels.push({ cx: sx * w * 0.31, y: 0, cz: sz * (d / 2 - 0.12), w: 0.66 * k, h: 0.64 * k, d: 0.24 });
      const cabinH = h - bodyY - bodyH;
      // side windows (glass outline + centre pillar) so the cabin reads as a car
      const cabX = -w * 0.06;
      const cabW = w * 0.5;
      const winX0 = cabX - cabW / 2 + 0.14 * k;
      const winX1 = cabX + cabW / 2 - 0.14 * k;
      const winY0 = bodyY + bodyH + 0.07 * k;
      const winY1 = bodyY + bodyH + cabinH - 0.07 * k;
      const side = (z: number): [V3, V3][] => [
        [[winX0, winY0, z], [winX1, winY0, z]],
        [[winX1, winY0, z], [winX1, winY1, z]],
        [[winX1, winY1, z], [winX0, winY1, z]],
        [[winX0, winY1, z], [winX0, winY0, z]],
        [[cabX, winY0, z], [cabX, winY1, z]],
      ];
      const cabD = d * 0.86;
      return [
        ...wheels,
        {
          cx: 0,
          y: bodyY,
          cz: 0,
          w,
          h: bodyH,
          d,
          decor: {
            '+z': [[[-w * 0.05, bodyY + bodyH * 0.1, d / 2], [-w * 0.05, bodyY + bodyH * 0.95, d / 2]]],
            '-z': [[[-w * 0.05, bodyY + bodyH * 0.1, -d / 2], [-w * 0.05, bodyY + bodyH * 0.95, -d / 2]]],
          },
        },
        { cx: cabX, y: bodyY + bodyH, cz: 0, w: cabW, h: cabinH, d: cabD, decor: { '+z': side(cabD / 2), '-z': side(-cabD / 2) } },
      ];
    }
    case 'stairs': {
      const n = 5;
      const out: LocalBox[] = [];
      for (let i = 0; i < n; i++) {
        out.push({ cx: 0, y: 0, cz: -d / 2 + (d / n) * (i + 0.5), w, h: (h / n) * (i + 1), d: d / n });
      }
      return out;
    }
    case 'building': {
      const floors = Math.max(1, Math.floor(h / 3.2));
      const fz: Record<'+x' | '-x' | '+z' | '-z', [V3, V3][]> = { '+x': [], '-x': [], '+z': [], '-z': [] };
      for (let i = 1; i < floors; i++) {
        const y = (h / floors) * i;
        fz['+z'].push([[-w / 2, y, d / 2], [w / 2, y, d / 2]]);
        fz['-z'].push([[-w / 2, y, -d / 2], [w / 2, y, -d / 2]]);
        fz['+x'].push([[w / 2, y, -d / 2], [w / 2, y, d / 2]]);
        fz['-x'].push([[-w / 2, y, -d / 2], [-w / 2, y, d / 2]]);
      }
      const bays = (len: number) => Math.max(1, Math.round(len / 3.5));
      const nx = bays(w);
      const nz = bays(d);
      for (let i = 1; i < nx; i++) {
        const x = -w / 2 + (w / nx) * i;
        fz['+z'].push([[x, 0, d / 2], [x, h, d / 2]]);
        fz['-z'].push([[x, 0, -d / 2], [x, h, -d / 2]]);
      }
      for (let i = 1; i < nz; i++) {
        const z = -d / 2 + (d / nz) * i;
        fz['+x'].push([[w / 2, 0, z], [w / 2, h, z]]);
        fz['-x'].push([[-w / 2, 0, z], [-w / 2, h, z]]);
      }
      return [{ cx: 0, y: 0, cz: 0, w, h, d, decor: fz }];
    }
    case 'door': {
      const knobX = w * 0.34;
      return [
        {
          cx: 0,
          y: 0,
          cz: 0,
          w,
          h,
          d,
          decor: {
            '-z': [
              [[-w * 0.36, h * 0.1, -d / 2], [w * 0.36, h * 0.1, -d / 2]],
              [[-w * 0.36, h * 0.1, -d / 2], [-w * 0.36, h * 0.88, -d / 2]],
              [[w * 0.36, h * 0.1, -d / 2], [w * 0.36, h * 0.88, -d / 2]],
              [[-w * 0.36, h * 0.88, -d / 2], [w * 0.36, h * 0.88, -d / 2]],
              [[knobX - 0.03, h * 0.47, -d / 2], [knobX + 0.03, h * 0.47, -d / 2]],
            ],
          },
        },
      ];
    }
    case 'window': {
      return [
        {
          cx: 0,
          y: 0,
          cz: 0,
          w,
          h,
          d,
          decor: {
            '-z': [
              [[0, h * 0.08, -d / 2], [0, h * 0.92, -d / 2]],
              [[-w * 0.42, h / 2, -d / 2], [w * 0.42, h / 2, -d / 2]],
              [[-w * 0.42, h * 0.08, -d / 2], [w * 0.42, h * 0.08, -d / 2]],
              [[-w * 0.42, h * 0.92, -d / 2], [w * 0.42, h * 0.92, -d / 2]],
              [[-w * 0.42, h * 0.08, -d / 2], [-w * 0.42, h * 0.92, -d / 2]],
              [[w * 0.42, h * 0.08, -d / 2], [w * 0.42, h * 0.92, -d / 2]],
            ],
          },
        },
      ];
    }
    case 'box':
      return [{ cx: 0, y: 0, cz: 0, w, h, d, decor: { '+y': [[[-w / 2, h, 0], [w / 2, h, 0]]] } }];
    case 'wall':
    default:
      return [{ cx: 0, y: 0, cz: 0, w, h, d }];
  }
}

/** Prop origin (x, z) in world space; camera-attached props ride with the camera rig. */
export function propWorldOrigin(p: BoardProp, cam: BoardCamera): { x: number; z: number; yaw: number } {
  if (p.attach !== 'camera') return { x: p.x, z: p.z, yaw: p.yaw_deg };
  const psi = cam.yaw_deg * DEG;
  return {
    x: cam.x + p.x * Math.cos(psi) + p.z * Math.sin(psi),
    z: cam.z - p.x * Math.sin(psi) + p.z * Math.cos(psi),
    yaw: p.yaw_deg + cam.yaw_deg,
  };
}

function localToWorld(o: { x: number; z: number; yaw: number }, baseY: number) {
  const psi = o.yaw * DEG;
  const c = Math.cos(psi);
  const s = Math.sin(psi);
  // local x → (cos ψ, 0, −sin ψ), local z → (sin ψ, 0, cos ψ)
  return (p: V3): V3 => [o.x + p[0] * c + p[2] * s, baseY + p[1], o.z - p[0] * s + p[2] * c];
}

const FACES: { key: FaceKey; n: V3; idx: [number, number, number, number] }[] = [
  // corner index bits: x(1) y(2) z(4)
  { key: '-z', n: [0, 0, -1], idx: [0, 1, 3, 2] },
  { key: '+z', n: [0, 0, 1], idx: [4, 6, 7, 5] },
  { key: '-x', n: [-1, 0, 0], idx: [0, 2, 6, 4] },
  { key: '+x', n: [1, 0, 0], idx: [1, 5, 7, 3] },
  { key: '-y', n: [0, -1, 0], idx: [0, 4, 5, 1] },
  { key: '+y', n: [0, 1, 0], idx: [2, 3, 7, 6] },
];

/** World corners of a local box (8, bit order x|y|z). */
/** World-space corners (8 each) of a prop's sub-boxes (pencil cast shadows). */
export function propWorldBoxes(p: BoardProp, cam: BoardCamera): V3[][] {
  const L = localToWorld(propWorldOrigin(p, cam), p.y);
  return propParts(p).map((lb) => boxCorners(lb, L));
}

function boxCorners(b: LocalBox, L: (p: V3) => V3): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < 8; i++) {
    const x = b.cx + (i & 1 ? b.w / 2 : -b.w / 2);
    const y = b.y + (i & 2 ? b.h : 0);
    const z = b.cz + (i & 4 ? b.d / 2 : -b.d / 2);
    out.push(L([x, y, z]));
  }
  return out;
}

function toPx(W: number, H: number) {
  return (p: V2): V2 => [p[0] * W, p[1] * H];
}

/** Project a prop into visible face polygons (frame px), sub-boxes sorted far → near. */
export function projectProp(p: BoardProp, cam: BoardCamera, b: CameraBasis, W: number, H: number): { faces: FacePrim[]; depth: number } {
  const o = propWorldOrigin(p, cam);
  const L = localToWorld(o, p.y);
  const psi = o.yaw * DEG;
  const rot = (n: V3): V3 => [n[0] * Math.cos(psi) + n[2] * Math.sin(psi), n[1], -n[0] * Math.sin(psi) + n[2] * Math.cos(psi)];
  const px = toPx(W, H);
  const subs = propParts(p).map((lb) => {
    const center = L([lb.cx, lb.y + lb.h / 2, lb.cz]);
    return { lb, depth: toCamera(b, center)[2] };
  });
  subs.sort((a, c) => c.depth - a.depth);
  const faces: FacePrim[] = [];
  for (const [si, { lb }] of subs.entries()) {
    const corners = boxCorners(lb, L);
    for (const f of FACES) {
      const n = rot(f.n);
      const c0 = corners[f.idx[0]] as V3;
      if (dot3(n, sub3(b.pos, c0)) <= 1e-9) continue; // back-face cull
      const poly = projectPolygon(
        b,
        f.idx.map((i) => corners[i] as V3),
      );
      if (poly.length < 3) continue;
      const decor: V2[][] = [];
      for (const seg of lb.decor?.[f.key] ?? []) {
        const s = projectSegment(b, L(seg[0]), L(seg[1]));
        if (s) decor.push([px(s[0]), px(s[1])]);
      }
      faces.push({ pts: poly.map(px), decor, n, sub: si });
    }
  }
  const center = L([0, p.h / 2, 0]);
  return { faces, depth: toCamera(b, center)[2] };
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

const TOP_VIEW_ELEVATION_DEG = 62;

export function projectSubject(s: BoardSubject, cam: BoardCamera, b: CameraBasis, W: number, H: number, order: number, seed = 0): SubjectItem {
  const px = toPx(W, H);
  const Hm = s.height_m;
  const topY = poseTopY(s.pose) * Hm;
  const refC = toCamera(b, [s.x, topY * 0.5, s.z]);
  const horiz = Math.hypot(s.x - cam.x, s.z - cam.z);
  const elev = Math.atan2(cam.y - topY * 0.6, horiz) / DEG;
  const style = figureStyleFor(s);
  const lying = s.pose === 'lie';
  const base: Omit<SubjectItem, 'view' | 'mirror' | 'parts' | 'lines' | 'heightPx' | 'headPx' | 'bbox' | 'head' | 'foot'> = {
    type: 'subject',
    id: s.id,
    badge: s.badge,
    label: s.label,
    depth: refC[2],
    order,
    style,
  };
  const headP = projectPoint(b, [s.x, topY, s.z]);
  const footP = projectPoint(b, [s.x, 0, s.z]);
  const head: V2 | null = headP.visible ? px([headP.x, headP.y]) : null;
  const foot: V2 | null = footP.visible ? px([footP.x, footP.y]) : null;
  // the head's height (2·ry) on screen, at the head centre's depth
  const headZ = toCamera(b, [s.x, topY - HEAD.ry * Hm, s.z])[2];
  const headPx = headZ > NEAR_M ? ((b.f * 2 * HEAD.ry * Hm) / headZ / b.sh) * H : H;

  if (!lying && elev > TOP_VIEW_ELEVATION_DEG) {
    // Overhead glyph on horizontal planes: shoulders ellipse + head circle + nose.
    const Y = s.yaw_deg * DEG;
    const F: V3 = [Math.sin(Y), 0, -Math.cos(Y)];
    const Lx: V3 = [Math.cos(Y), 0, Math.sin(Y)];
    const plane = (y: number, pts: V2[]) =>
      projectPolygon(
        b,
        pts.map((q) => [s.x + Lx[0] * q[0] + F[0] * q[1], y, s.z + Lx[2] * q[0] + F[2] * q[1]] as V3),
      ).map(px);
    const g = TOP_GLYPH;
    const shoulders = plane(topY * 0.8, ellipse([0, 0], g.shoulders.rx * Hm, g.shoulders.ry * Hm, 28));
    const headPoly = plane(topY - 0.07 * Hm, ellipse([0, 0.01 * Hm], g.head.r * Hm, g.head.r * Hm, 24));
    const nose = plane(
      topY - 0.07 * Hm,
      g.nose.map((q) => [q[0] * Hm, q[1] * Hm] as V2),
    );
    const parts: PuppetPrim[] = [];
    const ref = (s.pose === 'point' || s.pose === 'reach' ? [capsule([0, 0], [-0.2 * Hm, 0.3 * Hm], 0.03 * Hm, 0.022 * Hm)] : []).map((poly) =>
      plane(topY * 0.8, poly),
    );
    const prim = (pts: V2[], group: string, material: PuppetMaterial, fill: PuppetFill = 'body'): PuppetPrim => ({
      pts,
      fill,
      material,
      stroke: true,
      silhouette: true,
      group,
      far: false,
    });
    for (const r of ref) if (r.length >= 3) parts.push(prim(r, 'arm', 'top'));
    if (shoulders.length >= 3) parts.push(prim(shoulders, 'torso', 'top'));
    if (nose.length >= 3) parts.push(prim(nose, 'head', 'skin'));
    if (headPoly.length >= 3) parts.push(prim(headPoly, 'head', 'hair', 'hair'));
    const all = parts.flatMap((p) => p.pts);
    const bbox = bboxOf(all);
    const span = bbox ? Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) : 0;
    return { ...base, view: 'top', mirror: false, parts, lines: [], heightPx: span * 2.2, headPx, bbox, head, foot };
  }

  let view: PuppetView;
  let mirror: boolean;
  let toWorld: (q: V2) => V3;
  let lengthPx = 0;
  if (lying) {
    // A lying figure's billboard turns about its long axis (puppets.ts, LIE_AXIS_Y):
    // the plane holds the axis and faces the camera; its facing is the angle
    // between the face (world up) and the camera around that axis.
    const Y = s.yaw_deg * DEG;
    const Fh: V3 = [Math.sin(Y), 0, -Math.cos(Y)];
    const U: V3 = [0, 1, 0];
    const Ls = cross3(U, Fh);
    const ax = LIE_AXIS_Y * Hm;
    let r = cross3(Fh, sub3([s.x, ax, s.z], b.pos));
    const rl = Math.hypot(r[0], r[1], r[2]);
    r = rl > 1e-6 ? [r[0] / rl, r[1] / rl, r[2] / rl] : Ls;
    const bucket = facingBucket(Math.atan2(dot3(r, U), dot3(r, Ls)) / DEG);
    view = bucket.view;
    // a lying drawing has its head toward +x unmirrored: that is the mirrored facing
    mirror = !bucket.mirror;
    const k = bucket.mirror ? 1 : -1;
    toWorld = (q: V2): V3 => {
      const along = k * q[0] * Hm;
      const across = -k * (q[1] - LIE_AXIS_Y) * Hm;
      return [s.x + Fh[0] * along + r[0] * across, ax + r[1] * across, s.z + Fh[2] * along + r[2] * across];
    };
    const p0 = projectPoint(b, [s.x, ax, s.z]);
    const p1 = projectPoint(b, [s.x - Fh[0] * 0.93 * Hm, ax, s.z - Fh[2] * 0.93 * Hm]);
    if (p0.visible && p1.visible) lengthPx = Math.hypot((p0.x - p1.x) * W, (p0.y - p1.y) * H);
  } else {
    const rel = relativeYaw(s, cam);
    ({ view, mirror } = facingBucket(rel));
    // Billboard plane: vertical, perpendicular to the camera → subject line.
    let lx: number;
    let lz: number;
    if (horiz > 1e-6) {
      lx = (s.z - cam.z) / horiz;
      lz = -(s.x - cam.x) / horiz;
    } else {
      lx = b.right[0];
      lz = b.right[2];
    }
    toWorld = (q: V2): V3 => [s.x + q[0] * Hm * lx, q[1] * Hm, s.z + q[0] * Hm * lz];
  }
  const shape = buildPuppet(s.pose, view, mirror, s.silhouette, { gesture: effectiveGesture(s, seed), style });
  const parts: PuppetPrim[] = [];
  // idxMap[i] = index in `parts` of shape part i (or of the last part drawn before it)
  const idxMap: number[] = [];
  for (const p of shape.parts) {
    const pts = projectPolygon(b, p.pts.map(toWorld)).map(px);
    if (pts.length >= 3) parts.push({ pts, fill: p.fill, material: p.material, stroke: p.stroke, silhouette: p.silhouette, group: p.group, far: p.far });
    idxMap.push(parts.length - 1);
  }
  const lines = shape.lines
    .map((l, i) => {
      const runs: V2[] = [];
      for (let k = 0; k + 1 < l.pts.length; k++) {
        const seg = projectSegment(b, toWorld(l.pts[k] as V2), toWorld(l.pts[k + 1] as V2));
        if (seg) {
          if (runs.length === 0) runs.push(px(seg[0]));
          runs.push(px(seg[1]));
        }
      }
      const after = shape.lineAfter[i] ?? -1;
      return { pts: runs, after: after >= 0 ? (idxMap[after] ?? parts.length - 1) : parts.length - 1, key: l.key, kind: l.kind };
    })
    .filter((l) => l.pts.length >= 2);
  const heightPx = lying ? lengthPx : head && foot ? Math.hypot(head[0] - foot[0], head[1] - foot[1]) : 0;
  const bbox = bboxOf(parts.filter((p) => p.silhouette).flatMap((p) => p.pts));
  return { ...base, view, mirror, parts, lines, heightPx: heightPx || estimateHeightPx(b, refC, Hm, H), headPx, bbox, head, foot };
}

function estimateHeightPx(b: CameraBasis, refC: V3, Hm: number, H: number): number {
  if (refC[2] < NEAR_M) return H;
  return ((b.f * Hm) / refC[2] / b.sh) * H;
}

function bboxOf(pts: readonly V2[]) {
  if (pts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

function niceStep(v: number): number {
  const steps = [0.25, 0.5, 1, 2, 5, 10, 20];
  for (const s of steps) if (s >= v) return s;
  return 50;
}

function groundLines(spec: BoardSpec, b: CameraBasis, W: number, H: number): GroundLine[] {
  const out: GroundLine[] = [];
  const cam = spec.camera;
  const px = toPx(W, H);
  const subjects = spec.scene.subjects;
  const focus = subjects.length
    ? subjects.reduce((m, s) => Math.max(m, Math.hypot(s.x - cam.x, s.z - cam.z)), 0)
    : Math.max(2, cam.y * 2);
  const envWalls = spec.scene.props.filter((p) => isEnvProp(p) && p.kind === 'wall');
  const seg = (a: V3, c: V3, kind: GroundLine['kind']) => {
    const s = projectSegment(b, a, c);
    if (s) out.push({ pts: [px(s[0]), px(s[1])], kind });
  };
  const overhead = cam.pitch_deg < -60;
  const step = niceStep(Math.max(focus, overhead ? cam.y * 0.6 : 0) / 6);
  let x0: number;
  let x1: number;
  let z0: number;
  let z1: number;
  if (spec.scene.env === 'interior' && envWalls.length) {
    const back = envWalls.find((p) => p.id.endsWith('back'));
    const sides = envWalls.filter((p) => !p.id.endsWith('back'));
    const half = sides.length ? Math.max(...sides.map((p) => Math.abs(p.x))) - 0.1 : 4;
    x0 = -half;
    x1 = half;
    z0 = Math.min(cam.z - 2, 0);
    z1 = back ? back.z - back.d / 2 : focus + 3;
  } else {
    const far = overhead ? cam.y * 1.5 : Math.max(focus * 2.2, focus + 12);
    const halfW = (18 / cam.focal_mm) * far * 1.2 + Math.abs(cam.x);
    x0 = cam.x - halfW;
    x1 = cam.x + halfW;
    z0 = overhead ? cam.z - far : cam.z + 0.2;
    z1 = cam.z + far;
    if (spec.scene.env === 'street') {
      x0 = Math.max(x0, cam.x - STREET.walkHalf);
      x1 = Math.min(x1, cam.x + STREET.walkHalf);
    }
  }
  const snap = (v: number) => Math.round(v / step) * step;
  // Longitudinal lines (x = const) — cap the count for very wide frames.
  const nx = Math.min(80, Math.floor((x1 - x0) / step));
  for (let i = 0; i <= nx; i++) {
    const x = snap(x0) + i * step;
    if (x < x0 - 1e-9 || x > x1 + 1e-9) continue;
    seg([x, 0, z0], [x, 0, z1], 'grid');
  }
  // Transverse lines (z = const): stop once they crowd together near the horizon.
  let lastY: number | null = null;
  for (let z = Math.ceil(z0 / step) * step; z <= z1 + 1e-9; z += step) {
    const pz = projectPoint(b, [cam.x, 0, z]);
    if (!overhead && pz.visible) {
      const y = pz.y * H;
      if (lastY !== null && Math.abs(lastY - y) < 7) break;
      lastY = y;
    }
    seg([x0, 0, z], [x1, 0, z], 'grid');
  }
  if (spec.scene.env === 'street') {
    const far = Math.max(focus * 3, 90);
    for (const x of [-STREET.roadHalf, STREET.roadHalf, -STREET.walkHalf, STREET.walkHalf]) seg([cam.x + x, 0, 0.3], [cam.x + x, 0, far], 'road');
    for (let z = 1; z < far; z += 6) seg([cam.x, 0, z], [cam.x, 0, z + 3], 'road');
  } else if (spec.scene.env === 'open') {
    const rng = rngFor(spec.seed, 'ground-marks');
    const far = Math.max(focus * 2.5, 25);
    for (let i = 0; i < 70; i++) {
      const z = 1 + rng() * far;
      const half = (18 / cam.focal_mm) * z * 1.1;
      const x = cam.x + (rng() * 2 - 1) * half;
      const len = 0.12 + rng() * 0.25 * Math.max(1, z / 10);
      seg([x - len / 2, 0, z], [x + len / 2, 0, z], 'mark');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Painter-ordered frame scene for a board. */
export function buildFrameScene(spec: BoardSpec): FrameScene {
  const { W, H } = frameSize(spec.frame.aspect);
  const cam = spec.camera;
  const b = cameraBasis(cam, spec.frame.aspect);
  const hz = horizonLine(cam, spec.frame.aspect);
  const horizon: [V2, V2] | null = hz ? [[hz[0][0] * W, hz[0][1] * H], [hz[1][0] * W, hz[1][1] * H]] : null;

  const items: SceneItem[] = [];
  let order = 0;
  const propInfo = spec.scene.props.map((p) => {
    const o = propWorldOrigin(p, cam);
    return { p, o };
  });
  for (const { p } of propInfo) {
    const { faces, depth } = projectProp(p, cam, b, W, H);
    if (!faces.length) {
      order++;
      continue;
    }
    items.push({ type: 'prop', id: p.id, kind: p.kind, env: isEnvProp(p), depth, order: order++, faces });
  }
  // Items resting on another prop draw after it.
  for (const it of items) {
    if (it.type !== 'prop') continue;
    const me = propInfo.find((q) => q.p.id === it.id);
    if (!me || me.p.y <= 0.01) continue;
    for (const other of propInfo) {
      if (other.p.id === it.id) continue;
      const top = other.p.y + other.p.h;
      if (Math.abs(top - me.p.y) > 0.03) continue;
      const r = Math.max(other.p.w, other.p.d) / 2;
      if (Math.hypot(other.o.x - me.o.x, other.o.z - me.o.z) > r) continue;
      const sup = items.find((q) => q.id === other.p.id);
      if (sup) it.depth = Math.min(it.depth, sup.depth - 0.001);
    }
  }
  spec.scene.subjects.forEach((s) => {
    const item = projectSubject(s, cam, b, W, H, order++, spec.seed);
    if (item.parts.length) items.push(item);
  });
  // Painter order: environment shell first, then z_override (larger = later), then far → near.
  const zo = new Map(spec.scene.subjects.map((s) => [s.id, s.z_override ?? 0] as const));
  const key = (it: SceneItem) => (it.type === 'subject' ? (zo.get(it.id) ?? 0) : 0);
  const envRank = (it: SceneItem) => (it.type === 'prop' && it.env ? 0 : 1);
  items.sort((a, c) => envRank(a) - envRank(c) || key(a) - key(c) || c.depth - a.depth || a.order - c.order);
  return { W, H, basis: b, ground: groundLines(spec, b, W, H), horizon, items };
}
