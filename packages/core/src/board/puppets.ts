/**
 * 2D billboard puppets (original design, generated from joint tables).
 *
 * Every pose has two hand-authored 2D joint tables — FRONT (x = lateral offset,
 * the figure faces the viewer) and SIDE (x = forward offset, the figure faces
 * screen-right) — normalised to standing height 1 with the feet midpoint at the
 * origin (y up). Head : body ≈ 1 : 7.5.
 *
 * Joint suffix A = the figure's own right side (screen-left in the front view,
 * the near side when it faces screen-right); B = its left side.
 *
 * The two tables share heights, so together they define a 3D joint set
 * (lateral L, forward F, y). A view at relative angle a (0 = facing camera,
 * 90 = facing screen-right, 180 = facing away) is the rotation
 *     x = L·cos a + F·sin a,   depth toward viewer t = −L·sin a + F·cos a
 * which narrows shoulders/hips by cos a and pushes far-side limbs back; far limbs
 * are also thinned and drawn behind the torso. Screen-left facings are mirrors.
 */
import type { Pose, Silhouette } from '@storyscript/contracts';
import { DEG, chaikin, clamp, convexHull, type V2, wrapDeg } from './math.ts';

export const JOINTS = [
  'head',
  'neck',
  'chest',
  'waist',
  'pelvis',
  'shA',
  'shB',
  'elA',
  'elB',
  'wrA',
  'wrB',
  'haA',
  'haB',
  'hipA',
  'hipB',
  'knA',
  'knB',
  'anA',
  'anB',
  'heA',
  'heB',
  'toA',
  'toB',
] as const;
export type Joint = (typeof JOINTS)[number];
export type JointTable = Record<Joint, V2>;

const STAND_FRONT: JointTable = {
  head: [0, 0.933],
  neck: [0, 0.848],
  chest: [0, 0.75],
  waist: [0, 0.615],
  pelvis: [0, 0.525],
  shA: [-0.106, 0.815],
  shB: [0.106, 0.815],
  elA: [-0.138, 0.628],
  elB: [0.138, 0.628],
  wrA: [-0.15, 0.478],
  wrB: [0.15, 0.478],
  haA: [-0.155, 0.418],
  haB: [0.155, 0.418],
  hipA: [-0.05, 0.5],
  hipB: [0.05, 0.5],
  knA: [-0.053, 0.285],
  knB: [0.053, 0.285],
  anA: [-0.055, 0.048],
  anB: [0.055, 0.048],
  heA: [-0.055, 0.014],
  heB: [0.055, 0.014],
  toA: [-0.066, 0.01],
  toB: [0.066, 0.01],
};
const STAND_SIDE: JointTable = {
  head: [0.018, 0.933],
  neck: [0.006, 0.848],
  chest: [0.014, 0.75],
  waist: [0, 0.615],
  pelvis: [-0.006, 0.525],
  shA: [0, 0.815],
  shB: [0, 0.815],
  elA: [-0.008, 0.628],
  elB: [-0.02, 0.628],
  wrA: [0.012, 0.478],
  wrB: [-0.006, 0.478],
  haA: [0.022, 0.418],
  haB: [0.004, 0.418],
  hipA: [0.002, 0.5],
  hipB: [-0.004, 0.5],
  knA: [0.022, 0.285],
  knB: [0.004, 0.285],
  anA: [0.002, 0.048],
  anB: [-0.016, 0.048],
  heA: [-0.024, 0.014],
  heB: [-0.042, 0.014],
  toA: [0.098, 0.01],
  toB: [0.08, 0.01],
};

