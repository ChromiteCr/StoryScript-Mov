import { assertJobQuota } from '../quota.ts';
import { randomUUID } from 'node:crypto';
import { OrderSuggestionOutput, type DraftIssue, type Job, type Plan } from '@storyscript/contracts';
import {
  buildOrderMessages,
  contentHash,
  ORDER_PROMPT_VERSION,
  planInputHash,
  utcToLocal,
  ZH_SHOT_SIZE,
  type OrderPromptSetup,
  type ScheduleInput,
} from '@storyscript/core';
import { MAX_ATTEMPTS, usageRecord } from '../../ai/jobs.ts';
import { projectContext, resolveAi } from '../../ai/runtime.ts';
import { orderReplayKey } from '../../adapters/llm/replay-chat.ts';
import { structuredCall } from '../../adapters/llm/structured.ts';
import type { DbPort } from '../../db/port.ts';
import { insertDraft } from '../../db/repos/draft.ts';
import { listActiveShots } from '../../db/repos/shot.ts';
import type { AppDeps } from '../../deps.ts';
import { AppError } from '../../http/errors.ts';
import { currentInput, requirePlan, type OrderDraftParsed } from './plans.ts';

/**
 * LLM shooting-order suggestion (FR-06): the model only returns an order of
 * setup keys (u1, u2 …) and a rationale. The result lands in shot_draft
 * (kind 'order', INV-03) with the keys mapped back to setup ids; adopting it
 * goes through reorderSchedule + validate like any manual order.
 *
 * Remote job, idempotency key = plan id + current input hash. Without a text
 * model the route answers PROVIDER_NOT_CONFIGURED before anything is sent.
 */

const DEMO_MISS = '演示模式没有这份计划的排序建议录制，演示模式不会外发请求。配置文本模型后再试，或直接用上移/下移调整拍摄顺序';

interface PromptContext {
  messages: ReturnType<typeof buildOrderMessages>;
  keys: Map<string, string>;
  replayKey: string;
}

const hhmm = (iso: string, plan: Plan) => {
  const l = utcToLocal(iso, plan.timezone);
  return l.date === plan.date ? l.time : l.date > plan.date ? `次日 ${l.time}` : `${l.date} ${l.time}`;
};

/** Active setups (≥1 non-waived shot) in the plan's current order, keyed u1 … uN. */
export function orderPromptContext(db: DbPort, plan: Plan, input: ScheduleInput): PromptContext {
  const shotInfo = new Map(listActiveShots(db).map((s) => [s.id, s] as const));
  const sched = new Map(input.shots.map((s) => [s.id, s] as const));
  const resources = new Map(input.resources.map((r) => [r.id, r] as const));
  const active = input.setups.filter((s) => s.shot_ids.some((id) => sched.get(id) && sched.get(id)!.required_status !== 'waived'));
  const rank = new Map(plan.result.order.map((id, i) => [id, i] as const));
  active.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));

  const keys = new Map<string, string>();
  const keyOf = new Map<string, string>();
  const used = new Set<string>();
  const setups: OrderPromptSetup[] = active.map((s, i) => {
    const key = `u${i + 1}`;
    keys.set(key, s.id);
    keyOf.set(s.id, key);
    const shots = s.shot_ids.filter((id) => sched.get(id)?.required_status !== 'waived');
    const performers = [...new Set(shots.flatMap((id) => sched.get(id)?.performer_ids ?? []))];
    for (const rid of [...performers, ...(s.location_resource_id ? [s.location_resource_id] : []), ...s.resource_ids]) used.add(rid);
    return {
      key,
      label: s.label,
      location: s.location_resource_id ? (resources.get(s.location_resource_id)?.name ?? null) : null,
      shot_summaries: shots.map((id) => {
        const shot = shotInfo.get(id);
        return shot ? `${shot.code} ${ZH_SHOT_SIZE[shot.fields.shot_size]}：${shot.fields.action.slice(0, 40)}` : id;
      }),
      performers: performers.map((rid) => resources.get(rid)?.name ?? rid),
      total_minutes: s.durations.setup_min + s.durations.per_shot_min * shots.length + s.durations.reset_min,
    };
  });

  const availability = [`剧组：${hhmm(input.crew_window.start_utc, plan)}–${hhmm(input.crew_window.end_utc, plan)}`];
  for (const r of input.resources) {
    if (!used.has(r.id)) continue;
    const spans = r.windows.map((w) => `${hhmm(w.start_utc, plan)}–${hhmm(w.end_utc, plan)}`);
    availability.push(`${r.name}：${spans.join('、') || '当天没有可用时间'}`);
  }

  const constraints: string[] = [];
  for (const c of input.constraints) {
    if (c.type === 'before') {
      const a = keyOf.get(c.a_setup_id);
      const b = keyOf.get(c.b_setup_id);
      if (a && b) constraints.push(`${a} 必须在 ${b} 开始前拍完`);
    } else {
      const k = keyOf.get(c.setup_id);
      if (!k) continue;
      if (c.type === 'not_before') constraints.push(`${k} 不早于 ${hhmm(c.at_utc, plan)} 开始`);
      else if (c.type === 'not_after') constraints.push(`${k} 须在 ${hhmm(c.at_utc, plan)} 前结束`);
      else constraints.push(`${k} 锁定在 ${hhmm(c.start_utc, plan)}–${hhmm(c.end_utc, plan)}`);
    }
  }

  const messages = buildOrderMessages({ date: plan.date, timezone: plan.timezone, setups, availability, constraints });
  return { messages, keys, replayKey: orderReplayKey(setups) };
}

