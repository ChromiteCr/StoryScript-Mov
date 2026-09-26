import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, toFile } from 'openai';
import type { ImageEditParamsNonStreaming } from 'openai/resources/images';
import { parseRetryAfter } from '../llm/chat.ts';
import { redactSecrets } from '../llm/redact.ts';
import { isUnreached, materialize } from './payload.ts';
import { flattenUsage, ImageCallError, type AttemptOptions, type AttemptResult, type ImageEndpoint, type ImageRequest } from './types.ts';

/**
 * openai-edits (default dialect): official openai SDK, `maxRetries: 0`,
 * POST {base_url}/images/edits as multipart. `image` is always an array
 * (control image first, optional style anchor second → `image[]` fields),
 * model, size, quality, n = 1. input_fidelity is only sent to gpt-image-1.x
 * (gpt-image-2.x ignores it). quality and input_fidelity are the optional
 * params stripped after an "unknown parameter" 400.
 */

export const OPENAI_EDITS_OPTIONAL_PARAMS = ['quality', 'input_fidelity'] as const;

/** gpt-image-1, gpt-image-1-mini, gpt-image-1.5 accept input_fidelity; 2.x ignores it and others may reject it. */
export const sendsInputFidelity = (model: string) => /^gpt-image-1(\b|[.-])/i.test(model.trim());

export function editParams(endpoint: ImageEndpoint, req: ImageRequest, strip: boolean): Omit<ImageEditParamsNonStreaming, 'image'> {
  const p: Omit<ImageEditParamsNonStreaming, 'image'> = { model: endpoint.model, prompt: req.prompt, size: req.size, n: 1 };
  if (!strip && req.quality) p.quality = req.quality;
  if (!strip && sendsInputFidelity(endpoint.model)) p.input_fidelity = 'high';
  return p;
}

export function toImageCallError(err: unknown, apiKey: string): ImageCallError {
  const msg = (e: unknown) => redactSecrets(e instanceof Error ? e.message : String(e), [apiKey]);
  if (err instanceof ImageCallError) return err;
  if (err instanceof APIUserAbortError) return new ImageCallError('network', '请求已取消');
  if (err instanceof APIConnectionTimeoutError) return new ImageCallError('timeout', '图像服务在限定时间内没有返回');
  if (err instanceof APIConnectionError) {
    return isUnreached(err.cause ?? err) ? new ImageCallError('unreached', `无法连接图像服务：${msg(err)}`) : new ImageCallError('network', `网络中断：${msg(err)}`);
  }
  if (err instanceof APIError && typeof err.status === 'number') {
    const headers = err.headers as Headers | undefined;
    const retryAfter =
      parseRetryAfter(headers?.get?.('retry-after-ms') ? String(Number(headers.get('retry-after-ms')) / 1000) : null) ?? parseRetryAfter(headers?.get?.('retry-after'));
    const body = err.error as { message?: unknown; code?: unknown; type?: unknown } | undefined;
    const providerMessage = typeof body?.message === 'string' ? body.message : err.message;
    const code = typeof err.code === 'string' ? err.code : typeof err.type === 'string' ? err.type : null;
    return new ImageCallError('http', redactSecrets(providerMessage, [apiKey]), { status: err.status, retryAfterMs: retryAfter, providerCode: code });
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return new ImageCallError('timeout', '图像服务在限定时间内没有返回');
  return new ImageCallError('network', msg(err));
}

export async function openaiEditsAttempt(endpoint: ImageEndpoint, req: ImageRequest, opts: AttemptOptions): Promise<AttemptResult> {
  const client = new OpenAI({ baseURL: endpoint.base_url, apiKey: endpoint.api_key, maxRetries: 0, timeout: opts.timeoutMs });
  const secrets = [endpoint.api_key];
  let res: Awaited<ReturnType<typeof client.images.edit>>;
  try {
    const image = await Promise.all(req.images.map((im) => toFile(im.bytes, im.name, { type: im.mime })));
    res = await client.images.edit({ ...editParams(endpoint, req, opts.strip), image });
  } catch (err) {
    throw toImageCallError(err, endpoint.api_key);
  }
  const first = res.data?.[0];
  const value = first?.b64_json ?? first?.url ?? null;
  if (!value) throw new ImageCallError('bad_response', '服务返回成功，但结果里没有图像');
  const image = await materialize(value, { timeoutMs: opts.timeoutMs, userAgent: opts.userAgent, secrets });
  return { image, usage: flattenUsage(res.usage) };
}
