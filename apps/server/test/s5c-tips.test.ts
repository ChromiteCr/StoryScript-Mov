import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PROJECT_SCHEMA_VERSION, TIP_SHOTS_MAX, type ApplyBreakdownResult, type BreakdownOutput, type DraftDetail, type Job, type Scene, type Shot, type ShotTip, type ShotTipsOutput, type ShotTipsView } from '@storyscript/contracts';
import { ruleTips, timeOfDay } from '@storyscript/core';
import { startShotTips } from '../src/ai/tips-jobs.ts';
import { runWithRequest, syncMember, type Actor, type HostedRequest } from '../src/collab/actor.ts';
import { openDemoProject } from '../src/demo/seed.ts';
import { LATEST_VERSION, migrate, MIGRATIONS, userVersion } from '../src/db/migrations/index.ts';
import { openDb } from '../src/db/port.ts';
import { insertJob } from '../src/db/repos/job.ts';
import { listTips, upsertTip } from '../src/db/repos/tips.ts';
import type { AppDeps } from '../src/deps.ts';
import { isAppError } from '../src/http/errors.ts';
import { assertJobQuota, LLM_JOB_KINDS, quotaUsage } from '../src/services/quota.ts';
import { reply, startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.ts';
import { BREAKDOWN_REQUEST, bookshopRoster, importFixture, llmEnv, makeM3App, replayOutput, waitJob, type M3App } from './helpers/m3-app.ts';
import { BASE_FIELDS } from './media-fixture.ts';

/**
 * S5c 镜头拍摄提示 (server): a first guess for every live shot without any
 * model; one remote job per scene (at most 3 requests, counted against the
 * daily cap) whose usable items replace the scene's tips; tips go stale when
 * their shot changes; --demo replays the recordings of both sample scenes.
 */

const BREAKDOWN_1 = replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput;
const TIPS_1 = replayOutput('01-bookshop.tips-v1.scene-1.json') as ShotTipsOutput;
const TIPS_2 = replayOutput('01-bookshop.tips-v1.scene-2.json') as ShotTipsOutput;

let fake: FakeOpenAI;
let app: M3App;
let scenes: Scene[];
/** scene 1's shots, 001 … 012, in order */
let shots: Shot[];

const db = () => app.handle.projectSession.require().db;
const view = async (a: M3App = app) => {
  const res = await a.get<ShotTipsView>('/api/v1/tips');
  expect(res.status, res.text).toBe(200);
  return res.data.tips;
};
const tipOf = (tips: ShotTip[], shot: Shot) => tips.find((t) => t.shot_id === shot.id)!;
const sent = () => fake.chatRequests().length;

async function breakdownScene1(): Promise<Shot[]> {
  fake.enqueue(reply.json(BREAKDOWN_1));
  const res = await app.post<{ job_id: string }>(`/api/v1/scenes/${scenes[0]!.id}/breakdown`, BREAKDOWN_REQUEST);
  expect(res.status, res.text).toBe(202);
  const job = await waitJob(app, res.data.job_id);
  expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
  const detail = (await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`)).data;
  const n = (detail.draft.parsed as { shots: unknown[] }).shots.length;
  const applied = await app.post<ApplyBreakdownResult>(`/api/v1/drafts/${detail.draft.id}/apply`, {
    selected: [...Array(n).keys()],
    replace_existing: false,
    expected_revisions: {},
  });
  expect(applied.status, applied.text).toBe(200);
  return applied.data.created;
}

async function startTips(sceneId: string, a: M3App = app): Promise<string> {
  const res = await a.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/tips`);
  expect(res.status, res.text).toBe(202);
  return res.data.job_id;
}

/** Queue `answers` on the fake, run scene 1's tips, wait for the job. */
async function runTips(...answers: unknown[]): Promise<Job> {
  for (const a of answers) fake.enqueue(typeof a === 'string' ? reply.text(a) : reply.json(a));
  return waitJob(app, await startTips(scenes[0]!.id));
}

/** TIPS_1 with every text replaced, so a second run is told apart from the first. */
const rewritten = (tag: string): ShotTipsOutput => ({
  shots: TIPS_1.shots.map((s) => ({ ...s, difficulty: 'hard', tips: [`${tag} ${s.ref} 一`, `${tag} ${s.ref} 二`], mistake: `${tag} ${s.ref} 失误` })),
});

describe('with a text model (the fake service)', () => {
  beforeEach(async () => {
    fake = await startFakeOpenAI();
    app = await makeM3App({ env: llmEnv(fake.url) });
    scenes = (await importFixture(app, '01-bookshop.txt', 'txt')).scenes;
    await bookshopRoster(app);
    shots = await breakdownScene1();
  });

  afterEach(async () => {
    // every scripted answer was asked for: no test sent fewer requests than it meant to
    const left = fake.pending;
    app.close();
    await fake.close();
    expect(left).toBe(0);
  });

  describe('before any job: a first guess from the fields', () => {
    test('one rule guess per live shot; nothing sent', async () => {
      expect(shots.map((s) => s.code)).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']);
      const before = sent();
      const tips = await view();
      expect(tips.map((t) => t.shot_id)).toEqual(shots.map((s) => s.id));
      const time = timeOfDay(scenes[0]!.time_label ?? null);
      expect(time).toBe('day');
      for (const s of shots) {
        const g = ruleTips(s.fields, time);
        expect(tipOf(tips, s), s.code).toEqual({
          shot_id: s.id,
          difficulty: g.difficulty,
          gear: g.gear,
          tips: [],
          mistake: null,
          source: 'rule',
          stale: false,
          created_at: null,
          actor: null,
          prompt_version: null,
        });
      }
      expect(sent()).toBe(before);
    });

    test('a scene without shots and an unknown scene are refused before anything is queued', async () => {
      const empty = await app.post(`/api/v1/scenes/${scenes[1]!.id}/tips`);
      expect(empty.status).toBe(409);
      expect(empty.body.error?.code).toBe('VALIDATION_ERROR');
      expect(empty.body.error?.message).toContain('还没有镜头');
      const unknown = await app.post(`/api/v1/scenes/${randomUUID()}/tips`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error?.code).toBe('NOT_FOUND');
      expect(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM job WHERE kind = 'shot_tips'")!.n).toBe(0);
    });
  });

  describe('the shot_tips job', () => {
    test('one request with the scene\'s shots s1 … s12; the tips are stored as AI tips', async () => {
      const before = sent();
      const job = await runTips(TIPS_1);
      expect(job).toMatchObject({ kind: 'shot_tips', status: 'succeeded', attempts: 1, remote: true, error: null, result_ref: scenes[0]!.id });
      expect(sent()).toBe(before + 1);

      const req = fake.chatRequests().at(-1)!.body!;
      expect(req.model).toBe('fake-model');
      expect(req.response_format?.json_schema?.name).toBe('shot_tips');
      const [system, user] = req.messages!;
      expect(system!.content).toContain('car_mount 车载支架');
      expect(user!.content).toContain('【场次】第 1 场：');
      expect(user!.content).toContain('（时段：日）');
      shots.forEach((s, i) => expect(user!.content).toContain(`s${i + 1} 镜 ${s.code}：`));
      expect(user!.content).not.toContain('s13 ');

      const tips = await view();
      expect(tips).toHaveLength(12);
      shots.forEach((s, i) => {
        const t = tipOf(tips, s);
        const rec = TIPS_1.shots[i]!;
        expect(t, s.code).toMatchObject({ source: 'ai', stale: false, prompt_version: 'tips-v1', actor: null, difficulty: rec.difficulty, gear: rec.gear, tips: rec.tips, mistake: rec.mistake });
        expect(Number.isNaN(Date.parse(t.created_at!))).toBe(false);
      });

      const rows = listTips(db());
      expect(rows).toHaveLength(12);
      for (const r of rows) {
        const s = shots.find((x) => x.id === r.shot_id)!;
        expect(r).toMatchObject({ scene_id: scenes[0]!.id, basis_hash: s.content_hash, job_id: job.id, model: 'fake-model', prompt_version: 'tips-v1', actor_id: null });
      }
      // hints only: no shot was changed
      const after = (await app.get<Shot[]>('/api/v1/shots')).data;
      expect(after.map((s) => [s.id, s.revision, s.content_hash])).toEqual(shots.map((s) => [s.id, s.revision, s.content_hash]));
    });

    test('a second run replaces the scene\'s tips (one row per shot)', async () => {
      const first = await runTips(TIPS_1);
      const second = await runTips(rewritten('第二轮'));
      expect(second.status).toBe('succeeded');
      expect(second.id).not.toBe(first.id);
      const tips = await view();
      shots.forEach((s, i) => expect(tipOf(tips, s)).toMatchObject({ source: 'ai', difficulty: 'hard', tips: [`第二轮 s${i + 1} 一`, `第二轮 s${i + 1} 二`], mistake: `第二轮 s${i + 1} 失误` }));
      expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM shot_tip')!.n).toBe(12);
      expect(listTips(db()).every((r) => r.job_id === second.id)).toBe(true);
    });

    test('a shot edited after the run: its tip is stale, the others are not; a re-run makes it current', async () => {
      await runTips(TIPS_1);
      const target = shots[2]!;
      const edited = await app.patch<Shot>(`/api/v1/shots/${target.id}`, { expected_revision: target.revision, fields: { ...target.fields, movement: 'handheld' } });
      expect(edited.status, edited.text).toBe(200);
      expect(edited.data.content_hash).not.toBe(target.content_hash);
      // locking changes no content: not stale
      const locked = await app.patch<Shot>(`/api/v1/shots/${shots[3]!.id}`, { expected_revision: shots[3]!.revision, locked: true });
      expect(locked.status, locked.text).toBe(200);

      let tips = await view();
      expect(tips.filter((t) => t.stale).map((t) => t.shot_id)).toEqual([target.id]);
      // a stale tip still shows what the model wrote
      expect(tipOf(tips, target)).toMatchObject({ source: 'ai', tips: TIPS_1.shots[2]!.tips });

      // the shots changed, so this is a new job (not the finished one handed back)
      const again = await runTips(TIPS_1);
      expect(again.status).toBe('succeeded');
      tips = await view();
      expect(tips.some((t) => t.stale)).toBe(false);
    });

    test('an invalid answer gets a repair round; the second answer is kept', async () => {
      const job = await runTips({ shots: TIPS_1.shots.slice(0, 11) }, TIPS_1);
      expect(job).toMatchObject({ status: 'succeeded', attempts: 2 });
      const repair = fake.chatRequests().at(-1)!.body!.messages!.at(-1)!;
      expect(repair.role).toBe('user');
      expect(repair.content).toContain('缺少 s12');
      expect((await view()).filter((t) => t.source === 'ai')).toHaveLength(12);
    });

    test('three invalid answers: the usable items are stored, the rest dropped; earlier tips of the dropped shots stay', async () => {
      await runTips(TIPS_1);
      const partial = rewritten('第二轮');
      partial.shots[0]!.tips = ['只有一条'];
      partial.shots.pop();
      const before = sent();
      const job = await runTips(partial, partial, partial);
      expect(job).toMatchObject({ status: 'succeeded', attempts: 3 });
      expect(sent()).toBe(before + 3);
      const tips = await view();
      // s1 (one tip) and s12 (left out) keep the first run's tips
      expect(tipOf(tips, shots[0]!)).toMatchObject({ tips: TIPS_1.shots[0]!.tips, mistake: TIPS_1.shots[0]!.mistake });
      expect(tipOf(tips, shots[11]!)).toMatchObject({ tips: TIPS_1.shots[11]!.tips });
      for (let i = 1; i < 11; i++) expect(tipOf(tips, shots[i]!).tips).toEqual([`第二轮 s${i + 1} 一`, `第二轮 s${i + 1} 二`]);
      const rows = listTips(db());
      expect(rows.filter((r) => r.job_id === job.id)).toHaveLength(10);
    });

    test('three invalid answers on a fresh scene: only the usable shots get AI tips', async () => {
      const partial = structuredClone(TIPS_1);
      partial.shots[4]!.mistake = '';
      const job = await runTips(partial, partial, partial);
      expect(job.status).toBe('succeeded');
      const tips = await view();
      expect(tipOf(tips, shots[4]!)).toMatchObject({ source: 'rule', tips: [] });
      expect(tips.filter((t) => t.source === 'ai')).toHaveLength(11);
    });

    test('nothing usable: the job fails and the earlier tips stay', async () => {
      await runTips(TIPS_1);
      const before = await view();
      const failed = await runTips('抱歉，我无法按要求输出。', '还是不行', '{"shots": "没有"}');
      expect(failed).toMatchObject({ status: 'failed', attempts: 3 });
      expect(failed.error?.code).toBe('ATTEMPTS_EXHAUSTED');
      expect(await view()).toEqual(before);

      // answers that parse but name no shot of the scene: failed as well
      const wrongRefs = { shots: TIPS_1.shots.map((s, i) => ({ ...s, ref: `x${i + 1}` })) };
      const none = await runTips(wrongRefs, wrongRefs, wrongRefs);
      expect(none).toMatchObject({ status: 'failed', attempts: 3 });
      expect(await view()).toEqual(before);
    });

    test('nothing usable on a fresh scene: no tips are written', async () => {
      const failed = await runTips('不是 JSON', '不是 JSON', '不是 JSON');
      expect(failed.status).toBe('failed');
      expect(listTips(db())).toEqual([]);
      expect((await view()).every((t) => t.source === 'rule')).toBe(true);
    });

    test('a double click: the same shots while the job runs → the same job, one request', async () => {
      fake.enqueue(reply.json(TIPS_1));
      const before = sent();
      const [a, b] = await Promise.all([app.post<{ job_id: string }>(`/api/v1/scenes/${scenes[0]!.id}/tips`), app.post<{ job_id: string }>(`/api/v1/scenes/${scenes[0]!.id}/tips`)]);
      expect(a.status, a.text).toBe(202);
      expect(b.status, b.text).toBe(202);
      expect(b.data.job_id).toBe(a.data.job_id);
      expect((await waitJob(app, a.data.job_id)).status).toBe('succeeded');
      expect(sent()).toBe(before + 1);
      expect(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM job WHERE kind = 'shot_tips'")!.n).toBe(1);
    });

    test('an archived shot is neither sent nor shown; its earlier tip is hidden', async () => {
      await runTips(TIPS_1);
      const gone = shots[11]!;
      const archived = await app.post<Shot>(`/api/v1/shots/${gone.id}/archive`, { expected_revision: gone.revision, reason: '不要了' });
      expect(archived.status, archived.text).toBe(200);
      let tips = await view();
      expect(tips).toHaveLength(11);
      expect(tips.some((t) => t.shot_id === gone.id)).toBe(false);

      const job = await runTips({ shots: TIPS_1.shots.slice(0, 11) });
      expect(job).toMatchObject({ status: 'succeeded', attempts: 1 });
      const user = fake.chatRequests().at(-1)!.body!.messages![1]!.content;
      expect(user).toContain('s11 镜 011：');
      expect(user).not.toContain('镜 012');
      tips = await view();
      expect(tips).toHaveLength(11);
    });

    test('hosted: the tips name the member who started the job', async () => {
      const B: Actor = { id: 'acc-b', name: '小林', role: 'member', crew_roles: ['摄影'], text_source: 'group', image_source: 'group' };
      const req: HostedRequest = { actor: B, roster: () => [{ id: B.id, name: B.name, role: B.role, crew_roles: B.crew_roles }], personalDir: '/nonexistent' };
      syncMember(db(), B);
      fake.enqueue(reply.json(TIPS_1));
      const job = runWithRequest(req, () => startShotTips(app.handle.deps, scenes[0]!.id));
      expect((await waitJob(app, job.id)).status).toBe('succeeded');
      expect(listTips(db()).every((r) => r.actor_id === 'acc-b')).toBe(true);
      expect(tipOf(await view(), shots[0]!).actor).toMatchObject({ id: 'acc-b', name: '小林', crew_roles: ['摄影'] });
    });
  });

  describe('key and daily cap', () => {
    test('without a text model the start is refused before anything is queued or sent; the rule guess still shows', async () => {
      const plain = await makeM3App({ env: {} });
      try {
        const scene = (await importFixture(plain, '01-bookshop.txt', 'txt')).scenes[0]!;
        const made = await plain.post<Shot>('/api/v1/shots', { scene_id: scene.id, manual_note: '手工', fields: shots[0]!.fields });
        expect(made.status, made.text).toBe(201);
        const res = await plain.post(`/api/v1/scenes/${scene.id}/tips`);
        expect(res.status).toBe(409);
        expect(res.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
        const pdb = plain.handle.projectSession.require().db;
        expect(pdb.get<{ n: number }>('SELECT COUNT(*) AS n FROM job')!.n).toBe(0);
        const tips = await view(plain);
        expect(tips).toEqual([expect.objectContaining({ shot_id: made.data.id, source: 'rule' })]);
      } finally {
        plain.close();
      }
    });

    test('shot tips count against the group key\'s daily text cap', () => {
      expect(LLM_JOB_KINDS).toContain('shot_tips');
      const at = new Date().toISOString();
      db().tx(() =>
        insertJob(db(), {
          id: randomUUID(), kind: 'shot_tips', idempotency_key: `shot_tips:${randomUUID()}`, remote: true, status: 'succeeded', attempts: 1,
          input_hash: 'x', progress: null, error: null, usage: null, result_ref: null, created_at: at, updated_at: at,
        }),
      );
      // the breakdown above and this job
      const hosted = (llm: number) => ({ ...app.handle.deps, hosted: { slug: 't', name: '一组', limits: { llm_jobs_per_day: llm, image_jobs_per_day: 1 } } }) as AppDeps;
      expect(quotaUsage(hosted(2), db(), 'llm')).toMatchObject({ used: 2, remaining: 0 });
      let err: unknown;
      try {
        assertJobQuota(hosted(2), db(), 'llm');
      } catch (e) {
        err = e;
      }
      expect(isAppError(err) && err.code).toBe('QUOTA_EXCEEDED');

      // starting one at the cap: refused, nothing queued, nothing sent
      const before = sent();
      let refused: unknown;
      try {
        startShotTips(hosted(2), scenes[0]!.id);
      } catch (e) {
        refused = e;
      }
      expect(isAppError(refused) && refused.code).toBe('QUOTA_EXCEEDED');
      expect(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM job WHERE kind = 'shot_tips'")!.n).toBe(1);
      expect(sent()).toBe(before);
    });
  });
});

describe('the scene heading\'s time and the size of a scene', () => {
  const SCRIPT = `1. 外景 天台 夜

小林站在天台边。

2. 内景 楼道 CONTINUOUS

小林下楼。

3. 内景 教室 日

小林坐下。
`;
  let fk: FakeOpenAI;
  let a: M3App;
  let sc: Scene[];

  beforeEach(async () => {
    fk = await startFakeOpenAI();
    a = await makeM3App({ env: llmEnv(fk.url) });
    sc = (await importFixture(a, 's5c.txt', 'txt', SCRIPT)).scenes;
    expect(sc.map((s) => s.time_label)).toEqual(['夜', 'CONTINUOUS', '日']);
  });

  afterEach(async () => {
    a.close();
    await fk.close();
  });

  const make = async (sceneIndex: number, code: string): Promise<Shot> => {
    const paragraph = sc[sceneIndex]!.paragraph_ids[0]!;
    const r = await a.post<Shot>('/api/v1/shots', { scene_id: sc[sceneIndex]!.id, fields: { ...BASE_FIELDS, source: { paragraph_id: paragraph, quote: '' } }, manual_note: '手工', code });
    expect(r.status, r.text).toBe(201);
    return r.data;
  };

  test('night brings a light to the rule guess; CONTINUOUS takes the time of the scene before it', async () => {
    const night = await make(0, '001');
    const cont = await make(1, '001');
    const day = await make(2, '001');
    const tips = await view(a);
    expect(tipOf(tips, night)).toMatchObject({ source: 'rule', difficulty: 'medium', gear: ['tripod', 'light'] });
    expect(tipOf(tips, cont)).toMatchObject({ source: 'rule', difficulty: 'medium', gear: ['tripod', 'light'] });
    expect(tipOf(tips, day)).toMatchObject({ source: 'rule', difficulty: 'easy', gear: ['tripod'] });

    // the request says so too
    fk.enqueue(reply.json({ shots: [{ ref: 's1', difficulty: 'medium', gear: ['light'], tips: ['补光灯放在楼梯拐角', '曝光锁在脸上'], mistake: '脸上一片黑' }] }));
    const job = await waitJob(a, await startTips(sc[1]!.id, a));
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const user = fk.chatRequests()[0]!.body!.messages![1]!.content;
    expect(user).toContain('（时段：夜）');
    expect(user).toContain('规则估计：中，三脚架、补光灯');
    expect(tipOf(await view(a), cont)).toMatchObject({ source: 'ai', gear: ['light'] });
  });

  test(`more than ${TIP_SHOTS_MAX} shots in a scene: refused, nothing queued`, async () => {
    for (let i = 1; i <= TIP_SHOTS_MAX + 1; i++) await make(2, String(i).padStart(3, '0'));
    const res = await a.post(`/api/v1/scenes/${sc[2]!.id}/tips`);
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toContain(`超过 ${TIP_SHOTS_MAX} 个`);
    expect(fk.requests).toHaveLength(0);
    expect(a.handle.projectSession.require().db.get<{ n: number }>('SELECT COUNT(*) AS n FROM job')!.n).toBe(0);
  });
});

describe('--demo', () => {
  test('both sample scenes replay their recordings: 17 AI tips, nothing sent', async () => {
    const demo = await makeM3App({ demo: true, openProject: false });
    try {
      await openDemoProject(demo.handle.deps);
      const current = (await demo.get<{ scenes: Scene[] }>('/api/v1/scripts/current')).data.scenes;
      expect(current).toHaveLength(2);
      const live = (await demo.get<Shot[]>('/api/v1/shots')).data;
      expect(live).toHaveLength(17);
      const before = await view(demo);
      expect(before.every((t) => t.source === 'rule')).toBe(true);

      for (const scene of current) {
        const job = await waitJob(demo, await startTips(scene.id, demo));
        expect(job, scene.display_no).toMatchObject({ kind: 'shot_tips', status: 'succeeded', remote: false, error: null });
      }
      const tips = await view(demo);
      expect(tips).toHaveLength(17);
      expect(tips.every((t) => t.source === 'ai' && !t.stale && t.prompt_version === 'tips-v1')).toBe(true);
      // the recordings, shot by shot in scene order
      const byScene = (sceneId: string) => live.filter((s) => s.scene_id === sceneId);
      byScene(current[0]!.id).forEach((s, i) => expect(tipOf(tips, s).tips, s.code).toEqual(TIPS_1.shots[i]!.tips));
      byScene(current[1]!.id).forEach((s, i) => expect(tipOf(tips, s).tips, s.code).toEqual(TIPS_2.shots[i]!.tips));
      // nothing paid: no remote job
      const ddb = demo.handle.projectSession.require().db;
      expect(ddb.get<{ n: number }>("SELECT COUNT(*) AS n FROM job WHERE kind = 'shot_tips' AND remote = 1")!.n).toBe(0);
    } finally {
      demo.close();
    }
  });

  test('a changed shot list has no recording: the job fails with a clear reason, the tips stay', async () => {
    const demo = await makeM3App({ demo: true, openProject: false });
    try {
      await openDemoProject(demo.handle.deps);
      const scene = (await demo.get<{ scenes: Scene[] }>('/api/v1/scripts/current')).data.scenes[0]!;
      expect((await waitJob(demo, await startTips(scene.id, demo))).status).toBe('succeeded');
      const before = await view(demo);
      const last = (await demo.get<Shot[]>('/api/v1/shots')).data.filter((s) => s.scene_id === scene.id).at(-1)!;
      const archived = await demo.post<Shot>(`/api/v1/shots/${last.id}/archive`, { expected_revision: last.revision, reason: '合并' });
      expect(archived.status, archived.text).toBe(200);
      const job = await waitJob(demo, await startTips(scene.id, demo));
      expect(job.status).toBe('failed');
      expect(job.error?.message).toContain('演示模式没有这段输入的录制输出');
      expect(await view(demo)).toEqual(before.filter((t) => t.shot_id !== last.id));
    } finally {
      demo.close();
    }
  });
});

describe('migration 009', () => {
  test('a project database at v8 migrates to v9: the shot_tip table, one row per shot, gone with its shot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ssm-m009-'));
    const old = openDb(join(root, 'p.sqlite'));
    try {
      await migrate(old, { backupDir: join(root, 'rc'), migrations: MIGRATIONS.filter((m) => m.version <= 8) });
      expect(userVersion(old)).toBe(8);
      const tableNames = () => old.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => r.name);
      expect(tableNames()).not.toContain('shot_tip');
      const now = '2026-10-13T00:00:00.000Z';
      const [sv, scene, shot] = [randomUUID(), randomUUID(), randomUUID()];
      old.run("INSERT INTO script_version (id, source_name, format, content_hash, raw_text, paragraphs_json, created_at) VALUES (?, 'a', 'paste', 'h', '', '[]', ?)", sv, now);
      old.run("INSERT INTO scene (id, script_version_id, sort, display_no, heading, origin) VALUES (?, ?, 0, '1', '内景 天台 日', 'manual')", scene, sv);
      old.run(
        "INSERT INTO shot (id, scene_id, code, narrative_pos, origin, fields_json, content_hash, created_at, updated_at) VALUES (?, ?, '001', 1, 'manual', '{}', 'h1', ?, ?)",
        shot,
        scene,
        now,
        now,
      );

      const r = await migrate(old, { backupDir: join(root, 'rc') });
      expect(r).toMatchObject({ from: 8, to: 9, applied: ['009_shot_tips'] });
      expect(r.backup_path).not.toBeNull();
      expect(userVersion(old)).toBe(9);
      expect(LATEST_VERSION).toBe(9);
      expect(PROJECT_SCHEMA_VERSION).toBe(9);
      expect(tableNames()).toContain('shot_tip');
      expect(old.all<{ name: string }>('PRAGMA table_info(shot_tip)').map((c) => c.name)).toEqual([
        'shot_id', 'scene_id', 'basis_hash', 'difficulty', 'gear_json', 'tips_json', 'mistake', 'job_id', 'model', 'prompt_version', 'actor_id', 'created_at',
      ]);
      // the shot came through untouched
      expect(old.get<{ code: string; content_hash: string }>('SELECT code, content_hash FROM shot WHERE id = ?', shot)).toEqual({ code: '001', content_hash: 'h1' });

      const tip = { shot_id: shot, scene_id: scene, basis_hash: 'h1', difficulty: 'easy' as const, gear: ['tripod' as const], tips: ['一', '二'], mistake: '错', job_id: null, model: null, prompt_version: 'tips-v1', created_at: now };
      upsertTip(old, tip);
      upsertTip(old, { ...tip, difficulty: 'hard', tips: ['三', '四'] });
      expect(listTips(old)).toEqual([{ ...tip, difficulty: 'hard', tips: ['三', '四'], actor_id: null }]);
      // only the three difficulties; a tip needs its shot
      expect(() => old.run("UPDATE shot_tip SET difficulty = 'insane' WHERE shot_id = ?", shot)).toThrow(/CHECK/);
      expect(() => upsertTip(old, { ...tip, shot_id: randomUUID() })).toThrow(/FOREIGN KEY/);
      old.run('DELETE FROM shot WHERE id = ?', shot);
      expect(listTips(old)).toEqual([]);
      expect(old.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
    } finally {
      old.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
