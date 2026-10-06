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
 *
 * Layering is decided per whole limb, never per segment, so a leg's thigh,
 * shin and foot can never interleave with the other leg. Parts carry a
 * `group`; renderers draw each group's outlines first and its fills on top,
 * which merges thigh/shin/foot into one continuous limb (no knee circles)
 * while a nearer group still draws its contour over a farther one.
 * Layer order, back → front:
 *   (long hair seen from the front) → far arm → legs behind the pelvis → torso
 *   (+neck, + any thigh pointing at the viewer) → shins of those legs →
 *   coat/skirt → near arms → head → (hair hanging over the back, a hand held
 *   to the head)
 *
 * S4c: figures read as people. Every part has a material (skin / hair / top /
 * bottom / shoe) the renderers tone; the torso splits into top and bottom
 * clothing below the waist; the head carries a hair style (puppet-style.ts)
 * and detail lines — eyes, brows, nose, mouth, ears, hair whorl, collar,
 * cuffs, waist — placed on a head ellipsoid / the torso in 3D, so they turn
 * with the view. Gesture variants (gesturesFor) override arm joints.
 */
import type { Pose, Silhouette } from '@storyscript/contracts';
import { rngFor } from '../util/random.ts';
import { DEG, chaikin, clamp, clipPolygon, convexHull, mix2, type V2, wrapDeg } from './math.ts';
import { DEFAULT_FIGURE_STYLE, type FigureStyle, type HairStyle } from './puppet-style.ts';

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
// Kneeling on the A (right) knee, B foot planted ahead, B forearm resting on the B knee.
const KNEEL_FRONT: JointTable = {
  head: [0, 0.678],
  neck: [0, 0.593],
  chest: [0, 0.495],
  waist: [0, 0.36],
  pelvis: [0, 0.27],
  shA: [-0.106, 0.56],
  shB: [0.106, 0.56],
  elA: [-0.135, 0.375],
  elB: [0.125, 0.4],
  wrA: [-0.142, 0.228],
  wrB: [0.085, 0.31],
  haA: [-0.147, 0.17],
  haB: [0.075, 0.3],
  hipA: [-0.05, 0.245],
  hipB: [0.05, 0.245],
  knA: [-0.055, 0.035],
  knB: [0.062, 0.285],
  anA: [-0.055, 0.05],
  anB: [0.062, 0.048],
  heA: [-0.055, 0.07],
  heB: [0.062, 0.014],
  toA: [-0.06, 0.01],
  toB: [0.068, 0.01],
};
const KNEEL_SIDE: JointTable = {
  head: [0.02, 0.678],
  neck: [0.008, 0.593],
  chest: [0.012, 0.495],
  waist: [0, 0.36],
  pelvis: [-0.01, 0.27],
  shA: [0, 0.56],
  shB: [0, 0.56],
  elA: [-0.01, 0.375],
  elB: [0.06, 0.4],
  wrA: [0.005, 0.228],
  wrB: [0.18, 0.31],
  haA: [0.012, 0.17],
  haB: [0.23, 0.3],
  hipA: [-0.005, 0.245],
  hipB: [-0.01, 0.245],
  knA: [0.02, 0.035],
  knB: [0.2, 0.285],
  anA: [-0.22, 0.05],
  anB: [0.2, 0.048],
  heA: [-0.245, 0.07],
  heB: [0.175, 0.014],
  toA: [-0.17, 0.01],
  toB: [0.295, 0.01],
};

// Standing, B arm reaching straight ahead at shoulder height (a little outward, so
// it still reads from the front), torso leaning into the reach.
// Leaning in, B arm reaching forward and down (for something on a table or a
// shelf, or a hand to pull someone up); the A arm hangs a little back.
const REACH_FRONT: JointTable = {
  ...STAND_FRONT,
  head: [0, 0.918],
  neck: [0, 0.834],
  chest: [0, 0.74],
  shA: [-0.106, 0.802],
  shB: [0.106, 0.806],
  elB: [0.13, 0.69],
  wrB: [0.128, 0.61],
  haB: [0.124, 0.57],
};
const REACH_SIDE: JointTable = {
  ...STAND_SIDE,
  head: [0.075, 0.918],
  neck: [0.05, 0.834],
  chest: [0.04, 0.74],
  waist: [0.012, 0.612],
  shA: [0.03, 0.802],
  shB: [0.03, 0.806],
  elA: [-0.03, 0.62],
  wrA: [-0.03, 0.475],
  haA: [-0.026, 0.415],
  elB: [0.17, 0.69],
  wrB: [0.29, 0.61],
  haB: [0.345, 0.57],
};

// Standing, A hand holding a phone to the A ear.
const PHONE_FRONT: JointTable = {
  ...STAND_FRONT,
  elA: [-0.15, 0.69],
  wrA: [-0.082, 0.83],
  haA: [-0.066, 0.895],
};
const PHONE_SIDE: JointTable = {
  ...STAND_SIDE,
  head: [0.014, 0.933],
  elA: [0.1, 0.69],
  wrA: [0.035, 0.83],
  haA: [0.02, 0.895],
};

