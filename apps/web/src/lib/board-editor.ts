import type { BoardArrow, BoardSpec, BoardSubject, Emotion, FrameFormat, Pose, ShotFields, Silhouette, TimeOfDay } from '@storyscript/contracts';
import {
  arrowWorldHeights,
  cameraBasis,
  DEPTH_FACTOR,
  effectiveGesture,
  frameSize,
  gestureCount,
  LOOK_WIDE_PENCIL,
  TIME_LIGHT,
  NEAR_M,
  placeArrow,
  poseTopY,
  relativeYaw,
  solveCamera,
  stableStringify,
  subjectBands,
  subjectFramePoints,
  toCamera,
  unprojectToPlane,
  yawForRel,
  type CameraBasis,
} from '@storyscript/core';

/**
 * Board editor model (FR-04 编辑). Pure functions over BoardSpec plus a
 * snapshot undo/redo stack; no React, no DOM, unit-tested in node.
 *
 * Coordinates:
 *  - world: metres (contracts/board.ts), rounded to 4 decimals like layout;
 *  - frame: [0,1]² with (0,0) top-left (what the pointer maps to);
 *  - px: the renderer's viewBox units (W = 1840, H = W / aspect).
 * Only two things are dragged on the canvas: a person's foot point (ray ∩
 * ground) and an arrow end; every other property is set in the inspector.
 */

type V2 = readonly [number, number];

const round = (v: number, d = 4): number => {
  const k = 10 ** d;
  const r = Math.round(v * k) / k;
  return r === 0 ? 0 : r;
};
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrapDeg = (a: number): number => {
  let r = a % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return r;
};

/** Farthest ground point a drag may place something (near the horizon the ray runs off to infinity). */
export const MAX_GROUND_DISTANCE_M = 250;

// ------------------------------------------------------------------ history

export interface HistoryEntry {
  label: string;
  spec: BoardSpec;
}

/** Snapshot command stack: every committed command stores the spec it produced. */
export interface EditHistory {
  past: HistoryEntry[];
  present: HistoryEntry;
  future: HistoryEntry[];
}

export const HISTORY_LIMIT = 100;

export function specKey(spec: BoardSpec): string {
  return stableStringify(spec);
}

export function historyInit(spec: BoardSpec): EditHistory {
  return { past: [], present: { label: '打开', spec }, future: [] };
}

/** Commit a command's result; a no-op edit (same spec) leaves the history untouched. */
export function historyCommit(h: EditHistory, label: string, spec: BoardSpec): EditHistory {
  if (specKey(spec) === specKey(h.present.spec)) return h;
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: { label, spec }, future: [] };
}

export function historyUndo(h: EditHistory): EditHistory {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function historyRedo(h: EditHistory): EditHistory {
  const next = h.future[0];
  if (!next) return h;
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
}

export const canUndo = (h: EditHistory) => h.past.length > 0;
export const canRedo = (h: EditHistory) => h.future.length > 0;
/** Label of the command undo would revert / redo would apply. */
export const undoLabel = (h: EditHistory) => (h.past.length ? h.present.label : null);
export const redoLabel = (h: EditHistory) => h.future[0]?.label ?? null;

/** Differs from the saved version? */
export function isDirty(h: EditHistory, saved: BoardSpec): boolean {
  return specKey(h.present.spec) !== specKey(saved);
}

/** Which keyboard shortcut an event is (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Ctrl+Y). */
export function historyShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): 'undo' | 'redo' | null {
  if (e.altKey || !(e.metaKey || e.ctrlKey)) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && e.ctrlKey && !e.metaKey) return 'redo';
  return null;
}

// ------------------------------------------------------------------ helpers

function clone(spec: BoardSpec): BoardSpec {
  return structuredClone(spec);
}

function withSubject(spec: BoardSpec, id: string, fn: (s: BoardSubject) => void): BoardSpec {
  if (!spec.scene.subjects.some((s) => s.id === id)) return spec;
  const next = clone(spec);
  fn(next.scene.subjects.find((s) => s.id === id)!);
  return next;
}

