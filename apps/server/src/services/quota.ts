import type { AppDeps } from '../deps.ts';
import type { DbPort } from '../db/port.ts';
import { modelDir } from '../collab/models.ts';
import { AppError } from '../http/errors.ts';

/**
 * Hosted server: each group calls its own model service through the server,
 * with a cap on paid (remote) jobs per rolling 24 hours (server.json
 * `limits`) against runaway spending and load. The local single-user app has
 * no cap.
 */

const LLM_JOB_KINDS = ['extract_entities', 'breakdown_scene', 'suggest_order', 'research_style', 'polish_shots'] as const;
const IMAGE_JOB_KINDS = ['image_redraw'] as const;
const DAY_MS = 24 * 3600 * 1000;

export function assertJobQuota(deps: AppDeps, db: DbPort, lane: 'llm' | 'image', now: number = Date.now()): void {
  const limits = deps.hosted?.limits;
  if (!limits) return;
  // S4: the cap protects the group's key; a member calling with their own key spends their own money
  if (modelDir(deps, lane === 'llm' ? 'text' : 'image').source === 'own') return;
  const limit = lane === 'llm' ? limits.llm_jobs_per_day : limits.image_jobs_per_day;
  const kinds: readonly string[] = lane === 'llm' ? LLM_JOB_KINDS : IMAGE_JOB_KINDS;
  const since = new Date(now - DAY_MS).toISOString();
  const used =
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM job WHERE remote = 1 AND kind IN (${kinds.map(() => '?').join(', ')}) AND created_at >= ? AND (model_source IS NULL OR model_source = 'group')`,
      ...kinds,
      since,
    )?.n ?? 0;
  if (Number(used) >= limit) {
    const what = lane === 'llm' ? '文本模型' : '图像模型';
    throw new AppError('QUOTA_EXCEEDED', `本组 24 小时内的${what}调用已达 ${limit} 次上限（防止意外花费），稍后再试，或请管理员调高`, 409, { lane, limit, used: Number(used) });
  }
}
