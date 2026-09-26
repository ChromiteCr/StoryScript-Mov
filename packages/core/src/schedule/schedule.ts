import type { ScheduleResult, Uuid, Violation } from '@storyscript/contracts';
import { contentHash } from '../util/hash.ts';
import { findContradictions } from './contradictions.ts';
import { greedy } from './greedy.ts';
import { candidateOrders, resolveOrder } from './group.ts';
import { analyze, normalizeScheduleInput } from './model.ts';
import { type ScheduleInput, SCHEDULE_ALGORITHM_VERSION, SCHEDULE_VALIDATOR_VERSION } from './types.ts';
import { approvalBlockers, validate } from './validate.ts';

const versions = { algorithm_version: SCHEDULE_ALGORITHM_VERSION, validator_version: SCHEDULE_VALIDATOR_VERSION };

/**
 * Plans one shooting day (SPEC FR-06). Pipeline:
 *   normalise → explicit contradictions (→ proven_infeasible, with evidence)
 *   → missing data (→ needs_input) → multi-start greedy → independent validate.
 * Without an explicit order, greedy runs from a few deterministic starting
 * orders (group.ts candidateOrders) in append and backfill modes, and for
 * days with ≤ 6 setups over every setup order; the best placement wins.
 * `feasible` when validate finds nothing — every required setup placed and no
 * hard violation; optional setups that do not fit stay listed in `unplaced`
 * (SPEC: 必拍项已排). A heuristic miss on required work is `partial` with
 * reasons, never "infeasible".
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

  // An explicit order (manual move, adopted suggestion) is kept strictly.
  // Otherwise: a few heuristic starting orders × {append, backfill}, plus —
  // for small days — every setup order, and the best-scoring placement wins.
  const runs: { order: Uuid[]; backfill: boolean }[] = [];
  if (norm.order_override) runs.push({ order, backfill: false });
  else {
    for (const o of candidateOrders(model)) runs.push({ order: o, backfill: false }, { order: o, backfill: true });
    if (model.setups.length <= EXHAUSTIVE_MAX) for (const o of permutations(model.setups.map((s) => s.id))) runs.push({ order: o, backfill: false });
  }
  let best: { g: ReturnType<typeof greedy>; score: number[] } | null = null;
  for (const r of runs) {
    const g = greedy(model, r.order, { backfill: r.backfill });
    const score = scorePlacement(model, g);
    if (!best || lexLess(score, best.score)) best = { g, score };
  }
  const { g } = best!;
  const violations = validate(norm, g.blocks);
  const outcome = violations.length === 0 ? 'feasible' : 'partial';
  return { outcome, order: g.order, blocks: g.blocks, unplaced: g.unplaced, contradictions: [], violations, ...versions };
}

/** Days with at most this many active setups are also searched over every setup order (6! = 720 greedy runs). */
const EXHAUSTIVE_MAX = 6;

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i]!, ...p];
  }
}

/**
 * Lower is better: required misses, all misses, location changes, day end.
 * Greedy placements never violate hard constraints (validate is run once on
 * the winner), so scoring skips validation to keep the search cheap.
 */
function scorePlacement(model: ReturnType<typeof analyze>, g: ReturnType<typeof greedy>): number[] {
  const requiredMisses = g.unplaced.filter((u) => model.byId.get(u.setup_id)?.required).length;
  let moves = 0;
  let prev: string | null | undefined;
  for (const id of g.order) {
    if (g.unplaced.some((u) => u.setup_id === id)) continue;
    const loc = model.byId.get(id)?.location ?? null;
    if (prev !== undefined && loc !== prev) moves++;
    prev = loc;
  }
  const dayEnd = g.blocks.reduce((m, b) => Math.max(m, Date.parse(b.end_utc)), 0);
  return [requiredMisses, g.unplaced.length, moves, dayEnd];
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
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
