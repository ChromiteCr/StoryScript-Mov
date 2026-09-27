/**
 * ShotFields → BoardSpec. Pure and deterministic: the same shot + context always
 * yields the same spec. The LLM never produces coordinates; this is the only
 * place (besides user edits) where world positions come from.
 */
import {
  BoardSpec,
  Uuid,
  type BoardArrow,
  type BoardCamera,
  type BoardProp,
  type BoardSubject,
  type BoardTemplate,
  type CameraAngle,
  type DepthPlane,
  type EnvKind,
  type Facing,
  type FrameFormat,
  type LookPreset,
  type Pose,
  type PropKind,
  type ScreenPos,
  type ScreenSides,
  type ShotFields,
  type ShotSubject,
  type Silhouette,
  type Technique,
} from '@storyscript/contracts';
import { shotLabelZh } from '../i18n/zh.ts';
import { rngFor } from '../util/random.ts';
import { cameraBasis, REF_HEIGHT_M, solveCamera, type CameraBasis, type CameraSolution } from './camera.ts';
import { clamp, dot3, round, wrapDeg, type V3 } from './math.ts';
import { poseTopY } from './puppets.ts';

export interface RosterEntry {
  alias: string;
  label: string;
  badge: string;
  entity_id: string | null;
  height_m?: number | null;
  silhouette?: Silhouette | null;
}

export interface LayoutContext {
  /** which alias holds screen-left / screen-right in this scene (180° axis) */
  scene_sides: ScreenSides | null;
  roster: RosterEntry[];
  look: LookPreset;
  technique?: Technique | null;
  /** project default aspect; shot.frame_format wins when set */
  aspect: FrameFormat;
  seed: number;
  /** focal slider ("keep shot size"), overrides shot.focal_mm */
  focal_mm?: number | null;
}

/** Default prop sizes (w × h × d, metres). */
export const PROP_SIZE: Record<PropKind, { w: number; h: number; d: number }> = {
  door: { w: 0.9, h: 2.1, d: 0.1 },
  table: { w: 1.4, h: 0.75, d: 0.8 },
  chair: { w: 0.5, h: 0.9, d: 0.5 },
  car: { w: 4.5, h: 1.5, d: 1.8 },
  wall: { w: 6, h: 3, d: 0.2 },
  building: { w: 10, h: 15, d: 10 },
  stairs: { w: 1.2, h: 1.0, d: 2.0 },
  window: { w: 1.2, h: 1.2, d: 0.1 },
  box: { w: 0.5, h: 0.5, d: 0.5 },
};

export const SCREEN_X: Record<ScreenPos, number> = { L: 1 / 3, C: 0.5, R: 2 / 3 };

/** INSERT: the generic item when only a support is listed (on a tabletop / hung on a wall). */
const INSERT_ITEM = { w: 0.24, h: 0.15, d: 0.18 };
const INSERT_WALL_ITEM = { w: 0.42, h: 0.32, d: 0.03 };
const INSERT_WALL_ITEM_BOTTOM = 1.34;
/** INSERT on a wall: near-level view (the table-top pitches would frame the floor). */
const WALL_INSERT_PITCH: Record<CameraAngle, number> = { eye: 0, low: 10, high: -20, overhead: -20, dutch: 0 };
export const DEPTH_FACTOR: Record<DepthPlane, number> = { fg: 0.6, mg: 1.0, bg: 2.0 };
export const FACING_REL: Record<Facing, number> = {
  camera: 0,
  away: 180,
  screen_right: 90,
  screen_left: -90,
  '3q_right': 45,
  '3q_left': -45,
};

/** Street layout constants shared with the renderer (road markings). */
export const STREET = { roadHalf: 4, walkHalf: 6, blockDepth: 8, blockLen: 10, gap: 2 } as const;

const TIGHT = new Set(['MCU', 'CU', 'ECU']);
export const VEHICLE_RIG_HEIGHT_M = 1.2;
/** OTS foreground is always read from behind: |relative yaw| at least this. */
const OTS_FG_MIN_REL = 150;
const WIDE = new Set(['EWS', 'WS']);
const ENV_PREFIX = 'env-';

