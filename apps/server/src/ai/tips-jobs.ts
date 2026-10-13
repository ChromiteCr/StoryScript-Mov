import { ShotTipsOutput, TIP_SHOTS_MAX, type Job } from '@storyscript/contracts';
import { buildShotTipsMessages, contentHash, finalizeShotTips, normalizeShotTipsJson, timeOfDay, TIPS_PROMPT_VERSION, validateShotTips } from '@storyscript/core';
import { tipsReplayKey } from '../adapters/llm/replay-chat.ts';
import { structuredCall } from '../adapters/llm/structured.ts';
import { getScene } from '../db/repos/script.ts';
import { listSceneShots } from '../db/repos/shot.ts';
import { upsertTip } from '../db/repos/tips.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import type { JobRunResult } from '../jobs/queue.ts';
import { projectBoardContext } from '../services/boards/context.ts';
import { assertJobQuota } from '../services/quota.ts';
import { callOptions, usageRecord } from './jobs.ts';
import { projectContext, resolveAi } from './runtime.ts';

/**
 * S5c 镜头拍摄提示: one remote job per scene (at most 3 requests, one count
 * against the daily cap). Each usable item is stored for its shot with the
 * content hash the model saw, so a shot changed since reads as stale. Tips are
 * hints only: no shot is changed.
 */

const REPAIR_ERRORS_MAX = 12;

export function startShotTips(deps: AppDeps, sceneId: string): Job {
  const { project, jobs } = projectContext(deps);
  const db = project.db;
  const scene = getScene(db, sceneId);
  if (!scene) throw new AppError('NOT_FOUND', '场次不存在', 404, { scene_id: sceneId });
  const shots = listSceneShots(db, sceneId);
  if (shots.length === 0) throw new AppError('VALIDATION_ERROR', '这一场还没有镜头：先拆镜或新建镜头', 409, { scene_id: sceneId });
  if (shots.length > TIP_SHOTS_MAX) throw new AppError('VALIDATION_ERROR', `这一场的镜头超过 ${TIP_SHOTS_MAX} 个，暂不支持一次生成`, 409, { scene_id: sceneId });
  const ai = resolveAi(deps);
  const time = timeOfDay(projectBoardContext(db).timeLabel(sceneId));
  const items = shots.map((s, i) => ({ ref: `s${i + 1}`, code: s.code, fields: s.fields, shot_id: s.id, basis: s.content_hash }));
  const refs = items.map((i) => i.ref);
  const messages = buildShotTipsMessages({ scene: { display_no: scene.display_no, heading: scene.heading }, time, shots: items });
  if (ai.remote) assertJobQuota(deps, db, 'llm');
  return jobs.enqueue({
    kind: 'shot_tips',
    model_source: ai.source,
    idempotency_key: `shot_tips:${sceneId}:${contentHash(items.map((i) => i.basis))}`,
    input_hash: contentHash({ prompt_version: TIPS_PROMPT_VERSION, messages }),
    remote: ai.remote,
    lane: 'llm',
    run: async (ctx): Promise<JobRunResult> => {
      const res = await structuredCall({
        ...callOptions(ai),
        messages,
        schema: ShotTipsOutput,
        jsonSchemaName: 'shot_tips',
        preprocess: normalizeShotTipsJson,
        validate: (p) => {
          const errors = validateShotTips(p, refs).errors;
          return { ok: errors.length === 0, errors: errors.slice(0, REPAIR_ERRORS_MAX) };
        },
        signal: ctx.signal,
        meta: { prompt_version: TIPS_PROMPT_VERSION, replay_key: tipsReplayKey(scene.heading, items.map((i) => i.code)) },
        onAttempt: ctx.markSent,
      });
      const usage = usageRecord(res.usage);
      const parsed = res.value ?? res.last_parsed ?? null;
      const fin = parsed ? finalizeShotTips(parsed, refs) : null;
      // nothing usable: no tips are written (the earlier ones stay)
      if (!fin || fin.items.length === 0) {
        const error = res.error ?? { code: 'ATTEMPTS_EXHAUSTED', message: '模型的回答对不上本场的镜头，没有可用的提示' };
        return { status: 'failed', attempts: res.attempts, usage, error: { code: error.code, message: error.message } };
      }
      const byRef = new Map(items.map((i) => [i.ref, i] as const));
      const now = new Date().toISOString();
      return {
        status: 'succeeded',
        attempts: res.attempts,
        usage,
        error: null,
        commit: () => {
          for (const t of fin.items) {
            const it = byRef.get(t.ref)!;
            // the shot may have been archived or deleted while the model worked
            if (!db.get('SELECT 1 AS x FROM shot WHERE id = ? AND archived = 0', it.shot_id)) continue;
            upsertTip(db, {
              shot_id: it.shot_id,
              scene_id: sceneId,
              basis_hash: it.basis,
              difficulty: t.difficulty,
              gear: t.gear,
              tips: t.tips,
              mistake: t.mistake,
              job_id: ctx.job_id,
              model: ai.cfg.model,
              prompt_version: TIPS_PROMPT_VERSION,
              created_at: now,
            });
          }
          return sceneId;
        },
      };
    },
  });
}