function withArrow(spec: BoardSpec, id: string, fn: (a: BoardArrow) => BoardArrow): BoardSpec {
  const i = spec.overlay.arrows.findIndex((a) => a.id === id);
  if (i < 0) return spec;
  const next = clone(spec);
  next.overlay.arrows[i] = fn(next.overlay.arrows[i]!);
  return next;
}

/** Frame point → ground (or plane y = planeY) world point; null above the horizon or absurdly far. */
export function groundAt(spec: BoardSpec, fx: number, fy: number, planeY = 0): { x: number; z: number } | null {
  const p = unprojectToPlane(spec.camera, spec.frame.aspect, fx, fy, planeY);
  if (!p) return null;
  if (Math.hypot(p[0] - spec.camera.x, p[2] - spec.camera.z) > MAX_GROUND_DISTANCE_M) return null;
  return { x: round(p[0]), z: round(p[2]) };
}

// ------------------------------------------------------------------ people

/**
 * Drag a person's foot point to frame position (fx, fy): ray ∩ ground → world
 * x/z. The person keeps facing the same way relative to the lens, and the
 * anchored arrows that belong to them (their move arrow, their eyeline, an
 * eyeline aimed at them) travel along.
 */
export function moveSubjectFoot(spec: BoardSpec, id: string, fx: number, fy: number): BoardSpec {
  const g = groundAt(spec, fx, fy);
  const s0 = spec.scene.subjects.find((s) => s.id === id);
  if (!g || !s0) return spec;
  const dx = g.x - s0.x;
  const dz = g.z - s0.z;
  const rel = relativeYaw(s0, spec.camera);
  const next = withSubject(spec, id, (s) => {
    s.x = g.x;
    s.z = g.z;
    s.yaw_deg = round(yawForRel(rel, g.x, g.z, spec.camera), 2);
  });
  const shift = (p: { x: number; z: number }) => ({ x: round(p.x + dx), z: round(p.z + dz) });
  next.overlay.arrows = next.overlay.arrows.map((a) => {
    if (a.mode !== 'anchored') return a;
    if (a.subject_id === id) {
      return a.kind === 'eyeline' ? { ...a, world_from: shift(a.world_from) } : { ...a, world_from: shift(a.world_from), world_to: shift(a.world_to) };
    }
    if (a.kind === 'eyeline' && Math.hypot(a.world_to.x - s0.x, a.world_to.z - s0.z) < 0.05) return { ...a, world_to: shift(a.world_to) };
    return a;
  });
  return next;
}

/** Eight facings relative to the camera → subject line (0 = into the lens, +90 = screen right). */
export const FACING8 = [0, 45, 90, 135, 180, -135, -90, -45] as const;
export type Facing8 = (typeof FACING8)[number];

export function facing8Of(spec: BoardSpec, id: string): Facing8 | null {
  const s = spec.scene.subjects.find((x) => x.id === id);
  if (!s) return null;
  const rel = relativeYaw(s, spec.camera);
  const snapped = wrapDeg(Math.round(rel / 45) * 45);
  return (snapped === -180 ? 180 : snapped) as Facing8;
}

export function setFacing8(spec: BoardSpec, id: string, rel: Facing8): BoardSpec {
  return withSubject(spec, id, (s) => {
    s.yaw_deg = round(yawForRel(rel, s.x, s.z, spec.camera), 2);
  });
}

export function setPose(spec: BoardSpec, id: string, pose: Pose): BoardSpec {
  return withSubject(spec, id, (s) => {
    if (s.pose !== pose && s.gesture != null) s.gesture = null; // a gesture belongs to its pose: back to the seed's pick
    s.pose = pose;
  });
}

/** S5b: a person's feeling (null or neutral: a calm face, stored as absent). */
export function setEmotion(spec: BoardSpec, id: string, emotion: Emotion | null): BoardSpec {
  return withSubject(spec, id, (s) => {
    if (emotion && emotion !== 'neutral') s.emotion = emotion;
    else delete s.emotion;
  });
}

