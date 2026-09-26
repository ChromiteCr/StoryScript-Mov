import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AdoptSuggestionInput, CreatePlanInput, Plan, PlanDetail, PlanRevisionInput, ReorderPlanInput, Uuid } from '@storyscript/contracts';
import { canApprovePlan, localWindowToUtc, planInputHash, reorderSchedule, schedule, type ScheduleInput } from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import { getDraft, setDraftStatus } from '../../db/repos/draft.ts';
import { getPlan, insertPlan, readPlanMeta, updatePlanRow, writePlanMeta, type PlanMeta } from '../../db/repos/plan.ts';
import { getProject } from '../../db/repos/project.ts';
import { AppError } from '../../http/errors.ts';
import { buildScheduleInput } from './input.ts';

/**
 * Shooting-day plans (FR-06, INV-01, INV-05).
 *
 *   create     schedule(input) from current data; input_hash = planInputHash(input)
 *   get        rebuild input from current data → stale / approval (canApprovePlan)
 *   recompute  schedule again from current data; a hand-set order is kept as
 *              order_override, an automatic one is re-planned
 *   reorder    reorderSchedule(input, order) — validated like everything else
 *   approve    only when canApprovePlan passes (409 with blockers otherwise)
 *
 * Every write checks expected_revision (409), bumps the revision and resets
 * the status to draft except approve. Nothing here reads or writes
 * shot.narrative_pos (INV-01): shooting order lives only in plan.result.
 */

type Input<S extends z.ZodType> = z.infer<S>;

export const OrderDraftParsed = z.object({
  setup_order: z.array(z.uuid()),
  rationale: z.string(),
});
export type OrderDraftParsed = z.infer<typeof OrderDraftParsed>;

export const OrderDraftScope = z.object({ plan_id: z.uuid(), input_hash: z.string() });

export function requirePlan(db: DbPort, id: string): Plan {
  const p = getPlan(db, id);
  if (!p) throw new AppError('NOT_FOUND', '计划不存在', 404);
  return p;
}

function checkRevision(plan: Plan, expected: number): void {
  if (plan.revision !== expected) {
    throw new AppError('REVISION_CONFLICT', '计划已被修改，请刷新后再试', 409, {
      plan_id: plan.id,
      expected_revision: expected,
      current_revision: plan.revision,
    });
  }
}

/** Crew window of a plan; plans without meta (should not happen) get a 12 h day from call. */
export function planMeta(db: DbPort, plan: Plan): PlanMeta {
  const meta = readPlanMeta(db, plan.id);
  if (meta) return meta;
  const start = plan.day_start_utc;
  const end = new Date(Date.parse(start) + 12 * 3_600_000).toISOString();
  return { crew_call: '', crew_wrap: '', crew_window: { start_utc: start, end_utc: end }, order_manual: false };
}

/** The plan's ScheduleInput rebuilt from the current database contents. */
export function currentInput(db: DbPort, plan: Plan): ScheduleInput {
  return buildScheduleInput(db, { date: plan.date, timezone: plan.timezone, crew_window: planMeta(db, plan).crew_window });
}

export function planDetail(db: DbPort, plan: Plan): PlanDetail {
  const check = canApprovePlan(currentInput(db, plan), plan.result, plan.input_hash);
  return { plan, stale: check.stale, approval: { ok: check.ok, blockers: check.blockers } };
}

export function getPlanDetail(db: DbPort, id: string): PlanDetail {
  return planDetail(db, requirePlan(db, id));
}

export function createPlan(db: DbPort, input: Input<typeof CreatePlanInput>, now = new Date().toISOString()): PlanDetail {
  return db.tx(() => {
    const project = getProject(db);
    if (!project) throw new AppError('INTERNAL', '项目数据库缺少 project 记录', 500);
    let crew;
    try {
      crew = localWindowToUtc(input.date, input.crew_call, input.crew_wrap, project.timezone);
    } catch (err) {
      throw new AppError('VALIDATION_ERROR', `日期或时间无效：${err instanceof Error ? err.message : String(err)}`, 400);
    }
    const sched = buildScheduleInput(db, { date: input.date, timezone: project.timezone, crew_window: crew });
    const plan: Plan = {
      id: randomUUID(),
      date: input.date,
      timezone: project.timezone,
      day_start_utc: crew.start_utc,
      result: schedule(sched),
      input_hash: planInputHash(sched),
      status: 'draft',
      revision: 0,
      created_at: now,
      updated_at: now,
    };
    insertPlan(db, plan);
    writePlanMeta(db, plan.id, { crew_call: input.crew_call, crew_wrap: input.crew_wrap, crew_window: crew, order_manual: false }, now);
    return planDetail(db, plan);
  });
}

