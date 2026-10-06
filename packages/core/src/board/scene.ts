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
  hFov,
  horizonLine,
  NEAR_M,
  projectPoint,
  projectPolygon,
  projectSegment,
  toCamera,
  type CameraBasis,
} from './camera.ts';
import { isEnvProp, relativeYaw, shelfBoards, STREET } from './layout.ts';
import { clamp, clipPolygon, convexHull, cross3, DEG, dot3, mix2, sub3, type V2, type V3 } from './math.ts';
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
  /** S4c: fixed pencil tone (billboards, a blackboard) instead of the face-vs-light rule */
  tone?: number;
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
  /** S4c: top face scaled by this factor about the box axis (lamp shade, cup, pole) */
  taper?: number;
  /** S4c: fixed pencil tone for every face of this box */
  tone?: number;
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
      // grain lines on the top read as a table surface in close inserts
      const grain: [V3, V3][] = [-0.36, -0.22, -0.07, 0.06, 0.2, 0.33].map((k) => [
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
      // S4c: a window per floor and bay, a shopfront fascia and a door on the ground floor
      const floors = Math.max(1, Math.floor(h / 3.2));
      const fh = h / floors;
      const facade = (len: number, at: (a: number, y: number) => V3): [V3, V3][] => {
        const out: [V3, V3][] = [];
        const n = Math.max(1, Math.round(len / 3.5));
        const bw = len / n;
        const door = Math.floor(n / 2);
        const rect = (a0: number, y0: number, a1: number, y1: number) => {
          out.push([at(a0, y0), at(a1, y0)], [at(a1, y0), at(a1, y1)], [at(a1, y1), at(a0, y1)], [at(a0, y1), at(a0, y0)]);
        };
        if (floors > 1) out.push([at(-len / 2, fh * 0.86), at(len / 2, fh * 0.86)]);
        for (let j = 0; j < n; j++) {
          const ac = -len / 2 + bw * (j + 0.5);
          if (floors > 1) {
            if (j === door) {
              const dw = Math.min(1.1, 0.4 * bw) / 2;
              rect(ac - dw, 0, ac + dw, Math.min(2.3, 0.74 * fh));
            } else rect(ac - 0.36 * bw, 0.3, ac + 0.36 * bw, 0.74 * fh);
          }
          const ww = Math.min(1.4, 0.45 * bw) / 2;
          for (let i = floors > 1 ? 1 : 0; i < floors; i++) rect(ac - ww, i * fh + 0.3 * fh, ac + ww, i * fh + 0.76 * fh);
        }
        return out;
      };
      const fz: Record<'+x' | '-x' | '+z' | '-z', [V3, V3][]> = {
        '+z': facade(w, (a, y) => [a, y, d / 2]),
        '-z': facade(w, (a, y) => [a, y, -d / 2]),
        '+x': facade(d, (a, y) => [w / 2, y, a]),
        '-x': facade(d, (a, y) => [-w / 2, y, a]),
      };
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
    case 'bed':
      return bedParts(w, h, d);
    case 'sofa':
      return sofaParts(w, h, d);
    case 'shelf':
      return shelfParts(w, h, d);
    case 'lamp':
      return h > 2.5 ? streetLampParts(w, h) : floorLampParts(w, h, d);
    case 'tree': {
      // stand-in boxes (cast shadows); the frame draws a billboard (projectTree)
      const t = treeShape(w, h);
      return [
        { cx: 0, y: 0, cz: 0, w: t.trunkW, h: t.cy, d: t.trunkW },
        { cx: 0, y: t.cy - t.ry, cz: 0, w, h: 2 * t.ry, d: Math.min(d, w) },
      ];
    }
    case 'phone':
      return [
        {
          cx: 0,
          y: 0,
          cz: 0,
          w,
          h,
          d,
          // screen inset and the earpiece slot at the top (+z) end
          decor: { '+y': [...rectY(-w * 0.4, -d * 0.36, w * 0.4, d * 0.4, h), [[-w * 0.14, h, d * 0.45], [w * 0.14, h, d * 0.45]]] },
        },
      ];
    case 'cup': {
      const hw = 0.014;
      return [
        { cx: 0, y: 0, cz: 0, w, h, d, taper: 1.12, decor: { '+y': rectY(-w * 0.47, -d * 0.47, w * 0.47, d * 0.47, h) } },
        // the handle: a flat loop on the +x side
        { cx: w / 2 + hw, y: h * 0.22, cz: 0, w: 2 * hw, h: h * 0.52, d: Math.min(0.014, d * 0.2) },
      ];
    }
    case 'book': {
      // page edges on three sides, the hinge line beside the spine (−x)
      const along = (f: (y: number) => [V3, V3]) => [h * 0.34, h * 0.66].map(f);
      return [
        {
          cx: 0,
          y: 0,
          cz: 0,
          w,
          h,
          d,
          decor: {
            '+x': along((y) => [[w / 2, y, -d / 2 + 0.006], [w / 2, y, d / 2 - 0.006]]),
            '-z': along((y) => [[-w / 2 + 0.012, y, -d / 2], [w / 2 - 0.006, y, -d / 2]]),
            '+z': along((y) => [[-w / 2 + 0.012, y, d / 2], [w / 2 - 0.006, y, d / 2]]),
            '+y': [[[-w / 2 + 0.018, h, -d / 2], [-w / 2 + 0.018, h, d / 2]]],
          },
        },
      ];
    }
    case 'bag':
      return bagParts(w, h, d);
    case 'wall':
    default: {
      if (p.id.startsWith('env-board')) return boardParts(w, h, d);
      if (p.id.startsWith('env-ceiling')) return [{ cx: 0, y: 0, cz: 0, w, h, d, decor: { '-y': ceilingLights(w, d) } }];
      if (p.id.startsWith('env-wall-') && h >= 2.2) {
        // S4c: skirting and a dado rail on both long faces (only the inside one is drawn)
        const lines = (z: number): [V3, V3][] => [
          [[-w / 2, 0.12, z], [w / 2, 0.12, z]],
          [[-w / 2, 0.92, z], [w / 2, 0.92, z]],
        ];
        return [{ cx: 0, y: 0, cz: 0, w, h, d, decor: { '-z': lines(-d / 2), '+z': lines(d / 2) } }];
      }
      return [{ cx: 0, y: 0, cz: 0, w, h, d }];
    }
  }
}

