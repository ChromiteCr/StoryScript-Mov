import type { ImageAttempt } from '../../adapters/image/types.ts';
import type { ModelSource } from '@storyscript/contracts';
import { modelDir, OWN_NOT_CONFIGURED, type ModelSettingsDir } from '../../collab/models.ts';
import { imageClientConfig, type ImageClientConfig } from '../../config/image-provider.ts';
import type { AppDeps } from '../../deps.ts';
import { AppError } from '../../http/errors.ts';
import { APP_VERSION } from '../../version.ts';

/**
 * Per-app image wiring without touching AppDeps (same pattern as
 * ai/runtime.ts): tests shorten timeouts and replace the 429 sleep through
 * `configureImage(handle.deps, …)`.
 */

export interface ImageOverrides {
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  retryAfterCapMs?: number;
  defaultRetryAfterMs?: number;
  /** transport override (tests only; production uses the dialect's adapter) */
  attempt?: ImageAttempt;
}

const overrides = new WeakMap<AppDeps, ImageOverrides>();

export function configureImage(deps: AppDeps, o: ImageOverrides): void {
  overrides.set(deps, { ...overrides.get(deps), ...o });
}

export function imageOverrides(deps: AppDeps): ImageOverrides {
  return overrides.get(deps) ?? {};
}

export const USER_AGENT = `storyscript-mov/${APP_VERSION}`;

export const NOT_CONFIGURED_MESSAGE = '尚未配置图像模型：请在设置中填写图像服务的 base_url、API key 和模型名（或设置 STORYSCRIPT_IMAGE_* 环境变量）';

/** Configured image endpoint, or 409 PROVIDER_NOT_CONFIGURED (nothing is sent). */
export function requireImageClient(deps: AppDeps, opts: { forRedraw: boolean; where?: ModelSettingsDir }): ImageClientConfig & { source: ModelSource | null } {
  if (deps.demo) throw new AppError('PROVIDER_NOT_CONFIGURED', '演示模式不提供 AI 重绘，也不会外发任何请求', 409);
  const where = opts.where ?? modelDir(deps, 'image');
  const found = imageClientConfig(where.dir, where.env);
  if (!found) throw new AppError('PROVIDER_NOT_CONFIGURED', where.source === 'own' ? OWN_NOT_CONFIGURED.image : NOT_CONFIGURED_MESSAGE, 409);
  const cfg = { ...found, source: where.source };
  if (opts.forRedraw && cfg.blocking) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', `当前图像服务不能用于草图重绘：${cfg.warning}`, 409, { host: cfg.host });
  }
  return cfg;
}
