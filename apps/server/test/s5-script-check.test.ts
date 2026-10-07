import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Job, ScriptCheckOutput, ScriptCheckView, ScriptRisk } from '@storyscript/contracts';
import { runWithRequest, syncMember, type Actor, type HostedRequest } from '../src/collab/actor.ts';
import { insertJob } from '../src/db/repos/job.ts';
import type { AppDeps } from '../src/deps.ts';
import { isAppError } from '../src/http/errors.ts';
import { setRiskHandled } from '../src/services/check.ts';
import { assertJobQuota } from '../src/services/quota.ts';
import { reply, startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.ts';
import { fixtureText, importFixture, llmEnv, makeM3App, replayOutput, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * S5 剧本体检: the length estimate, one remote job over the whole script, the
 * difficulties kept (quotes checked, a repair round, a partial answer), the
 * ticks (who ticked, carried over to a re-check) and stale items after the
 * script changes.
 */

const DEMO = replayOutput('01-bookshop.check-v1.json') as ScriptCheckOutput;
const RAIN = DEMO.risks[2]!;
const LOCATION = DEMO.risks[0]!;

let fake: FakeOpenAI;
let app: M3App;

async function runCheck(): Promise<Job> {
  const res = await app.post<{ job_id: string }>('/api/v1/scripts/check');
  expect(res.status, res.text).toBe(202);
  return waitJob(app, res.data.job_id);
}
const view = async () => (await app.get<ScriptCheckView>('/api/v1/scripts/check')).data;

beforeEach(async () => {
  fake = await startFakeOpenAI();
  app = await makeM3App({ env: llmEnv(fake.url) });
});

afterEach(async () => {
  app.close();
  await fake.close();
});

describe('length estimate', () => {
  test('no script: no estimate, no check, and a check cannot start', async () => {
    expect(await view()).toEqual({ estimate: null, check: null, risks: [] });
    const res = await app.post('/api/v1/scripts/check');
    expect(res.status).toBe(409);
    expect(fake.requests).toHaveLength(0);
  });

  test('per scene from the text, with the heading tags; no shots yet', async () => {
    const imported = await importFixture(app, '01-bookshop.txt', 'txt');
    const est = (await view()).estimate!;
    expect(est.scenes.map((s) => [s.display_no, s.seconds, s.int_ext, s.time_label])).toEqual([
      ['1', 108, 'int', '日'],
      ['2', 37, 'int', '日'],
    ]);
    expect(est.seconds).toBe(145);
    expect(est.scenes[0]!.scene_id).toBe(imported.scenes[0]!.id);
    expect(est.scenes[0]!.shots_seconds).toBeNull();
  });
});

describe('the check job', () => {
  beforeEach(async () => {
    await importFixture(app, '01-bookshop.txt', 'txt');
  });

  test('one request with the numbered script; the difficulties land in their scenes', async () => {
    fake.enqueue(reply.json(DEMO, { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 }));
    const job = await runCheck();
    expect(job).toMatchObject({ kind: 'check_script', status: 'succeeded', attempts: 1, remote: true });
    expect(job.usage).toMatchObject({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 });
    const sent = fake.chatRequests()[0]!.body!.messages!;
    expect(sent[0]!.content).toContain('permit_location');
    expect(sent[1]!.content).toContain('[p-005] 门铃响了一声');
    expect(sent[1]!.content).toContain('## [p-020] 2. 内景 旧书店后屋 日');

    const v = await view();
    const scenes = (await app.get<{ scenes: { id: string }[] }>('/api/v1/scripts/current')).data.scenes;
    expect(v.check).toMatchObject({ status: 'done', current: true, prompt_version: 'check-v1', model: 'fake-model', issues: [] });
    expect(v.risks.map((r) => [r.category, r.severity, r.paragraph_id, r.stale])).toEqual([
      ['permit_location', 'medium', 'p-002', false],
      ['vfx', 'low', 'p-003', false],
      ['rain_water', 'low', 'p-005', false],
      ['period', 'low', 'p-021', false],
    ]);
    expect(v.risks.map((r) => r.scene_id)).toEqual([scenes[0]!.id, scenes[0]!.id, scenes[0]!.id, scenes[1]!.id]);
    expect(v.risks.every((r) => r.handled === null)).toBe(true);
  });

  test('a quote not in the script gets a repair round; the second answer is kept', async () => {
    fake.enqueue(reply.json({ risks: [{ ...RAIN, quote: '她浑身湿透地站在门口' }] }));
    fake.enqueue(reply.json({ risks: [RAIN] }));
    const job = await runCheck();
    expect(job.attempts).toBe(2);
    const repair = fake.chatRequests()[1]!.body!.messages!.at(-1)!.content;
    expect(repair).toContain('找不到');
    const v = await view();
    expect(v.check!.status).toBe('done');
    expect(v.risks).toHaveLength(1);
  });

  test('rounds used up: what is usable is kept as a partial check, the rest dropped with a note', async () => {
    const bad = { ...LOCATION, category: 'crowd', quote: '店里挤满了来淘书的人' };
    for (let i = 0; i < 3; i++) fake.enqueue(reply.json({ risks: [bad, RAIN] }));
    const job = await runCheck();
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(3);
    const v = await view();
    expect(v.check!.status).toBe('partial');
    expect(v.risks.map((r) => r.category)).toEqual(['rain_water']);
    expect(v.check!.issues.map((i) => i.code)).toContain('quote_not_found');
  });

  test('no usable answer: the job fails and no check is stored', async () => {
    for (let i = 0; i < 3; i++) fake.enqueue(reply.invalid());
    const job = await runCheck();
    expect(job.status).toBe('failed');
    expect((await view()).check).toBeNull();
  });

  test('ticks: on and off; a re-check keeps the tick on the same difficulty', async () => {
    fake.enqueue(reply.json(DEMO));
    await runCheck();
    const rain = (await view()).risks.find((r) => r.category === 'rain_water')!;
    const on = await app.put<ScriptRisk>(`/api/v1/scripts/risks/${rain.id}/handled`, { handled: true });
    expect(on.status, on.text).toBe(200);
    expect(on.data.handled).toMatchObject({ actor: null });
    const off = await app.put<ScriptRisk>(`/api/v1/scripts/risks/${rain.id}/handled`, { handled: false });
    expect(off.data.handled).toBeNull();
    await app.put(`/api/v1/scripts/risks/${rain.id}/handled`, { handled: true });

    // the next answer words the quote a little differently
    fake.enqueue(reply.json({ risks: [{ ...RAIN, quote: '外套肩上还有雨点。她在门口停了一下' }, LOCATION] }));
    await runCheck();
    const after = (await view()).risks;
    expect(after.find((r) => r.category === 'rain_water')!.handled).not.toBeNull();
    expect(after.find((r) => r.category === 'permit_location')!.handled).toBeNull();
    expect((await app.put(`/api/v1/scripts/risks/${randomUUID()}/handled`, { handled: true })).status).toBe(404);
  });

  test('after the script changes: found again in the new version, or stale', async () => {
    fake.enqueue(reply.json(DEMO));
    await runCheck();
    const text = fixtureText('01-bookshop.txt').replace('外套肩上还有雨点。', '').replace('1. 内景 旧书店 日', '1. 内景 旧书店 日\n\n林晓在门外犹豫了一会儿。');
    const next = await importFixture(app, '01-bookshop.txt', 'txt', text);
    const v = await view();
    expect(v.check!.current).toBe(false);
    const rain = v.risks.find((r) => r.category === 'rain_water')!;
    expect(rain).toMatchObject({ stale: true, paragraph_id: null, scene_id: null });
    const location = v.risks.find((r) => r.category === 'permit_location')!;
    expect(location).toMatchObject({ stale: false, scene_id: next.scenes[0]!.id });
    // a paragraph was added above: the old photo moved to another paragraph id
    const period = v.risks.find((r) => r.category === 'period')!;
    expect(period.paragraph_id).toBe('p-022');
    expect(period.scene_id).toBe(next.scenes[1]!.id);
  });
});

describe('demo, hosted ticks and the cap', () => {
  test('--demo replays the recorded check of the sample script; nothing is sent or billed', async () => {
    const demo = await makeM3App({ demo: true });
    try {
      await importFixture(demo, '01-bookshop.txt', 'txt');
      const res = await demo.post<{ job_id: string }>('/api/v1/scripts/check');
      const job = await waitJob(demo, res.data.job_id);
      expect(job).toMatchObject({ status: 'succeeded', remote: false });
      const v = (await demo.get<ScriptCheckView>('/api/v1/scripts/check')).data;
      expect(v.risks).toHaveLength(4);
    } finally {
      demo.close();
    }
  });

  test('hosted: a tick names the member; the job carries who started it', async () => {
    await importFixture(app, '01-bookshop.txt', 'txt');
    fake.enqueue(reply.json(DEMO));
    await runCheck();
    const db = app.handle.projectSession.require().db;
    const B: Actor = { id: 'acc-b', name: '小林', role: 'member', crew_roles: ['制片'], text_source: 'group', image_source: 'group' };
    const req: HostedRequest = { actor: B, roster: () => [{ id: B.id, name: B.name, role: B.role, crew_roles: B.crew_roles }], personalDir: '/nonexistent' };
    syncMember(db, B);
    const risk = (await view()).risks[0]!;
    const ticked = runWithRequest(req, () => db.tx(() => setRiskHandled(db, risk.id, true)));
    expect(ticked.handled!.actor).toMatchObject({ name: '小林', crew_roles: ['制片'] });
    expect((await view()).risks[0]!.handled!.actor!.name).toBe('小林');
  });

  test('a check counts against the group key\'s daily text cap', () => {
    const db = app.handle.projectSession.require().db;
    const at = new Date().toISOString();
    db.tx(() =>
      insertJob(db, {
        id: randomUUID(), kind: 'check_script', idempotency_key: `check_script:${randomUUID()}`, remote: true, status: 'succeeded', attempts: 1,
        input_hash: 'x', progress: null, error: null, usage: null, result_ref: null, created_at: at, updated_at: at,
      }),
    );
    const hosted = { ...app.handle.deps, hosted: { slug: 't', name: '一组', limits: { llm_jobs_per_day: 1, image_jobs_per_day: 1 } } } as AppDeps;
    let err: unknown;
    try {
      assertJobQuota(hosted, db, 'llm');
    } catch (e) {
      err = e;
    }
    expect(isAppError(err) && err.code).toBe('QUOTA_EXCEEDED');
  });
});