/** Template rules used when shot.template is null. */
export function inferTemplate(shot: Pick<ShotFields, 'subjects' | 'shot_size' | 'pov_owner' | 'subject_motion' | 'set_piece'>): BoardTemplate {
  const n = shot.subjects.length;
  if (n === 1 && TIGHT.has(shot.shot_size)) return 'single';
  if (n === 2 && shot.pov_owner) return 'ots';
  if (shot.shot_size === 'INSERT') return 'insert';
  if (shot.subject_motion === 'l2r' || shot.subject_motion === 'r2l') return 'lateral_move';
  if (WIDE.has(shot.shot_size) && shot.set_piece) return 'scale';
  if (n === 2) return 'two_shot';
  if (WIDE.has(shot.shot_size)) return 'establishing';
  return 'single';
}

/** World yaw for a facing relative to the camera → subject line (0 = looks into the lens). */
export function yawForRel(relDeg: number, sx: number, sz: number, cam: Pick<BoardCamera, 'x' | 'z'>): number {
  const bearing = (Math.atan2(sx - cam.x, sz - cam.z) * 180) / Math.PI;
  return wrapDeg(relDeg - bearing);
}

/** Facing relative to the viewing ray: 0 = toward camera, +90 = screen-right, ±180 = away. */
export function relativeYaw(subject: Pick<BoardSubject, 'x' | 'z' | 'yaw_deg'>, cam: Pick<BoardCamera, 'x' | 'z'>): number {
  const bearing = (Math.atan2(subject.x - cam.x, subject.z - cam.z) * 180) / Math.PI;
  return wrapDeg(subject.yaw_deg + bearing);
}

