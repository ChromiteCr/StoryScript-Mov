import type { ImagePreset } from '@storyscript/contracts';
import { parseRetryAfter } from '../llm/chat.ts';
import { redactSecrets } from '../llm/redact.ts';
import { isUnreached, materialize } from './payload.ts';
import { flattenUsage, ImageCallError, type AttemptOptions, type AttemptResult, type ImageEndpoint, type ImageRequest } from './types.ts';

/**
 * generations-ref: native fetch, JSON body assembled from the preset —
 * { model, prompt, <ref_field>: [data URLs], <size_field>: size, …extra_body }.
 * The image comes back at preset.response_path as base64 (or a URL, which is
 * downloaded at once). optional_params are removed on the stripped retry.
 * Quality is not sent: none of the preset services document it.
 */

export function presetUrl(baseUrl: string, preset: ImagePreset): string {
  return `${baseUrl.replace(/\/+$/, '')}/${preset.path.replace(/^\/+/, '')}`;
}

export function generationsBody(endpoint: ImageEndpoint, preset: ImagePreset, req: ImageRequest, strip: boolean): Record<string, unknown> {
  const refs = req.images.map((im) => (preset.ref_format === 'data_url' ? `data:${im.mime};base64,${Buffer.from(im.bytes).toString('base64')}` : Buffer.from(im.bytes).toString('base64')));
  const body: Record<string, unknown> = { model: endpoint.model, prompt: req.prompt };
  if (refs.length) body[preset.ref_field] = preset.ref_is_array ? refs : refs[0];
  body[preset.size_field] = req.size;
  for (const [k, v] of Object.entries(preset.extra_body)) body[k] = v;
  if (strip) for (const k of preset.optional_params) delete body[k];
  return body;
}

/** Resolve "data.0.b64_json" style dot paths. */
export function atPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const seg of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The configured path first; then the sibling url / b64_json key (services switch per request option). */
export function pickImageValue(body: unknown, preset: ImagePreset): string | null {
  const direct = atPath(body, preset.response_path);
  if (typeof direct === 'string' && direct) return direct;
  const parent = preset.response_path.split('.').slice(0, -1).join('.');
  for (const key of preset.response_kind === 'b64' ? ['url', 'b64_json'] : ['b64_json', 'url']) {
    const v = atPath(body, parent ? `${parent}.${key}` : key);
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function providerError(body: unknown, text: string): { message: string; code: string | null } {
  const b = body as { error?: unknown; message?: unknown; code?: unknown } | null;
  const e = b && typeof b.error === 'object' && b.error !== null ? (b.error as { message?: unknown; code?: unknown; type?: unknown }) : null;
  const message =
    (typeof e?.message === 'string' && e.message) ||
    (typeof b?.error === 'string' && b.error) ||
    (typeof b?.message === 'string' && b.message) ||
    text.slice(0, 300) ||
    '（无错误信息）';
  const rawCode = e?.code ?? e?.type ?? b?.code;
  return { message, code: typeof rawCode === 'string' ? rawCode : typeof rawCode === 'number' ? String(rawCode) : null };
}

export async function generationsRefAttempt(endpoint: ImageEndpoint, req: ImageRequest, opts: AttemptOptions): Promise<AttemptResult> {
  const preset = endpoint.preset;
  if (!preset) throw new ImageCallError('bad_response', 'generations-ref 缺少 preset');
  const secrets = [endpoint.api_key];
  const url = presetUrl(endpoint.base_url, preset);
  const body = generationsBody(endpoint, preset, req, opts.strip);
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.api_key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': opts.userAgent,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ImageCallError('timeout', '图像服务在限定时间内没有返回');
    }
    const m = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    throw isUnreached(err) ? new ImageCallError('unreached', `无法连接图像服务：${m}`) : new ImageCallError('network', `网络中断：${m}`);
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const pe = providerError(parsed, text);
    throw new ImageCallError('http', redactSecrets(pe.message, secrets), {
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      providerCode: pe.code,
    });
  }
  if (parsed === null) throw new ImageCallError('bad_response', '服务返回成功，但响应不是 JSON');
  const value = pickImageValue(parsed, preset);
  if (!value) {
    const pe = providerError(parsed, '');
    throw new ImageCallError('bad_response', redactSecrets(`服务返回成功，但结果里没有图像（${pe.message}）`, secrets), { providerCode: pe.code });
  }
  const image = await materialize(value, { timeoutMs: opts.timeoutMs, userAgent: opts.userAgent, secrets });
  return { image, usage: flattenUsage((parsed as { usage?: unknown }).usage) };
}