// Mid-stride: A (near) leg forward, A arm back; B leg back, B arm forward.
const WALK_FRONT: JointTable = {
  head: [0, 0.925],
  neck: [0, 0.84],
  chest: [0, 0.742],
  waist: [0, 0.607],
  pelvis: [0, 0.517],
  shA: [-0.106, 0.807],
  shB: [0.106, 0.807],
  elA: [-0.124, 0.625],
  elB: [0.126, 0.63],
  wrA: [-0.126, 0.482],
  wrB: [0.118, 0.49],
  haA: [-0.126, 0.422],
  haB: [0.114, 0.432],
  hipA: [-0.05, 0.495],
  hipB: [0.05, 0.495],
  knA: [-0.052, 0.292],
  knB: [0.054, 0.282],
  anA: [-0.052, 0.058],
  anB: [0.056, 0.085],
  heA: [-0.052, 0.018],
  heB: [0.056, 0.076],
  toA: [-0.06, 0.03],
  toB: [0.058, 0.006],
};
const WALK_SIDE: JointTable = {
  head: [0.03, 0.925],
  neck: [0.018, 0.84],
  chest: [0.02, 0.742],
  waist: [0.004, 0.607],
  pelvis: [0, 0.517],
  shA: [0.004, 0.807],
  shB: [0.004, 0.807],
  elA: [-0.07, 0.625],
  elB: [0.06, 0.63],
  wrA: [-0.1, 0.482],
  wrB: [0.11, 0.49],
  haA: [-0.11, 0.422],
  haB: [0.125, 0.432],
  hipA: [0.005, 0.495],
  hipB: [-0.005, 0.495],
  knA: [0.08, 0.292],
  knB: [-0.04, 0.282],
  anA: [0.13, 0.058],
  anB: [-0.15, 0.085],
  heA: [0.105, 0.018],
  heB: [-0.178, 0.076],
  toA: [0.225, 0.03],
  toB: [-0.07, 0.006],
};

// Running, leaning forward: A knee drives up, A arm swings back.
const RUN_FRONT: JointTable = {
  head: [0, 0.9],
  neck: [0, 0.818],
  chest: [0, 0.722],
  waist: [0, 0.59],
  pelvis: [0, 0.5],
  shA: [-0.104, 0.79],
  shB: [0.104, 0.79],
  elA: [-0.142, 0.64],
  elB: [0.132, 0.625],
  wrA: [-0.132, 0.5],
  wrB: [0.072, 0.766],
  haA: [-0.126, 0.445],
  haB: [0.056, 0.82],
  hipA: [-0.05, 0.48],
  hipB: [0.05, 0.48],
  knA: [-0.055, 0.389],
  knB: [0.058, 0.285],
  anA: [-0.056, 0.166],
  anB: [0.06, 0.133],
  heA: [-0.056, 0.15],
  heB: [0.06, 0.15],
  toA: [-0.062, 0.128],
  toB: [0.062, 0.006],
};
const RUN_SIDE: JointTable = {
  head: [0.1, 0.9],
  neck: [0.075, 0.818],
  chest: [0.062, 0.722],
  waist: [0.028, 0.59],
  pelvis: [0, 0.5],
  shA: [0.058, 0.79],
  shB: [0.058, 0.79],
  elA: [-0.06, 0.64],
  elB: [0.153, 0.625],
  wrA: [-0.02, 0.5],
  wrB: [0.204, 0.766],
  haA: [-0.008, 0.445],
  haB: [0.222, 0.82],
  hipA: [0.005, 0.48],
  hipB: [-0.005, 0.48],
  knA: [0.2, 0.389],
  knB: [-0.096, 0.285],
  anA: [0.119, 0.166],
  anB: [-0.278, 0.133],
  heA: [0.094, 0.15],
  heB: [-0.302, 0.15],
  toA: [0.205, 0.128],
  toB: [-0.18, 0.006],
};

// Seated on an (implicit) seat 0.265 high, hands on thighs.
const SIT_FRONT: JointTable = {
  head: [0, 0.69],
  neck: [0, 0.605],
  chest: [0, 0.508],
  waist: [0, 0.372],
  pelvis: [0, 0.285],
  shA: [-0.106, 0.573],
  shB: [0.106, 0.573],
  elA: [-0.13, 0.39],
  elB: [0.13, 0.39],
  wrA: [-0.09, 0.33],
  wrB: [0.09, 0.335],
  haA: [-0.075, 0.318],
  haB: [0.075, 0.322],
  hipA: [-0.055, 0.27],
  hipB: [0.055, 0.27],
  knA: [-0.065, 0.285],
  knB: [0.065, 0.28],
  anA: [-0.065, 0.048],
  anB: [0.065, 0.048],
  heA: [-0.065, 0.014],
  heB: [0.065, 0.014],
  toA: [-0.072, 0.01],
  toB: [0.072, 0.01],
};
const SIT_SIDE: JointTable = {
  head: [0.02, 0.69],
  neck: [0.008, 0.605],
  chest: [0.012, 0.508],
  waist: [-0.012, 0.372],
  pelvis: [-0.03, 0.285],
  shA: [0, 0.573],
  shB: [0, 0.573],
  elA: [0.01, 0.39],
  elB: [0.004, 0.39],
  wrA: [0.15, 0.33],
  wrB: [0.14, 0.335],
  haA: [0.21, 0.318],
  haB: [0.2, 0.322],
  hipA: [-0.01, 0.27],
  hipB: [-0.014, 0.27],
  knA: [0.2, 0.285],
  knB: [0.192, 0.28],
  anA: [0.205, 0.048],
  anB: [0.188, 0.048],
  heA: [0.18, 0.014],
  heB: [0.163, 0.014],
  toA: [0.3, 0.01],
  toB: [0.283, 0.01],
};

