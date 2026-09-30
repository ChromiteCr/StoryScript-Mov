import { PolishOutput, POLISH_MAX_SHOTS, type Job, type PolishRequest, type Shot, type ShotFields } from '@storyscript/contracts';
import {
  buildPolishMessages,
  contentHash,
  normalizeBreakdownJson,
  POLISH_PROMPT_VERSION,
  polishRepairErrors,
  shotOneLine,
  validatePolish,
  type PolishPromptShot,
} from '@storyscript/core';
import { structuredCall } from '../adapters/llm/structured.ts';
import type { DbPort } from '../db/port.ts';
import { characterRoster } from '../db/repos/entity.ts';
import { latestScriptVersion } from '../db/repos/script.ts';
import { listSceneShots } from '../db/repos/shot.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { assertJobQuota } from '../services/quota.ts';
import { availableTechniques, requireScene, requireShot } from '../services/shots.ts';
import { promptStyle, resolveStyle } from '../services/styles.ts';
import { callOptions, errorIssue, outcome } from './jobs.ts';
import { projectContext, resolveAi } from './runtime.ts';

/**
 * S3a polish: 1–12 existing shots (any scenes of the current script) are
 * rewritten, improved or refined one-for-one by the group's model, with the
 * style and level the user chose. One remote job, at most 3 outbound
 * requests, counted against the daily cap; the result is a draft reviewed
 * shot by shot (services/polish.ts applies it).
 */

export interface PolishScope {
  shot_ids: string[];
  /** ref (s1 …) → shot id, in prompt order */
  refs: Record<string, string>;
  /** revision each shot had when the request was made */
  expected_revisions: Record<string, number>;
  mode: PolishRequest['mode'];
  instruction: string | null;
  style_id: string | null;
  level: PolishRequest['level'];
}

const withoutSource = ({ source: _source, ...rest }: ShotFields) => rest;

/** The shots to polish, in scene and narrative order, each checked (exists, active, unlocked, current script). */
function polishTargets(db: DbPort, ids: readonly string[]): { shot: Shot; sceneShots: Shot[] }[] {
  const unique = [...new Set(ids)];
  if (unique.length > POLISH_MAX_SHOTS) throw new AppError('VALIDATION_ERROR', `一次最多润色 ${POLISH_MAX_SHOTS} 个镜头`, 400);
  const latest = latestScriptVersion(db);
  const out: { shot: Shot; sceneShots: Shot[]; sort: [number, number] }[] = [];
  const sceneOrder = new Map<string, number>();
  for (const id of unique) {
    const shot = requireShot(db, id);
    if (shot.archived) throw new AppError('VALIDATION_ERROR', `镜头 ${shot.code} 已归档，不能润色`, 409, { shot_id: id });
    if (shot.locked) throw new AppError('LOCKED_SHOT', `镜头 ${shot.code} 已锁定，先解锁再润色`, 409, { shot_id: id });
    const scene = requireScene(db, shot.scene_id);
    if (!latest || scene.script_version_id !== latest.id) {
      throw new AppError('VALIDATION_ERROR', `镜头 ${shot.code} 属于旧版本剧本，请在当前剧本版本中操作`, 409, { shot_id: id });
    }
    if (!sceneOrder.has(scene.id)) sceneOrder.set(scene.id, sceneOrder.size);
    const sceneShots = listSceneShots(db, scene.id);
    out.push({ shot, sceneShots, sort: [sceneSort(db, scene.id), shot.narrative_pos] });
  }
  return out.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1]).map(({ shot, sceneShots }) => ({ shot, sceneShots }));
}

function sceneSort(db: DbPort, sceneId: string): number {
  return db.get<{ sort: number }>('SELECT sort FROM scene WHERE id = ?', sceneId)?.sort ?? 0;
}

