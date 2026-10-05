import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { FakeChat } from '../src/adapters/llm/fake-chat.ts';
import { structuredCall } from '../src/adapters/llm/structured.ts';

/**
 * S4c: structuredCall's optional refine round — one more request on a valid
 * output the caller has hints for, kept only when it validates and is better,
 * always inside the step's 3 outbound attempts.
 */

const client = { base_url: 'http://fake.local/v1', api_key: 'sk-unit-SECRET-abcdef123456', model: 'm' };
const Out = z.object({ items: z.array(z.object({ name: z.string(), n: z.number().nullable() })) });
type Out = z.infer<typeof Out>;
const one: Out = { items: [{ name: 'a', n: 1 }] };
const two: Out = { items: [{ name: 'a', n: 1 }, { name: 'b', n: 2 }] };
const noSleep = async () => undefined;

/** hints while there is only one item; more items is better */
const refining = {
  refine: (v: Out) => (v.items.length < 2 ? ['只有一项，再加一项'] : []),
  refineBetter: (next: Out, prev: Out) => next.items.length > prev.items.length,
};

const call = (chat: FakeChat, extra: Partial<Parameters<typeof structuredCall<Out>>[0]> = {}) =>
  structuredCall<Out>({
    client,
    chat,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }],
    schema: Out,
    jsonSchemaName: 'out',
    sleep: noSleep,
    backoffMs: 0,
    ...refining,
    ...extra,
  });