// Standing, B (left) arm pointing forward-and-out: reads in every view.
const POINT_FRONT: JointTable = {
  ...STAND_FRONT,
  elB: [0.227, 0.81],
  wrB: [0.324, 0.805],
  haB: [0.364, 0.803],
};
const POINT_SIDE: JointTable = {
  ...STAND_SIDE,
  head: [0.024, 0.933],
  elB: [0.144, 0.81],
  wrB: [0.258, 0.805],
  haB: [0.306, 0.803],
};

// Half squat, heels down, torso leaning forward, forearms toward the knees.
const CROUCH_FRONT: JointTable = {
  head: [0, 0.675],
  neck: [0, 0.6],
  chest: [0, 0.52],
  waist: [0, 0.405],
  pelvis: [0, 0.325],
  shA: [-0.106, 0.575],
  shB: [0.106, 0.575],
  elA: [-0.13, 0.41],
  elB: [0.13, 0.415],
  wrA: [-0.11, 0.28],
  wrB: [0.11, 0.29],
  haA: [-0.1, 0.225],
  haB: [0.1, 0.235],
  hipA: [-0.055, 0.31],
  hipB: [0.055, 0.31],
  knA: [-0.09, 0.263],
  knB: [0.09, 0.26],
  anA: [-0.07, 0.048],
  anB: [0.07, 0.048],
  heA: [-0.07, 0.014],
  heB: [0.07, 0.014],
  toA: [-0.08, 0.01],
  toB: [0.08, 0.01],
};
const CROUCH_SIDE: JointTable = {
  head: [0.12, 0.675],
  neck: [0.08, 0.6],
  chest: [0.02, 0.52],
  waist: [-0.045, 0.405],
  pelvis: [-0.075, 0.325],
  shA: [0.06, 0.575],
  shB: [0.06, 0.575],
  elA: [0.14, 0.41],
  elB: [0.13, 0.415],
  wrA: [0.2, 0.28],
  wrB: [0.19, 0.29],
  haA: [0.22, 0.225],
  haB: [0.215, 0.235],
  hipA: [-0.075, 0.31],
  hipB: [-0.08, 0.31],
  knA: [0.13, 0.263],
  knB: [0.12, 0.26],
  anA: [0.03, 0.048],
  anB: [0.02, 0.048],
  heA: [0.005, 0.014],
  heB: [-0.005, 0.014],
  toA: [0.13, 0.01],
  toB: [0.12, 0.01],
};

export const POSE_TABLES: Record<Pose, { front: JointTable; side: JointTable }> = {
  stand: { front: STAND_FRONT, side: STAND_SIDE },
  walk: { front: WALK_FRONT, side: WALK_SIDE },
  run: { front: RUN_FRONT, side: RUN_SIDE },
  sit: { front: SIT_FRONT, side: SIT_SIDE },
  point: { front: POINT_FRONT, side: POINT_SIDE },
  crouch: { front: CROUCH_FRONT, side: CROUCH_SIDE },
};

/** Head ellipse half-axes (front width, side depth, height) in stature units (1 : 7.5). */
export const HEAD = { rxFront: 0.052, rxSide: 0.061, ry: 0.0667 } as const;

/** Head-top height of a pose as a fraction of standing height. */
export function poseTopY(pose: Pose): number {
  return POSE_TABLES[pose].front.head[1] + HEAD.ry;
}

// Limb radii (half widths): [start, end].
const R = {
  upperArm: [0.031, 0.023],
  foreArm: [0.022, 0.016],
  hand: [0.019, 0.015],
  thigh: [0.053, 0.035],
  shin: [0.034, 0.021],
  foot: [0.022, 0.016],
  neck: [0.027, 0.027],
} as const;