/** S5b: the board's light (day is stored as absent, like boards laid out before S5b). */
export function setTimeOfDay(spec: BoardSpec, time: TimeOfDay): BoardSpec {
  const next = clone(spec);
  const light = TIME_LIGHT[time];
  next.scene.light = { ...light };
  if (time === 'day') delete next.scene.time;
  else next.scene.time = time;
  return next;
}

/** How a pose's gesture variants are read: core's tables, or others injected by a test. */
export interface GestureTables {
  count(pose: Pose): number;
  effective(s: { id: string; pose: Pose; gesture?: number | null }, seed: number): number;
}
/** BoardSubject.gesture is 0…15 in the contract */
const GESTURE_MAX = 15;
const CORE_GESTURES: GestureTables = { count: gestureCount, effective: effectiveGesture };

/** Which variant a person is drawn with, out of how many; null when the pose has only one (nothing to change). */
export function gestureOf(spec: BoardSpec, id: string, tables: GestureTables = CORE_GESTURES): { index: number; count: number } | null {
  const s = spec.scene.subjects.find((x) => x.id === id);
  if (!s) return null;
  const count = Math.min(tables.count(s.pose), GESTURE_MAX + 1);
  if (count <= 1) return null;
  const index = tables.effective(s, spec.seed);
  return { index: ((index % count) + count) % count, count };
}

/**
 * 换个动作: the next gesture variant of the person's pose, wrapping around,
 * starting from the one they are drawn with now (so the first click always
 * changes the picture). Unchanged when the pose has a single variant.
 */
export function nextGesture(spec: BoardSpec, id: string, tables: GestureTables = CORE_GESTURES): BoardSpec {
  const g = gestureOf(spec, id, tables);
  if (!g) return spec;
  return withSubject(spec, id, (s) => {
    s.gesture = (g.index + 1) % g.count;
  });
}

export function setSilhouette(spec: BoardSpec, id: string, silhouette: Silhouette): BoardSpec {
  return withSubject(spec, id, (s) => {
    s.silhouette = silhouette;
  });
}

/** Painter-order override: null = by depth, 1 = in front of everything, -1 = behind the set. */
export function setLayer(spec: BoardSpec, id: string, z: number | null): BoardSpec {
  return withSubject(spec, id, (s) => {
    s.z_override = z;
  });
}

/** Pencil tone override (1 light … 3 dark), null = from the depth band. */
export function setTone(spec: BoardSpec, id: string, tone: number | null): BoardSpec {
  return withSubject(spec, id, (s) => {
    s.tone_override = tone === null ? null : clamp(Math.round(tone), 0, 3);
  });
}

export type DepthBand = 'fg' | 'mg' | 'bg';

/** The depth band the pencil renderer puts a person in (same rule as core). */
export function depthBandOf(spec: BoardSpec, id: string): DepthBand | null {
  return subjectBands(spec).find((b) => b.id === id)?.band ?? null;
}

/**
 * Move a person along their line of sight (same bearing from the camera, so
 * the same frame column) into a depth band. Bands are relative, as in the
 * pencil renderer: the nearest person is the reference (fg < 1.4x <= mg <
 * 2.6x <= bg). With other people in the frame:
 *   fg: 1/1.6 of the nearest other's depth (this person becomes the nearest);
 *   mg: the plane of the nearest other mid-ground person, else 1.8x the nearest other;
 *   bg: 3x the nearest other's depth.
 * Alone in the frame there is nothing to be relative to: the layout's depth
 * factors (fg 0.6x, bg 2x) scale the current distance.
 */
