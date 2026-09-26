import { ChatError, type ChatErrorKind, type ChatPort, type ChatRequest, type ChatResponse, type ChatUsage } from './chat.ts';

/**
 * FakeChat — scripted transport for tests and offline tooling. Each call
 * consumes the next step: a response, an error, or a function of the request.
 */

export type FakeStep =
  | { content: string | null; finish_reason?: string; refusal?: string | null; usage?: ChatUsage | null }
  | { error: { kind: ChatErrorKind; message?: string; status?: number; retryAfterMs?: number } }
  | ((req: ChatRequest) => FakeStep | Promise<FakeStep>);

const DEFAULT_USAGE: ChatUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };

export class FakeChat implements ChatPort {
  readonly kind = 'fake' as const;
  readonly requests: ChatRequest[] = [];
  private readonly steps: FakeStep[];

  constructor(steps: FakeStep[] = [], private readonly fallback?: FakeStep) {
    this.steps = [...steps];
  }

  push(...steps: FakeStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.steps.length;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    if (req.signal?.aborted) throw new ChatError('abort', '请求已取消');
    let step = this.steps.shift() ?? this.fallback;
    if (!step) throw new ChatError('network', 'FakeChat：没有更多预设响应');
    while (typeof step === 'function') step = await step(req);
    if ('error' in step) {
      throw new ChatError(step.error.kind, step.error.message ?? `fake ${step.error.kind}`, {
        status: step.error.status ?? null,
        retryAfterMs: step.error.retryAfterMs ?? null,
      });
    }
    return {
      content: step.content,
      finish_reason: step.finish_reason ?? 'stop',
      refusal: step.refusal ?? null,
      usage: step.usage === undefined ? DEFAULT_USAGE : step.usage,
    };
  }
}