/** Torso cross-sections: lateral half width W and front-back half depth D. */
const TORSO = {
  shoulder: { W: 0.112, D: 0.055 },
  chest: { W: 0.098, D: 0.068 },
  waist: { W: 0.078, D: 0.058 },
  pelvis: { W: 0.092, D: 0.064 },
  crotch: { W: 0.056, D: 0.05 },
} as const;

export type PuppetView = 'front' | '3q' | 'side' | 'back';
export const VIEW_ANGLE: Record<PuppetView, number> = { front: 0, '3q': 45, side: 90, back: 180 };

/**
 * Relative facing bucket: |rel| < 30 front, 30–75 3q, 75–120 side, > 120 back;
 * negative rel (facing screen-left) is drawn mirrored.
 */
export function facingBucket(relDeg: number): { view: PuppetView; mirror: boolean } {
  const r = wrapDeg(relDeg);
  const a = Math.abs(r);
  const view: PuppetView = a < 30 ? 'front' : a < 75 ? '3q' : a <= 120 ? 'side' : 'back';
  // exactly away (±180) is ambiguous under float noise: treat as unmirrored
  return { view, mirror: r < 0 && a < 179.5 };
}

export type PuppetFill = 'body' | 'hair' | 'none';

export interface PuppetPart {
  key: string;
  /** closed polygon, normalised units (x right, y up, standing height 1) */
  pts: V2[];
  fill: PuppetFill;
  /** stroke the part's own outline in the fill pass */
  stroke: boolean;
  /** contributes to the bold silhouette pass */
  silhouette: boolean;
}

export interface PuppetLine {
  key: string;
  pts: V2[];
}

export interface PuppetShape {
  view: PuppetView;
  mirror: boolean;
  /** parts in draw order (back → front) */
  parts: PuppetPart[];
  /** interior detail lines (face / coat hints), drawn after the parts they sit on */
  lines: PuppetLine[];
  /** index in `parts` after which each line is drawn */
  lineAfter: number[];
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

type J3 = { L: number; F: number; y: number };

function joints3(pose: Pose): Record<Joint, J3> {
  const { front, side } = POSE_TABLES[pose];
  const out = {} as Record<Joint, J3>;
  for (const j of JOINTS) {
    const f = front[j];
    const s = side[j];
    out[j] = { L: f[0], F: s[0], y: (f[1] + s[1]) / 2 };
  }
  return out;
}

/** Tapered capsule polygon between two circles (outer tangents + round caps). */
export function capsule(p0: V2, p1: V2, r0: number, r1: number, seg = 7): V2[] {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-9 || L <= Math.abs(r0 - r1)) {
    const c = r0 >= r1 ? p0 : p1;
    const r = Math.max(r0, r1);
    return ellipse(c, r, r, seg * 2 + 2);
  }
  const th = Math.atan2(dy, dx);
  const beta = Math.acos(clamp((r0 - r1) / L, -1, 1));
  const out: V2[] = [];
  // end cap: from th − beta to th + beta (through th)
  for (let i = 0; i <= seg; i++) {
    const a = th - beta + (2 * beta * i) / seg;
    out.push([p1[0] + r1 * Math.cos(a), p1[1] + r1 * Math.sin(a)]);
  }
  // start cap: from th + beta to th + 2π − beta (through th + π)
  for (let i = 0; i <= seg; i++) {
    const a = th + beta + ((2 * Math.PI - 2 * beta) * i) / seg;
    out.push([p0[0] + r0 * Math.cos(a), p0[1] + r0 * Math.sin(a)]);
  }
  return out;
}

export function ellipse(c: V2, rx: number, ry: number, n = 24, rot = 0): V2[] {
  const out: V2[] = [];
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const x = rx * Math.cos(a);
    const y = ry * Math.sin(a);
    out.push([c[0] + x * cr - y * sr, c[1] + x * sr + y * cr]);
  }
  return out;
}

const projW = (W: number, D: number, a: number) => Math.hypot(W * Math.cos(a), D * Math.sin(a));

/**
 * Build a puppet at a canonical view (front / 3q / side / back), optionally
 * mirrored for screen-left facings. Pure; output in normalised units.
 */