export function setDepthBand(spec: BoardSpec, id: string, band: DepthBand): BoardSpec {
  const infos = subjectBands(spec);
  const me = infos.find((i) => i.id === id);
  if (!me || me.depth <= NEAR_M) return spec;
  const others = infos.filter((i) => i.id !== id && i.depth > NEAR_M);
  let target: number;
  if (others.length) {
    const nearest = Math.min(...others.map((o) => o.depth));
    const mgOthers = others.filter((o) => o.band === 'mg' && o.depth > nearest * 1.01);
    if (band === 'fg') target = nearest / 1.6;
    else if (band === 'bg') target = nearest * 3;
    else target = mgOthers.length ? Math.min(...mgOthers.map((o) => o.depth)) : nearest * 1.8;
  } else {
    target = me.depth * DEPTH_FACTOR[band];
  }
  target = Math.max(target, 0.4);
  // camera depth of the body centre = k·A + B when the ground offset from the camera is scaled by k
  const subj = spec.scene.subjects.find((s) => s.id === id)!;
  const b = cameraBasis(spec.camera, spec.frame.aspect);
  const A = (subj.x - spec.camera.x) * b.fwd[0] + (subj.z - spec.camera.z) * b.fwd[2];
  const B = (0.5 * poseTopY(subj.pose) * subj.height_m - spec.camera.y) * b.fwd[1];
  const k = Math.abs(A) > 1e-6 ? (target - B) / A : target / me.depth;
  if (!Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-6) return spec;
  return withSubject(spec, id, (s) => {
    s.x = round(spec.camera.x + (s.x - spec.camera.x) * k);
    s.z = round(spec.camera.z + (s.z - spec.camera.z) * k);
  });
}

// ------------------------------------------------------------------ camera

/** The person the camera frames: camera depth closest to the solver's framing distance. */
export function framedSubject(spec: BoardSpec, axisDistance: number): BoardSubject | null {
  const b = cameraBasis(spec.camera, spec.frame.aspect);
  let best: BoardSubject | null = null;
  let err = Infinity;
  for (const s of spec.scene.subjects) {
    const d = toCamera(b, [s.x, 0.5 * poseTopY(s.pose) * s.height_m, s.z])[2];
    if (d <= NEAR_M) continue;
    const e = Math.abs(d - axisDistance);
    if (e < err) {
      err = e;
      best = s;
    }
  }
  return best;
}

export type CameraFields = Pick<ShotFields, 'shot_size' | 'angle' | 'lens' | 'focal_mm' | 'set_piece'>;

export const FOCAL_MIN = 12;
export const FOCAL_MAX = 200;

/**
 * Focal slider. keepSize (default): the camera dollies along its view so the
 * framed person keeps the same size — core solveCamera is run for the old
 * and the new focal length on the shot's grammar and the camera moves by the
 * ratio of the two solved distances (height and pitch follow the solver's
 * change too). Without the shot fields the ratio is new/old focal (exact for
 * a subject square to the lens). keepSize false: a plain zoom.
 */
export function setFocal(spec: BoardSpec, focal: number, opts: { keepSize: boolean; fields?: CameraFields | null }): BoardSpec {
  const f1 = spec.camera.focal_mm;
  const f2 = round(clamp(focal, FOCAL_MIN, FOCAL_MAX), 3);
  if (f2 === f1) return spec;
  const next = clone(spec);
  next.camera.focal_mm = f2;
  if (!opts.keepSize) return next;

  let ratio = f2 / f1;
  let dy = 0;
  let dPitch = 0;
  let overhead = spec.camera.pitch_deg <= -80;
  let axis = 0;
  if (opts.fields) {
    const base = { aspect: spec.frame.aspect, look: LOOK_WIDE_PENCIL, technique: null } as const;
    const guess = solveCamera(opts.fields, { ...base, focal_mm: f1 });
    const target = framedSubject(spec, guess.axis_distance_m);
    const o = { ...base, subject_height_m: target?.height_m ?? null, pose: target?.pose ?? null };
    const a = solveCamera(opts.fields, { ...o, focal_mm: f1 });
    const b = solveCamera(opts.fields, { ...o, focal_mm: f2 });
    overhead = a.mode === 'overhead';
    axis = a.axis_distance_m;
    if (!overhead && a.distance_m > 1e-6 && b.distance_m > 1e-6) {
      ratio = b.distance_m / a.distance_m;
      dy = b.camera.y - a.camera.y;
      dPitch = b.camera.pitch_deg - a.camera.pitch_deg;
    }
  }

  const cam = next.camera;
  if (overhead) {
    const target = framedSubject(spec, axis || cam.y);
    const yT = target ? 0.82 * poseTopY(target.pose) * target.height_m : 0;
    cam.y = round(yT + (cam.y - yT) * (f2 / f1));
    return next;
  }
  const psi = (cam.yaw_deg * Math.PI) / 180;
  const fwd: V2 = [Math.sin(psi), Math.cos(psi)];
  const guessAxis = axis || 3;
  const target = framedSubject(spec, guessAxis);
  // horizontal distance to the framed person along the view direction (fallback: the solver's)
  let dOld = target ? (target.x - cam.x) * fwd[0] + (target.z - cam.z) * fwd[1] : guessAxis;
  if (!(dOld > 0.05)) dOld = guessAxis;
  const dNew = dOld * ratio;
  cam.x = round(cam.x + fwd[0] * (dOld - dNew));
  cam.z = round(cam.z + fwd[1] * (dOld - dNew));
  cam.y = round(Math.max(0.05, cam.y + dy));
  cam.pitch_deg = round(clamp(cam.pitch_deg + dPitch, -90, 90), 4);
  return next;
}

