/**
 * Pinhole camera model + shot-grammar camera solver.
 *
 * World: metres, x → right, y → up, z → away from the camera (yaw 0 looks down +z).
 * Camera space: X right, Y up, Z forward. Image plane in mm:
 *   u = f·X/Z, v = f·Y/Z;  fx = 0.5 + u/36, fy = 0.5 − v/sensor_h   (frame [0,1], top-left origin)
 * sensor_w = 36 mm (full-frame equivalent width); sensor_h = 36 / aspect.
 */
import type {
  BoardCamera,
  CameraAngle,
  FrameFormat,
  LensClass,
  LookPreset,
  Pose,
  ShotFields,
  ShotSize,
  Technique,
} from '@storyscript/contracts';
import { DEG, clamp, clipPolygon, clipSegment, dot3, mix3, round, sub3, type V2, type V3 } from './math.ts';
import { poseTopY } from './puppets.ts';

export const SENSOR_W_MM = 36;
export const NEAR_M = 0.1;
/** Reference stature the shot-size table is written for. */
export const REF_HEIGHT_M = 1.7;

export function aspectValue(aspect: FrameFormat | number): number {
  return typeof aspect === 'number' ? aspect : Number(aspect);
}

export function sensorHeight(aspect: FrameFormat | number): number {
  return SENSOR_W_MM / aspectValue(aspect);
}

/** Vertical field of view (radians): 2·atan(sensor_h / 2f). */
export function vFov(focal_mm: number, aspect: FrameFormat | number): number {
  return 2 * Math.atan(sensorHeight(aspect) / (2 * focal_mm));
}

/** Horizontal field of view (radians): 2·atan(18 / f). */
export function hFov(focal_mm: number): number {
  return 2 * Math.atan(SENSOR_W_MM / 2 / focal_mm);
}

export interface CameraBasis {
  pos: V3;
  right: V3;
  up: V3;
  fwd: V3;
  f: number;
  sw: number;
  sh: number;
}

export function cameraBasis(cam: BoardCamera, aspect: FrameFormat | number): CameraBasis {
  const psi = cam.yaw_deg * DEG;
  const th = cam.pitch_deg * DEG;
  const phi = cam.roll_deg * DEG;
  const sp = Math.sin(psi);
  const cp = Math.cos(psi);
  const st = Math.sin(th);
  const ct = Math.cos(th);
  const fwd: V3 = [sp * ct, st, cp * ct];
  const up0: V3 = [-sp * st, ct, -cp * st];
  const right0: V3 = [cp, 0, -sp];
  const sr = Math.sin(phi);
  const cr = Math.cos(phi);
  const right: V3 = [right0[0] * cr + up0[0] * sr, right0[1] * cr + up0[1] * sr, right0[2] * cr + up0[2] * sr];
  const up: V3 = [up0[0] * cr - right0[0] * sr, up0[1] * cr - right0[1] * sr, up0[2] * cr - right0[2] * sr];
  return { pos: [cam.x, cam.y, cam.z], right, up, fwd, f: cam.focal_mm, sw: SENSOR_W_MM, sh: sensorHeight(aspect) };
}

/** World point → camera space (X right, Y up, Z forward). */
export function toCamera(b: CameraBasis, p: V3): V3 {
  const d = sub3(p, b.pos);
  return [dot3(d, b.right), dot3(d, b.up), dot3(d, b.fwd)];
}

/** Camera-space point (Z > 0) → frame coordinates. */
export function camToFrame(b: CameraBasis, c: V3): V2 {
  const u = (b.f * c[0]) / c[2];
  const v = (b.f * c[1]) / c[2];
  return [0.5 + u / b.sw, 0.5 - v / b.sh];
}

export interface Projected {
  /** frame x, [0,1] inside the frame */
  x: number;
  /** frame y, [0,1] inside the frame (top-left origin) */
  y: number;
  /** camera-space depth along the view axis (m) */
  depth: number;
  /** false when the point lies behind the near plane (x/y are then meaningless) */
  visible: boolean;
}

