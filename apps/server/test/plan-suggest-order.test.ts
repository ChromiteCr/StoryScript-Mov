import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DraftDetail, Job, PlanDetail, Setup } from '@storyscript/contracts';
import { orderReplayKey } from '../src/adapters/llm/replay-chat.ts';
import { startFakeOpenAI, reply, type FakeOpenAI } from './helpers/fake-openai.ts';
import { TEST_KEY, llmEnv } from './helpers/m3-app.ts';
import { W, expectOk, makePlanApp, makeResource, makeSetup, makeShot, seedWorld, waitJob, type PlanApp } from './helpers/plan-app.ts';

/**
 * LLM shooting-order suggestion end to end against a fake OpenAI-compatible
 * HTTP service (real OpenAIChat transport, maxRetries 0): the model sees
 * setup keys only, the result is a draft (kind 'order') mapped back to setup
 * ids, and adopting it re-plans through reorder + validate. At most 3
 * outbound requests; none at all without a key.
 */

let fake: FakeOpenAI;
let app: PlanApp;
let X: Setup;
let Y: Setup;
let planId: string;

async function seed(target: PlanApp): Promise<string> {
  const w = await seedWorld(target);
  const [s1] = w.scenes as [(typeof w.scenes)[0]];
  const loc = await makeResource(target, 'location', '书店', [W('09:00', '18:00')], [w.shop.id]);
  await makeResource(target, 'performer', '演员甲', [W('14:00', '15:00')], [w.c1.id]);
  const a = await makeShot(target, s1, { subjects: [{ alias: w.c1.alias, facing: 'camera' }], action: '老周抬头' });
  const b = await makeShot(target, s1, { action: '书架长镜头' });
  X = await makeSetup(target, 'X', [a.id], { location: loc.id, durations: { setup_min: 0, per_shot_min: 60, reset_min: 0 } });
  Y = await makeSetup(target, 'Y', [b.id], { location: loc.id, durations: { setup_min: 60, per_shot_min: 180, reset_min: 60 } });
  const created = await expectOk<PlanDetail>(target.post('/api/v1/plans', { date: '2026-10-05', crew_call: '09:00', crew_wrap: '18:00' }), 201);
  // the scheduler finds Y 09–14, X 14–15 on its own; force a bad manual order
  // (X first) so the suggestion has something to fix
  expect(created.plan.result.outcome).toBe('feasible');
  const bad = await expectOk<PlanDetail>(target.post(`/api/v1/plans/${created.plan.id}/reorder`, { expected_revision: 0, order: [X.id, Y.id] }));
  expect(bad.plan.result.outcome).toBe('partial');
  // keys follow the current order → u1 = X, u2 = Y
  expect(bad.plan.result.order).toEqual([X.id, Y.id]);
  return created.plan.id;
}

async function suggest(): Promise<{ job: Job; detail: DraftDetail | null }> {
  const res = await app.post<{ job_id: string }>(`/api/v1/plans/${planId}/suggest-order`);
  expect(res.status, res.text).toBe(202);
  const job = await waitJob(app, res.data.job_id);
  if (!job.result_ref) return { job, detail: null };
  return { job, detail: await expectOk<DraftDetail>(app.get(`/api/v1/drafts/${job.result_ref}`)) };
}

