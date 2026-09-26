/**
 * ChatPort — the one transport structuredCall talks to. Implementations:
 *   OpenAIChat  (openai SDK, chat.completions, maxRetries 0)
 *   FakeChat    (scripted responses/errors for tests)
 *   ReplayChat  (recorded outputs from fixtures/replay for --demo / E2E)
 * Transports never retry on their own; every call is one outbound attempt.
 */

export interface TextClientConfig {
  base_url: string;
  api_key: string;
  model: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ResponseFormat =
  | { type: 'json_schema'; json_schema: { name: string; strict: true; schema: Record<string, unknown> } }
  | { type: 'json_object' };

export interface ChatRequestMeta {
  /** prompt version, e.g. breakdown-v1 (ReplayChat lookup, logging) */
  prompt_version?: string;
  /** stable key of the input for replay lookup (scene heading hash, script hash) */
  replay_key?: string;
}

export interface ChatRequest {
  model: string;
  messages: LlmMessage[];
  response_format?: ResponseFormat;
  signal?: AbortSignal;
  meta?: ChatRequestMeta;
}

export interface ChatUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface ChatResponse {
  content: string | null;
  finish_reason: string | null;
  refusal: string | null;
  usage: ChatUsage | null;
}

export interface ChatPort {
  readonly kind: 'openai' | 'fake' | 'replay';
  complete(req: ChatRequest): Promise<ChatResponse>;
}

export type ChatErrorKind = 'http' | 'network' | 'timeout' | 'abort' | 'replay_miss';

/** Transport failure, already stripped of secrets. */
export class ChatError extends Error {
  readonly kind: ChatErrorKind;
  readonly status: number | null;
  /** parsed Retry-After in ms (429), capped by the caller */
  readonly retryAfterMs: number | null;

  constructor(kind: ChatErrorKind, message: string, opts: { status?: number | null; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = 'ChatError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/** Retry-After header: delta-seconds or an HTTP date → ms (null when absent/invalid). */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}