export function buildPuppet(pose: Pose, view: PuppetView, mirror: boolean, silhouette: Silhouette): PuppetShape {
  const a = VIEW_ANGLE[view] * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const J = joints3(pose);
  const sx = (j: J3) => j.L * ca + j.F * sa;
  const tz = (j: J3) => -j.L * sa + j.F * ca;
  const P = (k: Joint): V2 => [sx(J[k]), J[k].y];
  const T = (k: Joint): number => tz(J[k]);
  const turned = Math.abs(sa) > 0.3;
  const thin = (t: number) => (turned && t < -0.02 ? 0.88 : 1);

  type Draft = PuppetPart & { t: number };
  const drafts: Draft[] = [];
  const limb = (key: string, j0: Joint, j1: Joint, r: readonly [number, number], bias: number) => {
    const t = (T(j0) + T(j1)) / 2;
    const k = thin(t);
    drafts.push({ key, pts: capsule(P(j0), P(j1), r[0] * k, r[1] * k), fill: 'body', stroke: true, silhouette: true, t: t + bias });
  };

  // Legs: behind the torso when turned; over the pelvis (under any skirt) when frontal.
  const legBias = turned ? -0.08 : 0.001;
  for (const s of ['A', 'B'] as const) {
    limb(`thigh${s}`, `hip${s}`, `kn${s}`, R.thigh, legBias);
    limb(`shin${s}`, `kn${s}`, `an${s}`, R.shin, legBias - 0.001);
    limb(`foot${s}`, `he${s}`, `to${s}`, R.foot, legBias + 0.001);
  }

  // Torso: sections along the spine, offset along the spine normal.
  const shMid: J3 = {
    L: (J.shA.L + J.shB.L) / 2,
    F: (J.shA.F + J.shB.F) / 2,
    y: (J.shA.y + J.shB.y) / 2,
  };
  const crotch: J3 = { L: J.pelvis.L, F: J.pelvis.F, y: J.pelvis.y - 0.05 };
  const coat = silhouette === 'coat';
  const wScale = coat ? 1.05 : 1;
  const sections: { c: V2; hw: number }[] = [
    { c: [sx(shMid), shMid.y], hw: projW(TORSO.shoulder.W, TORSO.shoulder.D, a) * wScale },
    { c: P('chest'), hw: projW(TORSO.chest.W, TORSO.chest.D, a) * wScale },
    { c: P('waist'), hw: projW(TORSO.waist.W, TORSO.waist.D, a) * wScale },
    { c: P('pelvis'), hw: projW(TORSO.pelvis.W, TORSO.pelvis.D, a) * wScale },
    { c: [sx(crotch), crotch.y], hw: projW(TORSO.crotch.W, TORSO.crotch.D, a) },
  ];
  const right: V2[] = [];
  const left: V2[] = [];
  for (let i = 0; i < sections.length; i++) {
    const prev = sections[Math.max(0, i - 1)]!.c;
    const next = sections[Math.min(sections.length - 1, i + 1)]!.c;
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const n: V2 = [-dy, dx]; // right-hand normal of a downward spine
    const s = sections[i]!;
    right.push([s.c[0] + n[0] * s.hw, s.c[1] + n[1] * s.hw]);
    left.push([s.c[0] - n[0] * s.hw, s.c[1] - n[1] * s.hw]);
  }
  const top = sections[0]!.c;
  const neckHw = 0.045;
  const torsoPts: V2[] = [
    [top[0] - neckHw, top[1] + 0.022],
    [top[0] + neckHw, top[1] + 0.022],
    ...right,
    ...left.reverse(),
  ];
  drafts.push({ key: 'torso', pts: chaikin(torsoPts, 2), fill: 'body', stroke: true, silhouette: true, t: 0 });

  // Coat tail / dress: hull over waist, hips, (bent) knees and a flat hem; lightly rounded.
  let hemY: number | null = null;
  if (silhouette !== 'regular') {
    const pts: V2[] = [];
    const wc = P('waist');
    const pc = P('pelvis');
    const kA = P('knA');
    const kB = P('knB');
    const hwW = projW(TORSO.waist.W, TORSO.waist.D, a);
    const hwP = projW(TORSO.pelvis.W, TORSO.pelvis.D, a);
    const midX = (kA[0] + kB[0]) / 2;
    const spread = Math.abs(kA[0] - kB[0]);
    const bent = Math.min(kA[1], kB[1]) > pc[1] - 0.12; // both thighs roughly horizontal (sit / crouch)
    const hem = (y: number, half: number) => pts.push([midX - half, y], [midX + half, y]);
    if (coat) {
      pts.push([wc[0] - hwW * 1.12, wc[1]], [wc[0] + hwW * 1.12, wc[1]]);
      pts.push([pc[0] - hwP * 1.16, pc[1]], [pc[0] + hwP * 1.16, pc[1]]);
      hemY = Math.min(kA[1], kB[1], pc[1] - 0.1) + 0.03;
      // coat tails hang from the hips: follow the knees only a little
      const cx = pc[0] + (midX - pc[0]) * 0.35;
      const half = Math.max(hwP * 1.3, Math.min(spread / 2 + 0.05, hwP * 1.6));
      pts.push([cx - half, hemY], [cx + half, hemY]);
    } else {
      pts.push([wc[0] - hwW * 1.0, wc[1]], [wc[0] + hwW * 1.0, wc[1]]);
      pts.push([pc[0] - hwP * 1.1, pc[1] - 0.02], [pc[0] + hwP * 1.1, pc[1] - 0.02]);
      hemY = Math.min(kA[1], kB[1], pc[1] - 0.12) - 0.05;
      hem(hemY, Math.max(hwP * 1.75, spread / 2 + 0.085));
    }
    if (bent) {
      for (const k of [kA, kB]) {
        const r = R.thigh[1] + 0.02;
        pts.push([k[0] - r, k[1] + r], [k[0] + r, k[1] + r], [k[0] + r, k[1] - r]);
      }
    }
    const hull = convexHull(pts);
    drafts.push({ key: 'skirt', pts: chaikin(hull, 1, 0.14), fill: 'body', stroke: true, silhouette: true, t: 0.004 });
  }

  // Neck and head.
  const hc = P('head');
  const nk = P('neck');
  const toHead: V2 = [hc[0] - nk[0], hc[1] - nk[1]];
  const nl = Math.hypot(toHead[0], toHead[1]) || 1;
  const neckTop: V2 = [nk[0] + (toHead[0] / nl) * 0.04, nk[1] + (toHead[1] / nl) * 0.04];
  drafts.push({ key: 'neck', pts: capsule(nk, neckTop, R.neck[0], R.neck[1]), fill: 'body', stroke: true, silhouette: true, t: -0.001 });

  // Arms (in front of the torso unless on the far side).
  for (const s of ['A', 'B'] as const) {
    limb(`upperArm${s}`, `sh${s}`, `el${s}`, R.upperArm, 0.02);
    limb(`foreArm${s}`, `el${s}`, `wr${s}`, R.foreArm, 0.021);
    limb(`hand${s}`, `wr${s}`, `ha${s}`, R.hand, 0.022);
  }

  const rx = projW(HEAD.rxFront, HEAD.rxSide, a);
  const ry = HEAD.ry;
  const headT = T('head') + 0.03;

  // Nose bump (profile only) sits behind the head fill.
  if (view === 'side') {
    drafts.push({
      key: 'nose',
      pts: [
        [hc[0] + rx - 0.012, hc[1] + 0.006],
        [hc[0] + rx + 0.017, hc[1] - 0.02],
        [hc[0] + rx - 0.004, hc[1] - 0.03],
      ],
      fill: 'body',
      stroke: true,
      silhouette: true,
      t: headT - 0.0005,
    });
  }
  const headPoly = ellipse(hc, rx, ry, 28);
  drafts.push({ key: 'head', pts: headPoly, fill: 'hair', stroke: true, silhouette: true, t: headT });

  // Face: the part of the head's front hemisphere below the hairline.
  const face = facePolygon(hc, rx, ry, VIEW_ANGLE[view]);
  if (face) drafts.push({ key: 'face', pts: face, fill: 'body', stroke: false, silhouette: false, t: headT + 0.0001 });
  drafts.push({ key: 'headLine', pts: headPoly, fill: 'none', stroke: true, silhouette: false, t: headT + 0.0002 });

  // Stable sort back → front.
  const order = drafts.map((d, i) => ({ d, i })).sort((p, q) => p.d.t - q.d.t || p.i - q.i);
  const parts: PuppetPart[] = order.map(({ d }) => ({ key: d.key, pts: d.pts, fill: d.fill, stroke: d.stroke, silhouette: d.silhouette }));
  const lines: PuppetLine[] = [];
  const lineAfter: number[] = [];
  const idxOf = (key: string) => parts.findIndex((p) => p.key === key);

  // Mannequin face cross (centre meridian + eye line) on visible faces.
  if (view === 'front' || view === '3q') {
    const faceIdx = idxOf('face');
    const hair = 0.3 * ry;
    const mer: V2[] = [];
    for (let i = 0; i <= 10; i++) {
      const y = hair - ((hair + ry * 0.92) * i) / 10;
      const q = Math.sqrt(Math.max(0, 1 - (y / ry) ** 2));
      mer.push([hc[0] + rx * sa * q, hc[1] + y]);
    }
    lines.push({ key: 'faceMeridian', pts: mer });
    lineAfter.push(faceIdx);
    const ye = -0.08 * ry;
    const re = rx * Math.sqrt(1 - (ye / ry) ** 2);
    const eye: V2[] = [];
    const lo = view === 'front' ? -0.82 : -0.35;
    for (let i = 0; i <= 8; i++) {
      const u = lo + ((0.82 - lo) * i) / 8;
      eye.push([hc[0] + re * u, hc[1] + ye - 0.12 * ry * (1 - u * u) * 0.5]);
    }
    lines.push({ key: 'faceEyes', pts: eye });
    lineAfter.push(faceIdx);
  }
  if (view === '3q') {
    const nx = hc[0] + rx * 0.93;
    lines.push({ key: 'noseTick', pts: [[nx - 0.004, hc[1] + 0.004], [nx + 0.008, hc[1] - 0.02], [nx - 0.003, hc[1] - 0.024]] });
    lineAfter.push(idxOf('headLine'));
  }
  if (coat && view !== 'back' && view !== 'side' && hemY !== null) {
    const off = (j: J3, D: number) => sx(j) + D * sa;
    const ys: V2[] = [
      [off(J.chest, TORSO.chest.D), J.chest.y],
      [off(J.waist, TORSO.waist.D), J.waist.y],
      [off(J.pelvis, TORSO.pelvis.D), J.pelvis.y],
      [off(J.pelvis, TORSO.pelvis.D) + (P('knA')[0] + P('knB')[0]) / 2 - P('pelvis')[0], hemY],
    ];
    lines.push({ key: 'coatFront', pts: ys });
    lineAfter.push(idxOf('skirt'));
  }

  let shape: PuppetShape = { view, mirror, parts, lines, lineAfter, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } };
  if (mirror) shape = mirrorShape(shape);
  shape.bbox = bboxOf(shape.parts.filter((p) => p.silhouette).flatMap((p) => p.pts));
  return shape;
}