export function setCameraHeight(spec: BoardSpec, y: number): BoardSpec {
  const next = clone(spec);
  next.camera.y = round(clamp(y, 0.05, 60));
  return next;
}

export function setPitch(spec: BoardSpec, deg: number): BoardSpec {
  const next = clone(spec);
  next.camera.pitch_deg = round(clamp(deg, -90, 90), 2);
  return next;
}

export function setRoll(spec: BoardSpec, deg: number): BoardSpec {
  const next = clone(spec);
  next.camera.roll_deg = round(clamp(deg, -45, 45), 2);
  return next;
}

export function setAspect(spec: BoardSpec, aspect: FrameFormat): BoardSpec {
  const next = clone(spec);
  next.frame.aspect = aspect;
  return next;
}

/** 1.43 centre-extraction guide on/off (only meaningful on frames wider than 1.43). */
export function setGuide143(spec: BoardSpec, on: boolean): BoardSpec {
  const has = spec.frame.guides.includes('1.43');
  if (has === on) return spec;
  const next = clone(spec);
  next.frame.guides = on ? [...next.frame.guides, '1.43'] : next.frame.guides.filter((g) => g !== '1.43');
  return next;
}

// ------------------------------------------------------------------ overlay

export function setLabelText(spec: BoardSpec, id: string, text: string): BoardSpec {
  const i = spec.overlay.labels.findIndex((l) => l.id === id);
  if (i < 0) return spec;
  const next = clone(spec);
  next.overlay.labels[i]!.text = text;
  return next;
}

/** Whole annotation layer translation, frame units (clamped to ±0.5). */
export function setOverlayOffset(spec: BoardSpec, x: number, y: number): BoardSpec {
  const next = clone(spec);
  next.overlay.offset = { x: round(clamp(x, -0.5, 0.5)), y: round(clamp(y, -0.5, 0.5)) };
  return next;
}

export interface ArrowHandle {
  id: string;
  kind: BoardArrow['kind'];
  mode: BoardArrow['mode'];
  /** drawn end points in px (viewBox units), overlay offset applied */
  from: V2;
  to: V2;
  /** anchored: the world heights the drawn ends sit at */
  heights: [number, number] | null;
}

/** Where each overlay arrow is drawn (same placement as core renderBoard), in px. */
export function arrowHandles(spec: BoardSpec): ArrowHandle[] {
  const { W, H } = frameSize(spec.frame.aspect);
  const b = cameraBasis(spec.camera, spec.frame.aspect);
  const ox = spec.overlay.offset.x * W;
  const oy = spec.overlay.offset.y * H;
  const out: ArrowHandle[] = [];
  for (const a of spec.overlay.arrows) {
    const placed = placeArrow(spec, b, W, H, a);
    if (!placed) continue;
    const [f, t] = placed.pts as [V2, V2];
    out.push({ id: a.id, kind: a.kind, mode: a.mode, from: [f[0] + ox, f[1] + oy], to: [t[0] + ox, t[1] + oy], heights: placed.heights });
  }
  return out;
}

export interface SubjectHandle {
  id: string;
  badge: string;
  label: string;
  /** foot point in px, null when behind the camera */
  foot: V2 | null;
}

