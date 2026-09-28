import type { ErrorCode } from '@storyscript/contracts';
import {
  DEFAULT_PIXEL_WINDOW,
  formatSize,
  legalOpenAISize,
  nearestStandardOpenAISize,
  parseAspect,
  parseSize,
  pixelSize,
  pickAspectValue,
} from '@storyscript/core';
import { redactSecrets } from '../llm/redact.ts';
import { generationsRefAttempt, presetUrl } from './generations-ref.ts';
import { OPENAI_EDITS_OPTIONAL_PARAMS, openaiEditsAttempt, sendsInputFidelity } from './openai-edits.ts';
import { ImageCallError, type AttemptResult, type ImageAttempt, type ImageEndpoint, type ImageRequest, type ReturnedImage } from './types.ts';

/**
 * One paid image step with the SPEC FR-11/FR-12 policy:
 *
 *   - at most 3 outbound requests per step (every attempt counts, including
 *     the stripped retry);
 *   - only 429 is retried, after Retry-After (capped at 30 s);
 *   - timeout, 5xx or a connection dropped mid-request → outcome_unknown, never
 *     re-sent (the service may have processed and billed it);
 *   - 400 pointing at an unknown parameter → drop the dialect's optional params
 *     and retry once;
 *   - moderation refusals → PROVIDER_REFUSED, not retried;
 *   - everything else fails with a plain-Chinese message. No message ever
 *     contains the key.
 *
 * `signal` is only checked between attempts and during the 429 wait: a request
 * that already left is never aborted, so a late result can still be stored
 * (late_after_cancel).
 */

export const MAX_IMAGE_ATTEMPTS = 3;
export const RETRY_AFTER_CAP_MS = 30_000;
export const DEFAULT_RETRY_AFTER_MS = 10_000;
export const IMAGE_TIMEOUT_MS = 180_000;

export interface CallPolicy {
  timeoutMs?: number;
  maxAttempts?: number;
  retryAfterCapMs?: number;
  defaultRetryAfterMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** called right before every outbound request with the 1-based attempt number */
  onAttempt?: (attempt: number) => void;
  userAgent: string;
  /** transport to the service (default: global fetch) */
  fetch?: typeof fetch;
  /** transport override (tests) */
  attempt?: ImageAttempt;
}

export interface CallError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type CallOutcome =
  | { outcome: 'ok'; image: ReturnedImage; usage: Record<string, number> | null; attempts: number; stripped: boolean }
  | { outcome: 'refused'; error: CallError; attempts: number }
  | { outcome: 'outcome_unknown'; error: CallError; attempts: number }
  | { outcome: 'failed'; error: CallError; attempts: number }
  | { outcome: 'cancelled'; attempts: number };

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function attemptFor(endpoint: ImageEndpoint): ImageAttempt {
  return endpoint.dialect === 'openai-edits' ? openaiEditsAttempt : generationsRefAttempt;
}

/** Optional params this request actually carries (what a stripped retry would drop). */
export function optionalParamsSent(endpoint: ImageEndpoint, req: ImageRequest): string[] {
  if (endpoint.dialect === 'openai-edits') {
    return OPENAI_EDITS_OPTIONAL_PARAMS.filter((p) => (p === 'quality' ? req.quality !== null : sendsInputFidelity(endpoint.model)));
  }
  const preset = endpoint.preset;
  if (!preset) return [];
  return preset.optional_params.filter((p) => Object.hasOwn(preset.extra_body, p));
}

function endpointPath(endpoint: ImageEndpoint): string {
  if (endpoint.dialect === 'openai-edits') return `${endpoint.base_url.replace(/\/+$/, '')}/images/edits`;
  return endpoint.preset ? presetUrl(endpoint.base_url, endpoint.preset) : endpoint.base_url;
}

const REFUSAL_CODE = /moderation|content_?policy|content_?filter|safety|sensitive|risk/i;
const REFUSAL_TEXT = /moderation|safety system|content policy|content_policy|sensitive (content|information)|was flagged|flagged by|违规|敏感|审核/i;
const UNKNOWN_PARAM =
  /unknown (parameter|field|argument|name)|unrecogni[sz]ed (request )?(argument|parameter|field|key)|unsupported (parameter|field|argument)|not (a )?(valid|supported|recognized|permitted|allowed) (parameter|field|argument)|parameter\b.{0,80}\b(is )?(not (valid|supported|allowed|permitted|recognized)|invalid)|extra (fields|inputs) (are )?not permitted|unexpected (keyword|field|argument|parameter)|additional properties/i;