// Lying on the back, head toward +F, A knee drawn up. Unlike the other poses the
// origin is the ground point under the head centre (a lying subject's x / z),
// and y is the height above the ground: the whole body stays below ~0.25.
const LIE_FRONT: JointTable = {
  head: [0, 0.075],
  neck: [0, 0.062],
  chest: [0, 0.075],
  waist: [0, 0.065],
  pelvis: [0, 0.07],
  shA: [-0.106, 0.06],
  shB: [0.106, 0.06],
  elA: [-0.14, 0.04],
  elB: [0.14, 0.04],
  wrA: [-0.15, 0.03],
  wrB: [0.15, 0.03],
  haA: [-0.152, 0.025],
  haB: [0.152, 0.025],
  hipA: [-0.05, 0.065],
  hipB: [0.05, 0.065],
  knA: [-0.065, 0.2],
  knB: [0.055, 0.05],
  anA: [-0.06, 0.05],
  anB: [0.055, 0.045],
  heA: [-0.06, 0.018],
  heB: [0.055, 0.02],
  toA: [-0.066, 0.012],
  toB: [0.062, 0.1],
};
const LIE_SIDE: JointTable = {
  head: [0, 0.075],
  neck: [-0.085, 0.062],
  chest: [-0.183, 0.075],
  waist: [-0.318, 0.065],
  pelvis: [-0.408, 0.07],
  shA: [-0.118, 0.06],
  shB: [-0.118, 0.06],
  elA: [-0.305, 0.04],
  elB: [-0.305, 0.04],
  wrA: [-0.455, 0.03],
  wrB: [-0.455, 0.03],
  haA: [-0.515, 0.025],
  haB: [-0.515, 0.025],
  hipA: [-0.433, 0.065],
  hipB: [-0.433, 0.065],
  knA: [-0.62, 0.2],
  knB: [-0.648, 0.05],
  anA: [-0.79, 0.05],
  anB: [-0.885, 0.045],
  heA: [-0.8, 0.018],
  heB: [-0.905, 0.02],
  toA: [-0.69, 0.012],
  toB: [-0.93, 0.1],
};

export const POSE_TABLES: Record<Pose, { front: JointTable; side: JointTable }> = {
  stand: { front: STAND_FRONT, side: STAND_SIDE },
  walk: { front: WALK_FRONT, side: WALK_SIDE },
  run: { front: RUN_FRONT, side: RUN_SIDE },
  sit: { front: SIT_FRONT, side: SIT_SIDE },
  point: { front: POINT_FRONT, side: POINT_SIDE },
  crouch: { front: CROUCH_FRONT, side: CROUCH_SIDE },
  lie: { front: LIE_FRONT, side: LIE_SIDE },
  kneel: { front: KNEEL_FRONT, side: KNEEL_SIDE },
  reach: { front: REACH_FRONT, side: REACH_SIDE },
  phone: { front: PHONE_FRONT, side: PHONE_SIDE },
};

/**
 * A lying body is drawn as the standing figure it would be if it were rotated
 * up onto its feet (the "standing frame": up = toward the head, forward = the
 * world up its face looks at). Its billboard turns about the body's long axis,
 * in a plane through that axis at this height above the ground (stature units).
 */
export const LIE_AXIS_Y = 0.07;
/** head-centre height of the standing-frame figure (its long-axis coordinate of the head) */
const LIE_HEAD_S = 0.933;

// ---------------------------------------------------------------------------
// Gesture variants
// ---------------------------------------------------------------------------

/**
 * One way of holding the arms in a pose (and of carrying the head). Overrides
 * arm joints of the pose's FRONT / SIDE tables; heights agree between the two.
 */
export interface GestureVariant {
  key: string;
  front?: Partial<JointTable>;
  side?: Partial<JointTable>;
  /** head yaw toward the figure's left (deg, faces only) and tilt (deg, counter-clockwise in the unmirrored view) */
  head?: { turn?: number; tilt?: number };
}

const NATURAL: GestureVariant = { key: 'natural' };

const STAND_GESTURES: readonly GestureVariant[] = [
  { key: 'arms-down' },
  {
    key: 'pockets',
    front: { elA: [-0.142, 0.64], elB: [0.142, 0.64], wrA: [-0.112, 0.5], wrB: [0.112, 0.5], haA: [-0.104, 0.475], haB: [0.104, 0.475] },
    side: { elA: [-0.035, 0.64], elB: [-0.045, 0.64], wrA: [0, 0.5], wrB: [-0.01, 0.5], haA: [0.012, 0.475], haB: [0.002, 0.475] },
    head: { tilt: -2 },
  },
  {
    key: 'arms-crossed',
    front: { elA: [-0.128, 0.63], wrA: [0.03, 0.665], haA: [0.07, 0.672], elB: [0.128, 0.635], wrB: [-0.03, 0.69], haB: [-0.07, 0.697] },
    side: { elA: [0.02, 0.63], wrA: [0.088, 0.665], haA: [0.09, 0.672], elB: [0.015, 0.635], wrB: [0.092, 0.69], haB: [0.094, 0.697] },
    head: { tilt: 3 },
  },
  {
    key: 'hand-on-hip',
    front: { elB: [0.215, 0.665], wrB: [0.115, 0.585], haB: [0.09, 0.565] },
    side: { elB: [-0.055, 0.665], wrB: [-0.02, 0.585], haB: [0, 0.565] },
    head: { tilt: -4 },
  },
  {
    key: 'talking',
    front: { elB: [0.15, 0.63], wrB: [0.13, 0.73], haB: [0.115, 0.77] },
    side: { elB: [0.01, 0.63], wrB: [0.13, 0.73], haB: [0.17, 0.77] },
    head: { turn: 8, tilt: 3 },
  },
];