export function subjectHandles(spec: BoardSpec): SubjectHandle[] {
  const { W, H } = frameSize(spec.frame.aspect);
  const pts = subjectFramePoints(spec);
  return spec.scene.subjects.map((s) => {
    const f = pts.get(s.id)?.foot ?? null;
    return { id: s.id, badge: s.badge, label: s.label, foot: f ? [f[0] * W, f[1] * H] : null };
  });
}

/**
 * Drag an arrow end to frame position (fx, fy) — the pointer, before the
 * overlay offset is taken out. Free arrows store frame coordinates; anchored
 * ones intersect the pointer ray with the horizontal plane at the height the
 * end is drawn at, so the end stays under the pointer.
 */
export function moveArrowEnd(spec: BoardSpec, id: string, end: 'from' | 'to', fx: number, fy: number): BoardSpec {
  const a = spec.overlay.arrows.find((x) => x.id === id);
  if (!a) return spec;
  const px = fx - spec.overlay.offset.x;
  const py = fy - spec.overlay.offset.y;
  if (a.mode === 'free') {
    return withArrow(spec, id, (x) => (x.mode === 'free' ? { ...x, [end]: { x: round(px), y: round(py) } } : x));
  }
  const h = arrowHandles(spec).find((x) => x.id === id)?.heights ?? arrowWorldHeights(spec, a)[0] ?? [0, 0];
  const g = groundAt(spec, px, py, end === 'from' ? h[0] : h[1]);
  if (!g) return spec;
  const key = end === 'from' ? 'world_from' : 'world_to';
  return withArrow(spec, id, (x) => (x.mode === 'anchored' ? { ...x, [key]: g } : x));
}

/**
 * Switch an arrow between anchored (world ground points, follows the camera)
 * and free (frame points, stays put on the paper) without moving it on screen.
 */
export function setArrowMode(spec: BoardSpec, id: string, mode: BoardArrow['mode']): BoardSpec {
  const a = spec.overlay.arrows.find((x) => x.id === id);
  if (!a || a.mode === mode) return spec;
  const { W, H } = frameSize(spec.frame.aspect);
  const handle = arrowHandles(spec).find((x) => x.id === id);
  const ox = spec.overlay.offset.x;
  const oy = spec.overlay.offset.y;
  if (mode === 'free') {
    if (!handle) return spec;
    const from = { x: round(handle.from[0] / W - ox), y: round(handle.from[1] / H - oy) };
    const to = { x: round(handle.to[0] / W - ox), y: round(handle.to[1] / H - oy) };
    return withArrow(spec, id, (x) => ({ id: x.id, kind: x.kind, mode: 'free', subject_id: x.subject_id, from, to }));
  }
  if (a.mode !== 'free') return spec;
  // free → anchored: unproject at a first-guess height, then once more at the renderer's heights
  const top = (() => {
    const s = spec.scene.subjects.find((x) => x.id === a.subject_id);
    return s ? poseTopY(s.pose) * s.height_m : 1.7;
  })();
  const guess = (y0: number, y1: number) => {
    const f = groundAt(spec, a.from.x, a.from.y, y0);
    const t = groundAt(spec, a.to.x, a.to.y, y1);
    return f && t ? { f, t } : null;
  };
  const first = guess(0.5 * top, 0.5 * top) ?? guess(0, 0);
  if (!first) return spec;
  const provisional: Extract<BoardArrow, { mode: 'anchored' }> = {
    id: a.id,
    kind: a.kind,
    mode: 'anchored',
    subject_id: a.subject_id,
    world_from: first.f,
    world_to: first.t,
  };
  const hh = arrowWorldHeights(spec, provisional)[0] ?? [0, 0];
  const second = guess(hh[0], hh[1]) ?? first;
  return withArrow(spec, id, () => ({ ...provisional, world_from: second.f, world_to: second.t }));
}

// ------------------------------------------------------------------ pointer

/** Pointer position inside an element box → frame coordinates (may fall outside [0,1]). */
export function pointerToFrame(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): { fx: number; fy: number } {
  return { fx: (clientX - rect.left) / Math.max(rect.width, 1), fy: (clientY - rect.top) / Math.max(rect.height, 1) };
}