const SIZE_TEXT = /\bsize\b|dimension|resolution|\bwidth\b|\bheight\b|aspect|pixel|像素|尺寸|分辨率|宽高/i;

export function isRefusal(e: ImageCallError): boolean {
  if (e.kind !== 'http' && e.kind !== 'bad_response') return false;
  if (e.kind === 'http' && (e.status === null || e.status < 400 || e.status >= 500)) return false;
  return (e.providerCode !== null && REFUSAL_CODE.test(e.providerCode)) || REFUSAL_TEXT.test(e.message);
}

/** The nearest size the service is likely to accept (400 hint). */
export function suggestSize(endpoint: ImageEndpoint, size: string): string | null {
  if (endpoint.dialect === 'openai-edits') {
    const s = parseSize(size);
    if (!s) return '1536x1024';
    const legal = legalOpenAISize(s);
    return legal.w !== s.w || legal.h !== s.h ? formatSize(legal) : formatSize(nearestStandardOpenAISize(s));
  }
  const preset = endpoint.preset;
  if (preset?.size_mode === 'aspect_enum') {
    const r = parseAspect(size);
    return r === null ? (preset.aspect_values[0] ?? null) : pickAspectValue(r, preset.aspect_values);
  }
  const s = parseSize(size);
  if (!s) return null;
  const inWindow = pixelSize(s.w / s.h, DEFAULT_PIXEL_WINDOW);
  return formatSize(inWindow);
}

function translate(e: ImageCallError, endpoint: ImageEndpoint, req: ImageRequest, attempts: number, timeoutMs: number): CallOutcome {
  const status = e.status;
  const provider = e.message ? `：${e.message}` : '';
  if (isRefusal(e)) {
    return {
      outcome: 'refused',
      attempts,
      error: {
        code: 'PROVIDER_REFUSED',
        message: `图像服务的内容审核拒绝了这次请求${e.providerCode ? `（${e.providerCode}）` : ''}：请修改镜头的动作描述后再试；本次不会自动重试`,
      },
    };
  }
  switch (e.kind) {
    case 'timeout':
      return {
        outcome: 'outcome_unknown',
        attempts,
        error: {
          code: 'PROVIDER_OUTCOME_UNKNOWN',
          message: `图像服务在 ${Math.round(timeoutMs / 1000)} 秒内没有返回：请求可能仍在处理并计费，系统不会自动重发；请到服务商后台核对后再决定是否重试`,
        },
      };
    case 'network':
      return {
        outcome: 'outcome_unknown',
        attempts,
        error: { code: 'PROVIDER_OUTCOME_UNKNOWN', message: `请求发出后连接中断${provider}；服务可能已处理并计费，系统不会自动重发` },
      };
    case 'unreached':
      return { outcome: 'failed', attempts, error: { code: 'PROVIDER_ERROR', message: `无法连接图像服务（${endpoint.host || endpoint.base_url}）：请检查 base_url 和网络` } };
    case 'bad_response':
      return { outcome: 'failed', attempts, error: { code: 'PROVIDER_ERROR', message: e.message } };
    default:
      break;
  }
  if (status !== null && status >= 500) {
    return {
      outcome: 'outcome_unknown',
      attempts,
      error: {
        code: 'PROVIDER_OUTCOME_UNKNOWN',
        message: `图像服务出错（HTTP ${status}）：请求可能已被处理并计费，系统不会自动重发；请到服务商后台核对后再决定是否重试`,
      },
    };
  }
  if (status === 401) {
    return { outcome: 'failed', attempts, error: { code: 'PROVIDER_ERROR', message: '图像服务拒绝了 API key（HTTP 401）：请检查 key 是否填写正确、是否已过期' } };
  }
  if (status === 403) {
    return {
      outcome: 'failed',
      attempts,
      error: { code: 'PROVIDER_ERROR', message: `API key 没有权限调用模型 ${endpoint.model}（HTTP 403）：请确认账号已开通该模型，或更换模型` },
    };
  }
  if (status === 404 || status === 405) {
    const hint =
      endpoint.dialect === 'openai-edits'
        ? '建议在设置里把方言切换到 generations-ref'
        : '请核对 base_url，或在设置里把方言切换到 openai-edits';
    return {
      outcome: 'failed',
      attempts,
      error: { code: 'PROVIDER_ERROR', message: `该端点不支持此写法（HTTP ${status}，POST ${endpointPath(endpoint)}），${hint}`, details: { status } },
    };
  }
  if (status === 413) {
    return { outcome: 'failed', attempts, error: { code: 'PROVIDER_ERROR', message: '请求体过大（HTTP 413）：控制图可能超过了该服务的上传上限' } };
  }
  if (status === 400 && (SIZE_TEXT.test(e.message) || (e.providerCode !== null && SIZE_TEXT.test(e.providerCode)))) {
    const suggested = suggestSize(endpoint, req.size);
    return {
      outcome: 'failed',
      attempts,
      error: {
        code: 'PROVIDER_ERROR',
        message: `图像服务不接受尺寸 ${req.size}（HTTP 400）${suggested ? `；最近的合法尺寸：${suggested}` : ''}${provider}`,
        details: { requested_size: req.size, suggested_size: suggested },
      },
    };
  }
  if (status === 429) {
    return {
      outcome: 'failed',
      attempts,
      error: { code: 'ATTEMPTS_EXHAUSTED', message: `图像服务持续限流（HTTP 429），已外发 ${attempts} 次，请稍后再试` },
    };
  }
  return { outcome: 'failed', attempts, error: { code: 'PROVIDER_ERROR', message: `图像服务拒绝了请求（HTTP ${status ?? '?'}）${provider}` } };
}

