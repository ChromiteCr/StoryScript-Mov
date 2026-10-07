import { randomUUID } from 'node:crypto';
import { ScriptCheckOutput, type DraftIssue, type Job } from '@storyscript/contracts';
import {
  buildScriptCheckMessages,
  contentHash,
  finalizeScriptCheck,
  normalizeScriptCheckJson,
  sameRisk,
  SCRIPT_CHECK_PROMPT_VERSION,
  validateScriptCheck,
} from '@storyscript/core';
import { scriptReplayKey } from '../adapters/llm/replay-chat.ts';
import { structuredCall } from '../adapters/llm/structured.ts';
import { insertCheck, latestCheck, listRisks } from '../db/repos/check.ts';
import { latestScriptVersion } from '../db/repos/script.ts';
import type { DbPort } from '../db/port.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import type { JobRunResult } from '../jobs/queue.ts';
import { assertJobQuota } from '../services/quota.ts';
import { callOptions, errorIssue, usageRecord } from './jobs.ts';
import { projectContext, resolveAi } from './runtime.ts';

/**
 * S5 剧本体检: one remote job sends the whole current script to the model the
 * member uses (at most 3 requests, counted against the group's daily cap)
 * and keeps the difficulties whose quotes are in the script. They are hints:
 * nothing is applied to the script or the shots. A tick on a difficulty
 * carries over to the same difficulty in the next check.
 */

/** Repair messages sent back in one round are kept short. */
const REPAIR_ERRORS_MAX = 12;

export function startScriptCheck(deps: AppDeps): Job {
  const { project, jobs } = projectContext(deps);
  const db = project.db;
  const ai = resolveAi(deps);
  const version = latestScriptVersion(db);
  if (!version) throw new AppError('VALIDATION_ERROR', '请先导入剧本', 409);
  if (!version.paragraphs.some((p) => p.scene_idx !== null && !p.is_heading)) {
    throw new AppError('VALIDATION_ERROR', '当前剧本没有场次内容，无法体检：重新导入时在预览里把场次标题行标为「场」', 409);
  }
  const messages = buildScriptCheckMessages({ paragraphs: version.paragraphs });
  if (ai.remote) assertJobQuota(deps, db, 'llm');
  return jobs.enqueue({
    kind: 'check_script',
    model_source: ai.source,
    idempotency_key: `check_script:${version.id}`,
    input_hash: contentHash({ prompt_version: SCRIPT_CHECK_PROMPT_VERSION, messages }),
    remote: ai.remote,
    lane: 'llm',
    run: async (ctx): Promise<JobRunResult> => {
      const res = await structuredCall({
        ...callOptions(ai),
        messages,
        schema: ScriptCheckOutput,
        jsonSchemaName: 'script_check',
        preprocess: normalizeScriptCheckJson,
        validate: (p) => {
          const errors = validateScriptCheck(p, version.paragraphs).errors;
          return { ok: errors.length === 0, errors: errors.slice(0, REPAIR_ERRORS_MAX) };
        },
        signal: ctx.signal,
        meta: { prompt_version: SCRIPT_CHECK_PROMPT_VERSION, replay_key: scriptReplayKey(version.paragraphs) },
        onAttempt: ctx.markSent,
      });
      const usage = usageRecord(res.usage);
      const parsed = res.value ?? res.last_parsed ?? null;
      if (!parsed) {
        return { status: 'failed', attempts: res.attempts, usage, error: res.error ? { code: res.error.code, message: res.error.message } : null };
      }
      const fin = finalizeScriptCheck(parsed, version.paragraphs);
      const issues: DraftIssue[] = [];
      if (fin.dropped) issues.push({ level: 'warning', code: 'quote_not_found', message: `有 ${fin.dropped} 条难点的引用在剧本里找不到，已略去`, item: null });
      if (fin.truncated) issues.push({ level: 'warning', code: 'text_truncated', message: `有 ${fin.truncated} 条难点的说明过长，已截短`, item: null });
      if (fin.capped) issues.push({ level: 'warning', code: 'too_many', message: `难点太多，每场只保留最严重的 4 条（略去 ${fin.capped} 条）`, item: null });
      // a usable answer is kept even when the rounds ran out; the error stays on the check as a note
      const partial = res.value === undefined;
      if (partial) issues.push(...errorIssue(res).map((i) => ({ ...i, level: 'warning' as const })));
      const raw = res.value_raw ?? res.raw_outputs.at(-1) ?? null;
      return {
        status: 'succeeded',
        attempts: res.attempts,
        usage,
        error: null,
        commit: () => commitCheck(db, {
          job_id: ctx.job_id,
          script_version_id: version.id,
          model: ai.cfg.model,
          raw,
          issues,
          attempts: res.attempts,
          usage,
          partial,
          items: fin.items,
        }),
      };
    },
  });
}

function commitCheck(
  db: DbPort,
  c: {
    job_id: string;
    script_version_id: string;
    model: string;
    raw: string | null;
    issues: DraftIssue[];
    attempts: number;
    usage: Record<string, number>;
    partial: boolean;
    items: ReturnType<typeof finalizeScriptCheck>['items'];
  },
): string {
  // ticks carry over from the previous check to the same difficulty
  const prev = latestCheck(db);
  const handled = prev ? listRisks(db, prev.id).filter((r) => r.handled_at) : [];
  const id = randomUUID();
  insertCheck(db, {
    id,
    script_version_id: c.script_version_id,
    job_id: c.job_id,
    model: c.model,
    prompt_version: SCRIPT_CHECK_PROMPT_VERSION,
    raw_output: c.raw,
    issues: c.issues,
    attempts: c.attempts,
    usage: c.usage,
    status: c.partial ? 'partial' : 'done',
    created_at: new Date().toISOString(),
    risks: c.items.map((item) => {
      const was = handled.find((h) => sameRisk(h, item));
      return { ...item, id: randomUUID(), handled_at: was?.handled_at ?? null, handled_by: was?.handled_by ?? null };
    }),
  });
  return id;
}