const SIT_GESTURES: readonly GestureVariant[] = [
  { key: 'hands-on-thighs' },
  {
    key: 'arms-crossed',
    front: { elA: [-0.128, 0.39], wrA: [0.03, 0.425], haA: [0.07, 0.432], elB: [0.128, 0.395], wrB: [-0.03, 0.45], haB: [-0.07, 0.457] },
    side: { elA: [0.02, 0.39], wrA: [0.088, 0.425], haA: [0.09, 0.432], elB: [0.015, 0.395], wrB: [0.092, 0.45], haB: [0.094, 0.457] },
    head: { tilt: -3 },
  },
  {
    key: 'talking',
    front: { elB: [0.15, 0.39], wrB: [0.13, 0.49], haB: [0.115, 0.53] },
    side: { elB: [0.01, 0.39], wrB: [0.13, 0.49], haB: [0.17, 0.53] },
    head: { turn: 8, tilt: 3 },
  },
];

const WALK_GESTURES: readonly GestureVariant[] = [
  { key: 'arm-swing' },
  {
    key: 'pockets',
    front: { elA: [-0.142, 0.632], elB: [0.142, 0.632], wrA: [-0.112, 0.492], wrB: [0.112, 0.492], haA: [-0.104, 0.467], haB: [0.104, 0.467] },
    side: { elA: [-0.03, 0.632], elB: [-0.04, 0.632], wrA: [0.005, 0.492], wrB: [-0.005, 0.492], haA: [0.017, 0.467], haB: [0.007, 0.467] },
    head: { tilt: -2 },
  },
];

export const GESTURES: Record<Pose, readonly GestureVariant[]> = {
  stand: STAND_GESTURES,
  walk: WALK_GESTURES,
  run: [NATURAL],
  sit: SIT_GESTURES,
  point: [NATURAL],
  crouch: [NATURAL],
  lie: [NATURAL],
  kneel: [NATURAL],
  reach: [NATURAL],
  phone: [{ key: 'natural', head: { tilt: -4 } }],
};

/** The gesture variants of a pose (index = BoardSubject.gesture modulo their count). */
export function gesturesFor(pose: Pose): readonly GestureVariant[] {
  return GESTURES[pose];
}

export function gestureCount(pose: Pose): number {
  return GESTURES[pose].length;
}

/** The variant a subject is drawn with: its own `gesture`, else one picked from the board seed. */
export function effectiveGesture(s: { id: string; pose: Pose; gesture?: number | null }, seed: number): number {
  const n = gestureCount(s.pose);
  if (n <= 1) return 0;
  if (s.gesture !== undefined && s.gesture !== null) return ((s.gesture % n) + n) % n;
  return Math.floor(rngFor(seed, `gesture:${s.id}`)() * n) % n;
}

/** Head ellipse half-axes (front width, side depth, height) in stature units (1 : 7.5). */
export const HEAD = { rxFront: 0.052, rxSide: 0.061, ry: 0.0667 } as const;

/** Head-top height of a pose as a fraction of standing height (a lying head: its height above the ground). */
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

/**
 * Hair per style. The hairline is a curve on the skull: its height (fraction
 * of the head's ry above the head centre) at the forehead, the temples, above
 * the ears and at the nape; the hair covers the skull above it. `fringe`
 * lowers the forehead on the figure's right (a side-swept fringe); `volume`
 * scales the outline of the hair beyond the skull (k across, ky up, dy lift).
 */
interface HairShape {
  front: number;
  temple: number;
  side: number;
  nape: number;
  fringe: number;
  volume: { k: number; ky: number; dy: number };
}
const HAIR: Record<HairStyle, HairShape> = {
  short: { front: 0.5, temple: 0.34, side: 0.2, nape: -0.42, fringe: 0, volume: { k: 1.05, ky: 1.0, dy: 0.06 } },
  crop: { front: 0.56, temple: 0.42, side: 0.3, nape: -0.3, fringe: 0, volume: { k: 1.02, ky: 0.99, dy: 0.03 } },
  side: { front: 0.44, temple: 0.3, side: 0.18, nape: -0.46, fringe: 0.3, volume: { k: 1.07, ky: 1.02, dy: 0.08 } },
  long: { front: 0.5, temple: 0.18, side: -0.75, nape: -1, fringe: 0, volume: { k: 1.08, ky: 1.0, dy: 0.06 } },
  ponytail: { front: 0.52, temple: 0.34, side: 0.22, nape: -0.32, fringe: 0, volume: { k: 1.03, ky: 0.99, dy: 0.04 } },
  bun: { front: 0.52, temple: 0.34, side: 0.22, nape: -0.32, fringe: 0, volume: { k: 1.03, ky: 0.99, dy: 0.04 } },
};

/** Hairline height at azimuth φ (deg, 0 = the face, + toward the figure's left). */
function hairlineAt(h: HairShape, phi: number): number {
  const a = Math.abs(wrapDeg(phi));
  const knots: [number, number][] = [
    [0, h.front],
    [60, h.temple],
    [95, h.side],
    [180, h.nape],
  ];
  let y = h.nape;
  for (let i = 1; i < knots.length; i++) {
    const [a0, y0] = knots[i - 1] as [number, number];
    const [a1, y1] = knots[i] as [number, number];
    if (a <= a1) {
      const u = (a - a0) / (a1 - a0);
      y = y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
      break;
    }
  }
  // side-swept fringe on the figure's right of the forehead
  const w = wrapDeg(phi);
  if (h.fringe && w < 0 && w > -75) y -= h.fringe * Math.sin((Math.PI * -w) / 75);
  return y;
}

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
/** What a part is made of (pencil tone offsets, structure fills); a phone counts as 'shoe' (a dark accessory). */
export type PuppetMaterial = 'skin' | 'hair' | 'top' | 'bottom' | 'shoe';