export async function callImage(endpoint: ImageEndpoint, req: ImageRequest, policy: CallPolicy): Promise<CallOutcome> {
  const max = policy.maxAttempts ?? MAX_IMAGE_ATTEMPTS;
  const timeoutMs = policy.timeoutMs ?? IMAGE_TIMEOUT_MS;
  const cap = policy.retryAfterCapMs ?? RETRY_AFTER_CAP_MS;
  const sleep = policy.sleep ?? defaultSleep;
  const attempt = policy.attempt ?? attemptFor(endpoint);
  const optional = optionalParamsSent(endpoint, req);
  let strip = false;
  let attempts = 0;
  const scrub = (o: CallOutcome): CallOutcome => {
    if (o.outcome === 'ok' || o.outcome === 'cancelled') return o;
    return { ...o, error: { ...o.error, message: redactSecrets(o.error.message, [endpoint.api_key]) } };
  };
  for (;;) {
    if (policy.signal?.aborted) return { outcome: 'cancelled', attempts };
    attempts++;
    policy.onAttempt?.(attempts);
    let res: AttemptResult;
    try {
      res = await attempt(endpoint, req, { timeoutMs, strip, userAgent: policy.userAgent, fetch: policy.fetch ?? globalThis.fetch });
    } catch (err) {
      const e = err instanceof ImageCallError ? err : new ImageCallError('network', redactSecrets(err instanceof Error ? err.message : String(err), [endpoint.api_key]));
      const canRetry = attempts < max;
      if (e.kind === 'http' && e.status === 429 && canRetry && !isRefusal(e)) {
        const wait = Math.min(cap, Math.max(0, e.retryAfterMs ?? policy.defaultRetryAfterMs ?? DEFAULT_RETRY_AFTER_MS));
        try {
          await sleep(wait, policy.signal);
        } catch {
          return { outcome: 'cancelled', attempts };
        }
        continue;
      }
      if (e.kind === 'http' && e.status === 400 && canRetry && !strip && optional.length > 0 && !isRefusal(e)) {
        const names = optional.some((p) => e.message.includes(p));
        if (names || (UNKNOWN_PARAM.test(e.message) && !SIZE_TEXT.test(e.message))) {
          strip = true;
          continue;
        }
      }
      return scrub(translate(e, endpoint, req, attempts, timeoutMs));
    }
    return { outcome: 'ok', image: res.image, usage: res.usage, attempts, stripped: strip };
  }
}