describe('suggest-order with a configured text model', () => {
  beforeEach(async () => {
    fake = await startFakeOpenAI();
    app = await makePlanApp({ env: llmEnv(fake.url) });
    planId = await seed(app);
  });

  afterEach(async () => {
    app.close();
    await fake.close();
  });

  test('model order → draft → adopt → validated feasible plan, one outbound request', async () => {
    fake.enqueue(reply.json({ setup_order: ['u2', 'u1'], rationale: '先拍需要整段时间的大场面，演员下午到场后再拍特写。' }));
    const { job, detail } = await suggest();
    expect(job.status).toBe('succeeded');
    expect(job.kind).toBe('suggest_order');
    expect(job.remote).toBe(true);
    expect(job.attempts).toBe(1);
    expect(fake.chatRequests()).toHaveLength(1);

    const sent = fake.chatRequests()[0]!;
    expect(sent.authorization).toBe(`Bearer ${TEST_KEY}`);
    const user = sent.body!.messages!.find((m) => m.role === 'user')!.content;
    expect(user).toContain('u1｜X');
    expect(user).toContain('u2｜Y');
    expect(user).toContain('演员甲：14:00–15:00');
    expect(user).not.toContain(X.id); // the model never sees ids
    expect(sent.body!.response_format?.type).toBe('json_schema');

    expect(detail!.draft.kind).toBe('order');
    expect(detail!.draft.status).toBe('pending');
    expect(detail!.draft.parsed).toEqual({ setup_order: [Y.id, X.id], rationale: expect.stringContaining('大场面') });
    expect(detail!.draft.scope).toMatchObject({ plan_id: planId });

    const adopted = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${planId}/adopt-suggestion`, { expected_revision: 1, draft_id: detail!.draft.id }));
    expect(adopted.plan.result.order).toEqual([Y.id, X.id]);
    expect(adopted.plan.result.outcome).toBe('feasible');
    expect(adopted.plan.result.violations).toEqual([]);
    expect(adopted.plan.revision).toBe(2);
    // a draft is adopted once
    const twice = await app.post(`/api/v1/plans/${planId}/adopt-suggestion`, { expected_revision: 2, draft_id: detail!.draft.id });
    expect(twice.status).toBe(409);
  });

  test('a reply that misses a key is repaired within the 3-attempt budget', async () => {
    fake.enqueue(reply.json({ setup_order: ['u1'], rationale: '只排一个' }), reply.json({ setup_order: ['U2 ', 'u1'], rationale: '修正后' }));
    const { job, detail } = await suggest();
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(2);
    expect(fake.chatRequests()).toHaveLength(2);
    const repair = fake.chatRequests()[1]!.body!.messages!.at(-1)!.content;
    expect(repair).toContain('u2');
    expect(detail!.draft.parsed).toMatchObject({ setup_order: [Y.id, X.id] });
  });

  test('three invalid replies → failed job, failed draft, exactly 3 outbound requests', async () => {
    fake.enqueue(
      reply.json({ setup_order: ['u1', 'u1'], rationale: '' }),
      reply.json({ setup_order: ['u3', 'u2'], rationale: '' }),
      reply.json({ setup_order: [], rationale: '' }),
      reply.json({ setup_order: ['u2', 'u1'], rationale: '不该被请求' }),
    );
    const { job, detail } = await suggest();
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(3);
    expect(fake.chatRequests()).toHaveLength(3);
    expect(detail!.draft.status).toBe('failed');
    expect(detail!.draft.parsed).toBeNull();
    const adopt = await app.post(`/api/v1/plans/${planId}/adopt-suggestion`, { expected_revision: 1, draft_id: detail!.draft.id });
    expect(adopt.status).toBe(409);
  });
});

describe('suggest-order without a usable model', () => {
  test('no key → 409 PROVIDER_NOT_CONFIGURED and nothing is sent', async () => {
    fake = await startFakeOpenAI();
    app = await makePlanApp({ env: {} });
    try {
      planId = await seed(app);
      const res = await app.post(`/api/v1/plans/${planId}/suggest-order`);
      expect(res.status).toBe(409);
      expect(res.body.error!.code).toBe('PROVIDER_NOT_CONFIGURED');
      expect(fake.requests).toHaveLength(0);
    } finally {
      app.close();
      await fake.close();
    }
  });

  test('--demo without a recording → failed job with a clear message, no network', async () => {
    app = await makePlanApp({ demo: true, ai: { replayDir: '/nonexistent-replay-dir' } });
    try {
      planId = await seed(app);
      const { job, detail } = await suggest();
      expect(job.status).toBe('failed');
      expect(job.remote).toBe(false);
      expect(job.error!.message).toContain('演示模式没有这份计划的排序建议录制');
      expect(detail!.draft.status).toBe('failed');
    } finally {
      app.close();
    }
  });
});

describe('order replay key', () => {
  test('pairs each positional key with its setup label: the same setups in another order → another recording', () => {
    const ab = orderReplayKey([
      { key: 'u1', label: '场1 · 平视' },
      { key: 'u2', label: '场2 · 俯拍' },
    ]);
    const ba = orderReplayKey([
      { key: 'u1', label: '场2 · 俯拍' },
      { key: 'u2', label: '场1 · 平视' },
    ]);
    expect(ab).not.toBe(ba);
    // labels compare normalised (spacing, full-width forms), like scene headings
    const spaced = orderReplayKey([
      { key: 'u1', label: '场１　·　平视' },
      { key: 'u2', label: '场2 ·俯拍' },
    ]);
    expect(spaced).toBe(ab);
  });
});
