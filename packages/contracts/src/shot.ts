import { z } from 'zod';
import { ActorRef, IsoTime, Origin, Uuid } from './common.ts';
import { ParagraphId } from './script.ts';

// ---------------------------------------------------------------------------
// Closed vocabularies. English enum values are the storage/LLM format;
// Chinese labels live in core/i18n and are display-only.
// ---------------------------------------------------------------------------

export const ShotSize = z.enum(['EWS', 'WS', 'FS', 'MLS', 'MS', 'MCU', 'CU', 'ECU', 'INSERT']);
export type ShotSize = z.infer<typeof ShotSize>;

export const CameraAngle = z.enum(['eye', 'low', 'high', 'overhead', 'dutch']);
export type CameraAngle = z.infer<typeof CameraAngle>;

export const LensClass = z.enum(['wide', 'normal', 'tele']);
export type LensClass = z.infer<typeof LensClass>;

export const Movement = z.enum([
  'static',
  'push_in',
  'pull_out',
  'pan',
  'tilt',
  'track',
  'crane',
  'handheld',
  'vehicle',
  // S3: moves a braver crew attempts
  'orbit',
  'aerial',
  'dolly_zoom',
]);
export type Movement = z.infer<typeof Movement>;

export const ScreenPos = z.enum(['L', 'C', 'R']);
export type ScreenPos = z.infer<typeof ScreenPos>;

export const DepthPlane = z.enum(['fg', 'mg', 'bg']);
export type DepthPlane = z.infer<typeof DepthPlane>;

/** Facing relative to camera / screen. */
export const Facing = z.enum(['camera', 'away', 'screen_left', 'screen_right', '3q_left', '3q_right']);
export type Facing = z.infer<typeof Facing>;

export const Pose = z.enum([
  'stand',
  'walk',
  'run',
  'sit',
  'point',
  'crouch',
  // S4c: more of what people do in a scene
  'lie',
  'kneel',
  'reach',
  'phone',
]);
export type Pose = z.infer<typeof Pose>;

/**
 * S5b: what a person feels in the shot (face and body language on the board).
 * Absent or null on a shot subject: read from the shot's action text.
 */
export const Emotion = z.enum(['neutral', 'happy', 'sad', 'angry', 'afraid', 'surprised', 'tense']);
export type Emotion = z.infer<typeof Emotion>;

export const PropKind = z.enum([
  'door',
  'table',
  'chair',
  'car',
  'wall',
  'building',
  'stairs',
  'window',
  'box',
  // S4c: furniture, a tree and the small things an insert is about
  'bed',
  'sofa',
  'shelf',
  'lamp',
  'tree',
  'phone',
  'cup',
  'book',
  'bag',
  // S5b: turned forms an insert is often about (a tin of fruit, a bottle of pills)
  'can',
  'bottle',
]);
export type PropKind = z.infer<typeof PropKind>;

export const EnvKind = z.enum([
  'open',
  'interior',
  'street',
  // S4c: the places school shorts are shot in
  'nature',
  'corridor',
  'classroom',
]);
export type EnvKind = z.infer<typeof EnvKind>;

export const SubjectMotion = z.enum(['none', 'l2r', 'r2l', 'toward', 'away']);
export type SubjectMotion = z.infer<typeof SubjectMotion>;

export const FrameFormat = z.enum(['2.39', '2.20', '1.90', '1.78', '1.43']);
export type FrameFormat = z.infer<typeof FrameFormat>;

export const BoardTemplate = z.enum([
  'establishing',
  'single',
  'two_shot',
  'ots',
  'insert',
  'lateral_move',
  'scale',
]);
export type BoardTemplate = z.infer<typeof BoardTemplate>;

export const RequiredStatus = z.enum(['required', 'optional', 'waived']);
export type RequiredStatus = z.infer<typeof RequiredStatus>;

// ---------------------------------------------------------------------------
// ShotFields — the semantic description of a shot. This is what the LLM emits
// (inside BreakdownOutput) and what users edit. Flat, all keys required,
// nullable instead of optional, no numeric bounds in the schema (bounds are
// enforced by core/shots business validation) so the JSON schema stays
// portable across providers (json_schema strict / json_object).
// Subject detail fields are nullable: layout fills defaults from the template.
// ---------------------------------------------------------------------------

export const ShotSubject = z.object({
  /** character alias from the roster, e.g. c1 */
  alias: z.string(),
  screen: ScreenPos.nullable(),
  depth: DepthPlane.nullable(),
  facing: Facing.nullable(),
  pose: Pose.nullable(),
  /** S5b: optional so shots written before S5b keep their content hash; null = infer from the action */
  emotion: Emotion.nullable().optional(),
});
export type ShotSubject = z.infer<typeof ShotSubject>;