export function projectPoint(b: CameraBasis, p: V3): Projected {
  const c = toCamera(b, p);
  if (c[2] < NEAR_M) return { x: Number.NaN, y: Number.NaN, depth: c[2], visible: false };
  const [x, y] = camToFrame(b, c);
  return { x, y, depth: c[2], visible: true };
}

/** project(camera, frame, P) → frame coords [0,1] (top-left origin) + depth. */
export function project(cam: BoardCamera, aspect: FrameFormat | number, p: V3): Projected {
  return projectPoint(cameraBasis(cam, aspect), p);
}

/** Direction (world) of the ray through frame point (fx, fy). Not normalised. */
export function frameRay(b: CameraBasis, fx: number, fy: number): V3 {
  const u = (fx - 0.5) * b.sw;
  const v = (0.5 - fy) * b.sh;
  return [
    b.right[0] * u + b.up[0] * v + b.fwd[0] * b.f,
    b.right[1] * u + b.up[1] * v + b.fwd[1] * b.f,
    b.right[2] * u + b.up[2] * v + b.fwd[2] * b.f,
  ];
}

/** Inverse projection onto the horizontal plane y = planeY. Null when the ray misses (parallel or behind). */
export function unprojectToPlane(cam: BoardCamera, aspect: FrameFormat | number, fx: number, fy: number, planeY = 0): V3 | null {
  const b = cameraBasis(cam, aspect);
  const r = frameRay(b, fx, fy);
  if (Math.abs(r[1]) < 1e-12) return null;
  const t = (planeY - b.pos[1]) / r[1];
  if (t <= 0) return null;
  return [b.pos[0] + r[0] * t, planeY, b.pos[2] + r[2] * t];
}

/** Inverse projection at a given camera-space depth. */
export function unprojectAtDepth(cam: BoardCamera, aspect: FrameFormat | number, fx: number, fy: number, depth: number): V3 {
  const b = cameraBasis(cam, aspect);
  const r = frameRay(b, fx, fy);
  const k = depth / b.f; // the ray's forward component is exactly f
  return [b.pos[0] + r[0] * k, b.pos[1] + r[1] * k, b.pos[2] + r[2] * k];
}

/** Project a 3D polygon with near-plane clipping (Sutherland–Hodgman). Empty when fully behind. */
export function projectPolygon(b: CameraBasis, pts: readonly V3[]): V2[] {
  const cam = pts.map((p) => toCamera(b, p));
  const clipped = clipPolygon(cam, (c) => c[2] - NEAR_M, mix3);
  return clipped.map((c) => camToFrame(b, c));
}

/** Project a 3D segment with near-plane clipping. */
export function projectSegment(b: CameraBasis, a: V3, c: V3): [V2, V2] | null {
  const seg = clipSegment(toCamera(b, a), toCamera(b, c), (p) => p[2] - NEAR_M, mix3);
  if (!seg) return null;
  return [camToFrame(b, seg[0]), camToFrame(b, seg[1])];
}

