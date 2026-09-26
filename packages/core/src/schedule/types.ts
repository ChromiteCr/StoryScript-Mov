import type { Constraint, RequiredStatus, Resource, Setup, TimeWindow, Uuid } from '@storyscript/contracts';

/** Stamped into every ScheduleResult; bump when placement behaviour changes. */
export const SCHEDULE_ALGORITHM_VERSION = 'greedy-multistart-3';
/** Stamped into every ScheduleResult; bump when validation rules change. */
export const SCHEDULE_VALIDATOR_VERSION = 'validate-2';

/**
 * The scheduler's view of a shot. Deliberately minimal: there is no
 * narrative order here (INV-01), so scheduling cannot read or write it.
 * `performer_ids` is resolved by the caller from the casting map
 * (character → performer resource).
 */
export interface ScheduleShot {
  id: Uuid;
  required_status: RequiredStatus;
  performer_ids: readonly Uuid[];
}

/**
 * Pure input for one shooting day, single crew (SPEC FR-06).
 * All instants are UTC ISO strings; local wall-clock input is converted with
 * `localToUtc` / `localWindowToUtc` before it gets here.
 */
export interface ScheduleInput {
  /** local shooting date YYYY-MM-DD in `timezone` */
  date: string;
  /** IANA zone, used for human-readable reasons only */
  timezone: string;
  /** the crew's working window; every block must sit inside it */
  crew_window: TimeWindow;
  setups: readonly Setup[];
  resources: readonly Resource[];
  shots: readonly ScheduleShot[];
  /** only `confirmed` constraints take part in planning and validation */
  constraints: readonly Constraint[];
  /** explicit setup order (manual move up/down, adopted LLM suggestion) */
  order_override?: readonly Uuid[];
}
