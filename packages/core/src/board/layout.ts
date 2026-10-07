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
  type TimeOfDay,
} from '@storyscript/contracts';
import { shotLabelZh } from '../i18n/zh.ts';
import { shotEmotions, timeOfDay } from './emotion.ts';
import { rngFor } from '../util/random.ts';
import { cameraBasis, projectPoint, REF_HEIGHT_M, solveCamera, type CameraBasis, type CameraSolution } from './camera.ts';
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
  /** S5b: the scene heading's time (日 / 夜 / 黄昏 …): the light of the frame */
  time_label?: string | null;
  /** S5b: the project's prop names (道具条目): an insert's object is named by the one its action mentions */
  prop_names?: readonly string[];
}

/** S5b: longest object name a board writes (a callout, not a caption). */
export const OBJECT_NAME_MAX = 12;

/**
 * The name a board writes next to the object a shot is about: the shot's own
 * `object_name`, else the longest project prop name its action (then its
 * purpose) mentions. Trimmed and cut to OBJECT_NAME_MAX.
 */
export function objectNameFor(shot: Pick<ShotFields, 'object_name' | 'action' | 'narrative_purpose'>, propNames: readonly string[] = []): string | null {
  const own = typeof shot.object_name === 'string' ? shot.object_name.trim() : '';
  if (own) return [...own].slice(0, OBJECT_NAME_MAX).join('');
  const names = propNames.map((n) => n.trim()).filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
  for (const text of [shot.action, shot.narrative_purpose]) {
    const hit = names.find((n) => text?.includes(n));
    if (hit) return [...hit].slice(0, OBJECT_NAME_MAX).join('');
  }
  return null;
}

/** Rough frame-px width of a label at the overlay's 26 px (CJK ≈ 1 em, others ≈ 0.66 em) plus its tab padding. */
function labelWidthPx(t: string, size = 26): number {
  let w = 0;
  for (const ch of t) w += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? size : size * 0.66;
  return w + size * 0.6;
}

/** S5b: where the light comes from at each time of day (day is the S0 light, unchanged). */
export const TIME_LIGHT: Record<TimeOfDay, { azimuth_deg: number; elevation_deg: number }> = {
  day: { azimuth_deg: 45, elevation_deg: 40 },
  dusk: { azimuth_deg: 70, elevation_deg: 14 },
  night: { azimuth_deg: 30, elevation_deg: 55 },
};

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
  bed: { w: 1.5, h: 0.55, d: 2.0 },
  sofa: { w: 2.0, h: 0.85, d: 0.9 },
  shelf: { w: 1.0, h: 1.9, d: 0.35 },
  lamp: { w: 0.4, h: 1.6, d: 0.4 },
  tree: { w: 3.0, h: 6.0, d: 3.0 },
  phone: { w: 0.075, h: 0.01, d: 0.15 },
  cup: { w: 0.09, h: 0.11, d: 0.09 },
  book: { w: 0.17, h: 0.03, d: 0.24 },
  bag: { w: 0.4, h: 0.32, d: 0.18 },
  can: { w: 0.085, h: 0.11, d: 0.085 },
  bottle: { w: 0.075, h: 0.28, d: 0.075 },
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

/** Which third a facing puts a single on (look room in front of the face); null: no side. */
const FACING_SIDE: Record<Facing, ScreenPos | null> = {
  camera: null,
  away: null,
  screen_right: 'L',
  '3q_right': 'L',
  screen_left: 'R',
  '3q_left': 'R',
};

/** Street layout constants shared with the renderer (road markings). */
export const STREET = { roadHalf: 4, walkHalf: 6, blockDepth: 8, blockLen: 10, gap: 2 } as const;