export interface PuppetPart {
  key: string;
  /** limb/body group; consecutive parts of one group are drawn outline-then-fill */
  group: string;
  /** far-side limb of a turned figure (renderers may tone it down) */
  far: boolean;
  /** closed polygon, normalised units (x right, y up, standing height 1) */
  pts: V2[];
  fill: PuppetFill;
  material: PuppetMaterial;
  /** stroke the part's own outline in the fill pass */
  stroke: boolean;
  /** contributes to the bold silhouette pass */
  silhouette: boolean;
}

/**
 * Interior detail line kinds. Renderers pick by on-screen size: 'face' (eyes,
 * brows, nose, mouth) needs a head of ~20 px, 'faceMinor' (ear, nostril) more;
 * 'hair' (whorl, fringe) and 'cloth' (collar, cuffs, waist, coat opening) go
 * with the figure's size.
 */
export type PuppetLineKind = 'face' | 'faceMinor' | 'hair' | 'cloth';

/**
 * Whether a detail line of this kind is drawn on a figure this size on screen
 * (head height / figure height in frame px; `scale` < 1 lowers the bar, e.g.
 * for crisp line art). Small people keep only hair mass and face tone.
 */
export function detailVisible(kind: PuppetLineKind, headPx: number, heightPx: number, scale = 1): boolean {
  switch (kind) {
    case 'face':
      return headPx >= 20 * scale;
    case 'faceMinor':
      return headPx >= 36 * scale;
    case 'hair':
      return headPx >= 16 * scale;
    case 'cloth':
      return heightPx >= 90 * scale;
  }
}

export interface PuppetLine {
  key: string;
  kind: PuppetLineKind;
  pts: V2[];
}

