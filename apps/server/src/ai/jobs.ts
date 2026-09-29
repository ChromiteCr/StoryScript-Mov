import { assertJobQuota } from '../services/quota.ts';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  BreakdownOutput,
  BreakdownRequest,
  EntitiesOutput,
  type DraftIssue,
  type Job,
  type ShotDraft,
} from '@storyscript/contracts';
import {
  BREAKDOWN_PROMPT_VERSION,
  breakdownPromptVersion,
  breakdownRepairErrors,
  buildBreakdownMessages,
  buildEntitiesMessages,
  contentHash,
  ENTITIES_PROMPT_VERSION,
  normalizeBreakdownJson,
  normalizeEntitiesJson,
  normalizeForMatch,
  validateBreakdown,
  type BreakdownValidationContext,
} from '@storyscript/core';
import { sceneReplayKey, scriptReplayKey } from '../adapters/llm/replay-chat.ts';
import { structuredCall, type StructuredCallResult, type StructuredUsage } from '../adapters/llm/structured.ts';
import type { DbPort } from '../db/port.ts';
import { insertDraft } from '../db/repos/draft.ts';
import { characterRoster } from '../db/repos/entity.ts';
import { latestScriptVersion } from '../db/repos/script.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import type { JobRunResult } from '../jobs/queue.ts';
import { availableTechniques, requireScene } from '../services/shots.ts';
import { promptStyle, resolveStyle } from '../services/styles.ts';
import { projectContext, resolveAi, type AiClient } from './runtime.ts';

/**
 * AI jobs: entity extraction and per-scene breakdown. Both run as remote jobs
 * (never auto-resent), call structuredCall, and write exactly one shot_draft
 * (INV-03: AI output never touches the formal tables here).
 */

export const MAX_ATTEMPTS = 3;

export function usageRecord(u: StructuredUsage): Record<string, number> {
  return { prompt_tokens: u.prompt, completion_tokens: u.completion, total_tokens: u.total, unknown_calls: u.unknown_calls };
}

export function errorIssue(res: StructuredCallResult<unknown>): DraftIssue[] {
  return res.error && res.error.code !== 'CANCELLED'
    ? [{ level: 'error', code: res.error.code, message: res.error.message, item: null }]
    : [];
}

export function outcome<T>(
  db: DbPort,
  res: StructuredCallResult<T>,
  draft: Omit<ShotDraft, 'id' | 'raw_output' | 'parsed' | 'attempts' | 'usage' | 'status' | 'issues' | 'created_at'> & {
    parsed: T | null;
    issues: DraftIssue[];
  },
): JobRunResult {
  const usage = usageRecord(res.usage);
  return {
    status: res.value !== undefined ? 'succeeded' : 'failed',
    attempts: res.attempts,
    usage,
    error: res.error ? { code: res.error.code, message: res.error.message } : null,
    commit: () => {
      const id = randomUUID();
      insertDraft(db, {
        id,
        kind: draft.kind,
        scope: draft.scope,
        model: draft.model,
        prompt_version: draft.prompt_version,
        raw_output: res.raw_outputs.at(-1) ?? null,
        parsed: draft.parsed,
        issues: draft.issues,
        attempts: res.attempts,
        usage,
        status: draft.parsed !== null ? 'pending' : 'failed',
        created_at: new Date().toISOString(),
      });
      return id;
    },
  };
}

export function callOptions(ai: AiClient) {
  return {
    client: ai.cfg,
    chat: ai.chat,
    capabilityCache: ai.capabilityCache,
    maxAttempts: MAX_ATTEMPTS,
    sleep: ai.sleep,
    backoffMs: ai.backoffMs,
  };
}

// ---------------------------------------------------------------------------
// entities
// ---------------------------------------------------------------------------