/** Lenient pre-normalisation: keys trimmed and lower-cased, a missing rationale becomes "". */
function normalizeOrderJson(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(o.setup_order)) o.setup_order = o.setup_order.map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : k));
  if (o.rationale === undefined || o.rationale === null) o.rationale = '';
  return o;
}

/** Business validation: every key exactly once, nothing else. */
export function checkOrderKeys(order: readonly string[], keys: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const k of order) {
    if (!keys.has(k)) errors.push(`setup_order 里的 "${k}" 不是输入中的 setup key`);
    else if (seen.has(k)) errors.push(`setup_order 里 "${k}" 出现了不止一次`);
    seen.add(k);
  }
  const missing = [...keys].filter((k) => !seen.has(k));
  if (missing.length > 0) errors.push(`setup_order 缺少：${missing.join(', ')}（必须恰好包含每个 key 各一次）`);
  return errors;
}

export function startOrderSuggestion(deps: AppDeps, planId: string): Job {
  const { project, jobs } = projectContext(deps);
  const db = project.db;
  const plan = requirePlan(db, planId);
  const ai = resolveAi(deps);
  const input = currentInput(db, plan);
  const ctx = orderPromptContext(db, plan, input);
  if (ctx.keys.size < 2) {
    throw new AppError('VALIDATION_ERROR', `只有 ${ctx.keys.size} 个需要拍摄的 setup，没有可排的顺序`, 409);
  }
  const inputHash = planInputHash(input);
  const keySet = new Set(ctx.keys.keys());
  if (ai.remote) assertJobQuota(deps, db, 'llm');
  return jobs.enqueue({
    kind: 'suggest_order',
    idempotency_key: `suggest_order:${plan.id}:${inputHash}`,
    input_hash: contentHash({ prompt_version: ORDER_PROMPT_VERSION, messages: ctx.messages }),
    remote: ai.remote,
    lane: 'llm',
    run: async (run) => {
      const res = await structuredCall({
        client: ai.cfg,
        chat: ai.chat,
        capabilityCache: ai.capabilityCache,
        maxAttempts: MAX_ATTEMPTS,
        sleep: ai.sleep,
        backoffMs: ai.backoffMs,
        messages: ctx.messages,
        schema: OrderSuggestionOutput,
        jsonSchemaName: 'order_suggestion',
        preprocess: normalizeOrderJson,
        validate: (p) => {
          const errors = checkOrderKeys(p.setup_order, keySet);
          return { ok: errors.length === 0, errors };
        },
        signal: run.signal,
        meta: { prompt_version: ORDER_PROMPT_VERSION, replay_key: ctx.replayKey },
        onAttempt: run.markSent,
      });
      const error = res.error
        ? { code: res.error.code, message: deps.demo && res.error.code === 'PROVIDER_ERROR' ? DEMO_MISS : res.error.message }
        : null;
      const parsed: OrderDraftParsed | null = res.value
        ? { setup_order: res.value.setup_order.map((k) => ctx.keys.get(k)!), rationale: res.value.rationale.trim() }
        : null;
      const issues: DraftIssue[] = [];
      if (!parsed && res.last_errors) {
        for (const message of res.last_errors) issues.push({ level: 'error', code: 'order_keys', message, item: null });
      }
      if (error && error.code !== 'CANCELLED') issues.push({ level: 'error', code: error.code, message: error.message, item: null });
      const usage = usageRecord(res.usage);
      return {
        status: parsed ? 'succeeded' : 'failed',
        attempts: res.attempts,
        usage,
        error,
        commit: () => {
          const id = randomUUID();
          insertDraft(db, {
            id,
            kind: 'order',
            scope: { plan_id: plan.id, input_hash: inputHash, plan_revision: plan.revision },
            model: ai.cfg.model,
            prompt_version: ORDER_PROMPT_VERSION,
            raw_output: res.raw_outputs.at(-1) ?? null,
            parsed,
            issues,
            attempts: res.attempts,
            usage,
            status: parsed ? 'pending' : 'failed',
            created_at: new Date().toISOString(),
          });
          return id;
        },
      };
    },
  });
}