// ---- S4c furniture, small props and set pieces (local frame: front = −z) ---

const rectZ = (x0: number, y0: number, x1: number, y1: number, z: number): [V3, V3][] => [
  [[x0, y0, z], [x1, y0, z]],
  [[x1, y0, z], [x1, y1, z]],
  [[x1, y1, z], [x0, y1, z]],
  [[x0, y1, z], [x0, y0, z]],
];
const rectY = (x0: number, z0: number, x1: number, z1: number, y: number): [V3, V3][] => [
  [[x0, y, z0], [x1, y, z0]],
  [[x1, y, z0], [x1, y, z1]],
  [[x1, y, z1], [x0, y, z1]],
  [[x0, y, z1], [x0, y, z0]],
];

/** Bed: base, mattress with a folded-back blanket, headboard at +z, pillows. */
function bedParts(w: number, h: number, d: number): LocalBox[] {
  const hb = 0.08;
  const baseH = h * 0.5;
  const mw = w - 0.04;
  const md = d - hb - 0.02;
  const mz = -hb / 2;
  const fold = d / 2 - hb - 0.62;
  const pillows: LocalBox[] =
    w > 1.2
      ? [-1, 1].map((sx) => ({ cx: (sx * w) / 4.4, y: h, cz: d / 2 - hb - 0.24, w: w * 0.38, h: 0.1, d: 0.34 }))
      : [{ cx: 0, y: h, cz: d / 2 - hb - 0.24, w: w * 0.7, h: 0.1, d: 0.34 }];
  return [
    { cx: 0, y: 0, cz: -hb / 2, w, h: baseH, d: d - hb },
    {
      cx: 0,
      y: baseH,
      cz: mz,
      w: mw,
      h: h - baseH,
      d: md,
      decor: {
        '+y': [[[-mw / 2, h, fold], [mw / 2, h, fold]]],
        '+x': [[[mw / 2, baseH + 0.03, fold], [mw / 2, h, fold]]],
        '-x': [[[-mw / 2, baseH + 0.03, fold], [-mw / 2, h, fold]]],
      },
    },
    {
      cx: 0,
      y: 0,
      cz: d / 2 - hb / 2,
      w,
      h: h + Math.min(0.5, 0.8 * h),
      d: hb,
      decor: { '-z': rectZ(-w / 2 + 0.1, h + 0.06, w / 2 - 0.1, h + Math.min(0.5, 0.8 * h) - 0.08, d / 2 - hb) },
    },
    ...pillows,
  ];
}

