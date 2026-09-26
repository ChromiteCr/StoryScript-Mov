import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Fake OpenAI-compatible HTTP service on 127.0.0.1 (random port) for tests.
 * Replies to POST /v1/chat/completions are scripted in order; every request
 * is recorded so tests can assert outbound counts and response_format.
 */

export type FakeReply =
  | { type: 'content'; content: string | null; finish_reason?: string; usage?: Record<string, number> | null; refusal?: string | null }
  | { type: 'status'; status: number; message?: string; headers?: Record<string, string> }
  /** error whose message echoes the Authorization header (providers sometimes leak keys) */
  | { type: 'echo_auth'; status: number }
  /** never answers until the client aborts */
  | { type: 'hang' };

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: {
    model?: string;
    messages?: { role: string; content: string }[];
    response_format?: { type: string; json_schema?: { name: string; strict: boolean; schema: Record<string, unknown> } };
  } | null;
}

export const reply = {
  json: (value: unknown, usage?: Record<string, number> | null): FakeReply => ({ type: 'content', content: JSON.stringify(value), usage }),
  fenced: (value: unknown): FakeReply => ({ type: 'content', content: `下面是结果：\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`` }),
  text: (content: string): FakeReply => ({ type: 'content', content }),
  invalid: (): FakeReply => ({ type: 'content', content: '抱歉，我无法按要求输出。' }),
  empty: (): FakeReply => ({ type: 'content', content: '' }),
  truncated: (value: unknown): FakeReply => ({ type: 'content', content: JSON.stringify(value).slice(0, 40), finish_reason: 'length' }),
  unsupportedSchema: (): FakeReply => ({
    type: 'status',
    status: 400,
    message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
  }),
  rateLimited: (retryAfter = '1'): FakeReply => ({ type: 'status', status: 429, message: 'Rate limit reached', headers: { 'retry-after': retryAfter } }),
  serverError: (status = 500): FakeReply => ({ type: 'status', status, message: 'The server had an error while processing your request.' }),
  hang: (): FakeReply => ({ type: 'hang' }),
};

export interface FakeOpenAI {
  /** base_url to configure, ends in /v1 */
  readonly url: string;
  readonly requests: RecordedRequest[];
  chatRequests(): RecordedRequest[];
  enqueue(...replies: FakeReply[]): void;
  readonly pending: number;
  /** ids served by GET /v1/models; null → 404 */
  models: string[] | null;
  /** resolves when a 'hang' request has arrived */
  waitForHang(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_USAGE = { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const queue: FakeReply[] = [];
  const requests: RecordedRequest[] = [];
  const hanging = new Set<ServerResponse>();
  let hangWaiters: (() => void)[] = [];
  const state = { models: ['fake-model', 'other-model'] as string[] | null };

  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const path = (req.url ?? '/').split('?')[0]!;
      let body: RecordedRequest['body'] = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      requests.push({ method: req.method ?? 'GET', path, authorization: req.headers.authorization, body });

      if (req.method === 'GET' && path === '/v1/models') {
        if (state.models === null) return send(res, 404, { error: { message: 'Not found' } });
        return send(res, 200, { object: 'list', data: state.models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake' })) });
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') return send(res, 404, { error: { message: 'Not found' } });

      const r = queue.shift();
      if (!r) return send(res, 500, { error: { message: 'fake-openai: no scripted reply', type: 'server_error' } });
      switch (r.type) {
        case 'content':
          return send(res, 200, {
            id: `chatcmpl-${requests.length}`,
            object: 'chat.completion',
            created: 0,
            model: body?.model ?? 'fake-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: r.content, refusal: r.refusal ?? null },
                finish_reason: r.finish_reason ?? 'stop',
              },
            ],
            ...(r.usage === null ? {} : { usage: r.usage ?? DEFAULT_USAGE }),
          });
        case 'status':
          return send(res, r.status, { error: { message: r.message ?? `status ${r.status}`, type: 'invalid_request_error', code: null } }, r.headers);
        case 'echo_auth':
          return send(res, r.status, { error: { message: `Incorrect API key provided: ${req.headers.authorization ?? ''}`, type: 'invalid_request_error' } });
        case 'hang':
          hanging.add(res);
          res.on('close', () => hanging.delete(res));
          for (const w of hangWaiters) w();
          hangWaiters = [];
          return;
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    chatRequests: () => requests.filter((r) => r.path === '/v1/chat/completions'),
    enqueue: (...replies) => queue.push(...replies),
    get pending() {
      return queue.length;
    },
    get models() {
      return state.models;
    },
    set models(v) {
      state.models = v;
    },
    waitForHang: () =>
      new Promise<void>((resolve) => {
        if (hanging.size > 0) resolve();
        else hangWaiters.push(resolve);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
