import { afterEach, describe, expect, test } from 'vitest';
import type { ApplyBreakdownResult, BreakdownOutput, BuildCandidatesOutput, Job, PlanDetail, Plan, Setup, ShotDraft, ShotMediaLink } from '@storyscript/contracts';
import { projectContext } from '../src/ai/runtime.ts';
import { openDemoProject } from '../src/demo/seed.ts';
import { startFakeOpenAI, reply, type FakeOpenAI } from './helpers/fake-openai.ts';
import { BREAKDOWN_REQUEST, bookshopRoster, importFixture, llmEnv, makeM3App, replayOutput, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * AT-15 (subset, SPEC §7 / FR-11): a double click never writes twice — the
 * same job is handed back while it runs, a draft applies once, revisioned
 * writes let exactly one of two identical requests through, rule candidates
 * are not duplicated; a paid remote call whose outcome is unknown is never
 * sent again, neither by the queue nor after the project is reopened.
 */

let app: M3App | null = null;
let fake: FakeOpenAI | null = null;

afterEach(async () => {
  app?.close();
  app = null;
  await fake?.close();
  fake = null;
});

const count = (a: M3App, table: string) => a.handle.projectSession.require().db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
const idle = (a: M3App) => projectContext(a.handle.deps).jobs.idle();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AT-15 double clicks do not duplicate records', () => {
  test('demo project: breakdown + apply, rule candidates, link review, setups, plan approval', async () => {
    const a = (app = await makeM3App({ demo: true, openProject: false }));
    await openDemoProject(a.handle.deps);
    await idle(a);

    // --- AI breakdown clicked twice: one job, one draft; apply clicked twice: shots created once
    const scene = (await a.get<{ scenes: { id: string }[] }>('/api/v1/scripts/current')).data.scenes[0]!;
    const drafts0 = count(a, 'shot_draft');
    const [b1, b2] = await Promise.all([
      a.post<{ job_id: string }>(`/api/v1/scenes/${scene.id}/breakdown`, { ...BREAKDOWN_REQUEST, max_shots: 12 }),
      a.post<{ job_id: string }>(`/api/v1/scenes/${scene.id}/breakdown`, { ...BREAKDOWN_REQUEST, max_shots: 12 }),
    ]);
    expect(b1.status, b1.text).toBe(202);
    expect(b2.data.job_id).toBe(b1.data.job_id);
    const job = await waitJob(a, b1.data.job_id);
    expect(job.status).toBe('succeeded');
    expect(count(a, 'shot_draft')).toBe(drafts0 + 1);
    const draft = (await a.get<ShotDraft[]>('/api/v1/drafts')).data.find((d) => d.status === 'pending' && d.kind === 'breakdown')!;
    expect(draft).toBeDefined();

    const shots0 = count(a, 'shot');
    const boards0 = count(a, 'board');
    const body = { selected: [0, 1], replace_existing: false, expected_revisions: {} };
    const applied = await Promise.all([a.post<ApplyBreakdownResult>(`/api/v1/drafts/${draft.id}/apply`, body), a.post<ApplyBreakdownResult>(`/api/v1/drafts/${draft.id}/apply`, body)]);
    expect(applied.map((r) => r.status).sort()).toEqual([200, 409]);
    const again = await a.post(`/api/v1/drafts/${draft.id}/apply`, body);
    expect(again.status).toBe(409);
    expect(count(a, 'shot')).toBe(shots0 + 2);
    expect(count(a, 'board')).toBe(boards0 + 2);

    // --- rule candidates built twice: the second run adds nothing
    const links0 = count(a, 'shot_media_link');
    const first = await a.post<BuildCandidatesOutput>('/api/v1/media/candidates', { user_regex: null });
    expect(first.status, first.text).toBe(200);
    const second = await a.post<BuildCandidatesOutput>('/api/v1/media/candidates', { user_regex: null });
    expect(second.data.created).toEqual([]);
    expect(count(a, 'shot_media_link')).toBe(links0 + first.data.created.length);

    // --- confirming the same candidate twice (same revision): one write, one 409
    const candidate = (await a.get<ShotMediaLink[]>('/api/v1/links')).data.find((l) => l.status === 'candidate')!;
    expect(candidate).toBeDefined();
    const reviews = await Promise.all(
      [0, 1].map(() => a.patch<ShotMediaLink>(`/api/v1/links/${candidate.id}`, { expected_revision: candidate.revision, action: 'confirm' })),
    );
    expect(reviews.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(reviews.find((r) => r.status === 409)!.body.error?.code).toBe('REVISION_CONFLICT');
    const confirmed = (await a.get<ShotMediaLink[]>('/api/v1/links')).data.find((l) => l.id === candidate.id)!;
    expect(confirmed).toMatchObject({ status: 'confirmed', revision: candidate.revision + 1 });

    // --- automatic grouping twice keeping edits: the same setups, no copies
    const derive = { keep_edited: true, default_durations: { setup_min: 20, per_shot_min: 15, reset_min: 10 } };
    const d1 = await a.post<Setup[]>('/api/v1/setups/derive', derive);
    expect(d1.status, d1.text).toBe(200);
    const d2 = await a.post<Setup[]>('/api/v1/setups/derive', derive);
    expect(d2.data.map((s) => s.id).sort()).toEqual(d1.data.map((s) => s.id).sort());
    expect(count(a, 'setup')).toBe(d1.data.length);
    // the two new shots got new setups with estimated durations: confirm them so the plan can be approved
    for (const s of d2.data.filter((x) => !x.estimate_confirmed)) {
      expect((await a.patch(`/api/v1/setups/${s.id}`, { estimate_confirmed: true })).status).toBe(200);
    }

    // --- recompute and approve, each clicked twice with the same revision: one write each
    const plan = (await a.get<Plan[]>('/api/v1/plans')).data[0]!;
    const recomputed = await Promise.all([0, 1].map(() => a.post<PlanDetail>(`/api/v1/plans/${plan.id}/recompute`, { expected_revision: plan.revision })));
    expect(recomputed.map((r) => r.status).sort()).toEqual([200, 409]);
    const fresh = recomputed.find((r) => r.status === 200)!.data.plan;
    expect(fresh.revision).toBe(plan.revision + 1);
    const approvals = await Promise.all([0, 1].map(() => a.post<PlanDetail>(`/api/v1/plans/${plan.id}/approve`, { expected_revision: fresh.revision })));
    expect(approvals.map((r) => r.status).sort(), approvals.map((r) => r.text).join('\n')).toEqual([200, 409]);
    const final = (await a.get<PlanDetail>(`/api/v1/plans/${plan.id}`)).data.plan;
    expect(final).toMatchObject({ status: 'approved', revision: fresh.revision + 1 });
    expect(count(a, 'plan')).toBe(1);
  });
});

