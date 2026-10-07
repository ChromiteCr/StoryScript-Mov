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

export const LLM_JOB_KINDS = ['extract_entities', 'breakdown_scene', 'suggest_order', 'research_style', 'polish_shots', 'check_script', 'organize_paste'] as const;
export const IMAGE_JOB_KINDS = ['image_redraw'] as const;
const DAY_MS = 24 * 3600 * 1000;

export interface QuotaUsage {
  limit: number;
  used: number;
  remaining: number;
}

/** Hosted: the group key's paid jobs of a lane in the last 24 hours against its cap (null locally). */
export function quotaUsage(deps: AppDeps, db: DbPort, lane: 'llm' | 'image', now: number = Date.now()): QuotaUsage | null {
  const limits = deps.hosted?.limits;
  if (!limits) return null;
  const limit = lane === 'llm' ? limits.llm_jobs_per_day : limits.image_jobs_per_day;
  const kinds: readonly string[] = lane === 'llm' ? LLM_JOB_KINDS : IMAGE_JOB_KINDS;
  const since = new Date(now - DAY_MS).toISOString();
  const used = Number(
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM job WHERE remote = 1 AND kind IN (${kinds.map(() => '?').join(', ')}) AND created_at >= ? AND (model_source IS NULL OR model_source = 'group')`,
      ...kinds,
      since,
    )?.n ?? 0,
  );
  return { limit, used, remaining: Math.max(0, limit - used) };
}

/** `need`: jobs about to be queued at once (S5a: one per pasted segment); all or none. */
export function assertJobQuota(deps: AppDeps, db: DbPort, lane: 'llm' | 'image', now: number = Date.now(), need = 1): void {
  // S4: the cap protects the group's key; a member calling with their own key spends their own money
  if (modelDir(deps, lane === 'llm' ? 'text' : 'image').source === 'own') return;
  const q = quotaUsage(deps, db, lane, now);
  if (!q || q.used + need <= q.limit) return;
  const what = lane === 'llm' ? '文本模型' : '图像模型';
  const left = need > 1 ? `，这次要 ${need} 次，只剩 ${q.remaining} 次` : '';
  throw new AppError('QUOTA_EXCEEDED', `本组 24 小时内的${what}调用已达 ${q.limit} 次上限${left}（防止意外花费），稍后再试，或请管理员调高`, 409, { lane, limit: q.limit, used: q.used, need });
}
