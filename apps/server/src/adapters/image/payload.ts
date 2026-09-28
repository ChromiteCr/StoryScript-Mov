import { createHash } from 'node:crypto';
import { redactSecrets } from '../llm/redact.ts';
import { imageInfo } from './sniff.ts';
import { ImageCallError, type ReturnedImage } from './types.ts';

/**
 * Turn what a service returned (base64, data URL or http(s) URL) into bytes.
 * URLs are downloaded immediately — they expire — with our User-Agent and
 * without the Authorization header (the URL belongs to a storage host).
 */

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function finish(bytes: Uint8Array, delivery: ReturnedImage['delivery']): ReturnedImage {
  if (bytes.length === 0) throw new ImageCallError('bad_response', '服务返回了空图像');
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageCallError('bad_response', '服务返回的图像超过 50MB，已丢弃');
  const info = imageInfo(bytes);
  if (!info) throw new ImageCallError('bad_response', '服务返回的数据不是可识别的图像（PNG/JPEG/GIF/WebP）');
  return { bytes, mime: info.mime, width: info.width, height: info.height, sha256: sha256Hex(bytes), delivery };
}

export interface DownloadOptions {
  timeoutMs: number;
  userAgent: string;
  secrets: readonly string[];
  /** default: global fetch (hosted: public https only) */
  fetch?: typeof fetch;
}

export async function downloadImage(url: string, opts: DownloadOptions): Promise<ReturnedImage> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { headers: { 'User-Agent': opts.userAgent, Accept: 'image/*' }, signal: AbortSignal.timeout(opts.timeoutMs), redirect: 'follow' });
  } catch (err) {
    const timeout = err instanceof Error && err.name === 'TimeoutError';
    throw new ImageCallError('bad_response', timeout ? '图像已生成，但下载超时；请到服务商后台查看' : redactSecrets(`图像已生成，但下载失败：${err instanceof Error ? err.message : String(err)}`, opts.secrets));
  }
  if (!res.ok) throw new ImageCallError('bad_response', `图像已生成，但下载失败（HTTP ${res.status}）`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return finish(bytes, 'url');
}

/** base64 / data URL / http(s) URL → image bytes. */
export async function materialize(value: string, opts: DownloadOptions): Promise<ReturnedImage> {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return downloadImage(v, opts);
  const b64 = v.startsWith('data:') ? v.slice(v.indexOf(',') + 1) : v;
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(b64)) throw new ImageCallError('bad_response', '服务返回的图像数据格式无法识别');
  return finish(new Uint8Array(Buffer.from(b64, 'base64')), 'b64');
}

/** Error codes of fetch failures, walking cause / AggregateError chains. */
export function errorCodes(err: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (e: unknown) => {
    if (!e || typeof e !== 'object' || seen.has(e)) return;
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') out.push(code);
    walk((e as { cause?: unknown }).cause);
    const errors = (e as { errors?: unknown }).errors;
    if (Array.isArray(errors)) errors.forEach(walk);
  };
  walk(err);
  return out;
}

/** Connection never established: nothing reached the service. */
const UNREACHED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']);

export function isUnreached(err: unknown): boolean {
  return errorCodes(err).some((c) => UNREACHED.has(c));
}