/** Sofa: plinth, two arms, a back at +z, seat cushions; seams on the back. */
function sofaParts(w: number, h: number, d: number): LocalBox[] {
  const arm = Math.min(0.2, w * 0.1);
  const seatY = Math.min(0.45, h * 0.53);
  const baseY = seatY - 0.15;
  const backD = Math.min(0.22, d * 0.25);
  const inner = w - 2 * arm;
  const n = inner > 1.3 ? 3 : inner > 0.7 ? 2 : 1;
  const cw = inner / n;
  const seams: [V3, V3][] = [];
  for (let i = 1; i < n; i++) seams.push([[-inner / 2 + cw * i, seatY + 0.04, d / 2 - backD], [-inner / 2 + cw * i, h - 0.06, d / 2 - backD]]);
  const out: LocalBox[] = [
    { cx: 0, y: 0, cz: 0, w: inner, h: baseY, d },
    { cx: 0, y: baseY, cz: d / 2 - backD / 2, w: inner, h: h - baseY, d: backD, decor: { '-z': seams } },
  ];
  for (let i = 0; i < n; i++) out.push({ cx: -inner / 2 + cw * (i + 0.5), y: baseY, cz: -backD / 2, w: cw - 0.012, h: seatY - baseY, d: d - backD });
  for (const sx of [-1, 1]) out.push({ cx: sx * (w / 2 - arm / 2), y: 0, cz: 0, w: arm, h: seatY + 0.2, d });
  return out;
}

/** Bookcase open at −z: sides, top, plinth, back panel with book spines, boards. */
function shelfParts(w: number, h: number, d: number): LocalBox[] {
  const t = 0.03;
  const iw = w - 2 * t;
  const boards = shelfBoards(h);
  const comp = (h - 0.08 - t) / boards.length;
  const zb = d / 2 - 0.02;
  // book spines: a run of books per compartment, widths and heights from a fixed pattern
  const widths = [0.035, 0.05, 0.03, 0.045, 0.04, 0.055, 0.03];
  const heights = [0.92, 1, 0.84, 0.96, 0.88, 1, 0.8];
  const spines: [V3, V3][] = [];
  boards.forEach((y0, k) => {
    const bh = Math.min(0.27, comp * 0.72);
    const end = iw / 2 - iw * (0.18 + 0.12 * (k % 3));
    let x = -iw / 2 + 0.02 + 0.06 * (k % 2);
    let i = k * 3;
    const y = y0 + (k === 0 ? 0 : 0.012);
    while (x < end) {
      const bw = widths[i % widths.length] as number;
      const top = y + bh * (heights[i % heights.length] as number);
      spines.push([[x, y, zb], [x, top, zb]], [[x, top, zb], [x + bw, top, zb]]);
      x += bw;
      i++;
    }
    spines.push([[x, y, zb], [x, y + bh * 0.9, zb]]);
  });
  const out: LocalBox[] = [
    { cx: 0, y: 0.08, cz: d / 2 - 0.01, w: iw, h: h - 0.08 - t, d: 0.02, decor: { '-z': spines } },
    { cx: 0, y: 0, cz: 0, w: iw, h: 0.08, d },
    { cx: 0, y: h - t, cz: 0, w: iw, h: t, d },
  ];
  for (const y of boards.slice(1)) out.push({ cx: 0, y: y - 0.012, cz: -0.01, w: iw, h: 0.024, d: d - 0.02 });
  for (const sx of [-1, 1]) out.push({ cx: sx * (w / 2 - t / 2), y: 0, cz: 0, w: t, h, d });
  return out;
}

/** Floor lamp: disc base, stem, a shade narrowing to the top. */
function floorLampParts(w: number, h: number, d: number): LocalBox[] {
  const shadeY = h * 0.74;
  return [
    { cx: 0, y: 0, cz: 0, w: w * 0.6, h: 0.03, d: d * 0.6 },
    { cx: 0, y: 0.03, cz: 0, w: 0.025, h: shadeY - 0.01, d: 0.025 },
    { cx: 0, y: shadeY, cz: 0, w, h: h - shadeY, d, taper: 0.62 },
  ];
}

