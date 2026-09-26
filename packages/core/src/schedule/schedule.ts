import type { ScheduleResult, Uuid, Violation } from '@storyscript/contracts';
import { contentHash } from '../util/hash.ts';
import { findContradictions } from './contradictions.ts';
import { greedy } from './greedy.ts';
import { resolveOrder } from './group.ts';
import { analyze, normalizeScheduleInput } from './model.ts';
import { type ScheduleInput, SCHEDULE_ALGORITHM_VERSION, SCHEDULE_VALIDATOR_VERSION } from './types.ts';
import { approvalBlockers, validate } from './validate.ts';

const versions = { algorithm_version: SCHEDULE_ALGORITHM_VERSION, validator_version: SCHEDULE_VALIDATOR_VERSION };

/**
 * Plans one shooting day (SPEC FR-06). Pipeline:
 *   normalise → explicit contradictions (→ proven_infeasible, with evidence)
 *   → missing data (→ needs_input) → group/order → greedy → independent validate.
 * `feasible` only when every active setup is placed and validate finds
 * nothing; a heuristic miss is `partial` with reasons, never "infeasible".
 * Deterministic: the result depends only on the normalised input.
 */
export function schedule(input: ScheduleInput): ScheduleResult {
  const norm = normalizeScheduleInput(input);
  const model = analyze(norm);
  const order = resolveOrder(model, norm.order_override);

  const contradictions = findContradictions(model);
  if (contradictions.length > 0) {
    return { outcome: 'proven_infeasible', order, blocks: [], unplaced: [], contradictions, violations: model.issues, ...versions };
  }
  if (model.issues.length > 0) {
    return { outcome: 'needs_input', order, blocks: [], unplaced: [], contradictions: [], violations: model.issues, ...versions };
  }

  const g = greedy(model, order);
  const violations = validate(norm, g.blocks);
  const outcome = g.unplaced.length === 0 && violations.length === 0 ? 'feasible' : 'partial';
  return { outcome, order: g.order, blocks: g.blocks, unplaced: g.unplaced, contradictions: [], violations, ...versions };
}

/**
 * Re-plans with an explicit setup order and re-validates (manual move
 * up/down, adopting an LLM order suggestion). Unknown or duplicate ids are
 * ignored; active setups missing from `order` are appended in default order.
 */
export function reorder(input: ScheduleInput, order: readonly Uuid[]): ScheduleResult {
  return schedule({ ...input, order_override: order });
}

/**
 * Placement only, skipping the contradiction and missing-data gates. For
 * tests and diagnostics; production callers use `schedule`.
 */
export function greedySchedule(input: ScheduleInput, order?: readonly Uuid[]): Pick<ScheduleResult, 'order' | 'blocks' | 'unplaced'> {
  const norm = normalizeScheduleInput(input);
  const model = analyze(norm);
  return greedy(model, resolveOrder(model, order ?? norm.order_override));
}

/** Hash of everything a plan depends on (stale detection); array order-insensitive. */
export function planInputHash(input: ScheduleInput): string {
  return contentHash({ ...versions, input: normalizeScheduleInput(input) });
}

export interface ApprovalCheck {
  ok: boolean;
  /** input changed since the plan was computed, or planner/validator versions differ */
  stale: boolean;
  outcome_ok: boolean;
  blockers: Violation[];
}

/**
 * INV-05 gate: a plan can be approved only when its outcome is `feasible`,
 * the validator finds nothing, every estimate/resource is confirmed and it
 * is not stale against `basisHash` (the planInputHash stored with the plan).
 */
export function canApprovePlan(input: ScheduleInput, result: ScheduleResult, basisHash: string): ApprovalCheck {
  const stale =
    basisHash !== planInputHash(input) ||
    result.algorithm_version !== SCHEDULE_ALGORITHM_VERSION ||
    result.validator_version !== SCHEDULE_VALIDATOR_VERSION;
  const outcomeOk = result.outcome === 'feasible';
  const blockers = approvalBlockers(input, result);
  return { ok: outcomeOk && !stale && blockers.length === 0, stale, outcome_ok: outcomeOk, blockers };
}