describe('AT-15 a remote call with an unknown outcome is never re-sent', () => {
  const good: BreakdownOutput = { shots: (replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput).shots.slice(0, 2) };

  async function start(): Promise<{ a: M3App; f: FakeOpenAI; sceneId: string }> {
    const f = (fake = await startFakeOpenAI());
    const a = (app = await makeM3App({ env: llmEnv(f.url) }));
    const sceneId = (await importFixture(a, '01-bookshop.txt', 'txt')).scenes[0]!.id;
    await bookshopRoster(a);
    return { a, f, sceneId };
  }

  test('cancelled after sending → outcome_unknown; no automatic resend, none after reopening', async () => {
    const { a, f, sceneId } = await start();
    f.enqueue(reply.hang());
    const res = await a.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/breakdown`, BREAKDOWN_REQUEST);
    await f.waitForHang();
    // a resend would be answered at once, so any retry would show up below
    f.enqueue(reply.json(good), reply.json(good), reply.json(good));
    const cancelled = await a.post<Job>(`/api/v1/jobs/${res.data.job_id}/cancel`);
    expect(cancelled.data).toMatchObject({ status: 'outcome_unknown', attempts: 1, error: { code: 'PROVIDER_OUTCOME_UNKNOWN' } });
    await idle(a);
    await sleep(100);
    expect(f.chatRequests()).toHaveLength(1);
    expect((await a.get<Job[]>('/api/v1/jobs')).data).toEqual([]);
    expect(count(a, 'shot_draft')).toBe(0);

    expect((await a.post('/api/v1/projects/close')).status).toBe(204);
    expect((await a.post('/api/v1/projects/open', { dir: a.projectDir })).status).toBe(200);
    await idle(a);
    await sleep(100);
    const after = await a.get<Job>(`/api/v1/jobs/${res.data.job_id}`);
    expect(after.data).toMatchObject({ status: 'outcome_unknown', attempts: 1, result_ref: null });
    expect(f.chatRequests()).toHaveLength(1);
    expect(f.pending).toBe(3);
  });

  test('project closed while the request is out → reopened as outcome_unknown, nothing re-sent', async () => {
    const { a, f, sceneId } = await start();
    f.enqueue(reply.hang());
    const res = await a.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/breakdown`, BREAKDOWN_REQUEST);
    await f.waitForHang();
    f.enqueue(reply.json(good), reply.json(good), reply.json(good));

    expect((await a.post('/api/v1/projects/close')).status).toBe(204);
    expect((await a.post('/api/v1/projects/open', { dir: a.projectDir })).status).toBe(200);
    await idle(a);
    await sleep(100);
    const job = await a.get<Job>(`/api/v1/jobs/${res.data.job_id}`);
    expect(job.data.status).toBe('outcome_unknown');
    expect(job.data.error?.code).toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(job.data.error?.message).toMatch(/不会自动重发|计费/);
    expect(f.chatRequests()).toHaveLength(1);
    expect(count(a, 'shot_draft')).toBe(0);
    expect((await a.get<Job[]>('/api/v1/jobs')).data).toEqual([]);
  });

  test.todo('an interrupted local job (scan_root / probe / hash / poster) re-runs by its idempotency key after a restart — needs the M9 queue re-run registration, not on this branch');
});