export function startPolish(deps: AppDeps, request: PolishRequest): Job {
  if (deps.demo) throw new AppError('VALIDATION_ERROR', '演示模式不连接模型，只回放录好的拆镜，不能润色镜头。', 409);
  const { project, jobs } = projectContext(deps);
  const db = project.db;
  const ai = resolveAi(deps);
  const targets = polishTargets(db, request.shot_ids);
  const style = resolveStyle(db, request.style_id);
  const latest = latestScriptVersion(db)!;
  const paragraphs = new Map(latest.paragraphs.map((p) => [p.id, p.text]));
  const roster = characterRoster(db);
  const techniques = availableTechniques(db);

  const refs: Record<string, string> = {};
  const expected: Record<string, number> = {};
  const before: Record<string, ShotFields> = {};
  const promptShots: PolishPromptShot[] = targets.map(({ shot, sceneShots }, i) => {
    const ref = `s${i + 1}`;
    refs[ref] = shot.id;
    expected[shot.id] = shot.revision;
    before[ref] = shot.fields;
    const scene = requireScene(db, shot.scene_id);
    const at = sceneShots.findIndex((s) => s.id === shot.id);
    const prev = at > 0 ? sceneShots[at - 1]! : null;
    const next = at >= 0 && at < sceneShots.length - 1 ? sceneShots[at + 1]! : null;
    return {
      ref,
      scene: { display_no: scene.display_no, heading: scene.heading },
      source_text: paragraphs.get(shot.fields.source.paragraph_id) ?? shot.fields.source.quote ?? '',
      fields: withoutSource(shot.fields),
      prev: prev ? shotOneLine(prev.fields) : null,
      next: next ? shotOneLine(next.fields) : null,
    };
  });
  const messages = buildPolishMessages({
    mode: request.mode,
    instruction: request.instruction,
    shots: promptShots,
    roster,
    techniques,
    style: promptStyle(style),
    level: request.level,
    frame_format: project.project().default_aspect,
  });
  const scope: PolishScope = {
    shot_ids: targets.map((t) => t.shot.id),
    refs,
    expected_revisions: expected,
    mode: request.mode,
    instruction: request.instruction,
    style_id: request.style_id,
    level: request.level,
  };
  const vctx = {
    refs: Object.keys(refs),
    aliases: roster.map((r) => r.alias),
    technique_ids: techniques.map((t) => t.id),
    mode: request.mode,
    before,
  };
  if (ai.remote) assertJobQuota(deps, db, 'llm');
  return jobs.enqueue({
    kind: 'polish_shots',
    model_source: ai.source,
    idempotency_key: `polish:${contentHash({ request, expected })}`,
    input_hash: contentHash({ prompt_version: POLISH_PROMPT_VERSION, messages }),
    remote: ai.remote,
    lane: 'llm',
    run: async (ctx) => {
      const res = await structuredCall({
        ...callOptions(ai),
        messages,
        schema: PolishOutput,
        jsonSchemaName: 'polish',
        preprocess: normalizePolishJson,
        validate: (p) => {
          const v = validatePolish(p, vctx);
          return { ok: v.error_count === 0, errors: polishRepairErrors(v, p) };
        },
        signal: ctx.signal,
        meta: { prompt_version: POLISH_PROMPT_VERSION },
        onAttempt: ctx.markSent,
      });
      const parsed = res.value ?? res.last_parsed ?? null;
      const issues = parsed ? validatePolish(parsed, vctx).issues : [];
      return outcome(db, res, {
        kind: 'polish',
        scope: { ...scope },
        model: ai.cfg.model,
        prompt_version: POLISH_PROMPT_VERSION,
        parsed,
        issues: [...issues, ...errorIssue(res)],
      });
    },
  });
}

/** Reuse the breakdown normaliser on each item's fields (enum case, missing nullables). */
function normalizePolishJson(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const shots = Array.isArray(raw) ? raw : (raw as { shots?: unknown }).shots;
  if (!Array.isArray(shots)) return raw;
  return {
    shots: shots.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const it = item as { ref?: unknown; change_note?: unknown; fields?: unknown };
      const fields = it.fields && typeof it.fields === 'object' ? normalizeFields(it.fields as Record<string, unknown>) : it.fields;
      return { ref: typeof it.ref === 'string' ? it.ref.trim() : it.ref, change_note: it.change_note ?? '', fields };
    }),
  };
}

function normalizeFields(f: Record<string, unknown>): unknown {
  // the breakdown normaliser works on { shots: [fields with source] }; give it a placeholder source and drop it again
  const out = normalizeBreakdownJson({ shots: [{ ...f, source: { paragraph_id: 'p-000', quote: '' } }] }) as { shots?: Record<string, unknown>[] };
  const one = out.shots?.[0];
  if (!one) return f;
  const { source: _s, ...rest } = one;
  return rest;
}