/** S4c classroom: desk rows front to back (m) and the desk / chair sizes. */
const DESK_PITCH = 1.3;
const DESK = { w: 1.1, h: 0.74, d: 0.55 } as const;
const DESK_CHAIR = { w: 0.44, h: 0.82, d: 0.44 } as const;
/** S4c corridor cross-section (half width, ceiling height) and its door spacing. */
const CORRIDOR = { half: 1.25, h: 2.8, doorEvery: 3.6 } as const;
/** Small things that sit on a tabletop: an insert of one gets a table under it. */
const TABLETOP_ITEMS: ReadonlySet<PropKind> = new Set<PropKind>(['phone', 'cup', 'book', 'can', 'bottle']);
/** S4c kinds placed by the generic rules below (featured in an insert, on a table, beside a person). */
const SMALL_ITEMS: ReadonlySet<PropKind> = new Set<PropKind>(['phone', 'cup', 'book', 'bag', 'can', 'bottle']);
/** Kinds that existed before S4c keep their own placement rules, also when featured in an insert. */
const PROP_SIZE_LEGACY: ReadonlySet<PropKind> = new Set<PropKind>(['door', 'table', 'chair', 'car', 'wall', 'building', 'stairs', 'window', 'box']);
/** Props are placed in this order, so a table exists before what goes on it. */
const PLACE_ORDER: PropKind[] = ['table', 'chair', 'bed', 'sofa', 'shelf', 'lamp', 'door', 'window', 'wall', 'building', 'stairs', 'car', 'tree', 'box', 'phone', 'cup', 'book', 'bag', 'can', 'bottle'];

/**
 * Heights of a shelf's compartment floors, bottom up (the plinth top first).
 * Shared with the renderer (scene.ts draws the boards and the book spines).
 */
