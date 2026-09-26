import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { BreakdownOutput } from '@storyscript/contracts';
import { parseRetryAfter } from '../src/adapters/llm/chat.ts';
import { FakeChat } from '../src/adapters/llm/fake-chat.ts';
import { parseModelJson, toStrictJsonSchema } from '../src/adapters/llm/json.ts';
import { redactSecrets } from '../src/adapters/llm/redact.ts';
import { structuredCall } from '../src/adapters/llm/structured.ts';
import { MemoryCapabilityCache } from '../src/config/capability-cache.ts';

/** structuredCall unit behaviour over FakeChat (transport-independent rules). */

const client = { base_url: 'http://fake.local/v1', api_key: 'sk-unit-SECRET-abcdef123456', model: 'm' };
const Out = z.object({ items: z.array(z.object({ name: z.string(), n: z.number().nullable() })) });
const value = { items: [{ name: 'a', n: 1 }] };
const noSleep = async () => undefined;

const call = (chat: FakeChat, extra: Partial<Parameters<typeof structuredCall<z.infer<typeof Out>>>[0]> = {}) =>
  structuredCall({ client, chat, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }], schema: Out, jsonSchemaName: 'out', sleep: noSleep, backoffMs: 0, ...extra });

describe('structuredCall', () => {
  test('ladder: json_schema 400 → json_object 400 → prompt_only; all three count', async () => {
    const chat = new FakeChat([
      { error: { kind: 'http', status: 400, message: "response_format 'json_schema' is not supported" } },
      { error: { kind: 'http', status: 400, message: 'json_object response format unsupported' } },
      { content: JSON.stringify(value) },
    ]);
    const cache = new MemoryCapabilityCache();
    const res = await call(chat, { capabilityCache: cache });
    expect(res.value).toEqual(value);
    expect(res.attempts).toBe(3);
    expect(res.mode).toBe('prompt_only');
    expect(chat.requests.map((r) => r.response_format?.type ?? null)).toEqual(['json_schema', 'json_object', null]);
    expect(chat.requests[2]!.messages[0]!.content).toContain('只输出 JSON，符合以下 JSON Schema');
    expect(cache.get(client.base_url, client.model)).toBe('prompt_only');
  });

  test('a 400 about something else is not a capability problem', async () => {
    const chat = new FakeChat([{ error: { kind: 'http', status: 400, message: "This model's maximum context length is 8192 tokens" } }]);
    const res = await call(chat);
    expect(res.error?.code).toBe('PROVIDER_ERROR');
    expect(res.attempts).toBe(1);
  });

  test('network errors count: 3 failures → ATTEMPTS_EXHAUSTED', async () => {
    const chat = new FakeChat([], { error: { kind: 'network', message: 'ECONNRESET' } });
    const res = await call(chat);
    expect(res.error).toMatchObject({ code: 'ATTEMPTS_EXHAUSTED', retryable: true });
    expect(res.attempts).toBe(3);
    expect(chat.requests).toHaveLength(3);
  });

  test('zod failure → repair round with the issue list', async () => {
    const chat = new FakeChat([{ content: JSON.stringify({ items: [{ name: 1 }] }) }, { content: JSON.stringify(value) }]);
    const res = await call(chat);
    expect(res.value).toEqual(value);
    expect(res.attempts).toBe(2);
    const last = chat.requests[1]!.messages.at(-1)!;
    expect(last.content).toContain('items.0.name');
  });

  test('business validation failure is repaired; last_parsed kept when it never passes', async () => {
    const chat = new FakeChat([], { content: JSON.stringify(value) });
    const res = await call(chat, { validate: () => ({ ok: false, errors: ['名字不对'] }) });
    expect(res.error?.code).toBe('ATTEMPTS_EXHAUSTED');
    expect(res.last_parsed).toEqual(value);
    expect(res.last_errors).toEqual(['名字不对']);
    expect(res.raw_outputs).toHaveLength(3);
  });

  test('refusal and content_filter → PROVIDER_REFUSED without retry', async () => {
    const r1 = await call(new FakeChat([{ content: null, refusal: 'I cannot help with that.' }]));
    expect(r1.error?.code).toBe('PROVIDER_REFUSED');
    expect(r1.attempts).toBe(1);
    const r2 = await call(new FakeChat([{ content: '', finish_reason: 'content_filter' }]));
    expect(r2.error?.code).toBe('PROVIDER_REFUSED');
  });

  test('usage accumulates; responses without usage are counted as unknown', async () => {
    const chat = new FakeChat([{ content: 'nope', usage: null }, { content: JSON.stringify(value) }]);
    const res = await call(chat);
    expect(res.usage).toEqual({ prompt: 100, completion: 50, total: 150, unknown_calls: 1 });
  });

  test('abort → CANCELLED, no further requests', async () => {
    const ac = new AbortController();
    ac.abort();
    const chat = new FakeChat([{ content: JSON.stringify(value) }]);
    const res = await call(chat, { signal: ac.signal });
    expect(res.error?.code).toBe('CANCELLED');
    expect(chat.requests).toHaveLength(0);
  });

  test('missing config → PROVIDER_NOT_CONFIGURED without sending', async () => {
    const res = await structuredCall({ client: { ...client, api_key: '' }, messages: [], schema: Out, jsonSchemaName: 'x' });
    expect(res.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(res.attempts).toBe(0);
  });

  test('error messages are scrubbed of the key', async () => {
    const chat = new FakeChat([{ error: { kind: 'http', status: 401, message: `Incorrect API key provided: ${client.api_key}` } }]);
    const res = await call(chat);
    expect(res.error?.code).toBe('PROVIDER_ERROR');
    expect(res.error?.message).not.toContain(client.api_key);
  });
});

describe('helpers', () => {
  test('parseModelJson strips fences / prose and repairs small defects', () => {
    expect(parseModelJson('```json\n{"a": 1,}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('结果如下：{"a": [1, 2]} 以上。')).toEqual({ a: [1, 2] });
    expect(() => parseModelJson('没有 JSON')).toThrow();
  });

  test('toStrictJsonSchema closes every object and requires every property', () => {
    const s = toStrictJsonSchema(BreakdownOutput) as Record<string, unknown>;
    expect(s.$schema).toBeUndefined();
    const objects: Record<string, unknown>[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (o.type === 'object') objects.push(o);
      Object.values(o).forEach(walk);
    };
    walk(s);
    expect(objects.length).toBeGreaterThanOrEqual(4);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect(o.required).toEqual(Object.keys(o.properties as object));
    }
  });

  test('parseRetryAfter: seconds or HTTP date', () => {
    expect(parseRetryAfter('1')).toBe(1000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    const now = Date.parse('2026-09-26T00:00:00Z');
    expect(parseRetryAfter('Sat, 26 Sep 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('garbage')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  test('redactSecrets removes the configured key and key-like tokens', () => {
    const out = redactSecrets(`key sk-abcdefghijkl and Bearer abc.def-123456 and ${client.api_key}`, [client.api_key]);
    expect(out).not.toContain('sk-abcdefghijkl');
    expect(out).not.toContain('abc.def-123456');
    expect(out).not.toContain(client.api_key);
  });
});
