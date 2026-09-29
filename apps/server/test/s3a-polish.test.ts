import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ApplyPolishResult, BreakdownOutput, DraftDetail, Job, PolishOutput, Shot, ShotRevision } from '@storyscript/contracts';
import { startFakeOpenAI, reply, type FakeOpenAI } from './helpers/fake-openai.ts';
import { bookshopRoster, importFixture, llmEnv, makeM3App, replayOutput, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * S3a polish: selected shots → one job → a draft item per shot → apply in
 * place (revision + 1, the shot's own source kept, revision origin ai);
 * locked shots refused up front, edits since the request → 409.
 */

const SCENE1 = replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput;

let fake: FakeOpenAI;
let app: M3App;
let shots: Shot[];

const noSource = (s: Shot) => {
  const { source: _s, ...rest } = s.fields;
  return rest;
};

async function polishJob(body: Record<string, unknown>): Promise<{ job: Job; detail: DraftDetail }> {
  const res = await app.post<{ job_id: string }>('/api/v1/shots/polish', body);
  expect(res.status, res.text).toBe(202);
  const job = await waitJob(app, res.data.job_id);
  const detail = await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`);
  return { job, detail: detail.data };
}

beforeEach(async () => {
  fake = await startFakeOpenAI();
  app = await makeM3App({ env: llmEnv(fake.url) });
  const imported = await importFixture(app, '01-bookshop.txt', 'txt');
  await bookshopRoster(app);
  fake.enqueue(reply.json({ shots: SCENE1.shots.slice(0, 3) }));
  const bd = await app.post<{ job_id: string }>(`/api/v1/scenes/${imported.scenes[0]!.id}/breakdown`, { technique_id: null, reference_note: null, max_shots: 8, target_seconds: null });
  const job = await waitJob(app, bd.data.job_id);
  const applied = await app.post(`/api/v1/drafts/${job.result_ref}/apply`, { selected: [0, 1, 2], replace_existing: false, expected_revisions: {} });
  expect(applied.status, applied.text).toBe(200);
  shots = (await app.get<Shot[]>('/api/v1/shots')).data;
  fake.requests.length = 0;
});

afterEach(async () => {
  app.close();
  await fake.close();
});

describe('polish', () => {
  test('two shots → draft → apply: fields replaced, source kept, revision + 1, origin ai', async () => {
    const [a, b] = [shots[0]!, shots[1]!];
    const out: PolishOutput = {
      shots: [
        { ref: 's1', change_note: '改成低角度环绕', fields: { ...noSource(a), angle: 'low', movement: 'orbit', camera_notes: '稳定器绕两人半圈' } },
        { ref: 's2', change_note: '补充动作', fields: { ...noSource(b), action: `${b.fields.action}，停顿一下` } },
      ],
    };
    fake.enqueue(reply.json(out));
    const { job, detail } = await polishJob({ shot_ids: [b.id, a.id], mode: 'improve', instruction: '更有压迫感', style_id: 'style.thriller-press', level: 'bold' });
    expect(job.kind).toBe('polish_shots');
    expect(job.status).toBe('succeeded');
    // refs follow narrative order, whatever order the ids came in
    const sent = fake.chatRequests()[0]!.body!.messages![1]!.content;
    expect(sent.indexOf('〔s1〕')).toBeLessThan(sent.indexOf('〔s2〕'));
    expect(sent).toContain('【风格】惊悚压迫');
    expect(sent).toContain('更有压迫感');
    expect(detail.draft.kind).toBe('polish');
    expect(detail.current_shots.map((s) => s.id)).toEqual([a.id, b.id]);

    const applied = await app.post<ApplyPolishResult>(`/api/v1/drafts/${detail.draft.id}/apply-polish`, {
      selected: [0, 1],
      expected_revisions: { [a.id]: a.revision, [b.id]: b.revision },
    });
    expect(applied.status, applied.text).toBe(200);
    expect(applied.data.updated).toHaveLength(2);
    const now = (await app.get<Shot[]>('/api/v1/shots')).data;
    const na = now.find((s) => s.id === a.id)!;
    expect(na.revision).toBe(a.revision + 1);
    expect(na.fields).toMatchObject({ angle: 'low', movement: 'orbit', camera_notes: '稳定器绕两人半圈' });
    expect(na.fields.source).toEqual(a.fields.source);
    const revs = (await app.get<ShotRevision[]>(`/api/v1/shots/${a.id}/revisions`)).data;
    expect(revs.at(-1)).toMatchObject({ origin: 'ai', reason: 'AI 润色（优化）：更有压迫感' });
    // applied once only
    const again = await app.post(`/api/v1/drafts/${detail.draft.id}/apply-polish`, { selected: [0], expected_revisions: { [a.id]: na.revision } });
    expect(again.status).toBe(409);
  });

  test('a locked shot cannot be polished; nothing is sent', async () => {
    const a = shots[0]!;
    await app.patch(`/api/v1/shots/${a.id}`, { expected_revision: a.revision, locked: true });
    const res = await app.post('/api/v1/shots/polish', { shot_ids: [a.id], mode: 'refine', instruction: null, style_id: null, level: 'steady' });
    expect(res.status).toBe(409);
    expect(res.text).toContain('LOCKED_SHOT');
    expect(fake.chatRequests()).toHaveLength(0);
  });

  test('a shot edited after the request → 409 on apply, nothing written', async () => {
    const a = shots[0]!;
    fake.enqueue(reply.json({ shots: [{ ref: 's1', change_note: '细化', fields: { ...noSource(a), action: '新的动作' } }] }));
    const { detail } = await polishJob({ shot_ids: [a.id], mode: 'refine', instruction: null, style_id: null, level: 'steady' });
    const edited = await app.patch<Shot>(`/api/v1/shots/${a.id}`, { expected_revision: a.revision, fields: { ...a.fields, action: '手改的动作' } });
    expect(edited.status).toBe(200);
    const res = await app.post(`/api/v1/drafts/${detail.draft.id}/apply-polish`, { selected: [0], expected_revisions: { [a.id]: a.revision } });
    expect(res.status).toBe(409);
    expect(res.text).toContain('REVISION_CONFLICT');
    const now = (await app.get<Shot[]>('/api/v1/shots')).data.find((s) => s.id === a.id)!;
    expect(now.fields.action).toBe('手改的动作');
  });

  test('a missing ref goes back for repair; an unknown alias blocks the item', async () => {
    const [a, b] = [shots[0]!, shots[1]!];
    fake.enqueue(
      reply.json({ shots: [{ ref: 's1', change_note: 'x', fields: noSource(a) }] }),
      reply.json({
        shots: [
          { ref: 's1', change_note: 'x', fields: noSource(a) },
          { ref: 's2', change_note: 'y', fields: { ...noSource(b), subjects: [{ alias: 'c9', screen: null, depth: null, facing: null, pose: null }] } },
        ],
      }),
      reply.json({
        shots: [
          { ref: 's1', change_note: 'x', fields: noSource(a) },
          { ref: 's2', change_note: 'y', fields: { ...noSource(b), subjects: [{ alias: 'c9', screen: null, depth: null, facing: null, pose: null }] } },
        ],
      }),
    );
    const { job, detail } = await polishJob({ shot_ids: [a.id, b.id], mode: 'rewrite', instruction: null, style_id: null, level: 'extreme' });
    expect(fake.chatRequests()).toHaveLength(3);
    expect(fake.chatRequests()[1]!.body!.messages!.at(-1)!.content).toContain('缺少这些镜头：s2');
    expect(job.status).toBe('failed');
    // the last parsed output is still reviewable; the bad item cannot be applied
    const res = await app.post(`/api/v1/drafts/${detail.draft.id}/apply-polish`, { selected: [1], expected_revisions: { [b.id]: b.revision } });
    expect(res.status).toBe(400);
    expect(res.text).toContain('第 2 项有错误');
    // the good item can still be applied
    const ok = await app.post<ApplyPolishResult>(`/api/v1/drafts/${detail.draft.id}/apply-polish`, { selected: [0], expected_revisions: { [a.id]: a.revision } });
    expect(ok.status, ok.text).toBe(200);
  });

  test('polish counts against the hosted daily cap', async () => {
    app.handle.deps.hosted = { slug: 'g1', name: '一组', limits: { llm_jobs_per_day: 1, image_jobs_per_day: 1 } };
    const res = await app.post('/api/v1/shots/polish', { shot_ids: [shots[0]!.id], mode: 'refine', instruction: null, style_id: null, level: 'steady' });
    expect(res.status).toBe(409);
    expect(res.text).toContain('QUOTA_EXCEEDED');
  });
});