/** Yaw that makes a subject at (ax, az) look at (bx, bz). */
export function yawLookAt(ax: number, az: number, bx: number, bz: number): number {
  return wrapDeg((Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI);
}

/** World x at camera-forward distance `z` (and height `y`) whose projection lands on frame x = fx. */
export function worldXAtFrameX(b: CameraBasis, fx: number, z: number, y: number): number {
  const g = ((fx - 0.5) * b.sw) / b.f;
  // P = (X, y, z); Xc = X·r.x + k1, Zc = X·f.x + k2
  const base: V3 = [0 - b.pos[0], y - b.pos[1], z - b.pos[2]];
  const k1 = dot3(base, b.right);
  const k2 = dot3(base, b.fwd);
  const den = g * b.fwd[0] - b.right[0];
  if (Math.abs(den) < 1e-9) return 0;
  return (k1 - g * k2) / den;
}

interface Resolved {
  idx: number;
  spec: ShotSubject;
  alias: string;
  label: string;
  badge: string;
  entity_id: string | null;
  height: number;
  silhouette: Silhouette;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function resolveSubjects(shot: ShotFields, ctx: LayoutContext): Resolved[] {
  const used = new Set<string>();
  const out = shot.subjects.map((s, idx) => {
    const r = ctx.roster.find((e) => e.alias === s.alias);
    const entity = r?.entity_id && Uuid.safeParse(r.entity_id).success ? r.entity_id : null;
    const h = r?.height_m && Number.isFinite(r.height_m) && r.height_m > 0.5 && r.height_m < 2.6 ? r.height_m : REF_HEIGHT_M;
    const badge = (r?.badge ?? '').trim();
    if (badge) used.add(badge);
    return {
      idx,
      spec: s,
      alias: s.alias,
      label: r?.label ?? s.alias,
      badge,
      entity_id: entity,
      height: h,
      silhouette: r?.silhouette ?? 'regular',
    } satisfies Resolved;
  });
  // Fill missing badges with the next free letter (duplicates are left for lint to report).
  let li = 0;
  for (const s of out) {
    if (s.badge) continue;
    while (li < LETTERS.length && used.has(LETTERS[li] as string)) li++;
    s.badge = LETTERS[li] ?? String(s.idx + 1);
    used.add(s.badge);
  }
  return out;
}

function defaultEnv(template: BoardTemplate): EnvKind {
  switch (template) {
    case 'establishing':
    case 'scale':
      return 'open';
    case 'lateral_move':
      return 'street';
    default:
      return 'interior';
  }
}

const r4 = (v: number) => round(v, 4);

function box(id: string, kind: PropKind, x: number, z: number, y: number, dims: { w: number; h: number; d: number }, yaw = 0, attach: 'world' | 'camera' = 'world'): BoardProp {
  return { id, kind, x: r4(x), z: r4(z), y: r4(y), w: r4(dims.w), h: r4(dims.h), d: r4(dims.d), yaw_deg: round(yaw, 2), attach };
}

/**
 * Lay out a board for a shot. Output always passes `BoardSpec.parse`.
 */
export function layoutBoard(shot: ShotFields, ctx: LayoutContext): BoardSpec {
  const template = shot.template ?? inferTemplate(shot);
  const aspect: FrameFormat = shot.frame_format ?? ctx.aspect;
  const subs = resolveSubjects(shot, ctx);
  const env = shot.env ?? defaultEnv(template);
  const motion = shot.subject_motion;
  const lateral = motion === 'l2r' || motion === 'r2l';
  const dirX = motion === 'r2l' ? -1 : 1;

  // ---- who is framed ------------------------------------------------------
  let fgIdx = -1; // ots foreground (pov owner)
  let primaryIdx = subs.length ? 0 : -1;
  if (template === 'ots' && subs.length >= 2) {
    const pov = shot.pov_owner ? subs.findIndex((s) => s.alias === shot.pov_owner) : -1;
    fgIdx = pov >= 0 ? pov : 0;
    primaryIdx = subs.findIndex((s) => s.idx !== fgIdx);
  }
  const poseOf = (s: Resolved): Pose => s.spec.pose ?? (template === 'lateral_move' ? 'run' : 'stand');
  if ((template === 'two_shot' || template === 'establishing') && subs.length > 1) {
    // Frame the group on its tallest head among people on the main (mg) plane.
    const main = subs.filter((s) => (s.spec.depth ?? 'mg') === 'mg');
    const pool = main.length ? main : subs;
    const top = (s: Resolved) => poseTopY(poseOf(s)) * s.height;
    primaryIdx = pool.reduce((best, s) => (top(s) > top(subs[best] as Resolved) ? s.idx : best), (pool[0] as Resolved).idx);
  }
  const primary = primaryIdx >= 0 ? subs[primaryIdx] : undefined;
  const eyeLevel = shot.angle === 'eye' || shot.angle === 'dutch';
  // Rig height: a vehicle hard-mount rides at door height; an over-the-shoulder
  // camera sits at the foreground character's eye line, just behind the shoulder.
  let rigHeight: number | null = null;
  if (shot.movement === 'vehicle' && eyeLevel) rigHeight = VEHICLE_RIG_HEIGHT_M;
  else if (fgIdx >= 0 && eyeLevel) {
    const fg = subs[fgIdx] as Resolved;
    rigHeight = 0.93 * poseTopY(poseOf(fg)) * fg.height;
  }

  // ---- insert target --------------------------------------------------------
  // The featured object is the first listed prop that is not a support. When
  // only a table or a wall is listed, the insert is about a small item on it
  // (a letter on the table, a photo on the wall): a generic item is placed on
  // the tabletop, or hung at eye height on a wall that faces the lens.
  const isInsert = template === 'insert';
  const hasTable = shot.props.includes('table');
  const listed = shot.props.find((k) => k !== 'table' && k !== 'wall' && k !== 'building' && k !== 'stairs') ?? null;
  const wallMount = isInsert && !listed && !hasTable && shot.props.includes('wall');
  const featuredKind: PropKind | null = isInsert ? (listed ?? (hasTable || wallMount ? 'box' : (shot.props[0] ?? 'box'))) : null;
  const featuredDims = featuredKind === 'box' ? (wallMount ? INSERT_WALL_ITEM : INSERT_ITEM) : featuredKind ? PROP_SIZE[featuredKind] : null;
  const supportTop = isInsert && hasTable && featuredKind !== 'table' ? PROP_SIZE.table.h : wallMount ? INSERT_WALL_ITEM_BOTTOM : 0;
  const insertCenterY = featuredDims ? supportTop + Math.min(featuredDims.h, 0.6) / 2 : null;

  // ---- camera ---------------------------------------------------------------
  const sol: CameraSolution = solveCamera(isInsert ? { ...shot, shot_size: 'INSERT' } : shot, {
    aspect,
    focal_mm: ctx.focal_mm ?? null,
    subject_height_m: primary?.height ?? REF_HEIGHT_M,
    pose: primary ? poseOf(primary) : 'stand',
    technique: ctx.technique ?? null,
    look: ctx.look,
    insert_center_y: insertCenterY,
    insert_pitch_deg: wallMount ? WALL_INSERT_PITCH[shot.angle] : null,
    camera_height_m: rigHeight,
  });
  const camera = sol.camera;
  const basis = cameraBasis(camera, aspect);
  const d = Math.max(sol.distance_m, 0.4);
  const overhead = sol.mode === 'overhead';
  const frameWidthAt = (z: number) => (36 / camera.focal_mm) * Math.max(z, 0.1);

  // ---- subject placement ------------------------------------------------------
  const placed: BoardSubject[] = new Array(subs.length);
  const make = (s: Resolved, x: number, z: number, yaw: number, pose: Pose): BoardSubject => ({
    id: `s${s.idx}`,
    entity_id: s.entity_id,
    label: s.label,
    badge: s.badge,
    x: r4(x),
    z: r4(z),
    yaw_deg: round(yaw, 2),
    pose,
    height_m: s.height,
    silhouette: s.silhouette,
    tone_override: null,
    z_override: null,
  });
  const fxOf = (s: Resolved, fallback: number) => (s.spec.screen ? SCREEN_X[s.spec.screen] : fallback);
  const depthOf = (s: Resolved, fallback: DepthPlane = 'mg') => DEPTH_FACTOR[s.spec.depth ?? fallback];
  /** fx: frame x; k: distance factor relative to the framed subject (fg 0.6 / mg 1 / bg 2). */
  const put = (s: Resolved, fx: number, k: number, rel: number, pose: Pose) => {
    const yRef = s.height * 0.55;
    // Overhead: depth planes become frame rows (fg lower, bg higher in frame).
    const zz = overhead ? (k - 1) * 0.35 * sol.visible_m : d * k;
    let x = overhead ? (fx - 0.5) * frameWidthAt(camera.y - yRef) : worldXAtFrameX(basis, fx, zz, yRef);
    if (!Number.isFinite(x)) x = 0;
    placed[s.idx] = make(s, x, zz, yawForRel(rel, x, zz, camera), pose);
  };
  const relOf = (s: Resolved, fallback: Facing) => FACING_REL[s.spec.facing ?? fallback];
  const sideOf = (alias: string): ScreenPos | null =>
    ctx.scene_sides?.left === alias ? 'L' : ctx.scene_sides?.right === alias ? 'R' : null;
  const rng = rngFor(ctx.seed, 'layout');

  const baseZ = overhead ? 0 : d;
  switch (template) {
    case 'ots': {
      if (subs.length < 2) {
        for (const s of subs) put(s, fxOf(s, 0.5), depthOf(s), relOf(s, 'camera'), poseOf(s));
        break;
      }
      const fg = subs[fgIdx] as Resolved;
      const tg = primary as Resolved;
      const fgSide: ScreenPos =
        sideOf(fg.alias) ?? (sideOf(tg.alias) === 'L' ? 'R' : sideOf(tg.alias) === 'R' ? 'L' : (fg.spec.screen ?? 'L'));
      const left = fgSide !== 'R';
      const tgFx = tg.spec.screen ? SCREEN_X[tg.spec.screen] : left ? 2 / 3 : 1 / 3;
      put(tg, tgFx, depthOf(tg), relOf(tg, left ? '3q_left' : '3q_right'), poseOf(tg));
      // Foreground shoulder: ~0.55× the target distance, cropped ~30 % by the frame edge.
      const zA = overhead ? 0 : baseZ * 0.55;
      const halfW = 0.14 * fg.height;
      const yRef = fg.height * 0.8;
      const edgeX = worldXAtFrameX(basis, left ? 0 : 1, zA, yRef);
      let xA = left ? edgeX + 0.4 * halfW : edgeX - 0.4 * halfW;
      const lat = clamp(Math.abs(xA), 0.2, 0.75);
      xA = (left ? -1 : 1) * lat;
      const tgP = placed[tg.idx] as BoardSubject;
      const fgFacing = fg.spec.facing;
      let yaw: number;
      if (fgFacing && fgFacing !== 'away') {
        yaw = yawForRel(FACING_REL[fgFacing], xA, zA, camera);
      } else {
        // Look toward the target, but keep the back to camera (reads as an over-the-shoulder).
        yaw = yawLookAt(xA, zA, tgP.x, tgP.z);
        const rel = relativeYaw({ x: xA, z: zA, yaw_deg: yaw }, camera);
        if (Math.abs(rel) < OTS_FG_MIN_REL) yaw = yawForRel((rel >= 0 ? 1 : -1) * OTS_FG_MIN_REL, xA, zA, camera);
      }
      placed[fg.idx] = make(fg, xA, zA, yaw, poseOf(fg));
      // any extra people stand in the background
      subs.forEach((s, i) => {
        if (s.idx === fg.idx || s.idx === tg.idx) return;
        put(s, fxOf(s, left ? 0.5 + 0.1 * i : 0.5 - 0.1 * i), depthOf(s, 'bg'), relOf(s, 'camera'), poseOf(s));
      });
      break;
    }
    case 'two_shot': {
      subs.forEach((s, i) => {
        const side = sideOf(s.alias);
        const fallback = side ? SCREEN_X[side] : i === 0 ? 1 / 3 : i === 1 ? 2 / 3 : 0.5 + 0.08 * (i - 1);
        const fx = fxOf(s, fallback);
        put(s, fx, depthOf(s), relOf(s, fx < 0.5 ? '3q_right' : fx > 0.5 ? '3q_left' : 'camera'), poseOf(s));
      });
      break;
    }
    case 'lateral_move': {
      subs.forEach((s, i) => {
        const lead = dirX > 0 ? 0.42 : 0.58;
        const fx = fxOf(s, clamp(lead - dirX * 0.17 * i, 0.12, 0.88));
        const fallbackFacing: Facing = motion === 'r2l' ? 'screen_left' : 'screen_right';
        put(s, fx, depthOf(s), relOf(s, fallbackFacing), poseOf(s));
      });
      break;
    }
    case 'insert': {
      // People only as off-frame context behind the prop.
      subs.forEach((s, i) => {
        const side = i % 2 === 0 ? 1 : -1;
        const z = baseZ + 0.9;
        const x = side * (frameWidthAt(z) / 2 + 0.45 + 0.5 * Math.floor(i / 2));
        placed[s.idx] = make(s, x, z, yawLookAt(x, z, 0, baseZ), poseOf(s));
      });
      break;
    }
    case 'scale': {
      subs.forEach((s, i) => {
        const fx = fxOf(s, 0.5 + (i === 0 ? 0 : (i % 2 ? 1 : -1) * 0.05 * Math.ceil(i / 2)));
        put(s, fx, depthOf(s), relOf(s, 'away'), poseOf(s));
      });
      break;
    }
    case 'establishing': {
      const n = subs.length;
      const spread = Math.min(0.12, 0.36 / Math.max(1, n - 1));
      const facings: Facing[] = ['3q_right', 'camera', '3q_left', '3q_right', 'camera', '3q_left'];
      subs.forEach((s, i) => {
        const fx = fxOf(s, 0.5 + (i - (n - 1) / 2) * spread);
        const jitter = s.spec.depth ? 1 : 1 + (rng() - 0.5) * 0.24;
        const fallback = n === 1 ? 'camera' : (facings[i % facings.length] as Facing);
        put(s, fx, depthOf(s) * jitter, relOf(s, fallback), poseOf(s));
      });
      break;
    }
    case 'single':
    default: {
      subs.forEach((s, i) => {
        const fx = fxOf(s, i === 0 ? 0.5 : i % 2 ? 0.72 : 0.28);
        const fallback: Facing = fx < 0.45 ? '3q_right' : fx > 0.55 ? '3q_left' : 'camera';
        put(s, fx, depthOf(s, i === 0 ? 'mg' : 'bg'), relOf(s, fallback), poseOf(s));
      });
      break;
    }
  }

  // Spread people who landed on the same spot.
  for (let i = 0; i < placed.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = placed[i] as BoardSubject;
      const b = placed[j] as BoardSubject;
      if (Math.hypot(a.x - b.x, a.z - b.z) < 0.45) a.x = r4(a.x + 0.55);
    }
  }

  const subjects = placed.filter(Boolean);
  const focusZ = primary ? (placed[primary.idx]?.z ?? d) : d;
  const focusX = primary ? (placed[primary.idx]?.x ?? 0) : 0;
  const maxZ = subjects.reduce((m, s) => Math.max(m, s.z), focusZ);

  // ---- props ------------------------------------------------------------------
  const props: BoardProp[] = [];
  const envProps: BoardProp[] = [];
  const wallH = 3;
  let backZ: number | null = null;
  let roomHalf = 0;
  if (env === 'interior') {
    backZ = Math.max(maxZ + 2.2, focusZ + 2.5);
    roomHalf = Math.max(3.5, 0.45 * frameWidthAt(focusZ));
    envProps.push(box(`${ENV_PREFIX}wall-back`, 'wall', 0, backZ + 0.1, 0, { w: roomHalf * 2 + 0.4, h: wallH, d: 0.2 }));
    const sideLen = backZ + 2;
    envProps.push(box(`${ENV_PREFIX}wall-left`, 'wall', -roomHalf - 0.1, sideLen / 2 - 2, 0, { w: sideLen, h: wallH, d: 0.2 }, 90));
    envProps.push(box(`${ENV_PREFIX}wall-right`, 'wall', roomHalf + 0.1, sideLen / 2 - 2, 0, { w: sideLen, h: wallH, d: 0.2 }, 90));
  } else if (env === 'street') {
    const erng = rngFor(ctx.seed, 'env-street');
    const zEnd = Math.max(focusZ, 10) + 45;
    let k = 0;
    for (const side of [-1, 1]) {
      for (let z = -4; z < zEnd; z += STREET.blockLen + STREET.gap) {
        const h = 8 + Math.floor(erng() * 5) * 3;
        const xc = side * (STREET.walkHalf + STREET.blockDepth / 2);
        envProps.push(
          box(`${ENV_PREFIX}block-${k++}`, 'building', xc, z + STREET.blockLen / 2, 0, { w: STREET.blockDepth, h, d: STREET.blockLen }),
        );
      }
    }
  }

  const want = shot.props.slice();
  if (isInsert && featuredKind === 'box' && !want.includes('box')) want.push('box');
  if (template === 'scale' && !want.includes('building') && !want.includes('wall')) want.push('building');
  if (shot.movement === 'vehicle' && !want.includes('car')) want.push('car');
  const counts: Partial<Record<PropKind, number>> = {};
  const nextId = (k: PropKind) => {
    const n = counts[k] ?? 0;
    counts[k] = n + 1;
    return `p-${k}-${n}`;
  };
  const side = focusX > 0.2 ? -1 : 1; // put set dressing on the emptier side
  let tableTop: { x: number; z: number } | null = null;

  for (const kind of want) {
    const dims = PROP_SIZE[kind];
    switch (kind) {
      case 'table': {
        if (isInsert) {
          // featured object sits near the front edge so the edge reads in frame
          props.push(box(nextId(kind), kind, 0.05, focusZ + dims.d / 2 - 0.16, 0, dims));
          tableTop = { x: 0, z: focusZ };
        } else if (template === 'two_shot' && subjects.length >= 2) {
          const a = subjects[0] as BoardSubject;
          const b = subjects[1] as BoardSubject;
          const tx = (a.x + b.x) / 2;
          const tz = Math.max((a.z + b.z) / 2 + 0.2, 0.8);
          props.push(box(nextId(kind), kind, tx, tz, 0, dims));
          tableTop = { x: tx, z: tz };
        } else {
          const tx = focusX + side * 1.1;
          const tz = focusZ + 0.4;
          props.push(box(nextId(kind), kind, tx, tz, 0, dims));
          tableTop = { x: tx, z: tz };
        }
        break;
      }
      case 'chair': {
        const cx = (tableTop?.x ?? focusX + side * 1.1) + side * 0.95;
        const cz = (tableTop?.z ?? focusZ + 0.4) + 0.05;
        props.push(box(nextId(kind), kind, cx, cz, 0, dims, side > 0 ? -90 : 90));
        break;
      }
      case 'box': {
        if (isInsert && featuredKind === 'box' && featuredDims) {
          props.push(box(nextId(kind), kind, 0, focusZ, supportTop, featuredDims, 12));
        } else if (tableTop) {
          props.push(box(nextId(kind), kind, tableTop.x + 0.25, tableTop.z - 0.05, PROP_SIZE.table.h, { w: 0.3, h: 0.22, d: 0.25 }, 8));
        } else {
          props.push(box(nextId(kind), kind, focusX + side * 0.75, focusZ - 0.3, 0, dims, 10));
        }
        break;
      }
      case 'door': {
        if (backZ !== null) {
          props.push(box(nextId(kind), kind, clamp(focusX - side * 1.5, -roomHalf + 0.6, roomHalf - 0.6), backZ - 0.05, 0, dims));
        } else {
          props.push(box(nextId(kind), kind, focusX - side * 1.5, focusZ + 2.5, 0, dims));
        }
        break;
      }
      case 'window': {
        const wz = backZ !== null ? backZ - 0.05 : focusZ + 2.5;
        const wx = backZ !== null ? clamp(focusX + side * 1.6, -roomHalf + 0.8, roomHalf - 0.8) : focusX + side * 1.6;
        props.push(box(nextId(kind), kind, wx, wz, 1.0, dims));
        break;
      }
      case 'wall': {
        if (wallMount && featuredDims) {
          // right behind the hung item, square to the lens
          props.push(box(nextId(kind), kind, 0, focusZ + featuredDims.d / 2 + dims.d / 2, 0, { w: dims.w, h: wallH, d: dims.d }));
        } else if (template === 'scale') {
          props.push(box(nextId(kind), kind, focusX - 6, focusZ + 12, 0, { w: 40, h: 22, d: 1.5 }));
        } else if (backZ !== null) {
          props.push(box(nextId(kind), kind, focusX + side * 2.4, focusZ + 1.2, 0, { w: 2.4, h: wallH, d: 0.2 }, 90));
        } else {
          props.push(box(nextId(kind), kind, focusX, focusZ + 2.2, 0, dims));
        }
        break;
      }
      case 'building': {
        if (template === 'scale') {
          props.push(box(nextId(kind), kind, focusX - 5, focusZ + 16, 0, { w: 30, h: 48, d: 16 }));
          props.push(box(nextId(kind), kind, focusX + 24, focusZ + 34, 0, { w: 18, h: 38, d: 14 }, 8));
        } else {
          props.push(box(nextId(kind), kind, focusX + side * 7, focusZ + 16, 0, dims));
        }
        break;
      }
      case 'stairs': {
        props.push(box(nextId(kind), kind, focusX + side * 2.2, focusZ + 1.4, 0, dims, 0));
        break;
      }
      case 'car': {
        const rig = shot.movement === 'vehicle' || template === 'lateral_move';
        if (rig) {
          // Camera rig: the car's flank runs along one side of the foreground.
          const cz = 0.5 + dims.w / 2;
          const edge = worldXAtFrameX(basis, lateral && dirX < 0 ? 1 : 0, 1.6, 0.8);
          const cx = (lateral && dirX < 0 ? 1 : -1) * (Math.abs(edge) + dims.d / 2 - 0.55);
          props.push(box(nextId(kind), kind, cx, cz, 0, dims, 90, 'camera'));
        } else {
          props.push(box(nextId(kind), kind, focusX + side * 3.2, focusZ + 2.4, 0, dims, 0));
        }
        break;
      }
    }
  }

  // ---- overlay ------------------------------------------------------------------
  const arrows: BoardArrow[] = [];
  if (motion !== 'none') {
    const movers = subjects.filter((s) => lateral || s.pose === 'walk' || s.pose === 'run');
    let list = movers.length ? movers : subjects.slice(0, 1);
    if (lateral) {
      // One arrow per depth band, led by the front-runner of that band.
      const sorted = list.slice().sort((a, b) => b.x * dirX - a.x * dirX);
      list = [];
      for (const s of sorted) if (!list.some((k) => Math.abs(k.z - s.z) < 0.3 * Math.max(k.z, 1))) list.push(s);
    }
    for (const s of list) {
      let from: { x: number; z: number };
      let to: { x: number; z: number };
      if (lateral) {
        const L = clamp(0.2 * frameWidthAt(s.z), 0.6, 30);
        from = { x: s.x + dirX * 0.3 * s.height_m, z: s.z };
        to = { x: from.x + dirX * L, z: s.z };
      } else {
        // beside the body, on the frame-centre side
        const off = (s.x >= camera.x ? -1 : 1) * 0.32 * s.height_m;
        if (motion === 'toward') {
          from = { x: s.x + off, z: s.z - 0.2 };
          to = { x: s.x + off, z: Math.max(0.9, s.z - Math.max(0.8, 0.4 * s.z)) };
        } else {
          from = { x: s.x + off, z: s.z + 0.3 };
          to = { x: s.x + off, z: s.z + Math.max(2, s.z) };
        }
      }
      arrows.push({
        id: `a-move-${s.id}`,
        kind: 'subject_move',
        mode: 'anchored',
        subject_id: s.id,
        world_from: { x: r4(from.x), z: r4(from.z) },
        world_to: { x: r4(to.x), z: r4(to.z) },
      });
    }
  }
  if (template === 'ots' && fgIdx >= 0 && primaryIdx >= 0) {
    const a = placed[fgIdx] as BoardSubject;
    const b = placed[primaryIdx] as BoardSubject;
    arrows.push({
      id: `a-eye-${a.id}`,
      kind: 'eyeline',
      mode: 'anchored',
      subject_id: a.id,
      world_from: { x: a.x, z: a.z },
      world_to: { x: b.x, z: b.z },
    });
  }

  const guides: BoardSpec['frame']['guides'] = aspect === '2.39' && ctx.look.center_guide ? ['1.43'] : [];
  const spec = {
    version: 1 as const,
    frame: { aspect, guides },
    camera,
    scene: {
      env,
      light: { azimuth_deg: 45, elevation_deg: 40 },
      subjects,
      props: [...envProps, ...props],
    },
    overlay: {
      labels: [{ id: 'l-shot', text: shotLabelZh(isInsert ? 'INSERT' : shot.shot_size, camera.focal_mm), x: 0.012, y: 0.955 }],
      arrows,
      camera_move: shot.movement,
      offset: { x: 0, y: 0 },
      show_code: true,
    },
    seed: Math.trunc(ctx.seed),
  };
  return BoardSpec.parse(spec);
}

/** True for props the layout generated as environment shell (walls of the room, street blocks). */
export function isEnvProp(p: Pick<BoardProp, 'id'>): boolean {
  return p.id.startsWith(ENV_PREFIX);
}
