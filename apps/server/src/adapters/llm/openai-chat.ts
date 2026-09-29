import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { ChatError, parseRetryAfter, type ChatPort, type ChatRequest, type ChatResponse, type TextClientConfig } from './chat.ts';
import { redactSecrets } from './redact.ts';

export const LLM_TIMEOUT_MS = 120_000;

/**
 * Real transport on the official openai SDK. `maxRetries: 0` — the SDK must
 * never retry on its own: structuredCall counts every outbound request.
 */
export class OpenAIChat implements ChatPort {
  readonly kind = 'openai' as const;
  private readonly client: OpenAI;
  private readonly apiKey: string;

  constructor(cfg: TextClientConfig, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}) {
    this.apiKey = cfg.api_key;
    this.client = new OpenAI({
      baseURL: cfg.base_url,
      apiKey: cfg.api_key,
      maxRetries: 0,
      timeout: opts.timeoutMs ?? LLM_TIMEOUT_MS,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    try {
      const res = await this.client.chat.completions.create(
        {
          ...(req.extra_body ?? {}),
          model: req.model,
          messages: req.messages,
          ...(req.response_format ? { response_format: req.response_format } : {}),
        },
        { signal: req.signal },
      );
      const choice = res.choices?.[0];
      const u = res.usage;
      return {
        content: choice?.message?.content ?? null,
        finish_reason: choice?.finish_reason ?? null,
        refusal: choice?.message?.refusal ?? null,
        usage: u
          ? {
              prompt_tokens: u.prompt_tokens ?? null,
              completion_tokens: u.completion_tokens ?? null,
              total_tokens: u.total_tokens ?? null,
            }
          : null,
      };
    } catch (err) {
      throw toChatError(err, this.apiKey);
    }
  }
}

export function toChatError(err: unknown, apiKey: string): ChatError {
  const msg = (e: unknown) => redactSecrets(e instanceof Error ? e.message : String(e), [apiKey]);
  if (err instanceof ChatError) return err;
  if (err instanceof APIUserAbortError) return new ChatError('abort', '请求已取消');
  if (err instanceof APIConnectionTimeoutError) return new ChatError('timeout', '请求超时');
  if (err instanceof APIConnectionError) return new ChatError('network', `网络错误：${msg(err)}`);
  if (err instanceof APIError && typeof err.status === 'number') {
    const headers = err.headers as Headers | undefined;
    const retryAfter =
      parseRetryAfter(headers?.get?.('retry-after-ms') ? String(Number(headers.get('retry-after-ms')) / 1000) : null) ??
      parseRetryAfter(headers?.get?.('retry-after'));
    return new ChatError('http', msg(err), { status: err.status, retryAfterMs: retryAfter });
  }
  if (err instanceof Error && err.name === 'AbortError') return new ChatError('abort', '请求已取消');
  return new ChatError('network', msg(err));
}