/** Store a new result computed from the current input (revision + 1, back to draft). */
function storeResult(db: DbPort, plan: Plan, input: ScheduleInput, order: readonly Uuid[] | null, now: string): PlanDetail {
  const result = order ? reorderSchedule(input, order) : schedule(input);
  const next: Plan = { ...plan, result, input_hash: planInputHash(input), status: 'draft', revision: plan.revision + 1, updated_at: now };
  updatePlanRow(db, next);
  const meta = planMeta(db, plan);
  const manual = order !== null;
  if (meta.order_manual !== manual) writePlanMeta(db, plan.id, { ...meta, order_manual: manual }, now);
  return planDetail(db, next);
}

export function recomputePlan(db: DbPort, id: string, input: Input<typeof PlanRevisionInput>, now = new Date().toISOString()): PlanDetail {
  return db.tx(() => {
    const plan = requirePlan(db, id);
    checkRevision(plan, input.expected_revision);
    const meta = planMeta(db, plan);
    return storeResult(db, plan, currentInput(db, plan), meta.order_manual ? plan.result.order : null, now);
  });
}

export function reorderPlan(db: DbPort, id: string, input: Input<typeof ReorderPlanInput>, now = new Date().toISOString()): PlanDetail {
  return db.tx(() => {
    const plan = requirePlan(db, id);
    checkRevision(plan, input.expected_revision);
    return storeResult(db, plan, currentInput(db, plan), input.order, now);
  });
}

export function approvePlan(db: DbPort, id: string, input: Input<typeof PlanRevisionInput>, now = new Date().toISOString()): PlanDetail {
  return db.tx(() => {
    const plan = requirePlan(db, id);
    checkRevision(plan, input.expected_revision);
    const check = canApprovePlan(currentInput(db, plan), plan.result, plan.input_hash);
    if (!check.ok) {
      const why = check.stale
        ? '输入在计算后发生了变化，请先重新计算'
        : !check.outcome_ok
          ? '计划不是"可行"状态'
          : `还有 ${check.blockers.length} 项未解决`;
      throw new AppError('VALIDATION_ERROR', `计划还不能批准：${why}`, 409, {
        stale: check.stale,
        outcome: plan.result.outcome,
        blockers: check.blockers,
      });
    }
    const next: Plan = { ...plan, status: 'approved', revision: plan.revision + 1, updated_at: now };
    updatePlanRow(db, next);
    return planDetail(db, next);
  });
}

export function adoptSuggestion(db: DbPort, id: string, input: Input<typeof AdoptSuggestionInput>, now = new Date().toISOString()): PlanDetail {
  return db.tx(() => {
    const plan = requirePlan(db, id);
    checkRevision(plan, input.expected_revision);
    const draft = getDraft(db, input.draft_id);
    if (!draft || draft.kind !== 'order') throw new AppError('NOT_FOUND', '排序建议不存在', 404);
    const scope = OrderDraftScope.safeParse(draft.scope);
    if (!scope.success || scope.data.plan_id !== plan.id) throw new AppError('VALIDATION_ERROR', '这条排序建议不属于当前计划', 400);
    if (draft.status !== 'pending') throw new AppError('VALIDATION_ERROR', `排序建议状态为 ${draft.status}，不能采纳`, 409);
    const parsed = OrderDraftParsed.safeParse(draft.parsed);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '排序建议没有可用的顺序', 409);
    const detail = storeResult(db, plan, currentInput(db, plan), parsed.data.setup_order, now);
    setDraftStatus(db, draft.id, 'applied');
    return detail;
  });
}