export interface PuppetShape {
  view: PuppetView;
  mirror: boolean;
  /** parts in draw order (back → front), grouped contiguously by `group` */
  parts: PuppetPart[];
  /** interior detail lines (face, hair, clothing), drawn after the parts they sit on */
  lines: PuppetLine[];
  /** index in `parts` after which each line is drawn */
  lineAfter: number[];
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface BuildPuppetOptions {
  /** gesture variant index (taken modulo the pose's count) */
  gesture?: number;
  style?: FigureStyle;
}

type J3 = { L: number; F: number; y: number };

function joints3(pose: Pose, gesture: number): Record<Joint, J3> {
  const { front, side } = POSE_TABLES[pose];
  const g = GESTURES[pose][gesture];
  const fr: JointTable = g?.front ? { ...front, ...g.front } : front;
  const sd: JointTable = g?.side ? { ...side, ...g.side } : side;
  const out = {} as Record<Joint, J3>;
  for (const j of JOINTS) {
    const f = fr[j];
    const s = sd[j];
    const y = (f[1] + s[1]) / 2;
    // lying: into the standing frame (lateral flips so the frame keeps its handedness)
    out[j] = pose === 'lie' ? { L: -f[0], F: y - LIE_AXIS_Y, y: s[0] + LIE_HEAD_S } : { L: f[0], F: s[0], y };
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

/** u ∈ [−1, 1] sampled n times. */
const span = (n: number) => Array.from({ length: n }, (_, i) => -1 + (2 * i) / (n - 1));

/**
 * Build a puppet at a canonical view (front / 3q / side / back), optionally
 * mirrored for screen-left facings. Pure; output in normalised units.
 *
 * A lying figure ('lie') is built in its standing frame (see LIE_AXIS_Y) with
 * the view taken about its long axis ('front' = seen from above, 'side' = from
 * one side at ground level), then laid down: x runs along the body (head at
 * x ≈ 0, toward +x unmirrored), y across it (for 'side', the height above the
 * ground).
 */
export function buildPuppet(pose: Pose, view: PuppetView, mirror: boolean, silhouette: Silhouette, opts: BuildPuppetOptions = {}): PuppetShape {
  const n = gestureCount(pose);
  const gi = (((opts.gesture ?? 0) % n) + n) % n;
  const gv = GESTURES[pose][gi];
  const style = opts.style ?? DEFAULT_FIGURE_STYLE;
  const a = VIEW_ANGLE[view] * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const J = joints3(pose, gi);
  const sx = (j: J3) => j.L * ca + j.F * sa;
  const tz = (j: J3) => -j.L * sa + j.F * ca;
  const P = (k: Joint): V2 => [sx(J[k]), J[k].y];
  const T = (k: Joint): number => tz(J[k]);
  const turned = Math.abs(sa) > 0.3;

  type Draft = PuppetPart & { layer: number; t: number };
  const drafts: Draft[] = [];
  const LAYER = { hairBehind: -1, farArm: 0, legBehind: 1, torso: 2, legFront: 3, skirt: 4, arm: 5, head: 6, hairOver: 6.5, armOverHead: 7 } as const;
  const push = (d: Omit<Draft, 'far'> & { far?: boolean }) => drafts.push({ far: false, ...d });
  type Seg = readonly [string, Joint, Joint, readonly [number, number], PuppetMaterial];

  // One depth per whole limb (mean of its joints): segments of a limb never interleave.
  const limbDepth = (js: readonly Joint[]) => js.reduce((acc, j) => acc + T(j), 0) / js.length;
  const limb = (group: string, layer: number, t: number, far: boolean, segs: readonly Seg[]) => {
    const k = far ? 0.88 : 1;
    for (const [key, j0, j1, r, material] of segs) {
      push({ key, group, far, layer, t, pts: capsule(P(j0), P(j1), r[0] * k, r[1] * k), fill: 'body', material, stroke: true, silhouette: true });
    }
  };
  type Line = PuppetLine & { after: string };
  const lines: Line[] = [];

  // Legs sit behind the pelvis. A thigh that points at the viewer (sitting,
  // crouching, a raised running knee seen from the front) instead merges into
  // the torso group — no seam where it leaves the pelvis — and its shin/foot
  // draw on top, so the knee reads over the foreshortened thigh.
  for (const s of ['A', 'B'] as const) {
    const t = limbDepth([`hip${s}`, `kn${s}`, `an${s}`]);
    const far = turned && t < -0.02;
    const towardViewer = !turned && T(`kn${s}`) - T(`hip${s}`) > 0.12;
    const thigh: Seg = [`thigh${s}`, `hip${s}`, `kn${s}`, R.thigh, 'bottom'];
    const lower: Seg[] = [
      [`shin${s}`, `kn${s}`, `an${s}`, R.shin, 'bottom'],
      [`foot${s}`, `he${s}`, `to${s}`, R.foot, 'shoe'],
    ];
    if (towardViewer) {
      limb('torso', LAYER.torso, 0.001 + t * 0.001, false, [thigh]);
      limb(`leg${s}`, LAYER.legFront, t, false, lower);
    } else {
      limb(`leg${s}`, LAYER.legBehind, t, far, [thigh, ...lower]);
    }
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
    const nrm: V2 = [-dy, dx]; // right-hand normal of a downward spine
    const s = sections[i]!;
    right.push([s.c[0] + nrm[0] * s.hw, s.c[1] + nrm[1] * s.hw]);
    left.push([s.c[0] - nrm[0] * s.hw, s.c[1] - nrm[1] * s.hw]);
  }
  const top = sections[0]!.c;
  const neckHw = 0.045;
  const torsoPts = chaikin([[top[0] - neckHw, top[1] + 0.022], [top[0] + neckHw, top[1] + 0.022], ...right, ...left.reverse()], 2);
  // Top / bottom clothing split a little below the waist, across the spine.
  const wc = P('waist');
  const pc = P('pelvis');
  const cut: V2 = [wc[0] + (pc[0] - wc[0]) * 0.28, wc[1] + (pc[1] - wc[1]) * 0.28];
  let ux = top[0] - pc[0];
  let uy = top[1] - pc[1];
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul;
  uy /= ul;
  const above = (p: V2) => (p[0] - cut[0]) * ux + (p[1] - cut[1]) * uy;
  const upper = clipPolygon(torsoPts, above, mix2);
  const lower = clipPolygon(torsoPts, (p) => -above(p), mix2);
  const torsoPart = (key: string, pts: V2[], material: PuppetMaterial) =>
    push({ key, group: 'torso', layer: LAYER.torso, t: 0, pts, fill: 'body', material, stroke: true, silhouette: true });
  if (upper.length >= 3 && lower.length >= 3) {
    torsoPart('torso', upper, 'top');
    torsoPart('hips', lower, 'bottom');
    const seam = upper.filter((p) => Math.abs(above(p)) < 1e-9).sort((p, q) => p[0] - q[0]);
    if (!coat && seam.length >= 2) {
      const s0 = seam[0] as V2;
      const s1 = seam[seam.length - 1] as V2;
      lines.push({ key: 'waist', kind: 'cloth', after: 'hips', pts: [s0, [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2 - 0.004], s1] });
    }
  } else torsoPart('torso', torsoPts, 'top');

  // Coat tail / dress: hull over waist, hips, (bent) knees and a flat hem; lightly rounded.
  let hemY: number | null = null;
  if (silhouette !== 'regular') {
    const pts: V2[] = [];
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
    push({ key: 'skirt', group: 'skirt', layer: LAYER.skirt, t: 0, pts: chaikin(hull, 1, 0.14), fill: 'body', material: 'bottom', stroke: true, silhouette: true });
  }

  // Neck and head.
  const hc = P('head');
  const nk = P('neck');
  const toHead: V2 = [hc[0] - nk[0], hc[1] - nk[1]];
  const nl = Math.hypot(toHead[0], toHead[1]) || 1;
  const neckTop: V2 = [nk[0] + (toHead[0] / nl) * 0.04, nk[1] + (toHead[1] / nl) * 0.04];
  // neck belongs to the torso group, drawn before it so the collar covers its base
  push({ key: 'neck', group: 'torso', layer: LAYER.torso, t: -0.001, pts: capsule(nk, neckTop, R.neck[0], R.neck[1]), fill: 'body', material: 'skin', stroke: true, silhouette: true });

  // Collar: a V over the chest front, a shallow curve across the back.
  {
    const D = TORSO.shoulder.D;
    const pt = (dL: number, dF: number, dy: number) => {
      const j = { L: shMid.L + dL, F: shMid.F + dF, y: shMid.y + dy };
      return { p: [sx(j), j.y] as V2, t: -dL * sa + dF * ca };
    };
    const front = [pt(-0.046, 0.55 * D, 0.02), pt(-0.022, 0.85 * D, -0.008), pt(0, 0.98 * D, -0.034), pt(0.022, 0.85 * D, -0.008), pt(0.046, 0.55 * D, 0.02)];
    const back = [pt(-0.05, -0.55 * D, 0.02), pt(0, -0.92 * D, 0.01), pt(0.05, -0.55 * D, 0.02)];
    for (const [key, list] of [['collar', front], ['collarBack', back]] as const) {
      let run: V2[] = [];
      const flush = () => {
        if (run.length >= 2) lines.push({ key, kind: 'cloth', after: 'torso', pts: run });
        run = [];
      };
      for (const q of list) {
        if (q.t > 0.012) run.push(q.p);
        else flush();
      }
      flush();
    }
  }

  // Arms: in front of the torso, except the far arm of a turned figure. A hand
  // held to the head (phone) draws over the head.
  for (const s of ['A', 'B'] as const) {
    const t = limbDepth([`sh${s}`, `el${s}`, `wr${s}`]);
    const far = turned && t < -0.02;
    const overHead = pose === 'phone' && s === 'A' && !far;
    limb(`arm${s}`, far ? LAYER.farArm : overHead ? LAYER.armOverHead : LAYER.arm, t, far, [
      [`upperArm${s}`, `sh${s}`, `el${s}`, R.upperArm, 'top'],
      [`foreArm${s}`, `el${s}`, `wr${s}`, R.foreArm, 'top'],
      [`hand${s}`, `wr${s}`, `ha${s}`, R.hand, 'skin'],
    ]);
    // cuff across the sleeve end
    const e = P(`el${s}`);
    const w = P(`wr${s}`);
    const L = Math.hypot(w[0] - e[0], w[1] - e[1]);
    if (L > 0.03) {
      const d: V2 = [(w[0] - e[0]) / L, (w[1] - e[1]) / L];
      const c: V2 = [e[0] + (w[0] - e[0]) * 0.88, e[1] + (w[1] - e[1]) * 0.88];
      const h = R.foreArm[1] * (far ? 0.88 : 1) * 1.2;
      lines.push({ key: `cuff${s}`, kind: 'cloth', after: `foreArm${s}`, pts: [[c[0] - d[1] * h, c[1] + d[0] * h], [c[0] + d[1] * h, c[1] - d[0] * h]] });
    }
    if (overHead) {
      const ha = P('haA');
      push({ key: 'phone', group: 'armA', layer: LAYER.armOverHead, t, far: false, pts: capsule([ha[0], ha[1] - 0.012], [ha[0] + 0.004, ha[1] + 0.05], 0.011, 0.011, 3), fill: 'body', material: 'shoe', stroke: true, silhouette: true });
    }
  }

  // ---- head ---------------------------------------------------------------
  const rx = projW(HEAD.rxFront, HEAD.rxSide, a);
  const ry = HEAD.ry;
  const hair = HAIR[style.hair];
  // the face may look a little aside of the body (gesture head turn)
  const ah = a + (gv?.head?.turn ?? 0) * DEG;
  const cah = Math.cos(ah);
  const sah = Math.sin(ah);
  const headDrafts: Draft[] = [];
  const headLines: Line[] = [];
  const pushHead = (d: Omit<Draft, 'far' | 'layer' | 'group'> & { layer?: number; group?: string }) => {
    const full: Draft = { far: false, layer: LAYER.head, group: 'head', ...d };
    drafts.push(full);
    headDrafts.push(full);
  };
  /** Point on the head ellipsoid at azimuth φ (deg, 0 = the face, + toward the figure's left), height yf·ry, pushed out by k. */
  const headPt = (phi: number, yf: number, k = 0): { p: V2; t: number } => {
    const q = Math.sqrt(Math.max(0, 1 - yf * yf)) * (1 + k);
    const L = HEAD.rxFront * q * Math.sin(phi * DEG);
    const F = HEAD.rxSide * q * Math.cos(phi * DEG);
    return { p: [hc[0] + L * cah + F * sah, hc[1] + yf * ry], t: -L * sah + F * cah };
  };
  const surfaceLine = (key: string, kind: PuppetLineKind, after: string, samples: readonly (readonly [number, number, number])[], minT = 0.007) => {
    let run: V2[] = [];
    const flush = () => {
      if (run.length >= 2) headLines.push({ key, kind, after, pts: run });
      run = [];
    };
    for (const [phi, yf, k] of samples) {
      const q = headPt(phi, yf, k);
      if (q.t > minT) run.push(q.p);
      else flush();
    }
    flush();
  };

  // Hair hanging behind the head (long hair, ponytail, bun): behind the whole
  // figure when it faces the camera, over the head and back otherwise.
  {
    const hairBack: V2[][] = [];
    if (style.hair === 'long') {
      const pts: V2[] = [];
      const rows: [number, number][] = [
        [0.86, 0.86],
        [0.3, 1],
        [-0.5, 1],
        [-1.4, 0.98],
        [-2.1, 0.86],
      ];
      for (const [yf, w] of rows)
        for (let phi = 70; phi <= 290; phi += 20) {
          const L = 1.12 * HEAD.rxFront * Math.sin(phi * DEG) * w;
          const F = Math.min(0.2 * HEAD.rxSide, 1.05 * HEAD.rxSide * Math.cos(phi * DEG)) * w;
          pts.push([hc[0] + L * ca + F * sa, hc[1] + yf * ry]);
        }
      hairBack.push(chaikin(convexHull(pts), 2));
    } else if (style.hair === 'ponytail') {
      const at = (F: number, yf: number): V2 => [hc[0] + F * HEAD.rxSide * sa, hc[1] + yf * ry];
      // tied at the back of the crown, hanging to the nape
      hairBack.push(chaikin([...capsule(at(-0.92, 0.32), at(-1.28, -0.95), 0.012, 0.007, 4)], 1));
    } else if (style.hair === 'bun') {
      hairBack.push(ellipse([hc[0] - 0.8 * HEAD.rxSide * sa, hc[1] + 0.58 * ry], 0.026, 0.024, 16));
    }
    for (const pts of hairBack)
      // behind the head unless the head is seen from behind
      pushHead({ key: 'hairBack', group: 'hairBack', layer: view === 'back' ? LAYER.hairOver : LAYER.hairBehind, t: 0, pts, fill: 'hair', material: 'hair', stroke: true, silhouette: true });
  }

  // Ears: peeking out behind the head seen edge-on, drawn on it seen from the side.
  const ears: { side: number; c: V2; t: number }[] = [];
  for (const side of [-1, 1]) {
    const q = headPt(side * 97, -0.12, 0.1);
    if (q.t > -0.012) ears.push({ side, c: q.p, t: q.t });
  }
  for (const e of ears) {
    const open = clamp(e.t / HEAD.rxFront, 0, 1);
    const onTop = e.t > 0.02;
    const covered = style.hair === 'long';
    pushHead({
      key: onTop ? 'ear' : 'earBehind',
      t: onTop ? (covered ? 0.00005 : 0.00015) : -0.003,
      pts: ellipse(e.c, 0.003 + 0.0035 * open, 0.0115, 14),
      fill: 'body',
      material: 'skin',
      stroke: true,
      silhouette: true,
    });
    if (onTop && !covered) {
      const dir = sah >= 0 ? -1 : 1; // the ear's rim faces the back of the head
      const arc: V2[] = [];
      for (let i = 0; i <= 6; i++) {
        const th = (-70 + (140 * i) / 6) * DEG;
        arc.push([e.c[0] + dir * 0.0045 * open * Math.cos(th), e.c[1] + 0.008 * Math.sin(th)]);
      }
      headLines.push({ key: 'earLine', kind: 'faceMinor', after: 'ear', pts: arc });
    }
  }

  // Nose bump (profile only) sits behind the head fill.
  if (view === 'side') {
    pushHead({
      key: 'nose',
      pts: [
        [hc[0] + rx - 0.012, hc[1] + 0.006],
        [hc[0] + rx + 0.017, hc[1] - 0.02],
        [hc[0] + rx - 0.004, hc[1] - 0.03],
      ],
      fill: 'body',
      material: 'skin',
      stroke: true,
      silhouette: true,
      t: -0.0005,
    });
  }
  // The head is skin; the hair is laid over it, bounded by the visible part of
  // the hairline and, over the crown, by the hair's own outline.
  const headPoly = ellipse(hc, rx, ry, 28);
  pushHead({ key: 'head', pts: headPoly, fill: 'body', material: 'skin', stroke: true, silhouette: true, t: 0 });
  const vol = hair.volume;
  const vc: V2 = [hc[0], hc[1] + vol.dy * ry];
  const vrx = projW(HEAD.rxFront * vol.k, HEAD.rxSide * vol.k, a);
  const vry = ry * vol.ky;
  const cap = hairCap(hair, headPt, vc, vrx, vry);
  let outline = headPoly;
  if (cap) {
    pushHead({ key: 'hair', t: 0.0001, pts: cap, fill: 'hair', material: 'hair', stroke: true, silhouette: true });
    outline = convexHull([...headPoly, ...cap]);
  }
  pushHead({ key: 'headLine', pts: outline, fill: 'none', material: 'hair', stroke: true, silhouette: false, t: 0.0002 });

  // Features: sketchy storyboard marks — lids with an iris tick, brows, nose, mouth.
  if (view !== 'back') {
    for (const side of [-1, 1]) {
      const pc0 = 27 * side;
      surfaceLine('eye', 'face', 'headLine', span(9).map((u) => [pc0 + 10 * u, -0.05 + 0.075 * (1 - u * u), 0] as const));
      surfaceLine('iris', 'face', 'headLine', [
        [pc0 + 1.5, -0.02, 0],
        [pc0 + 1.5, -0.13, 0],
      ]);
      surfaceLine('brow', 'face', 'headLine', span(7).map((u) => [pc0 + 13 * u, 0.19 + 0.05 * (1 - u * u) - 0.025 * u * side, 0.03] as const));
    }
    if (view !== 'side')
      surfaceLine('nose', 'face', 'headLine', [
        [-5, -0.06, 0.02],
        [-7, -0.3, 0.1],
        [-2, -0.4, 0.17],
        [6, -0.37, 0.07],
      ]);
    else
      headLines.push({
        key: 'nostril',
        kind: 'faceMinor',
        after: 'headLine',
        pts: [
          [hc[0] + rx * 0.8, hc[1] - 0.021],
          [hc[0] + rx * 0.92, hc[1] - 0.028],
        ],
      });
    surfaceLine('mouth', 'face', 'headLine', span(7).map((u) => [15 * u, -0.6, 0.03] as const));
    if (style.hair === 'side') surfaceLine('fringe', 'hair', 'headLine', span(6).map((u) => [-38 + 34 * (u + 1), 0.5 - 0.12 * u, 0.07] as const), 0.012);
  } else {
    // hair whorl at the crown
    const whorl: (readonly [number, number, number])[] = [];
    for (let i = 0; i <= 10; i++) {
      const th = (i / 10) * 3 * Math.PI;
      const r = 0.25 + (0.75 * i) / 10;
      whorl.push([180 + 11 * r * Math.cos(th), 0.55 + 0.12 * r * Math.sin(th), 0.05]);
    }
    surfaceLine('whorl', 'hair', 'headLine', whorl, 0.004);
  }

  // Gesture head tilt: the whole head (hair, ears, features) about the top of the neck.
  const tilt = (gv?.head?.tilt ?? 0) * DEG;
  if (tilt) {
    const c = Math.cos(tilt);
    const s = Math.sin(tilt);
    const rot = (p: V2): V2 => [neckTop[0] + (p[0] - neckTop[0]) * c - (p[1] - neckTop[1]) * s, neckTop[1] + (p[0] - neckTop[0]) * s + (p[1] - neckTop[1]) * c];
    for (const d of headDrafts) d.pts = d.pts.map(rot);
    for (const l of headLines) l.pts = l.pts.map(rot);
  }
  lines.push(...headLines);

  if (coat && view !== 'back' && view !== 'side' && hemY !== null) {
    const off = (j: J3, D: number) => sx(j) + D * sa;
    const ys: V2[] = [
      [off(J.chest, TORSO.chest.D), J.chest.y],
      [off(J.waist, TORSO.waist.D), J.waist.y],
      [off(J.pelvis, TORSO.pelvis.D), J.pelvis.y],
      [off(J.pelvis, TORSO.pelvis.D) + (P('knA')[0] + P('knB')[0]) / 2 - P('pelvis')[0], hemY],
    ];
    lines.push({ key: 'coatFront', kind: 'cloth', after: 'skirt', pts: ys });
  }

  // Stable sort back → front: layer, then whole-limb depth; a group's parts stay
  // contiguous and in authoring order (thigh → shin → foot).
  const order = drafts
    .map((d, i) => ({ d, i }))
    .sort((p, q) => p.d.layer - q.d.layer || p.d.t - q.d.t || (p.d.group < q.d.group ? -1 : p.d.group > q.d.group ? 1 : 0) || p.i - q.i);
  let parts: PuppetPart[] = order.map(({ d }) => ({
    key: d.key,
    group: d.group,
    far: d.far,
    pts: d.pts,
    fill: d.fill,
    material: d.material,
    stroke: d.stroke,
    silhouette: d.silhouette,
  }));
  const idxOf = (key: string) => parts.findIndex((p) => p.key === key);
  let outLines: PuppetLine[] = lines.map((l) => ({ key: l.key, kind: l.kind, pts: l.pts }));
  const lineAfter = lines.map((l) => {
    const i = idxOf(l.after);
    return i >= 0 ? i : parts.length - 1;
  });

  if (pose === 'lie') {
    // lay the standing-frame drawing down: along the body → x (head at 0), across → y
    const lay = (p: V2): V2 => [p[1] - LIE_HEAD_S, p[0] + LIE_AXIS_Y];
    parts = parts.map((p) => ({ ...p, pts: p.pts.map(lay) }));
    outLines = outLines.map((l) => ({ ...l, pts: l.pts.map(lay) }));
  }

  let shape: PuppetShape = { view, mirror, parts, lines: outLines, lineAfter, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } };
  if (mirror) shape = mirrorShape(shape);
  shape.bbox = bboxOf(shape.parts.filter((p) => p.silhouette).flatMap((p) => p.pts));
  return shape;
}

/**
 * The hair over the skull as seen: the visible run of the hairline (points on
 * the head where the hair starts, `headPt`) closed over the crown by the
 * hair's outline ellipse (centre `vc`, half-axes vrx × vry). Null when none of
 * the hairline faces the viewer.
 */
function hairCap(
  h: HairShape,
  headPt: (phi: number, yf: number, k?: number) => { p: V2; t: number },
  vc: V2,
  vrx: number,
  vry: number,
): V2[] | null {
  // start the sweep at the most hidden azimuth so the visible run is contiguous
  let phi0 = 0;
  let tMin = Infinity;
  for (let phi = -180; phi < 180; phi += 5) {
    const t = headPt(phi, 0).t;
    if (t < tMin) {
      tMin = t;
      phi0 = phi;
    }
  }
  const run: V2[] = [];
  let prev: { p: V2; t: number } | null = null;
  for (let i = 0; i <= 144; i++) {
    const phi = phi0 + i * 2.5;
    const q = headPt(phi, hairlineAt(h, phi));
    if (prev && (prev.t > 0) !== (q.t > 0)) {
      // where the hairline crosses the silhouette
      const u = prev.t / (prev.t - q.t);
      run.push([prev.p[0] + (q.p[0] - prev.p[0]) * u, prev.p[1] + (q.p[1] - prev.p[1]) * u]);
    }
    if (q.t > 0) run.push(q.p);
    prev = q;
  }
  if (run.length < 2) return null;
  // close over the crown: from the run's end round the top back to its start
  const angle = (p: V2) => Math.atan2((p[1] - vc[1]) / vry, (p[0] - vc[0]) / vrx);
  const a0 = angle(run[run.length - 1] as V2);
  let a1 = angle(run[0] as V2);
  const top = Math.PI / 2;
  // pick the direction whose sweep passes the crown
  const ccw = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const through = ccw(top - a0) < ccw(a1 - a0);
  if (through) {
    while (a1 < a0) a1 += 2 * Math.PI;
  } else {
    while (a1 > a0) a1 -= 2 * Math.PI;
  }
  const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)));
  const arc: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const th = a0 + ((a1 - a0) * i) / n;
    arc.push([vc[0] + vrx * Math.cos(th), vc[1] + vry * Math.sin(th)]);
  }
  return [...run, ...arc];
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
