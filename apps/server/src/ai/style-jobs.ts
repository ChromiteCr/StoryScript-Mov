import { StyleResearchOutput, type DraftIssue, type Job, type StyleResearchInput } from '@storyscript/contracts';
import { buildStyleResearchMessages, contentHash, STYLE_RESEARCH_PROMPT_VERSION, validateStyleResearch } from '@storyscript/core';
import { structuredCall } from '../adapters/llm/structured.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { assertJobQuota } from '../services/quota.ts';
import type { StyleDraftScope } from '../services/styles.ts';
import { callOptions, errorIssue, outcome } from './jobs.ts';
import { projectContext, resolveAi } from './runtime.ts';

/**
 * S3 style research: one remote job that asks the group's own model (or its
 * research model, with the service's web search when turned on) to describe
 * a style the user names as general techniques. At most 3 outbound requests,
 * counted against the group's daily text-model cap; the result is a draft
 * the user reviews and saves as an unverified card.
 */

function normalizeResearch(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  for (const k of ['shot_size_bias', 'angle_bias', 'lens_bias', 'movement_bias', 'caveats']) if (o[k] == null) o[k] = [];
  for (const k of ['gear', 'low_budget', 'summary']) if (o[k] == null) o[k] = '';
  if (typeof o.confidence === 'string') o.confidence = o.confidence.toLowerCase();
  for (const k of ['shot_size_bias']) if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).map((v) => (typeof v === 'string' ? v.toUpperCase() : v));
  for (const k of ['angle_bias', 'lens_bias', 'movement_bias']) if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).map((v) => (typeof v === 'string' ? v.toLowerCase() : v));
  return o;
}

export function startStyleResearch(deps: AppDeps, input: StyleResearchInput): Job {
  if (deps.demo) throw new AppError('VALIDATION_ERROR', '演示模式不连接模型，不能研究新风格。可以先用内置风格卡。', 409);
  const { project, jobs } = projectContext(deps);
  const db = project.db;
  const ai = resolveAi(deps);
  const messages = buildStyleResearchMessages(input);
  const scope: StyleDraftScope = { reference: input.reference, notes: input.notes };
  if (ai.remote) assertJobQuota(deps, db, 'llm');
  const research = ai.research;
  return jobs.enqueue({
    kind: 'research_style',
    idempotency_key: `research_style:${contentHash(input)}`,
    input_hash: contentHash({ prompt_version: STYLE_RESEARCH_PROMPT_VERSION, messages, model: research.cfg.model, search: research.extraBody !== null }),
    remote: ai.remote,
    lane: 'llm',
    run: async (ctx) => {
      const res = await structuredCall({
        ...callOptions(ai),
        client: research.cfg,
        chat: research.chat,
        extraBody: research.extraBody,
        messages,
        schema: StyleResearchOutput,
        jsonSchemaName: 'style_card',
        preprocess: normalizeResearch,
        validate: (p) => {
          const v = validateStyleResearch(p);
          return { ok: v.ok, errors: v.errors };
        },
        signal: ctx.signal,
        meta: { prompt_version: STYLE_RESEARCH_PROMPT_VERSION },
        onAttempt: ctx.markSent,
      });
      const parsed = res.value ?? res.last_parsed ?? null;
      const issues: DraftIssue[] = [];
      if (parsed) {
        const v = validateStyleResearch(parsed);
        for (const message of v.errors) issues.push({ level: 'error', code: 'style_invalid', message, item: null });
        for (const message of v.warnings) issues.push({ level: 'warning', code: 'style_unverified', message, item: null });
      }
      issues.push({ level: 'warning', code: 'reference_unverified', message: '通用手法建议（未核实）：这是模型对参考的整理，不是对具体影片的核实。', item: null });
      return outcome(db, res, {
        kind: 'style',
        scope: { ...scope },
        model: research.cfg.model,
        prompt_version: STYLE_RESEARCH_PROMPT_VERSION,
        parsed,
        issues: [...issues, ...errorIssue(res)],
      });
    },
  });
}