describe('structuredCall refine round', () => {
  test('adopted: a valid, better answer replaces the original', async () => {
    const sent: number[] = [];
    const chat = new FakeChat([{ content: JSON.stringify(one) }, { content: JSON.stringify(two) }]);
    const res = await call(chat, { onAttempt: (n) => sent.push(n) });
    expect(res.value).toEqual(two);
    expect(res.value_raw).toBe(JSON.stringify(two));
    expect(res.refine).toEqual({ hints: ['只有一项，再加一项'], adopted: true, reason: null });
    expect(res.attempts).toBe(2);
    expect(sent).toEqual([1, 2]);
    expect(res.usage.total).toBe(300);
    expect(res.raw_outputs).toHaveLength(2);
    // the second request: the step's messages, the valid output, then the hints
    const msgs = chat.requests[1]!.messages;
    expect(msgs.slice(0, 2).map((m) => m.content)).toEqual(['sys', 'u']);
    expect(msgs[2]).toEqual({ role: 'assistant', content: JSON.stringify(one) });
    expect(msgs[3]!.content).toContain('- 只有一项，再加一项');
    expect(msgs[3]!.content).toContain('保留原有剧情内容、台词和出处原文');
    expect(chat.requests[1]!.response_format?.type).toBe('json_schema');
  });

  test('no hints: no refine round', async () => {
    const chat = new FakeChat([{ content: JSON.stringify(two) }]);
    const res = await call(chat);
    expect(res).toMatchObject({ value: two, attempts: 1 });
    expect(res.refine).toBeUndefined();
    expect(chat.requests).toHaveLength(1);
  });

  test('rejected: an invalid answer keeps the original, without a repair round', async () => {
    const chat = new FakeChat([{ content: JSON.stringify(one) }, { content: JSON.stringify({ items: [{ name: 1 }] }) }, { content: JSON.stringify(two) }]);
    const res = await call(chat);
    expect(res.value).toEqual(one);
    expect(res.value_raw).toBe(JSON.stringify(one));
    expect(res.refine).toMatchObject({ adopted: false });
    expect(res.refine!.reason).toContain('JSON Schema');
    expect(res.attempts).toBe(2);
    expect(chat.remaining).toBe(1);
    expect(res.last_parsed).toBeUndefined();
  });

  test('rejected: an answer that fails business validation, or is not better, keeps the original', async () => {
    const invalid = await call(new FakeChat([{ content: JSON.stringify(one) }, { content: JSON.stringify(two) }]), {
      validate: (v) => (v.items.some((x) => x.name === 'b') ? { ok: false, errors: ['不要 b'] } : { ok: true, errors: [] }),
    });
    expect(invalid.value).toEqual(one);
    expect(invalid.refine!.reason).toContain('不要 b');
    expect(invalid.error).toBeUndefined();

    const worse = await call(new FakeChat([{ content: JSON.stringify(one) }, { content: JSON.stringify({ items: [{ name: 'z', n: null }] }) }]));
    expect(worse.value).toEqual(one);
    expect(worse.refine).toMatchObject({ adopted: false, reason: '调整后的结果没有更好' });
    expect(worse.attempts).toBe(2);

    // without refineBetter any valid answer is kept
    const any = await call(new FakeChat([{ content: JSON.stringify(one) }, { content: JSON.stringify({ items: [{ name: 'z', n: null }] }) }]), { refineBetter: undefined });
    expect(any.value).toEqual({ items: [{ name: 'z', n: null }] });
  });

  test('rejected: transport errors and empty answers are not retried', async () => {
    for (const step of [
      { error: { kind: 'http' as const, status: 500, message: 'boom' } },
      { error: { kind: 'http' as const, status: 429, message: 'slow down', retryAfterMs: 10 } },
      { error: { kind: 'network' as const, message: 'ECONNRESET' } },
      { content: '' },
      { content: '{"items":[', finish_reason: 'length' },
    ]) {
      const chat = new FakeChat([{ content: JSON.stringify(one) }, step, { content: JSON.stringify(two) }]);
      const res = await call(chat);
      expect(res.value, JSON.stringify(step)).toEqual(one);
      expect(res.error).toBeUndefined();
      expect(res.attempts).toBe(2);
      expect(res.refine!.adopted).toBe(false);
      expect(chat.remaining).toBe(1);
    }
  });

  test('the cap: a refine round only while an attempt is left, never a fourth request', async () => {
    const bad = { content: JSON.stringify({ items: [{ name: 1 }] }) };
    const late = new FakeChat([bad, bad, { content: JSON.stringify(one) }, { content: JSON.stringify(two) }]);
    const r3 = await call(late);
    expect(r3).toMatchObject({ value: one, attempts: 3 });
    expect(r3.refine).toBeUndefined();
    expect(late.requests).toHaveLength(3);

    const second = new FakeChat([bad, { content: JSON.stringify(one) }, { content: JSON.stringify(two) }]);
    const r2 = await call(second);
    expect(r2).toMatchObject({ value: two, attempts: 3 });
    expect(r2.refine!.adopted).toBe(true);

    const capped = new FakeChat([{ content: JSON.stringify(one) }, { content: JSON.stringify(two) }]);
    const r1 = await call(capped, { maxAttempts: 1 });
    expect(r1).toMatchObject({ value: one, attempts: 1 });
    expect(capped.requests).toHaveLength(1);
  });

  test('at most one refine round, even with hints left and attempts to spare', async () => {
    const chat = new FakeChat([{ content: JSON.stringify(one) }, { content: JSON.stringify(two) }, { content: JSON.stringify(two) }]);
    const res = await call(chat, { refine: () => ['再改改'], refineBetter: () => true });
    expect(res.attempts).toBe(2);
    expect(chat.remaining).toBe(1);
  });

  test('cancellation before or during the refine round → CANCELLED', async () => {
    const before = new AbortController();
    const chat1 = new FakeChat([{ content: JSON.stringify(one) }, { content: JSON.stringify(two) }]);
    const r1 = await call(chat1, {
      signal: before.signal,
      refine: () => {
        before.abort();
        return ['再加一项'];
      },
    });
    expect(r1.error?.code).toBe('CANCELLED');
    expect(r1.value).toBeUndefined();
    expect(chat1.requests).toHaveLength(1);

    const during = new AbortController();
    const chat2 = new FakeChat([
      { content: JSON.stringify(one) },
      () => {
        during.abort();
        return { error: { kind: 'abort', message: 'aborted' } };
      },
    ]);
    const r2 = await call(chat2, { signal: during.signal });
    expect(r2.error?.code).toBe('CANCELLED');
    expect(r2.attempts).toBe(2);

    // aborted while the answer was on its way: still cancelled, not adopted
    const late = new AbortController();
    const chat3 = new FakeChat([
      { content: JSON.stringify(one) },
      () => {
        late.abort();
        return { content: JSON.stringify(two) };
      },
    ]);
    const r3 = await call(chat3, { signal: late.signal });
    expect(r3.error?.code).toBe('CANCELLED');
  });
});