export const SourceRef = z.object({
  paragraph_id: ParagraphId,
  quote: z.string(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const ShotFields = z.object({
  template: BoardTemplate.nullable(),
  shot_size: ShotSize,
  angle: CameraAngle,
  lens: LensClass,
  focal_mm: z.number().nullable(),
  movement: Movement,
  subjects: z.array(ShotSubject),
  props: z.array(PropKind),
  env: EnvKind.nullable(),
  subject_motion: SubjectMotion,
  set_piece: z.boolean(),
  /** alias of the character whose point of view the shot takes */
  pov_owner: z.string().nullable(),
  frame_format: FrameFormat.nullable(),
  technique_id: z.string().nullable(),
  est_seconds: z.number(),
  narrative_purpose: z.string(),
  action: z.string(),
  dialogue_quote: z.string().nullable(),
  source: SourceRef,
  assumptions: z.array(z.string()),
  questions: z.array(z.string()),
  /**
   * S3 拍法说明: blocking, rig and timing the enums cannot say (an orbit
   * around two actors, a one-take through a corridor). Optional so shots
   * written before S3 keep their content hash; empty is stored as absent.
   */
  camera_notes: z.string().nullable().optional(),
  /**
   * S5b 物件名称: what the object a close-up or insert is about is called
   * (水果罐头, 录取通知书). The board writes it next to the object, which it can
   * only draw as a plain shape. Optional (hash-stable like camera_notes).
   */
  object_name: z.string().nullable().optional(),
});
export type ShotFields = z.infer<typeof ShotFields>;

/** LLM output for one scene's breakdown. */
export const BreakdownOutput = z.object({
  shots: z.array(ShotFields),
});
export type BreakdownOutput = z.infer<typeof BreakdownOutput>;

/** LLM output for the shooting-order suggestion (U-03). */
export const OrderSuggestionOutput = z.object({
  setup_order: z.array(z.string()),
  rationale: z.string(),
});
export type OrderSuggestionOutput = z.infer<typeof OrderSuggestionOutput>;

export const QuoteMatch = z.enum(['exact', 'fuzzy', 'manual']);
export type QuoteMatch = z.infer<typeof QuoteMatch>;

export const SourceAnchor = z.object({
  script_version_id: Uuid,
  paragraph_id: ParagraphId,
  quote: z.string(),
  match: QuoteMatch,
});
export type SourceAnchor = z.infer<typeof SourceAnchor>;

export const Shot = z.object({
  id: Uuid,
  scene_id: Uuid,
  /** display code, editable, not identity (INV-02) */
  code: z.string(),
  /** narrative order key (INV-01); never touched by scheduling */
  narrative_pos: z.number(),
  source_anchor: SourceAnchor.nullable(),
  manual_note: z.string().nullable(),
  origin: Origin,
  fields: ShotFields,
  locked: z.boolean(),
  archived: z.boolean(),
  required_status: RequiredStatus,
  requirement_reason: z.string().nullable(),
  setup_id: Uuid.nullable(),
  needs_relink: z.boolean(),
  /** hash of `fields` (content only; code/narrative_pos excluded) */
  content_hash: z.string(),
  revision: z.number().int().nonnegative(),
  created_at: IsoTime,
  updated_at: IsoTime,
});
export type Shot = z.infer<typeof Shot>;

export const ShotRevision = z.object({
  id: Uuid,
  shot_id: Uuid,
  revision: z.number().int().nonnegative(),
  fields: ShotFields,
  origin: Origin,
  reason: z.string().nullable(),
  at: IsoTime,
  /** S4: who made this revision (hosted server) */
  actor: ActorRef.nullable().optional(),
});
export type ShotRevision = z.infer<typeof ShotRevision>;

export const DraftIssueLevel = z.enum(['error', 'warning']);
export const DraftIssue = z.object({
  level: DraftIssueLevel,
  code: z.string(),
  message: z.string(),
  /** index into the draft's items, null for whole-draft issues */
  item: z.number().int().nullable(),
});
export type DraftIssue = z.infer<typeof DraftIssue>;

export const DraftKind = z.enum(['entities', 'breakdown', 'order', 'style', 'polish']);
export type DraftKind = z.infer<typeof DraftKind>;

export const DraftStatus = z.enum(['pending', 'applied', 'discarded', 'failed']);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const ShotDraft = z.object({
  id: Uuid,
  kind: DraftKind,
  /** e.g. { scene_id } for breakdown */
  scope: z.record(z.string(), z.unknown()),
  model: z.string().nullable(),
  prompt_version: z.string(),
  raw_output: z.string().nullable(),
  parsed: z.unknown().nullable(),
  issues: z.array(DraftIssue),
  attempts: z.number().int().nonnegative(),
  usage: z.record(z.string(), z.number()).nullable(),
  status: DraftStatus,
  created_at: IsoTime,
  /** S4: who asked the model */
  actor: ActorRef.nullable().optional(),
});
export type ShotDraft = z.infer<typeof ShotDraft>;