/** Street lamp (a lamp taller than 2.5 m): tapered pole, an arm toward +x, the lamp head. */
function streetLampParts(w: number, h: number): LocalBox[] {
  const arm = Math.max(0.8, w * 2.5);
  return [
    { cx: 0, y: 0, cz: 0, w: 0.26, h: 0.45, d: 0.26, taper: 0.7 },
    { cx: 0, y: 0, cz: 0, w: 0.13, h, d: 0.13, taper: 0.6 },
    { cx: arm / 2, y: h - 0.1, cz: 0, w: arm, h: 0.06, d: 0.06 },
    { cx: arm, y: h - 0.24, cz: 0, w: 0.5, h: 0.16, d: 0.24, taper: 0.7 },
  ];
}

/** Bag: body with a flap and clasp on the front, a handle loop on top. */
function bagParts(w: number, h: number, d: number): LocalBox[] {
  const bh = h * 0.78;
  const hw = w * 0.22;
  const flap = bh * 0.42;
  return [
    {
      cx: 0,
      y: 0,
      cz: 0,
      w,
      h: bh,
      d,
      taper: 0.94,
      decor: {
        '-z': [
          [[-w * 0.46, flap, -d / 2], [w * 0.46, flap, -d / 2]],
          [[-w * 0.46, flap, -d / 2], [-w * 0.44, bh, -d / 2]],
          [[w * 0.46, flap, -d / 2], [w * 0.44, bh, -d / 2]],
          [[-w * 0.05, flap - 0.02, -d / 2], [w * 0.05, flap - 0.02, -d / 2]],
        ],
      },
    },
    ...[-1, 1].map((sx) => ({ cx: sx * hw, y: bh * 0.97, cz: 0, w: 0.02, h: h - bh, d: 0.02 })),
    { cx: 0, y: h - 0.02, cz: 0, w: 2 * hw + 0.02, h: 0.02, d: 0.02 },
  ];
}

/** Blackboard (env 'wall' id env-board-*): frame, a toned writing surface, chalk tray. */
function boardParts(w: number, h: number, d: number): LocalBox[] {
  const f = Math.min(0.06, h * 0.06);
  return [
    { cx: 0, y: 0, cz: 0, w, h, d },
    { cx: 0, y: f, cz: -0.004, w: w - 2 * f, h: h - 2 * f, d: d + 0.004, tone: 1 },
    { cx: 0, y: -0.02, cz: -d / 2 - 0.04, w: w * 0.92, h: 0.035, d: 0.08 },
  ];
}

/** Ceiling light panels down the corridor ceiling (local −y face, length along z). */
function ceilingLights(w: number, d: number): [V3, V3][] {
  const out: [V3, V3][] = [];
  const hw = Math.min(0.2, w * 0.1);
  for (let z = -d / 2 + 2; z < d / 2 - 0.8; z += 3.2) out.push(...rectY(-hw, z, hw, z + 1.2, 0));
  return out;
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

/** World-space corners (8 each) of a prop's sub-boxes (pencil cast shadows). */
export function propWorldBoxes(p: BoardProp, cam: BoardCamera): V3[][] {
  const L = localToWorld(propWorldOrigin(p, cam), p.y);
  return propParts(p).map((lb) => boxCorners(lb, L));
}

/** Local point → the same point on a tapered box (x, z scaled toward the axis with height). */
function tapered(b: LocalBox): (q: V3) => V3 {
  const t = b.taper;
  if (t === undefined || t === 1) return (q) => q;
  return (q) => {
    const k = 1 + (t - 1) * clamp((q[1] - b.y) / (b.h || 1), 0, 1);
    return [b.cx + (q[0] - b.cx) * k, q[1], b.cz + (q[2] - b.cz) * k];
  };
}

/** World corners of a local box (8, bit order x|y|z). */
function boxCorners(b: LocalBox, L: (p: V3) => V3): V3[] {
  const T = tapered(b);
  const out: V3[] = [];
  for (let i = 0; i < 8; i++) {
    const x = b.cx + (i & 1 ? b.w / 2 : -b.w / 2);
    const y = b.y + (i & 2 ? b.h : 0);
    const z = b.cz + (i & 4 ? b.d / 2 : -b.d / 2);
    out.push(L(T([x, y, z])));
  }
  return out;
}

function toPx(W: number, H: number) {
  return (p: V2): V2 => [p[0] * W, p[1] * H];
}

/** Decor shorter than this on screen (px) is dropped: far windows fade out instead of turning to fuzz. */
const MIN_DECOR_PX = 1.5;

/** Project a prop into visible face polygons (frame px), sub-boxes sorted far → near. */
export function projectProp(
  p: BoardProp,
  cam: BoardCamera,
  b: CameraBasis,
  W: number,
  H: number,
  light: V3 = DEFAULT_LIGHT,
): { faces: FacePrim[]; depth: number } {
  if (p.kind === 'tree') return projectTree(p, cam, b, W, H, light);
  if (p.kind === 'cup') return projectCup(p, cam, b, W, H, light);
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
    const T = tapered(lb);
    for (const f of FACES) {
      let n = rot(f.n);
      if (lb.taper !== undefined && lb.taper !== 1) n = faceNormal(f.idx.map((i) => corners[i] as V3), n);
      const c0 = corners[f.idx[0]] as V3;
      if (dot3(n, sub3(b.pos, c0)) <= 1e-9) continue; // back-face cull
      const poly = projectPolygon(
        b,
        f.idx.map((i) => corners[i] as V3),
      );
      if (poly.length < 3) continue;
      const decor: V2[][] = [];
      for (const seg of lb.decor?.[f.key] ?? []) {
        const s = projectSegment(b, L(T(seg[0])), L(T(seg[1])));
        if (!s) continue;
        const a = px(s[0]);
        const c = px(s[1]);
        if (Math.hypot(c[0] - a[0], c[1] - a[1]) >= MIN_DECOR_PX) decor.push([a, c]);
      }
      const face: FacePrim = { pts: poly.map(px), decor, n, sub: si };
      if (lb.tone !== undefined) face.tone = lb.tone;
      faces.push(face);
    }
  }
  const center = L([0, p.h / 2, 0]);
  return { faces, depth: toCamera(b, center)[2] };
}