function facePolygon(c: V2, rx: number, ry: number, angleDeg: number): V2[] | null {
  const a = angleDeg * DEG;
  const ca = Math.cos(a);
  if (angleDeg >= 150) return null;
  const hair = 0.3 * ry; // hairline height above the head centre
  const n = 14;
  const rightPts: V2[] = [];
  const leftPts: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const y = -ry + ((hair + ry) * i) / n;
    const q = Math.sqrt(Math.max(0, 1 - (y / ry) ** 2));
    const xr = rx * q;
    const xl = Math.min(xr, (ca >= 0 ? -1 : 1) * rx * Math.abs(ca) * q);
    rightPts.push([c[0] + xr, c[1] + y]);
    leftPts.push([c[0] + xl, c[1] + y]);
  }
  const width = Math.max(...rightPts.map((p, i) => p[0] - (leftPts[i] as V2)[0]));
  if (width < 0.06 * rx) return null;
  return [...rightPts, ...leftPts.reverse()];
}

function mirrorShape(s: PuppetShape): PuppetShape {
  const m = (pts: V2[]): V2[] => pts.map((p) => [-p[0], p[1]] as V2).reverse();
  return {
    ...s,
    parts: s.parts.map((p) => ({ ...p, pts: m(p.pts) })),
    lines: s.lines.map((l) => ({ ...l, pts: l.pts.map((p) => [-p[0], p[1]] as V2) })),
  };
}

function bboxOf(pts: readonly V2[]) {
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

/** Top-down glyph (overhead shots): head circle + shoulder ellipse + nose, in metres on the ground plane. */
export interface TopGlyph {
  shoulders: { rx: number; ry: number };
  head: { r: number };
  /** nose triangle offsets in the body frame (x lateral, y forward) */
  nose: V2[];
}
export const TOP_GLYPH: TopGlyph = {
  shoulders: { rx: 0.135, ry: 0.07 },
  head: { r: 0.075 },
  nose: [
    [-0.022, 0.06],
    [0, 0.1],
    [0.022, 0.06],
  ],
};
