import { afterEach, describe, expect, test } from 'vitest';
import type { BreakdownOutput, DraftDetail, Job, PolishOutput, Shot, ShotDraft, ShotFields } from '@storyscript/contracts';
import { analyzeVariety } from '@storyscript/core';
import { reply, startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.ts';
import { BREAKDOWN_REQUEST, bookshopRoster, importFixture, llmEnv, makeM3App, replayOutput, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * S4c: breakdown-v3 by default with the variety check on the draft; a
 * severely monotone answer gets one refine round inside the 3-request cap;
 * --demo keeps replaying v1 without one; 丰富变化 polish carries the
 * variety warnings.
 */

const SCENE1 = replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput;
/** six recorded shots, made into the reported pattern: eye-level static close shots, everyone centred */
const MONOTONE: BreakdownOutput = {
  shots: SCENE1.shots.slice(0, 6).map((s) => ({
    ...s,
    shot_size: 'MCU',
    angle: 'eye',
    movement: 'static',
    subjects: s.subjects.map((p) => ({ ...p, screen: 'C' as const, pose: 'stand' as const })),
  })),
};
const VARIED: BreakdownOutput = { shots: SCENE1.shots.slice(0, 6) };

let fake: FakeOpenAI | null = null;
/** set by setup(); the first test needs no app */
let app: M3App;

afterEach(async () => {
  if (app) app.close();
  await fake?.close();
  fake = null;
});

async function setup(demo = false): Promise<string> {
  if (!demo) fake = await startFakeOpenAI();
  app = await makeM3App(demo ? { demo: true } : { env: llmEnv(fake!.url) });
  const imported = await importFixture(app, '01-bookshop.txt', 'txt');
  await bookshopRoster(app);
  return imported.scenes[0]!.id;
}

async function breakdown(sceneId: string, body: Record<string, unknown> = BREAKDOWN_REQUEST): Promise<{ job: Job; draft: ShotDraft }> {
  const res = await app.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/breakdown`, body);
  expect(res.status, res.text).toBe(202);
  const job = await waitJob(app, res.data.job_id);
  const detail = await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`);
  return { job, draft: detail.data.draft };
}

const varietyCodes = (d: ShotDraft) => d.issues.filter((x) => x.code.startsWith('VARIETY_')).map((x) => x.code);

describe('breakdown-v3 and the variety check', () => {
  test('the fixtures: MONOTONE is severe, VARIED is not and scores higher', () => {
    expect(analyzeVariety(MONOTONE.shots).severe).toBe(true);
    expect(analyzeVariety(VARIED.shots).severe).toBe(false);
    expect(analyzeVariety(VARIED.shots).score).toBeGreaterThan(analyzeVariety(MONOTONE.shots).score);
  });

  test('default request: v3 prompt, one request, the variety warnings on the draft', async () => {
    const id = await setup();
    fake!.enqueue(reply.json(SCENE1));
    const { job, draft } = await breakdown(id);
    expect(job.status).toBe('succeeded');
    expect(draft.prompt_version).toBe('breakdown-v4');
    expect(fake!.chatRequests()).toHaveLength(1);
    const system = fake!.chatRequests()[0]!.body!.messages![0]!.content;
    expect(system).toContain('【镜头变化】');
    expect(system).toContain('lie | kneel | reach | phone');
    expect(varietyCodes(draft)).toEqual(['VARIETY_MOSTLY_STATIC']);
    expect(draft.issues.find((x) => x.code === 'VARIETY_MOSTLY_STATIC')).toMatchObject({ level: 'warning', item: null });
  });

  test('a style and a level also get v3', async () => {
    const id = await setup();
    fake!.enqueue(reply.json(VARIED));
    const { draft } = await breakdown(id, { ...BREAKDOWN_REQUEST, style_id: 'style.track-low', level: 'extreme' });
    expect(draft.prompt_version).toBe('breakdown-v4');
    const [system, user] = fake!.chatRequests()[0]!.body!.messages!;
    expect(system!.content).toContain('【难度：挑战】');
    expect(system!.content).toContain('【镜头变化】');
    expect(user!.content).toContain('【风格】赛道贴地');
  });

  test('severe → one refine round; the better answer is adopted', async () => {
    const id = await setup();
    fake!.enqueue(reply.json(MONOTONE), reply.json(VARIED));
    const { job, draft } = await breakdown(id);
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(2);
    expect(draft.attempts).toBe(2);
    const reqs = fake!.chatRequests();
    expect(reqs).toHaveLength(2);
    const last = reqs[1]!.body!.messages!.at(-1)!.content;
    expect(last).toContain('上一次输出可以用，但还可以改进');
    expect(last).toContain('第 1–6 个镜头都是近景、平视、固定');
    expect(last).toContain('保留原有剧情内容、台词和出处原文');
    expect(reqs[1]!.body!.messages!.at(-2)).toMatchObject({ role: 'assistant' });
    expect((draft.parsed as BreakdownOutput).shots.map((s) => s.shot_size)).toEqual(VARIED.shots.map((s) => s.shot_size));
    expect(JSON.parse(draft.raw_output!)).toEqual(VARIED);
    expect(varietyCodes(draft)).not.toContain('VARIETY_SIZE_RUN');
    expect(draft.usage).toMatchObject({ total_tokens: 400 }); // both requests counted
  });

  test('severe → refine rejected (not better, invalid or failed): the first answer stays, with its warnings', async () => {
    const id = await setup();
    const badQuote = { shots: VARIED.shots.map((s) => ({ ...s, source: { ...s.source, paragraph_id: 'p-999' } })) };
    for (const [i, second] of [reply.json(MONOTONE), reply.json(badQuote), reply.serverError()].entries()) {
      fake!.requests.length = 0;
      fake!.enqueue(reply.json(MONOTONE), second);
      // a different max_shots each time: the same request would be the same idempotent job
      const { job, draft } = await breakdown(id, { ...BREAKDOWN_REQUEST, max_shots: 14 + i });
      expect(job.status).toBe('succeeded');
      expect(job.attempts).toBe(2);
      expect(fake!.chatRequests()).toHaveLength(2);
      expect(JSON.parse(draft.raw_output!)).toEqual(MONOTONE);
      expect((draft.parsed as BreakdownOutput).shots.map((s) => s.shot_size)).toEqual(MONOTONE.shots.map((s) => s.shot_size));
      expect(varietyCodes(draft)).toEqual(expect.arrayContaining(['VARIETY_SIZE_RUN', 'VARIETY_MOSTLY_STATIC', 'VARIETY_ALL_CENTER']));
      expect(draft.issues.filter((x) => x.level === 'error')).toEqual([]);
    }
  });

  test('the cap holds: a severe answer on the third request is not refined', async () => {
    const id = await setup();
    const broken = { shots: [{ ...SCENE1.shots[0]!, shot_size: 'cinematic' }] };
    fake!.enqueue(reply.json(broken), reply.json(broken), reply.json(MONOTONE), reply.json(VARIED));
    const { job, draft } = await breakdown(id);
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(3);
    expect(fake!.chatRequests()).toHaveLength(3);
    expect(JSON.parse(draft.raw_output!)).toEqual(MONOTONE);
    expect(fake!.pending).toBe(1);
  });

  test('--demo: v1 replay, never refined, the variety warnings still shown; a level is refused', async () => {
    const id = await setup(true);
    const { job, draft } = await breakdown(id);
    expect(job.status).toBe('succeeded');
    expect(job.remote).toBe(false);
    expect(draft.prompt_version).toBe('breakdown-v1');
    expect(draft.attempts).toBe(1);
    expect(varietyCodes(draft)).toEqual(['VARIETY_MOSTLY_STATIC']);
    const bold = await app.post(`/api/v1/scenes/${id}/breakdown`, { ...BREAKDOWN_REQUEST, level: 'bold' });
    expect(bold.status).toBe(409);
    expect(bold.text).toContain('演示模式只回放录好的拆镜');
  });
});

describe('丰富变化 polish', () => {
  test('polish-v2: the picked shots as one passage; the result carries the variety warnings', async () => {
    const id = await setup();
    fake!.enqueue(reply.json(MONOTONE));
    const bd = await breakdown(id, { ...BREAKDOWN_REQUEST, max_shots: 8 });
    // MONOTONE is severe, so the refine round got the 500 of an empty queue and the answer stayed
    expect(bd.job.status).toBe('succeeded');
    const applied = await app.post(`/api/v1/drafts/${bd.draft.id}/apply`, { selected: [0, 1, 2, 3], replace_existing: false, expected_revisions: {} });
    expect(applied.status, applied.text).toBe(200);
    const shots = (await app.get<Shot[]>('/api/v1/shots')).data.sort((a, b) => a.narrative_pos - b.narrative_pos);
    fake!.requests.length = 0;

    const noSource = (f: ShotFields) => {
      const { source: _s, ...rest } = f;
      return rest;
    };
    // the model only changes the angle of two shots: still a run of static close shots
    const out: PolishOutput = {
      shots: shots.map((s, i) => ({ ref: `s${i + 1}`, change_note: '换角度', fields: { ...noSource(s.fields), angle: i % 2 ? 'low' : 'eye' } })),
    };
    fake!.enqueue(reply.json(out));
    const res = await app.post<{ job_id: string }>('/api/v1/shots/polish', { shot_ids: shots.map((s) => s.id), mode: 'vary', instruction: null, style_id: null, level: 'steady' });
    expect(res.status, res.text).toBe(202);
    const job = await waitJob(app, res.data.job_id);
    expect(job.status).toBe('succeeded');
    const detail = (await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`)).data;
    expect(detail.draft.prompt_version).toBe('polish-v3');
    const user = fake!.chatRequests()[0]!.body!.messages![1]!.content;
    expect(user).toContain('【方式：丰富变化】');
    expect(user).toContain('【现在的问题】');
    expect(user).toContain('第 1–4 个镜头都是近景、平视、固定');
    expect(fake!.chatRequests()).toHaveLength(1); // polish is never refined
    const codes = detail.draft.issues.filter((x) => x.code.startsWith('VARIETY_')).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['VARIETY_FEW_SIZES', 'VARIETY_NO_WIDE', 'VARIETY_MOSTLY_STATIC', 'VARIETY_ALL_CENTER']));
    expect(detail.draft.issues.every((x) => x.level === 'warning')).toBe(true);

    // other modes do not add them
    fake!.enqueue(reply.json(out));
    const improve = await app.post<{ job_id: string }>('/api/v1/shots/polish', { shot_ids: shots.map((s) => s.id), mode: 'improve', instruction: null, style_id: null, level: 'steady' });
    const ij = await waitJob(app, improve.data.job_id);
    const id2 = (await app.get<DraftDetail>(`/api/v1/drafts/${ij.result_ref}`)).data;
    expect(id2.draft.issues.filter((x) => x.code.startsWith('VARIETY_'))).toEqual([]);
  });
});