export function shelfBoards(h: number): number[] {
  const n = Math.max(2, Math.round((h - 0.11) / 0.36));
  const comp = (h - 0.08 - 0.03) / n;
  return Array.from({ length: n }, (_, k) => round(0.08 + comp * k, 4));
}

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
  // S4c: a phone / cup / book on its own still sits on something (a table the layout adds)
  const autoSupport = isInsert && !hasTable && !wallMount && featuredKind !== null && TABLETOP_ITEMS.has(featuredKind);
  const supportTop = isInsert && (hasTable || autoSupport) && featuredKind !== 'table' ? PROP_SIZE.table.h : wallMount ? INSERT_WALL_ITEM_BOTTOM : 0;
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
  // S5b: what each person feels — set on the shot, else read from its action text
  const felt = shotEmotions(shot, subs.map((s) => ({ alias: s.alias, label: s.label })));
  const make = (s: Resolved, x: number, z: number, yaw: number, pose: Pose): BoardSubject => {
    const emotion = s.spec.emotion ?? felt.get(s.alias) ?? null;
    return {
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
      ...(emotion && emotion !== 'neutral' ? { emotion } : {}),
    };
  };
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
      // S4c: a single holds its side of the scene axis (or the side its facing
      // gives it) on a third, looking across the frame toward the partner with
      // the look room in front; shot / reverse singles then alternate L and R.
      // Only a lone person with neither stays centred.
      const lead = subs[0];
      const leadSide = lead && !lead.spec.screen ? (sideOf(lead.alias) ?? FACING_SIDE[lead.spec.facing ?? 'camera']) : null;
      const off = shot.shot_size === 'ECU' ? 0.08 : shot.shot_size === 'CU' ? 0.12 : 1 / 6;
      const leadFx = lead ? fxOf(lead, leadSide === 'L' ? 0.5 - off : leadSide === 'R' ? 0.5 + off : 0.5) : 0.5;
      subs.forEach((s, i) => {
        const fx = i === 0 ? leadFx : fxOf(s, leadFx < 0.5 ? 0.72 : leadFx > 0.5 ? 0.28 : i % 2 ? 0.72 : 0.28);
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
  // with nobody framed, an overhead camera looks straight down at z = 0 (S5b: an overhead insert's object sits there, not off frame)
  const focusZ = primary ? (placed[primary.idx]?.z ?? d) : overhead || camera.pitch_deg < -80 ? camera.z : d;
  const focusX = primary ? (placed[primary.idx]?.x ?? 0) : 0;
  const maxZ = subjects.reduce((m, s) => Math.max(m, s.z), focusZ);

  // ---- props ------------------------------------------------------------------
  const props: BoardProp[] = [];
  const envProps: BoardProp[] = [];
  const wallH = 3;
  let backZ: number | null = null;
  let roomHalf = 0;
  const maxAbsX = subjects.reduce((m, s) => Math.max(m, Math.abs(s.x)), 0);
  const deskRows = env === 'classroom' ? 2 + (rngFor(ctx.seed, 'env-classroom-rows')() < 0.5 ? 1 : 0) : 0;
  const zEnd = Math.max(focusZ, 10) + 45;
  /** a room of env walls: back wall at `back`, side walls at ±half */
  const room = (back: number, half: number, h: number): [number, number] => {
    envProps.push(box(`${ENV_PREFIX}wall-back`, 'wall', 0, back + 0.1, 0, { w: half * 2 + 0.4, h, d: 0.2 }));
    const sideLen = back + 2;
    envProps.push(box(`${ENV_PREFIX}wall-left`, 'wall', -half - 0.1, sideLen / 2 - 2, 0, { w: sideLen, h, d: 0.2 }, 90));
    envProps.push(box(`${ENV_PREFIX}wall-right`, 'wall', half + 0.1, sideLen / 2 - 2, 0, { w: sideLen, h, d: 0.2 }, 90));
    return [back, half];
  };
  if (env === 'interior') {
    [backZ, roomHalf] = room(Math.max(maxZ + 2.2, focusZ + 2.5), Math.max(3.5, 0.45 * frameWidthAt(focusZ)), wallH);
  } else if (env === 'classroom') {
    // the first row of desks stands level with the people, the others behind them, then the blackboard wall
    const lastRow = focusZ + 0.15 + (deskRows - 1) * DESK_PITCH;
    [backZ, roomHalf] = room(Math.max(maxZ + 2.2, lastRow + 2.1), Math.max(4.2, 0.45 * frameWidthAt(focusZ), maxAbsX + 1.2), wallH);
  } else if (env === 'corridor') {
    [backZ, roomHalf] = room(Math.max(focusZ + 12, maxZ + 8, 16), Math.max(CORRIDOR.half, maxAbsX + 0.5), CORRIDOR.h);
  } else if (env === 'street') {
    const erng = rngFor(ctx.seed, 'env-street');
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
    // S4c: the kerbs along both sides of the road
    for (const side of [-1, 1])
      envProps.push(box(`${ENV_PREFIX}kerb-${side < 0 ? 0 : 1}`, 'wall', side * (STREET.roadHalf + 0.1), (zEnd - 4) / 2, 0, { w: 0.2, h: 0.13, d: zEnd + 4 }));
  }

  const want = shot.props.slice();
  if (isInsert && featuredKind === 'box' && !want.includes('box')) want.push('box');
  if (autoSupport && !want.includes('table')) want.push('table');
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
  want.sort((a, b) => PLACE_ORDER.indexOf(a) - PLACE_ORDER.indexOf(b));
  /** facing direction (world x, z) of a placed subject */
  const facingOf = (s: BoardSubject): [number, number] => [Math.sin((s.yaw_deg * Math.PI) / 180), -Math.cos((s.yaw_deg * Math.PI) / 180)];
  const lead = primary ? (placed[primary.idx] ?? null) : (subjects[0] ?? null);
  const posed = (pose: Pose) => subjects.find((s) => s.pose === pose) ?? null;
  /** inside the room's side walls (no-op outdoors) */
  const inRoom = (x: number, margin: number) => (backZ !== null ? clamp(x, -roomHalf + margin, roomHalf - margin) : x);
  /** against the back wall (or a few metres behind the subject outdoors), front to the camera */
  const backAt = (depth: number) => (backZ !== null ? backZ - depth / 2 - 0.03 : focusZ + 2.5);

  for (const kind of want) {
    const dims = PROP_SIZE[kind];
    // S4c: an insert's featured thing (a phone, a cup, a bag, a sofa …) is the subject, on its support
    if (isInsert && kind === featuredKind && featuredDims && !PROP_SIZE_LEGACY.has(kind)) {
      props.push(box(nextId(kind), kind, 0, focusZ, supportTop, featuredDims, SMALL_ITEMS.has(kind) ? 12 : 0));
      continue;
    }
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
      case 'bed': {
        const lying = posed('lie');
        if (lying) {
          // subjects stand on the ground: under a lying person the bed is a low mattress
          const [fx, fz] = facingOf(lying);
          const Hm = lying.height_m;
          // the frame draws the person over it (scene.ts: a lying person's depth)
          props.push(box(nextId(kind), kind, lying.x - fx * 0.45 * Hm, lying.z - fz * 0.45 * Hm, 0, { w: 1.2, h: 0.12, d: 2.1 }, 180 - lying.yaw_deg));
        } else {
          // against the back wall, headboard to the wall, foot toward the room
          props.push(box(nextId(kind), kind, inRoom(focusX + side * 2.4, dims.w / 2 + 0.1), backAt(dims.d), 0, dims, 0));
        }
        break;
      }
      case 'sofa': {
        const sitter = posed('sit');
        if (sitter) {
          // the seat under the sitter, its front the way they face
          const [fx, fz] = facingOf(sitter);
          props.push(box(nextId(kind), kind, sitter.x - fx * 0.22, sitter.z - fz * 0.22, 0, dims, -sitter.yaw_deg));
        } else {
          props.push(box(nextId(kind), kind, inRoom(focusX + side * 2.6, dims.w / 2 + 0.1), backAt(dims.d), 0, dims, 0));
        }
        break;
      }
      case 'shelf': {
        const reacher = posed('reach');
        const turned = reacher ? Math.abs(relativeYaw(reacher, camera)) > 60 : false;
        if (reacher && turned) {
          // in reach: its front a hand's length ahead of the person, facing them
          const [fx, fz] = facingOf(reacher);
          const k = 0.45 * reacher.height_m / 1.7 + dims.d / 2;
          props.push(box(nextId(kind), kind, reacher.x + fx * k, reacher.z + fz * k, 0, dims, 180 - reacher.yaw_deg));
        } else {
          props.push(box(nextId(kind), kind, inRoom(focusX + side * 2.6, dims.w / 2 + 0.1), backAt(dims.d), 0, dims, 0));
        }
        break;
      }
      case 'lamp': {
        if (env === 'street') {
          // a street lamp on the pavement, its arm over the road
          const x = side * (STREET.roadHalf + 0.7);
          props.push(box(nextId(kind), kind, x, focusZ + 3, 0, { w: 0.4, h: 5.2, d: 0.4 }, x < 0 ? 0 : 180));
        } else {
          props.push(box(nextId(kind), kind, inRoom(focusX + side * 1.9, 0.4), focusZ + 1.1, 0, dims, 0));
        }
        break;
      }
      case 'tree': {
        if (backZ !== null) {
          // indoors: a potted plant against the back wall, under the ceiling
          const plant = { w: 0.7, h: Math.min(1.6, (env === 'corridor' ? CORRIDOR.h : wallH) - 0.4), d: 0.7 };
          props.push(box(nextId(kind), kind, inRoom(focusX + side * 2.2, plant.w / 2 + 0.1), backAt(plant.d), 0, plant, 0));
        } else props.push(box(nextId(kind), kind, focusX + side * 3.6, focusZ + 4.5, 0, dims, 0));
        break;
      }
      case 'phone':
      case 'cup':
      case 'book':
      case 'can':
      case 'bottle': {
        // on the table; without one the person holds it (or it is left out of the frame)
        if (tableTop) {
          const at = { phone: [0.22, -0.12, 20], cup: [-0.3, -0.06, 0], book: [0.02, 0.12, -8], can: [0.32, 0.04, 0], bottle: [-0.12, 0.16, 0] }[kind] as [number, number, number];
          props.push(box(nextId(kind), kind, tableTop.x + at[0], tableTop.z + at[1], PROP_SIZE.table.h, dims, at[2]));
        }
        break;
      }
      case 'bag': {
        // at the feet of the lead person, on the emptier side
        const s = lead;
        if (s) props.push(box(nextId(kind), kind, s.x + side * 0.42 * s.height_m / 1.7, s.z + 0.05, 0, dims, side * 15));
        else props.push(box(nextId(kind), kind, focusX + side * 0.8, focusZ, 0, dims, 10));
        break;
      }
    }
  }

  // ---- set dressing (S4c) -------------------------------------------------------
  // Deterministic from the seed, all env- props (lighter than the set pieces the
  // shot lists), never in front of a person: what stands closer than someone is
  // kept out of their stretch of the frame.
  const drng = rngFor(ctx.seed, 'env-dressing');
  const shotProps = new Set(shot.props);
  const frameX = (x: number, z: number, y = 1): number | null => {
    const q = projectPoint(basis, [x, y, z]);
    return q.visible ? q.x : null;
  };
  const people = subjects.map((s) => ({ s, fx: frameX(s.x, s.z, s.height_m * 0.5) }));
  /** true when a dressing piece at (x, z) of half-width hw would stand in front of someone in the frame */
  const blocks = (x: number, z: number, hw: number, y = 1) => {
    const fx = frameX(x, z, y);
    if (fx === null) return false;
    const half = hw / Math.max(frameWidthAt(z), 0.1);
    return people.some(({ s, fx: px }) => px !== null && z < s.z + 0.6 && Math.abs(fx - px) < half + 0.1);
  };
  let dk = 0;
  const dress = (kind: PropKind, x: number, z: number, y: number, dims: { w: number; h: number; d: number }, yaw = 0, name: string = kind) =>
    envProps.push(box(`${ENV_PREFIX}${name}-${dk++}`, kind, x, z, y, dims, yaw));

  if (env === 'interior' && backZ !== null) {
    // the back wall gets a window (or a door), the emptier side one piece of furniture
    if (!shotProps.has('window') && !shotProps.has('door')) {
      if (drng() < 0.7) dress('window', inRoom(focusX + side * 1.3, 0.8), backZ - 0.05, 0.95, { w: 1.2, h: 1.3, d: 0.1 });
      else dress('door', inRoom(focusX + side * 1.4, 0.6), backZ - 0.05, 0, PROP_SIZE.door);
    }
    if (!['bed', 'sofa', 'shelf', 'lamp'].some((k) => shotProps.has(k as PropKind))) {
      const pick = (['shelf', 'lamp', 'sofa'] as const)[Math.floor(drng() * 3)] ?? 'shelf';
      const dims = PROP_SIZE[pick];
      const x = inRoom(focusX + side * 2.9, dims.w / 2 + 0.1);
      const z = pick === 'lamp' ? backZ - 0.45 : backAt(dims.d);
      if (!blocks(x, z, dims.w / 2)) dress(pick, x, z, 0, dims);
    }
  } else if (env === 'classroom' && backZ !== null) {
    // blackboard on the back wall, rows of desks with their chairs, windows down the left wall
    dress('wall', 0, backZ - 0.02, 0.9, { w: Math.min(4.2, 2 * roomHalf - 1.4), h: 1.2, d: 0.04 }, 0, 'board');
    for (let r = 0; r < deskRows; r++) {
      const z = focusZ + 0.15 + r * DESK_PITCH;
      for (let x = -roomHalf + 1.1; x <= roomHalf - 1.1 + 1e-6; x += 1.75) {
        if (z < 1.4 || subjects.some((s) => Math.abs(x - s.x) < 1.0 && Math.abs(z - s.z) < 1.0)) continue;
        if (blocks(x, z - 0.4, DESK.w / 2, 0.6)) continue;
        dress('table', x, z, 0, DESK, 0, 'desk');
        dress('chair', x, z - 0.42, 0, DESK_CHAIR, 0, 'desk-chair');
      }
    }
    for (let z = 1.2; z < backZ - 0.8; z += 2.6) dress('window', -roomHalf + 0.05, z, 0.9, { w: 1.5, h: 1.4, d: 0.08 }, -90);
  } else if (env === 'corridor' && backZ !== null) {
    // doors along both walls, a window at the far end, the ceiling with its lights
    let k = 0;
    for (let z = 2.2; z < backZ - 1; z += CORRIDOR.doorEvery / 2, k++) {
      const left = k % 2 === 0;
      dress('door', left ? -roomHalf + 0.03 : roomHalf - 0.03, z, 0, { w: 0.9, h: 2.1, d: 0.06 }, left ? -90 : 90);
    }
    dress('window', 0, backZ - 0.05, 0.9, { w: 1.4, h: 1.4, d: 0.08 });
    // the ceiling only from below: a camera above it (high, overhead) sees into the corridor
    if (camera.y < CORRIDOR.h - 0.05) dress('wall', 0, backZ / 2, CORRIDOR.h, { w: 2 * roomHalf + 0.4, h: 0.1, d: backZ + 4 }, 0, 'ceiling');
  } else if (env === 'street') {
    // lamps and trees along both pavements, off the people
    for (const sgn of [-1, 1]) {
      const x = sgn * (STREET.roadHalf + 0.8);
      let i = sgn < 0 ? 0 : 1;
      for (let z = 4 + (sgn < 0 ? 0 : 4.5); z < zEnd - 6; z += 9, i++) {
        if (subjects.some((s) => Math.abs(z - s.z) < 2.5 && Math.abs(x - s.x) < 2)) continue;
        if (i % 2 === 0) {
          if (!blocks(x, z, 0.3, 3)) dress('lamp', x, z, 0, { w: 0.4, h: 5.2, d: 0.4 }, sgn < 0 ? 0 : 180);
        } else if (!blocks(x, z, 1.5, 3)) dress('tree', x, z, 0, { w: 3, h: 6, d: 3 });
      }
    }
  } else if (env === 'nature') {
    // a few trees, off the people and not growing out of anyone's head
    const n = 4 + Math.floor(drng() * 4);
    for (let i = 0, tries = 0; i < n && tries < 80; tries++) {
      const z = Math.max(2.5, focusZ * 0.6) + drng() * (focusZ + 28);
      const fx = -0.25 + drng() * 1.5;
      const x = worldXAtFrameX(basis, fx, z, 2);
      const w = 2.4 + drng() * 2;
      const h = 4.5 + drng() * 4;
      const half = w / 2 / Math.max(frameWidthAt(z), 0.1);
      const clash = people.some(({ s, fx: px }) => px !== null && Math.abs(fx - px) < half + (z < s.z + 1 ? 0.12 : 0.04));
      // some of it in frame: the base, the trunk's middle or the canopy
      const seen = [0.05, 0.4, 0.75].some((k) => {
        const q = projectPoint(basis, [x, h * k, z]);
        return q.visible && q.x > -0.05 && q.x < 1.05 && q.y > 0 && q.y < 1;
      });
      if (!Number.isFinite(x) || clash || !seen) continue;
      dress('tree', x, z, 0, { w, h, d: w }, 0);
      i++;
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

  // ---- S5b: the object's name, next to it ------------------------------------
  // An insert names its featured object; another shot the first small thing it
  // lists (a tin on the table, a letter in a hand) — when it is in frame.
  const labels: BoardSpec['overlay']['labels'] = [{ id: 'l-shot', text: shotLabelZh(isInsert ? 'INSERT' : shot.shot_size, camera.focal_mm), x: 0.012, y: 0.955 }];
  const objectName = objectNameFor(shot, ctx.prop_names);
  const namedKind = isInsert ? featuredKind : (shot.props.find((k) => SMALL_ITEMS.has(k) || k === 'box') ?? null);
  const named = objectName && namedKind ? props.find((p) => p.kind === namedKind) : undefined;
  if (objectName && named) {
    const c = projectPoint(basis, [named.x, named.y + named.h / 2, named.z]);
    if (c.visible && c.x > 0.02 && c.x < 0.98 && c.y > 0.04 && c.y < 0.96) {
      // the frame's px size (scene.ts frameSize; not imported — scene.ts depends on this module)
      const FW = 1840;
      const FH = FW / Number(aspect);
      const tw = labelWidthPx(objectName) / FW;
      const th = 34 / FH;
      // the object's extent in frame (its box corners): the label goes beside it, not on it
      const r = Math.max(named.w, named.d) / 2;
      const corners = [named.y, named.y + named.h].flatMap((y) =>
        [-1, 1].flatMap((sx) => [-1, 1].map((sz) => projectPoint(basis, [named.x + sx * r, y, named.z + sz * r]))),
      );
      const seen = corners.filter((q) => q.visible);
      const box = seen.length
        ? { x0: Math.min(...seen.map((q) => q.x)), x1: Math.max(...seen.map((q) => q.x)), y0: Math.min(...seen.map((q) => q.y)), y1: Math.max(...seen.map((q) => q.y)) }
        : { x0: c.x, x1: c.x, y0: c.y, y1: c.y };
      const gap = 0.025;
      const baseline = (top: number) => top + th * 0.8;
      let x: number;
      let y: number;
      if (box.x1 + gap + tw <= 0.98) [x, y] = [box.x1 + gap, baseline(Math.max(box.y0, 0.1))];
      else if (box.x0 - gap - tw >= 0.02) [x, y] = [box.x0 - gap - tw, baseline(Math.max(box.y0, 0.1))];
      else if (box.y0 - gap - th >= 0.1) [x, y] = [c.x - tw / 2, box.y0 - gap];
      else [x, y] = [c.x + 0.07, c.y - 0.16 < 0.12 ? c.y + 0.22 : c.y - 0.16];
      x = clamp(x, 0.02, 0.98 - tw);
      y = clamp(y, 0.12, 0.86 - 10 / FH);
      labels.push({ id: 'l-object', text: objectName, x: round(x, 4), y: round(y, 4), prop_id: named.id });
    }
  }

  const guides: BoardSpec['frame']['guides'] = aspect === '2.39' && ctx.look.center_guide ? ['1.43'] : [];
  const time = timeOfDay(ctx.time_label);
  const spec = {
    version: 1 as const,
    frame: { aspect, guides },
    camera,
    scene: {
      env,
      light: { ...TIME_LIGHT[time] },
      subjects,
      props: [...envProps, ...props],
      ...(time !== 'day' ? { time } : {}),
    },
    overlay: {
      labels,
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