export function startEntityExtraction(deps: AppDeps): Job {
  const { project, jobs } = projectContext(deps);
  const db = project.db;
  const ai = resolveAi(deps);
  const version = latestScriptVersion(db);
  if (!version) throw new AppError('VALIDATION_ERROR', '请先导入剧本', 409);
  const messages = buildEntitiesMessages(version.paragraphs);
  const scriptText = normalizeForMatch(version.paragraphs.map((p) => p.text).join('\n'));
  if (ai.remote) assertJobQuota(deps, db, 'llm');
  return jobs.enqueue({
    kind: 'extract_entities',
    idempotency_key: `extract_entities:${version.id}`,
    input_hash: contentHash({ prompt_version: ENTITIES_PROMPT_VERSION, messages }),
    remote: ai.remote,
    lane: 'llm',
    run: async (ctx) => {
      const res = await structuredCall({
        ...callOptions(ai),
        messages,
        schema: EntitiesOutput,
        jsonSchemaName: 'entities',
        preprocess: normalizeEntitiesJson,
        validate: (p) => {
          const empty = [...p.characters, ...p.locations, ...p.props].filter((e) => !e.name.trim()).length;
          return empty ? { ok: false, errors: [`有 ${empty} 个条目的 name 为空`] } : { ok: true, errors: [] };
        },
        signal: ctx.signal,
        meta: { prompt_version: ENTITIES_PROMPT_VERSION, replay_key: scriptReplayKey(version.paragraphs) },
        onAttempt: ctx.markSent,
      });
      const parsed = res.value ?? res.last_parsed ?? null;
      const issues: DraftIssue[] = [];
      if (parsed) {
        for (const kind of ['characters', 'locations', 'props'] as const) {
          for (const e of parsed[kind]) {
            if (!scriptText.includes(normalizeForMatch(e.name))) {
              issues.push({ level: 'warning', code: 'name_not_in_script', message: `「${e.name}」在剧本原文中找不到，请核对`, item: null });
            }
          }
        }
      }
      return outcome(db, res, {
        kind: 'entities',
        scope: { script_version_id: version.id },
        model: ai.cfg.model,
        prompt_version: ENTITIES_PROMPT_VERSION,
        parsed,
        issues: [...issues, ...errorIssue(res)],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// breakdown
// ---------------------------------------------------------------------------

export interface BreakdownScope {
  scene_id: string;
  script_version_id: string;
  request: BreakdownRequest;
}

export function breakdownContext(db: DbPort, sceneId: string, request: BreakdownRequest) {
  const style = resolveStyle(db, request.style_id);
  const scene = requireScene(db, sceneId);
  const latest = latestScriptVersion(db);
  if (!latest || latest.id !== scene.script_version_id) {
    throw new AppError('VALIDATION_ERROR', '该场景属于旧版本剧本，请在当前剧本版本中操作', 409, { scene_id: sceneId });
  }
  const techniques = availableTechniques(db);
  if (request.technique_id !== null && !techniques.some((t) => t.id === request.technique_id)) {
    throw new AppError('VALIDATION_ERROR', `手法「${request.technique_id}」不存在`, 400);
  }
  const roster = characterRoster(db);
  const ids = new Set(scene.paragraph_ids);
  const paragraphs = latest.paragraphs.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, text: p.text }));
  const vctx: BreakdownValidationContext = {
    paragraphs,
    aliases: roster.map((r) => r.alias),
    technique_ids: techniques.map((t) => t.id),
    max_shots: request.max_shots,
    reference_note: request.reference_note,
  };
  return { scene, version: latest, techniques, roster, paragraphs, vctx, style };
}

export function startBreakdown(deps: AppDeps, sceneId: string, input: z.input<typeof BreakdownRequest>): Job {
  const request = BreakdownRequest.parse(input);
  const { project, jobs } = projectContext(deps);
  const db = project.db;
  const ai = resolveAi(deps);
  const { scene, version, techniques, roster, paragraphs, vctx, style } = breakdownContext(db, sceneId, request);
  const promptInput = {
    scene: { display_no: scene.display_no, heading: scene.heading },
    paragraphs,
    roster,
    techniques,
    preferred_technique_id: request.technique_id,
    reference_note: request.reference_note,
    frame_format: project.project().default_aspect,
    max_shots: request.max_shots,
    target_seconds: request.target_seconds,
    style: promptStyle(style),
    level: request.level,
  };
  const messages = buildBreakdownMessages(promptInput);
  const promptVersion = breakdownPromptVersion(promptInput);
  if (deps.demo && promptVersion !== BREAKDOWN_PROMPT_VERSION) {
    throw new AppError('VALIDATION_ERROR', '演示模式只回放录好的拆镜：请把风格设为「不指定」、难度设为「稳妥」。', 409);
  }
  const scope: BreakdownScope = { scene_id: scene.id, script_version_id: version.id, request };
  if (ai.remote) assertJobQuota(deps, db, 'llm');
  return jobs.enqueue({
    kind: 'breakdown_scene',
    idempotency_key: `breakdown:${scene.id}:${contentHash(request)}`,
    input_hash: contentHash({ prompt_version: promptVersion, messages }),
    remote: ai.remote,
    lane: 'llm',
    run: async (ctx) => {
      const res = await structuredCall({
        ...callOptions(ai),
        messages,
        schema: BreakdownOutput,
        jsonSchemaName: 'breakdown',
        preprocess: normalizeBreakdownJson,
        validate: (p) => {
          const v = validateBreakdown(p, vctx);
          return { ok: v.error_count === 0, errors: breakdownRepairErrors(v) };
        },
        signal: ctx.signal,
        meta: { prompt_version: promptVersion, replay_key: sceneReplayKey(scene.heading) },
        onAttempt: ctx.markSent,
      });
      const parsed = res.value ?? res.last_parsed ?? null;
      const issues = parsed ? validateBreakdown(parsed, vctx).issues : [];
      return outcome(db, res, {
        kind: 'breakdown',
        scope: { ...scope },
        model: ai.cfg.model,
        prompt_version: promptVersion,
        parsed,
        issues: [...issues, ...errorIssue(res)],
      });
    },
  });
}
