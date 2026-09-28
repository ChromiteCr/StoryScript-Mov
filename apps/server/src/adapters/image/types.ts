import type { ImageDialect, ImagePreset } from '@storyscript/contracts';

/**
 * ImagePort vocabulary. One attempt = one outbound HTTP request; transports
 * never retry on their own (the retry policy lives in call.ts). Every message
 * that can leave an adapter has been scrubbed of the key.
 */

export interface ImageEndpoint {
  base_url: string;
  api_key: string;
  model: string;
  dialect: ImageDialect;
  /** generations-ref only */
  preset: ImagePreset | null;
  host: string;
}

export interface ImageInput {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  name: string;
}

export type ImageQuality = 'low' | 'medium' | 'high';

export interface ImageRequest {
  prompt: string;
  /** [control image, optional style anchor] */
  images: ImageInput[];
  /** "WxH" (exact / pixels) or "21:9" (aspect_enum) */
  size: string;
  /** null → not sent */
  quality: ImageQuality | null;
}

export interface ReturnedImage {
  bytes: Uint8Array;
  mime: string;
  width: number | null;
  height: number | null;
  sha256: string;
  /** how the service delivered it */
  delivery: 'b64' | 'url';
}

export interface AttemptResult {
  image: ReturnedImage;
  /** numeric usage fields as reported (flattened, dot paths); null when absent */
  usage: Record<string, number> | null;
}

export interface AttemptOptions {
  timeoutMs: number;
  /** strip the dialect's optional params (second try after an "unknown parameter" 400) */
  strip: boolean;
  userAgent: string;
  /** transport to the service (hosted: public https only) */
  fetch: typeof fetch;
}

/** One transport attempt. Throws ImageCallError. */
export type ImageAttempt = (endpoint: ImageEndpoint, req: ImageRequest, opts: AttemptOptions) => Promise<AttemptResult>;

export type ImageErrorKind =
  /** HTTP error status from the service */
  | 'http'
  /** no answer within the timeout (the request may have been processed and billed) */
  | 'timeout'
  /** connection dropped mid-request (may have been processed) */
  | 'network'
  /** the service could not be reached at all (connection refused, DNS) — nothing was processed */
  | 'unreached'
  /** 2xx without a usable image */
  | 'bad_response';

export class ImageCallError extends Error {
  readonly kind: ImageErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  /** provider error code / type, e.g. moderation_blocked */
  readonly providerCode: string | null;

  constructor(kind: ImageErrorKind, message: string, opts: { status?: number | null; retryAfterMs?: number | null; providerCode?: string | null } = {}) {
    super(message);
    this.name = 'ImageCallError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.providerCode = opts.providerCode ?? null;
  }
}

/** Flatten numeric leaves of a usage object into dot paths (strings/null dropped). */
export function flattenUsage(value: unknown): Record<string, number> | null {
  if (value === null || typeof value !== 'object') return null;
  const out: Record<string, number> = {};
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'number' && Number.isFinite(v)) out[path] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(value, '');
  return Object.keys(out).length ? out : null;
}