/** Project a 3D polyline with near-plane clipping; returns the visible runs. */
export function projectPolyline(b: CameraBasis, pts: readonly V3[]): V2[][] {
  const runs: V2[][] = [];
  let cur: V2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = projectSegment(b, pts[i] as V3, pts[i + 1] as V3);
    if (!seg) {
      if (cur.length) runs.push(cur);
      cur = [];
      continue;
    }
    const last = cur[cur.length - 1];
    if (cur.length && last && Math.abs(last[0] - seg[0][0]) < 1e-9 && Math.abs(last[1] - seg[0][1]) < 1e-9) {
      cur.push(seg[1]);
    } else {
      if (cur.length) runs.push(cur);
      cur = [seg[0], seg[1]];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * Horizon (vanishing line of the ground plane) as a frame-space segment spanning
 * beyond both frame edges, or null when the camera looks straight down/up.
 */
export function horizonLine(cam: BoardCamera, aspect: FrameFormat | number): [V2, V2] | null {
  const b = cameraBasis(cam, aspect);
  if (Math.abs(b.up[1]) < 1e-6) return null;
  const at = (fx: number): V2 => {
    const u = (fx - 0.5) * b.sw;
    const v = -(u * b.right[1] + b.f * b.fwd[1]) / b.up[1];
    return [fx, 0.5 - v / b.sh];
  };
  return [at(-0.5), at(1.5)];
}

// ---------------------------------------------------------------------------
// Shot grammar → camera
// ---------------------------------------------------------------------------

export const LENS_MM: Record<LensClass, number> = { wide: 24, normal: 40, tele: 85 };

/** Visible height V (m) for the 1.7 m reference subject. WS/EWS are defined by subject share. */
export function visibleHeight(size: ShotSize, height_m = REF_HEIGHT_M): number {
  const s = height_m / REF_HEIGHT_M;
  switch (size) {
    case 'ECU':
      return 0.25 * s;
    case 'CU':
      return 0.45 * s;
    case 'MCU':
      return 0.7 * s;
    case 'MS':
      return 1.0 * s;
    case 'MLS':
      return 1.4 * s;
    case 'FS':
      return 2.0 * s;
    case 'WS':
      return 3 * height_m; // subject ≈ 1/3 of frame height
    case 'EWS':
      return height_m / 0.07; // subject ≈ 7 % of frame height
    case 'INSERT':
      return 0.35;
  }
}

/**
 * World heights (on the subject's vertical axis) that should meet the frame's
 * bottom and top edges. `top_y` is the subject's actual head-top height for the pose.
 */
export function framingBand(size: ShotSize, height_m: number, top_y: number): { bottom: number; top: number } {
  const V = visibleHeight(size, height_m);
  const s = height_m / REF_HEIGHT_M;
  let top: number;
  switch (size) {
    case 'ECU':
      top = top_y - 0.02 * s; // may crop the top of the head
      break;
    case 'CU':
    case 'MCU':
    case 'MS':
    case 'MLS':
    case 'INSERT':
      top = top_y + 0.1 * V; // ~10 % headroom
      break;
    case 'FS':
      top = top_y + (V - top_y) / 2; // centred, room above and below
      break;
    case 'WS':
      top = 0.7 * V; // feet ~30 % up from the bottom edge
      break;
    case 'EWS':
      top = 0.58 * V;
      break;
  }
  return { bottom: top - V, top };
}

const LOW_HEIGHT: Record<ShotSize, number> = { ECU: 0.8, CU: 0.8, MCU: 0.8, MS: 0.7, MLS: 0.6, FS: 0.5, WS: 0.45, EWS: 0.4, INSERT: 0.8 };
const HIGH_HEIGHT: Record<ShotSize, number> = { ECU: 2.5, CU: 2.5, MCU: 2.6, MS: 2.8, MLS: 3.0, FS: 3.3, WS: 3.8, EWS: 4.0, INSERT: 2.5 };
const INSERT_PITCH: Record<CameraAngle, number> = { eye: -30, low: -8, high: -55, overhead: -90, dutch: -30 };
const WIDE_SIZES: ReadonlySet<ShotSize> = new Set<ShotSize>(['EWS', 'WS', 'FS']);

export const DUTCH_ROLL_DEG = 15;
export const SET_PIECE_CAMERA_HEIGHT_M = 0.6;

export interface SolveCameraOptions {
  aspect: FrameFormat;
  /** focal slider ("keep shot size"): highest priority */
  focal_mm?: number | null;
  /** stature of the framed subject (m), default 1.7 */
  subject_height_m?: number | null;
  /** pose of the framed subject (sitting/crouching lowers the head) */
  pose?: Pose | null;
  technique?: Technique | null;
  look?: LookPreset | null;
  /** INSERT: centre height (m) of the featured object */
  insert_center_y?: number | null;
  /** INSERT: view pitch (deg) when the default per-angle pitch does not fit, e.g. an item hung on a wall */
  insert_pitch_deg?: number | null;
  /** fixed rig height (e.g. vehicle hard-mount); a technique's camera_height_m still wins */
  camera_height_m?: number | null;
}

export type FocalSource = 'override' | 'shot' | 'technique' | 'set_piece' | 'lens';
export type SolveMode = 'band' | 'fixed_pitch' | 'overhead' | 'insert';

export interface CameraSolution {
  camera: BoardCamera;
  /** ground point of the framed subject; the camera stands at x = 0, z = 0 */
  subject: { x: number; z: number };
  /** horizontal camera → subject distance (m) */
  distance_m: number;
  /** distance along the view axis (m) */
  axis_distance_m: number;
  /** target visible height V (m) */
  visible_m: number;
  /** world heights at the frame's bottom/top edge on the subject's vertical axis */
  band: { bottom: number; top: number };
  focal_mm: number;
  focal_source: FocalSource;
  mode: SolveMode;
}

const validFocal = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

export function pickFocal(
  fields: Pick<ShotFields, 'focal_mm' | 'lens'>,
  opts: { focal_mm?: number | null; technique?: Technique | null },
  setPieceLowWide: boolean,
): { focal: number; source: FocalSource } {
  if (validFocal(opts.focal_mm)) return { focal: clamp(opts.focal_mm, 8, 800), source: 'override' };
  if (validFocal(fields.focal_mm)) return { focal: clamp(fields.focal_mm, 8, 800), source: 'shot' };
  const tf = opts.technique?.camera_defaults.focal_mm;
  if (validFocal(tf)) return { focal: clamp(tf, 8, 800), source: 'technique' };
  if (setPieceLowWide) return { focal: 24, source: 'set_piece' };
  return { focal: LENS_MM[fields.lens], source: 'lens' };
}

/**
 * Exact framing on the subject's vertical axis: find pitch θ and horizontal
 * distance d so that the frame's top/bottom rays cross the axis at `top`/`bottom`.
 * With a = top − cy, b = bottom − cy, t = tan(vFOV/2), p = tanθ:
 *   (a+b)·t·p² − V(1+t²)·p + (a+b)·t = 0   (take the root with |p| < 1)
 * Reduces to D = V·f/sensor_h when the camera sits at the band centre.
 */
export function solveBand(cy: number, bottom: number, top: number, t: number): { theta: number; d: number } | null {
  const V = top - bottom;
  const s = top - cy + (bottom - cy);
  const k = V * (1 + t * t);
  const disc = k * k - 4 * s * s * t * t;
  if (disc < 0 || V <= 0) return null;
  const p = (2 * s * t) / (k + Math.sqrt(disc));
  const theta = Math.atan(p);
  const beta = Math.atan(t);
  const d = V / (Math.tan(theta + beta) - Math.tan(theta - beta));
  if (!(d > 0)) return null;
  return { theta, d };
}

/** Solve with a pitch cap by moving the camera height toward the band centre when needed. */
function solveBandCapped(cy0: number, bottom: number, top: number, t: number, maxPitch: number): { theta: number; d: number; cy: number } {
  const ok = (cy: number) => {
    const r = solveBand(cy, bottom, top, t);
    return r && Math.abs(r.theta) <= maxPitch ? r : null;
  };
  const direct = ok(cy0);
  if (direct) return { ...direct, cy: cy0 };
  const mid = (top + bottom) / 2;
  let lo = mid; // always feasible (θ = 0)
  let hi = cy0;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (ok(m)) lo = m;
    else hi = m;
  }
  const r = solveBand(lo, bottom, top, t) ?? { theta: 0, d: (top - bottom) / (2 * t) };
  return { ...r, cy: lo };
}

/**
 * Shot grammar → camera. The camera stands at the origin looking down +z; the framed
 * subject stands on the z axis at `distance_m`. Pure and deterministic.
 */
export function solveCamera(
  fields: Pick<ShotFields, 'shot_size' | 'angle' | 'lens' | 'focal_mm' | 'set_piece'>,
  opts: SolveCameraOptions,
): CameraSolution {
  const H = opts.subject_height_m && opts.subject_height_m > 0 ? opts.subject_height_m : REF_HEIGHT_M;
  const topY = poseTopY(opts.pose ?? 'stand') * H;
  const angle = fields.angle;
  const size = fields.shot_size;
  const setPieceLowWide = !!(fields.set_piece && opts.look?.set_piece_low_wide && (angle === 'eye' || angle === 'low'));
  const { focal, source } = pickFocal(fields, opts, setPieceLowWide);
  const sh = sensorHeight(opts.aspect);
  const t = sh / (2 * focal);
  const beta = Math.atan(t);
  const V = visibleHeight(size, H);
  const cd = opts.technique?.camera_defaults;
  const techHeight = cd && typeof cd.camera_height_m === 'number' && cd.camera_height_m > 0 ? cd.camera_height_m : null;
  const techPitch = cd && typeof cd.pitch_deg === 'number' && Number.isFinite(cd.pitch_deg) ? clamp(cd.pitch_deg, -80, 80) : null;
  const roll = angle === 'dutch' ? DUTCH_ROLL_DEG : 0;

  const finish = (cy: number, pitchRad: number, horiz: number, axis: number, band: { bottom: number; top: number }, mode: SolveMode): CameraSolution => ({
    camera: {
      x: 0,
      y: round(cy),
      z: 0,
      yaw_deg: 0,
      pitch_deg: round(pitchRad / DEG, 4),
      roll_deg: roll,
      focal_mm: round(focal, 3),
      sensor_w_mm: 36,
    },
    subject: { x: 0, z: round(horiz) },
    distance_m: horiz,
    axis_distance_m: axis,
    visible_m: V,
    band,
    focal_mm: focal,
    focal_source: source,
    mode,
  });

  // INSERT: frame the object perpendicular to the view axis (D = V·f/sensor_h along the axis).
  if (size === 'INSERT') {
    const yc = typeof opts.insert_center_y === 'number' ? opts.insert_center_y : 0.8;
    const th = (techPitch ?? opts.insert_pitch_deg ?? INSERT_PITCH[angle]) * DEG;
    const D = V / (2 * t);
    const horiz = D * Math.cos(th);
    const cy = yc - D * Math.sin(th);
    return finish(cy, th, horiz, D, { bottom: yc - V / 2, top: yc + V / 2 }, 'insert');
  }

  // Overhead: straight down; V spans the frame height on the subject's shoulder plane.
  if (angle === 'overhead') {
    const yRef = 0.82 * topY;
    const D = V / (2 * t);
    return finish(yRef + D, -90 * DEG, 0, D, { bottom: -V / 2, top: V / 2 }, 'overhead');
  }

  const band = framingBand(size, H, topY);

  const rigHeight = typeof opts.camera_height_m === 'number' && opts.camera_height_m > 0 ? opts.camera_height_m : null;
  let cy: number;
  if (techHeight !== null) cy = techHeight;
  else if (rigHeight !== null) cy = rigHeight;
  else if (setPieceLowWide) cy = SET_PIECE_CAMERA_HEIGHT_M;
  else if (angle === 'low') cy = LOW_HEIGHT[size];
  else if (angle === 'high') cy = HIGH_HEIGHT[size];
  else cy = 0.93 * H; // eye / dutch: subject eye height

  // Fixed pitch: technique override, or the set-piece low/wide look on wide sizes (tilt up 5–10°).
  let fixedPitch: number | null = techPitch !== null ? techPitch * DEG : null;
  if (fixedPitch === null && setPieceLowWide && WIDE_SIZES.has(size)) {
    const aim = solveBand(cy, band.bottom, band.top, t);
    const aimDeg = aim ? aim.theta / DEG : 5;
    fixedPitch = clamp(size === 'EWS' ? Math.max(aimDeg, 9) : aimDeg + 3, 5, 10) * DEG;
  }
  if (fixedPitch !== null) {
    const th = clamp(fixedPitch, -80 * DEG, 80 * DEG);
    const denom = Math.tan(th + beta) - Math.tan(th - beta);
    const d = V / denom;
    const b2 = { bottom: cy + d * Math.tan(th - beta), top: cy + d * Math.tan(th + beta) };
    return finish(cy, th, d, d / Math.cos(th), b2, 'fixed_pitch');
  }

  const maxPitch = (angle === 'low' || setPieceLowWide ? 35 : angle === 'high' ? 40 : 30) * DEG;
  const r = solveBandCapped(cy, band.bottom, band.top, t, maxPitch);
  return finish(r.cy, r.theta, r.d, r.d / Math.cos(r.theta), band, 'band');
}
