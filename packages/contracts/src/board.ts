import { z } from 'zod';
import { IsoTime, Uuid } from './common.ts';
import { EnvKind, FrameFormat, Movement, Pose, PropKind } from './shot.ts';

// ---------------------------------------------------------------------------
// BoardSpec v1 — produced only by core/board/layoutBoard or by user edits.
// The LLM never emits it (INV-10). World coordinates are metres:
//   x → screen-right when camera yaw = 0, y → up, z → away from camera.
// Frame coordinates are normalised [0,1] with (0,0) at top-left.
// ---------------------------------------------------------------------------

export const Vec2 = z.object({ x: z.number(), y: z.number() });
export type Vec2 = z.infer<typeof Vec2>;

export const GroundPoint = z.object({ x: z.number(), z: z.number() });
export type GroundPoint = z.infer<typeof GroundPoint>;

export const Silhouette = z.enum(['regular', 'coat', 'dress']);
export type Silhouette = z.infer<typeof Silhouette>;

/** 0 = paper white, 1 = light, 2 = mid, 3 = dark */
export const Tone = z.number().int().min(0).max(3);
export type Tone = z.infer<typeof Tone>;

export const BoardSubject = z.object({
  /** stable key inside the board, e.g. "s0" */
  id: z.string(),
  entity_id: Uuid.nullable(),
  label: z.string(),
  /** single letter badge for B/W identity, e.g. "A" */
  badge: z.string(),
  x: z.number(),
  z: z.number(),
  /** 0 = facing the camera, 180 = facing away, 90 = facing screen-right */
  yaw_deg: z.number(),
  pose: Pose,
  height_m: z.number().positive(),
  silhouette: Silhouette,
  tone_override: Tone.nullable(),
  /** manual painter-order override; larger draws later (in front) */
  z_override: z.number().nullable(),
});
export type BoardSubject = z.infer<typeof BoardSubject>;

export const BoardProp = z.object({
  id: z.string(),
  kind: PropKind,
  x: z.number(),
  z: z.number(),
  /** base height above ground (m) */
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  d: z.number().positive(),
  yaw_deg: z.number(),
  /** camera-attached props (vehicle rigs) move with the camera */
  attach: z.enum(['world', 'camera']),
});
export type BoardProp = z.infer<typeof BoardProp>;

export const BoardCamera = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  /** 0 = looking down +z */
  yaw_deg: z.number(),
  /** positive = tilt up */
  pitch_deg: z.number(),
  roll_deg: z.number(),
  focal_mm: z.number().positive(),
  /** full-frame equivalent width; height derives from aspect */
  sensor_w_mm: z.literal(36),
});
export type BoardCamera = z.infer<typeof BoardCamera>;

export const BoardFrame = z.object({
  aspect: FrameFormat,
  /** extra protection guides drawn inside the frame */
  guides: z.array(z.enum(['1.43', '1.78', 'thirds'])),
});
export type BoardFrame = z.infer<typeof BoardFrame>;

export const ArrowKind = z.enum(['subject_move', 'camera_move', 'eyeline']);
export type ArrowKind = z.infer<typeof ArrowKind>;

export const AnchoredArrow = z.object({
  id: z.string(),
  kind: ArrowKind,
  mode: z.literal('anchored'),
  subject_id: z.string().nullable(),
  world_from: GroundPoint,
  world_to: GroundPoint,
});
export const FreeArrow = z.object({
  id: z.string(),
  kind: ArrowKind,
  mode: z.literal('free'),
  subject_id: z.string().nullable(),
  from: Vec2,
  to: Vec2,
});
export const BoardArrow = z.discriminatedUnion('mode', [AnchoredArrow, FreeArrow]);
export type BoardArrow = z.infer<typeof BoardArrow>;

export const BoardLabel = z.object({
  id: z.string(),
  text: z.string(),
  /** frame coordinates */
  x: z.number(),
  y: z.number(),
});
export type BoardLabel = z.infer<typeof BoardLabel>;

export const BoardOverlay = z.object({
  labels: z.array(BoardLabel),
  arrows: z.array(BoardArrow),
  camera_move: Movement.nullable(),
  /** frame-space translation of the whole overlay, used to align drifted AI rasters */
  offset: Vec2,
  show_code: z.boolean(),
});
export type BoardOverlay = z.infer<typeof BoardOverlay>;

export const BoardScene = z.object({
  env: EnvKind,
  light: z.object({ azimuth_deg: z.number(), elevation_deg: z.number() }),
  subjects: z.array(BoardSubject),
  props: z.array(BoardProp),
});
export type BoardScene = z.infer<typeof BoardScene>;

export const BoardSpec = z.object({
  version: z.literal(1),
  frame: BoardFrame,
  camera: BoardCamera,
  scene: BoardScene,
  overlay: BoardOverlay,
  /** deterministic seed for pencil jitter */
  seed: z.number().int(),
});
export type BoardSpec = z.infer<typeof BoardSpec>;

export const RenderMode = z.enum(['structure', 'pencil', 'topview']);
export type RenderMode = z.infer<typeof RenderMode>;

export const Board = z.object({
  id: Uuid,
  shot_id: Uuid,
  version: z.number().int().positive(),
  parent_board_id: Uuid.nullable(),
  spec: BoardSpec,
  renderer_version: z.string(),
  /** shot.content_hash this board was laid out from; stale when it differs */
  basis_content_hash: z.string(),
  user_edited: z.boolean(),
  revision: z.number().int().nonnegative(),
  created_at: IsoTime,
});
export type Board = z.infer<typeof Board>;

export const RasterStatus = z.enum(['candidate', 'adopted', 'rejected']);
export const RasterOutcome = z.enum(['ok', 'refused', 'outcome_unknown', 'late_after_cancel']);

export const BoardRaster = z.object({
  id: Uuid,
  board_id: Uuid,
  structure_hash: z.string(),
  dialect: z.enum(['openai-edits', 'generations-ref', 'fake']),
  host: z.string(),
  model: z.string(),
  preset_id: z.string().nullable(),
  size: z.string(),
  quality: z.string().nullable(),
  prompt_hash: z.string(),
  control_sha256: z.string(),
  file: z.string().nullable(),
  sha256: z.string().nullable(),
  status: RasterStatus,
  outcome: RasterOutcome,
  usage: z.record(z.string(), z.number()).nullable(),
  ai_label_on: z.boolean(),
  source_type: z.literal('model_generated'),
  created_at: IsoTime,
});
export type BoardRaster = z.infer<typeof BoardRaster>;
