import { z } from 'zod';
import { IsoTime, Uuid } from './common.ts';

export const ResourceType = z.enum(['performer', 'location', 'equipment']);
export type ResourceType = z.infer<typeof ResourceType>;

/** Half-open availability interval [start, end) in UTC instants. */
export const TimeWindow = z.object({
  start_utc: IsoTime,
  end_utc: IsoTime,
});
export type TimeWindow = z.infer<typeof TimeWindow>;

export const Resource = z.object({
  id: Uuid,
  type: ResourceType,
  name: z.string().min(1),
  windows: z.array(TimeWindow),
  /** performer → character entity ids (casting map); empty for non-performers */
  cast_character_ids: z.array(Uuid),
  confirmed: z.boolean(),
});
export type Resource = z.infer<typeof Resource>;

export const SetupDurations = z.object({
  setup_min: z.number().nonnegative(),
  per_shot_min: z.number().nonnegative(),
  reset_min: z.number().nonnegative(),
});
export type SetupDurations = z.infer<typeof SetupDurations>;

export const Setup = z.object({
  id: Uuid,
  location_resource_id: Uuid.nullable(),
  label: z.string(),
  shot_ids: z.array(Uuid),
  /** extra resources (equipment) required for the whole setup */
  resource_ids: z.array(Uuid),
  durations: SetupDurations,
  /** estimates must be confirmed before a plan can be approved */
  estimate_confirmed: z.boolean(),
});
export type Setup = z.infer<typeof Setup>;

export const ConstraintType = z.enum(['before', 'not_before', 'not_after', 'locked_block']);
export type ConstraintType = z.infer<typeof ConstraintType>;

export const Constraint = z.discriminatedUnion('type', [
  z.object({ id: Uuid, type: z.literal('before'), a_setup_id: Uuid, b_setup_id: Uuid, confirmed: z.boolean() }),
  z.object({ id: Uuid, type: z.literal('not_before'), setup_id: Uuid, at_utc: IsoTime, confirmed: z.boolean() }),
  z.object({ id: Uuid, type: z.literal('not_after'), setup_id: Uuid, at_utc: IsoTime, confirmed: z.boolean() }),
  z.object({
    id: Uuid,
    type: z.literal('locked_block'),
    setup_id: Uuid,
    start_utc: IsoTime,
    end_utc: IsoTime,
    confirmed: z.boolean(),
  }),
]);
export type Constraint = z.infer<typeof Constraint>;

export const BlockKind = z.enum(['setup', 'shoot', 'reset', 'buffer']);
export type BlockKind = z.infer<typeof BlockKind>;

export const ScheduleBlock = z.object({
  id: z.string(),
  kind: BlockKind,
  setup_id: Uuid.nullable(),
  shot_ids: z.array(Uuid),
  resource_ids: z.array(Uuid),
  start_utc: IsoTime,
  end_utc: IsoTime,
  locked: z.boolean(),
});
export type ScheduleBlock = z.infer<typeof ScheduleBlock>;

export const PlanOutcome = z.enum(['needs_input', 'feasible', 'partial', 'search_incomplete', 'proven_infeasible']);
export type PlanOutcome = z.infer<typeof PlanOutcome>;

export const PlanStatus = z.enum(['draft', 'approved']);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const ViolationCode = z.enum([
  'RESOURCE_OVERLAP',
  'OUTSIDE_WINDOW',
  'PRECEDENCE',
  'NOT_BEFORE',
  'NOT_AFTER',
  'LOCKED_BLOCK_MOVED',
  'UNPLACED_REQUIRED',
  'CREW_OVERLAP',
  'ESTIMATE_UNCONFIRMED',
  'MISSING_INPUT',
]);
export type ViolationCode = z.infer<typeof ViolationCode>;

export const Violation = z.object({
  code: ViolationCode,
  message: z.string(),
  block_id: z.string().nullable(),
  setup_id: Uuid.nullable(),
  resource_id: Uuid.nullable(),
  shot_id: Uuid.nullable(),
});
export type Violation = z.infer<typeof Violation>;

/** Verifiable evidence for proven_infeasible (explicit contradictions only). */
export const Contradiction = z.object({
  code: z.enum(['NO_WINDOW', 'BLOCK_EXCEEDS_WINDOWS', 'PRECEDENCE_CYCLE', 'LOCKED_CONFLICT']),
  message: z.string(),
  setup_ids: z.array(Uuid),
  resource_ids: z.array(Uuid),
});
export type Contradiction = z.infer<typeof Contradiction>;

export const Unplaced = z.object({
  setup_id: Uuid,
  reason: z.string(),
});
export type Unplaced = z.infer<typeof Unplaced>;

/** Pure scheduler result from core/schedule. */
export const ScheduleResult = z.object({
  outcome: PlanOutcome,
  order: z.array(Uuid),
  blocks: z.array(ScheduleBlock),
  unplaced: z.array(Unplaced),
  contradictions: z.array(Contradiction),
  violations: z.array(Violation),
  algorithm_version: z.string(),
  validator_version: z.string(),
});
export type ScheduleResult = z.infer<typeof ScheduleResult>;

export const Plan = z.object({
  id: Uuid,
  /** local shooting date YYYY-MM-DD in `timezone` */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string(),
  day_start_utc: IsoTime,
  result: ScheduleResult,
  input_hash: z.string(),
  status: PlanStatus,
  revision: z.number().int().nonnegative(),
  created_at: IsoTime,
  updated_at: IsoTime,
});
export type Plan = z.infer<typeof Plan>;