/** Outward normal of a (planar) quad, oriented like the untapered face normal `ref`. */
function faceNormal(q: V3[], ref: V3): V3 {
  const a = q[0] as V3;
  const n = cross3(sub3(q[1] as V3, a), sub3(q[3] as V3, a));
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l < 1e-12) return ref;
  const k = dot3(n, ref) < 0 ? -1 / l : 1 / l;
  return [n[0] * k, n[1] * k, n[2] * k];
}

// ---- trees: billboard silhouettes ----------------------------------------------

/** Direction toward the light for a scene light (same convention as pencil-plan lightDirection). */
export function lightToward(l: { azimuth_deg: number; elevation_deg: number }): V3 {
  const az = l.azimuth_deg * DEG;
  const el = l.elevation_deg * DEG;
  return [-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/** The layout's default light (45°, 40°). */
const DEFAULT_LIGHT: V3 = lightToward({ azimuth_deg: 45, elevation_deg: 40 });

/** Canopy ellipse (centre height, radii) and trunk width of a w × h tree. */
export function treeShape(w: number, h: number): { cy: number; rx: number; ry: number; trunkW: number } {
  const ry = Math.min(h * 0.36, w * 0.7);
  return { cy: h - ry, rx: w / 2, ry, trunkW: Math.max(0.06, w * 0.09) };
}

/** Pencil tones of a tree: canopy lit / canopy shade / trunk (set dressing stays lighter). */
const TREE_TONES = { env: [1, 2, 2], set: [1, 2, 3] } as const;

/**
 * A tree as a billboard (vertical plane square to the camera ray, like a
 * puppet): a trunk and an irregular round canopy split into a lit and a
 * shaded side by the light. Seen from high above, the canopy is a disc. The
 * faces carry fixed tones, so they flow through the prop tone / contour path.
 */
function projectTree(p: BoardProp, cam: BoardCamera, b: CameraBasis, W: number, H: number, light: V3): { faces: FacePrim[]; depth: number } {
  const o = propWorldOrigin(p, cam);
  const px = toPx(W, H);
  const t = treeShape(p.w, p.h);
  const tones = isEnvProp(p) ? TREE_TONES.env : TREE_TONES.set;
  const rng = rngFor(0, `tree:${p.id}`);
  const ph = [rng() * 2 * Math.PI, rng() * 2 * Math.PI, rng() * 2 * Math.PI] as const;
  // lumpy outline: a few low harmonics on a circle
  const lump = (a: number) => 1 + 0.07 * Math.cos(3 * a + ph[0]) + 0.05 * Math.cos(5 * a + ph[1]) + 0.035 * Math.cos(8 * a + ph[2]);
  const canopy: V2[] = [];
  for (let i = 0; i < 36; i++) {
    const a = (2 * Math.PI * i) / 36;
    canopy.push([Math.cos(a) * lump(a), Math.sin(a) * lump(a)]);
  }
  const horiz = Math.hypot(o.x - cam.x, o.z - cam.z);
  const elev = Math.atan2(cam.y - (p.y + t.cy), horiz) / DEG;
  const toCam: V3 = horiz > 1e-6 ? [(cam.x - o.x) / horiz, 0, (cam.z - o.z) / horiz] : [0, 0, -1];
  const faces: FacePrim[] = [];
  // leaf clumps: short scalloped strokes inside the canopy (unit coordinates)
  const clumps: V2[][] = [];
  for (let i = 0; i < 9; i++) {
    const cx = (rng() * 2 - 1) * 0.6;
    const cy = (rng() * 2 - 1) * 0.55;
    const r = 0.12 + rng() * 0.08;
    const arc: V2[] = [];
    for (let k = 0; k <= 4; k++) {
      const a = Math.PI * (1.1 - (0.9 * k) / 4);
      arc.push([cx + r * Math.cos(a), cy + r * Math.sin(a) * 0.7]);
    }
    clumps.push(arc);
  }
  const push = (pts3: V3[], tone: number, sub: number, n: V3, decor3: V3[][] = []) => {
    const poly = projectPolygon(b, pts3);
    if (poly.length < 3) return;
    const decor: V2[][] = [];
    for (const line of decor3)
      for (let k = 1; k < line.length; k++) {
        const s = projectSegment(b, line[k - 1] as V3, line[k] as V3);
        if (s) decor.push([px(s[0]), px(s[1])]);
      }
    faces.push({ pts: poly.map(px), decor, n, sub, tone });
  };
  /** unit canopy → lit and shade halves (the cut is shared, so it reads as a crease) */
  const split = (dir: V2, toWorld: (q: V2) => V3, n: V3) => {
    const f = (q: V2) => q[0] * dir[0] + q[1] * dir[1] + 0.18;
    const lit = clipPolygon(canopy, f, mix2);
    const shade = clipPolygon(canopy, (q) => -f(q), mix2);
    if (shade.length >= 3) push(shade.map(toWorld), tones[1], 1, n);
    if (lit.length >= 3) push(lit.map(toWorld), tones[0], 1, n, clumps.map((c) => c.map(toWorld)));
  };
  if (elev > 60) {
    // from above: a disc at canopy height, split by the light's ground direction
    const y = p.y + t.cy;
    const lh = Math.hypot(light[0], light[2]) || 1;
    split([light[0] / lh, light[2] / lh], (q) => [o.x + q[0] * t.rx, y, o.z + q[1] * t.rx], [0, 1, 0]);
  } else {
    // billboard axis: horizontal, square to the camera → tree line
    const u: V3 = [toCam[2], 0, -toCam[0]];
    const toWorld = (q: V2): V3 => [o.x + u[0] * q[0], p.y + q[1], o.z + u[2] * q[0]];
    const tw = t.trunkW / 2;
    const top = t.cy - t.ry * 0.2;
    const trunk: V2[] = [
      [-tw * 1.3, 0],
      [tw * 1.3, 0],
      [tw * 0.8, top],
      [-tw * 0.8, top],
    ];
    push(trunk.map(toWorld), tones[2], 0, toCam);
    // the light within the billboard plane (along u, and up)
    const lu = dot3(light, u);
    const ll = Math.hypot(lu, light[1]) || 1;
    split([lu / ll, light[1] / ll], (q) => toWorld([q[0] * t.rx, t.cy + q[1] * t.ry]), toCam);
  }
  return { faces, depth: toCamera(b, [o.x, p.y + p.h / 2, o.z])[2] };
}

/**
 * A cup as a turned form (S4c): the body is the hull of its foot and rim
 * circles (split lit / shade by the light), the rim an ellipse with the dark
 * inside, the handle a flat loop on the cup's +x side drawn before or after
 * the body by depth. Fixed tones, so it flows through the prop pipeline.
 */
function projectCup(p: BoardProp, cam: BoardCamera, b: CameraBasis, W: number, H: number, light: V3): { faces: FacePrim[]; depth: number } {
  const o = propWorldOrigin(p, cam);
  const px = toPx(W, H);
  const psi = o.yaw * DEG;
  const r0 = p.w / 2;
  const r1 = r0 * 1.12;
  const top = p.y + p.h;
  const circle = (r: number, y: number, n = 24): V3[] => Array.from({ length: n }, (_, i) => [o.x + r * Math.cos((2 * Math.PI * i) / n), y, o.z + r * Math.sin((2 * Math.PI * i) / n)] as V3);
  const proj = (pts: V3[]) => projectPolygon(b, pts).map(px);
  const faces: FacePrim[] = [];
  const toCam: V3 = (() => {
    const h = Math.hypot(cam.x - o.x, cam.z - o.z) || 1;
    return [(cam.x - o.x) / h, 0, (cam.z - o.z) / h];
  })();
  const foot = proj(circle(r0, p.y));
  const rim = proj(circle(r1, top));
  if (foot.length < 3 || rim.length < 3) return { faces, depth: toCamera(b, [o.x, p.y + p.h / 2, o.z])[2] };
  const body = convexHull([...foot, ...rim]);
  // handle: a loop in the cup's local x–y plane, on its +x side
  const ax: V3 = [Math.cos(psi), 0, -Math.sin(psi)];
  const hc: V3 = [o.x + ax[0] * (r0 + 0.022), p.y + p.h * 0.52, o.z + ax[2] * (r0 + 0.022)];
  const loop = (r: number, from: number, to: number, n = 10): V3[] =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = from + ((to - from) * i) / n;
      return [hc[0] + ax[0] * r * Math.cos(a), hc[1] + r * Math.sin(a) * 1.3, hc[2] + ax[2] * r * Math.cos(a)] as V3;
    });
  const handle = proj([...loop(0.032, -Math.PI / 2, Math.PI / 2), ...loop(0.018, Math.PI / 2, -Math.PI / 2)]);
  const handleBehind = toCamera(b, hc)[2] > toCamera(b, [o.x, hc[1], o.z])[2];
  const pushFace = (pts: V2[], tone: number, sub: number, n: V3) => {
    if (pts.length >= 3) faces.push({ pts, decor: [], n, sub, tone });
  };
  if (handleBehind) pushFace(handle, 1, 0, toCam);
  // lit / shade halves of the body: split across the light's screen direction
  const lp = projectPoint(b, [o.x + light[0] * r1 * 4, p.y + p.h / 2, o.z + light[2] * r1 * 4]);
  const cp = projectPoint(b, [o.x, p.y + p.h / 2, o.z]);
  const sgn = lp.visible && cp.visible && lp.x > cp.x ? 1 : -1;
  const cx = cp.x * W;
  const bw = Math.max(...body.map((q) => q[0])) - Math.min(...body.map((q) => q[0]));
  // the lit side toward the light, a little past the middle
  const f = (q: V2) => (q[0] - cx) * sgn + 0.15 * bw;
  pushFace(clipPolygon(body, (q) => -f(q), mix2), 1, 1, toCam);
  pushFace(clipPolygon(body, f, mix2), 0, 1, toCam);
  if (!handleBehind) pushFace(handle, 1, 2, toCam);
  // the rim seen from above, with the dark inside
  if (cam.y > top) {
    pushFace(rim, 0, 3, [0, 1, 0]);
    pushFace(proj(circle(r1 * 0.86, top)), 2, 3, [0, 1, 0]);
  }
  return { faces, depth: toCamera(b, [o.x, p.y + p.h / 2, o.z])[2] };
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
  if (ROOM_ENVS.has(spec.scene.env) && envWalls.length) {
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
  if (spec.scene.env === 'corridor' && envWalls.length) {
    // S4c: floor joints running down the corridor to its vanishing point
    for (let k = 1; k < 4; k++) seg([x0 + ((x1 - x0) * k) / 4, 0, z0], [x0 + ((x1 - x0) * k) / 4, 0, z1], 'road');
  }
  if (spec.scene.env === 'street') {
    const far = Math.max(focus * 3, 90);
    for (const x of [-STREET.roadHalf, STREET.roadHalf, -STREET.walkHalf, STREET.walkHalf]) seg([cam.x + x, 0, 0.3], [cam.x + x, 0, far], 'road');
    for (let z = 1; z < far; z += 6) seg([cam.x, 0, z], [cam.x, 0, z + 3], 'road');
  } else if (spec.scene.env === 'open' || spec.scene.env === 'nature') {
    const rng = rngFor(spec.seed, 'ground-marks');
    const far = Math.max(focus * 2.5, 25);
    const count = spec.scene.env === 'nature' ? 110 : 70;
    for (let i = 0; i < count; i++) {
      const z = 1 + rng() * far;
      const half = (18 / cam.focal_mm) * z * 1.1;
      const x = cam.x + (rng() * 2 - 1) * half;
      const len = 0.12 + rng() * 0.25 * Math.max(1, z / 10);
      seg([x - len / 2, 0, z], [x + len / 2, 0, z], 'mark');
    }
  }
  return out;
}

/** Environments built as a room of env walls (floor grid stops at the walls). */
const ROOM_ENVS = new Set<BoardSpec['scene']['env']>(['interior', 'classroom', 'corridor']);

// ---------------------------------------------------------------------------
// Horizon band (render-time, from the spec only)
// ---------------------------------------------------------------------------

export const HORIZON_ID = 'env-horizon';

/**
 * S4c: what closes an outdoor frame at the horizon — distant low hills in the
 * open, a tree line in nature. A single far billboard band (fixed tone) that
 * goes through the prop pipeline; skipped when the horizon is out of frame.
 */
function horizonBand(spec: BoardSpec, b: CameraBasis, W: number, H: number, order: number): PropItem | null {
  const env = spec.scene.env;
  if (env !== 'open' && env !== 'nature') return null;
  const cam = spec.camera;
  if (Math.abs(cam.pitch_deg) > 50) return null;
  const trees = env === 'nature';
  const rng = rngFor(spec.seed, 'horizon-band');
  const ph = [rng(), rng(), rng()].map((v) => v * 2 * Math.PI) as [number, number, number];
  const D = trees ? 260 : 650;
  const span = (hFov(cam.focal_mm) / 2 + 6) * DEG;
  const N = clamp(Math.ceil((2 * span * D) / 1.5), 40, 220);
  // height (m) along the arc: rolling hills, or a scalloped canopy line with a slow swell
  const height = (s: number) =>
    trees
      ? 6 + 1.6 * Math.sin(s / 41 + ph[0]) + 2.4 * Math.abs(Math.sin(s / 11 + ph[1])) + 1.1 * Math.abs(Math.sin(s / 4.3 + ph[2]))
      : 6 + 10 * (0.5 + 0.5 * Math.sin(s / 95 + ph[0])) + 6 * (0.5 + 0.5 * Math.sin(s / 38 + ph[1]));
  const yaw = cam.yaw_deg * DEG;
  const top: V3[] = [];
  const base: V3[] = [];
  for (let i = 0; i <= N; i++) {
    const a = -span + (2 * span * i) / N;
    const x = cam.x + Math.sin(yaw + a) * D;
    const z = cam.z + Math.cos(yaw + a) * D;
    top.push([x, height(a * D), z]);
    base.push([x, 0, z]);
  }
  const poly = projectPolygon(b, [...top, ...base.reverse()]);
  if (poly.length < 3) return null;
  const pts = poly.map(toPx(W, H));
  if (!pts.some((q) => q[1] >= 0 && q[1] <= H)) return null;
  const face: FacePrim = { pts, decor: [], n: [-Math.sin(yaw), 0, -Math.cos(yaw)], sub: 0, tone: trees ? 1 : 0 };
  return { type: 'prop', id: HORIZON_ID, kind: trees ? 'tree' : 'wall', env: true, depth: D, order, faces: [face] };
}

/** Painter rank: set shell (walls, blocks, the horizon band) → things on the walls → everything else by depth. */
function paintRank(it: SceneItem): number {
  if (it.type !== 'prop' || !it.env) return 2;
  if (it.id.startsWith('env-board') || it.kind === 'window' || it.kind === 'door') return 1;
  return it.kind === 'wall' || it.kind === 'building' || it.id === HORIZON_ID ? 0 : 2;
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
  const light = lightToward(spec.scene.light);
  const band = horizonBand(spec, b, W, H, -1);
  if (band) items.push(band);
  const propInfo = spec.scene.props.map((p) => {
    const o = propWorldOrigin(p, cam);
    return { p, o };
  });
  for (const { p } of propInfo) {
    const { faces, depth } = projectProp(p, cam, b, W, H, light);
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
  // Painter order: environment shell first (then what hangs on it), then z_override (larger = later), then far → near.
  const zo = new Map(spec.scene.subjects.map((s) => [s.id, s.z_override ?? 0] as const));
  const key = (it: SceneItem) => (it.type === 'subject' ? (zo.get(it.id) ?? 0) : 0);
  items.sort((a, c) => paintRank(a) - paintRank(c) || key(a) - key(c) || c.depth - a.depth || a.order - c.order);
  return { W, H, basis: b, ground: groundLines(spec, b, W, H), horizon, items };
}
