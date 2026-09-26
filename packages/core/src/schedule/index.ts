// Public surface of core/schedule. Generic names are re-exported with a
// schedule-specific prefix so the package root never collides with other modules.
export type { ScheduleInput, ScheduleShot } from './types.ts';
export { SCHEDULE_ALGORITHM_VERSION, SCHEDULE_VALIDATOR_VERSION } from './types.ts';
export {
  schedule,
  reorder as reorderSchedule,
  greedySchedule,
  planInputHash,
  canApprovePlan,
  type ApprovalCheck,
} from './schedule.ts';
export { validate as validateSchedule, approvalBlockers } from './validate.ts';
export { normalizeScheduleInput } from './model.ts';
export {
  localToUtc,
  localWindowToUtc,
  utcToLocal,
  isValidTimeZone,
  tzOffsetMs,
  overlaps as intervalOverlaps,
  contains as intervalContains,
  minutes as intervalMinutes,
  type Interval as MsInterval,
} from './time.ts';
