import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BreakdownOutput, Job } from '@storyscript/contracts';
import type { DbPort } from '../src/db/port.ts';
import { getJob, insertJob } from '../src/db/repos/job.ts';
import { JobQueue, OUTCOME_UNKNOWN_MESSAGE, type JobRunContext, type JobRunResult, type JobSpec } from '../src/jobs/queue.ts';
import { reply, startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.ts';
import { BREAKDOWN_REQUEST, bookshopRoster, importFixture, llmEnv, makeM3App, replayOutput, TEST_KEY, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * FR-11 job queue: idempotency keys, one LLM job at a time, cancel semantics
 * (remote request already sent → outcome_unknown), restart recovery
 * (interrupted / outcome_unknown, never re-sent).
 */

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const OK: JobRunResult = { status: 'succeeded', attempts: 0, usage: null };

let app: M3App;
let db: DbPort;

beforeEach(async () => {
  app = await makeM3App();
  db = app.handle.projectSession.require().db;
});

afterEach(() => app.close());

function spec(key: string, run: JobSpec['run'], remote = false): JobSpec {
  return { kind: 'breakdown_scene', idempotency_key: key, input_hash: `h-${key}`, remote, lane: 'llm', run };
}

describe('JobQueue', () => {
  test('a result that cannot be saved ends the job as failed, not running forever', async () => {
    const q = new JobQueue(db);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const job = q.enqueue(
      spec('commit-fails', async () => ({
        ...OK,
        commit: () => {
          throw new Error('CHECK constraint failed');
        },
      })),
    );
    await q.idle();
    expect(q.get(job.id)).toMatchObject({ status: 'failed', result_ref: null, error: { code: 'INTERNAL', message: '结果没能保存：CHECK constraint failed' } });
    expect(q.listActive()).toEqual([]);
    errors.mockRestore();
  });

  test('same idempotency key while unfinished returns the existing job (double click)', async () => {
    const q = new JobQueue(db);
    const gate = deferred();
    const run = vi.fn(async () => {
      await gate.promise;
      return OK;
    });
    const a = q.enqueue(spec('k1', run));
    const b = q.enqueue(spec('k1', run));
    expect(b.id).toBe(a.id);
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.get(a.id)!.status).toBe('running');
    expect(q.listActive().map((j) => j.id)).toEqual([a.id]);
    gate.resolve();
    await q.idle();
    expect(q.get(a.id)!.status).toBe('succeeded');
    expect(q.listActive()).toEqual([]);

    // a finished job does not block a new run with the same key
    const c = q.enqueue(spec('k1', async () => OK));
    expect(c.id).not.toBe(a.id);
    await q.idle();
    expect(q.get(a.id)!.idempotency_key).toBe(`k1~${a.id}`);
    expect(q.get(c.id)!.idempotency_key).toBe('k1');
  });

  test('LLM lane runs one job at a time', async () => {
    const q = new JobQueue(db);
    const gate = deferred();
    const order: string[] = [];
    const a = q.enqueue(
      spec('a', async () => {
        order.push('a:start');
        await gate.promise;
        order.push('a:end');
        return OK;
      }),
    );
    const b = q.enqueue(
      spec('b', async () => {
        order.push('b:start');
        return OK;
      }),
    );
    await tick();
    expect(q.get(a.id)!.status).toBe('running');
    expect(q.get(b.id)!.status).toBe('queued');
    gate.resolve();
    await q.idle();
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    expect(q.get(b.id)!.status).toBe('succeeded');
  });

  test('cancel a queued job → cancelled, never run', async () => {
    const q = new JobQueue(db);
    const gate = deferred();
    q.enqueue(
      spec('first', async () => {
        await gate.promise;
        return OK;
      }),
    );
    const run = vi.fn(async () => OK);
    const second = q.enqueue(spec('second', run));
    await tick();
    expect(q.cancel(second.id).status).toBe('cancelled');
    gate.resolve();
    await q.idle();
    expect(run).not.toHaveBeenCalled();
    expect(q.get(second.id)!.status).toBe('cancelled');
  });

  test('cancel a running local job → cancelled; its late result is discarded', async () => {
    const q = new JobQueue(db);
    const gate = deferred();
    const commit = vi.fn(() => 'ref');
    let signal: AbortSignal | null = null;
    const job = q.enqueue(
      spec('local', async (ctx: JobRunContext) => {
        signal = ctx.signal;
        await gate.promise;
        return { ...OK, commit };
      }),
    );
    await tick();
    const cancelled = q.cancel(job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(signal!.aborted).toBe(true);
    gate.resolve();
    await q.idle();
    expect(commit).not.toHaveBeenCalled();
    expect(q.get(job.id)).toMatchObject({ status: 'cancelled', result_ref: null });
    // cancelling a terminal job is a no-op
    expect(q.cancel(job.id).status).toBe('cancelled');
  });

  test('cancel a remote job: before sending → cancelled; after sending → outcome_unknown', async () => {
    const q = new JobQueue(db);
    const gateA = deferred();
    const notSent = q.enqueue(
      spec(
        'remote-a',
        async () => {
          await gateA.promise;
          return OK;
        },
        true,
      ),
    );
    await tick();
    expect(q.cancel(notSent.id).status).toBe('cancelled');
    gateA.resolve();
    await q.idle();

    const gateB = deferred();
    const sent = q.enqueue(
      spec(
        'remote-b',
        async (ctx) => {
          ctx.markSent(1);
          await gateB.promise;
          return { ...OK, attempts: 1, commit: () => 'should-not-be-written' };
        },
        true,
      ),
    );
    await tick();
    expect(q.get(sent.id)!.attempts).toBe(1);
    const c = q.cancel(sent.id);
    expect(c.status).toBe('outcome_unknown');
    expect(c.error).toEqual({ code: 'PROVIDER_OUTCOME_UNKNOWN', message: OUTCOME_UNKNOWN_MESSAGE });
    expect(c.error!.message).toContain('仍可能完成');
    expect(c.error!.message).toContain('计费');
    gateB.resolve();
    await q.idle();
    expect(q.get(sent.id)).toMatchObject({ status: 'outcome_unknown', result_ref: null });
  });

  test('a throwing runner fails the job with a redacted message', async () => {
    const q = new JobQueue(db);
    const job = q.enqueue(
      spec('boom', async () => {
        throw new Error(`boom Bearer ${TEST_KEY}`);
      }),
    );
    await q.idle();
    const j = q.get(job.id)!;
    expect(j.status).toBe('failed');
    expect(j.error?.code).toBe('INTERNAL');
    expect(j.error?.message).not.toContain(TEST_KEY);
  });

  test('restart recovery: local → interrupted, remote sent → outcome_unknown, never re-run', () => {
    const now = new Date().toISOString();
    const row = (over: Partial<Job>): Job => ({
      id: randomUUID(),
      kind: 'breakdown_scene',
      idempotency_key: randomUUID(),
      remote: false,
      status: 'running',
      attempts: 0,
      input_hash: 'h',
      progress: null,
      error: null,
      usage: null,
      result_ref: null,
      created_at: now,
      updated_at: now,
      ...over,
    });
    const local = row({ kind: 'probe_asset' });
    const remoteSent = row({ remote: true, attempts: 1 });
    const remoteQueued = row({ remote: true, status: 'queued' });
    const done = row({ remote: true, status: 'succeeded', attempts: 2 });
    for (const j of [local, remoteSent, remoteQueued, done]) insertJob(db, j);

    const q = new JobQueue(db);
    expect(getJob(db, local.id)).toMatchObject({ status: 'interrupted', error: { code: 'INTERRUPTED' } });
    expect(getJob(db, remoteSent.id)).toMatchObject({ status: 'outcome_unknown', attempts: 1, error: { code: 'PROVIDER_OUTCOME_UNKNOWN' } });
    expect(getJob(db, remoteSent.id)!.error!.message).toContain('不会自动重发');
    // queued remote job never left the machine
    expect(getJob(db, remoteQueued.id)).toMatchObject({ status: 'interrupted', attempts: 0 });
    expect(getJob(db, done.id)).toMatchObject({ status: 'succeeded' });
    expect(q.listActive()).toEqual([]);
  });
});

describe('jobs over HTTP', () => {
  let fake: FakeOpenAI;
  let sceneId: string;
  const good: BreakdownOutput = { shots: (replayOutput('01-bookshop.breakdown-v1.scene-1.json') as BreakdownOutput).shots.slice(0, 2) };

  beforeEach(async () => {
    app.close();
    fake = await startFakeOpenAI();
    app = await makeM3App({ env: llmEnv(fake.url) });
    sceneId = (await importFixture(app, '01-bookshop.txt', 'txt')).scenes[0]!.id;
    await bookshopRoster(app);
  });

  afterEach(async () => {
    await fake.close();
  });

  test('double click → same job; second request waits; cancel mid-request → outcome_unknown, no draft', async () => {
    fake.enqueue(reply.hang());
    const a1 = await app.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/breakdown`, BREAKDOWN_REQUEST);
    const a2 = await app.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/breakdown`, BREAKDOWN_REQUEST);
    expect(a1.status).toBe(202);
    expect(a2.data.job_id).toBe(a1.data.job_id);
    const b = await app.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/breakdown`, { ...BREAKDOWN_REQUEST, max_shots: 8 });
    expect(b.data.job_id).not.toBe(a1.data.job_id);

    await fake.waitForHang();
    const active = await app.get<Job[]>('/api/v1/jobs');
    expect(active.data.map((j) => [j.id, j.status])).toEqual([
      [a1.data.job_id, 'running'],
      [b.data.job_id, 'queued'],
    ]);

    fake.enqueue(reply.json(good));
    const cancelled = await app.post<Job>(`/api/v1/jobs/${a1.data.job_id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.status).toBe('outcome_unknown');
    expect(cancelled.data.error?.code).toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(cancelled.data.error?.message).toContain('计费');

    const jobB = await waitJob(app, b.data.job_id);
    expect(jobB.status).toBe('succeeded');
    expect(fake.chatRequests()).toHaveLength(2);

    const jobA = await app.get<Job>(`/api/v1/jobs/${a1.data.job_id}`);
    expect(jobA.data).toMatchObject({ status: 'outcome_unknown', result_ref: null, attempts: 1 });
    expect((await app.get<unknown[]>('/api/v1/drafts')).data).toHaveLength(1);
    expect((await app.get<Job[]>('/api/v1/jobs')).data).toEqual([]);
  });

  test('unknown job id → 404; reopening the project recovers leftover rows', async () => {
    const missing = await app.get(`/api/v1/jobs/${randomUUID()}`);
    expect(missing.status).toBe(404);

    const now = new Date().toISOString();
    const leftover: Job = {
      id: randomUUID(),
      kind: 'extract_entities',
      idempotency_key: 'leftover',
      remote: true,
      status: 'running',
      attempts: 2,
      input_hash: 'h',
      progress: null,
      error: null,
      usage: null,
      result_ref: null,
      created_at: now,
      updated_at: now,
    };
    insertJob(app.handle.projectSession.require().db, leftover);
    expect((await app.post('/api/v1/projects/close')).status).toBe(204);
    const reopened = await app.post('/api/v1/projects/open', { dir: app.projectDir });
    expect(reopened.status, reopened.text).toBe(200);
    const job = await app.get<Job>(`/api/v1/jobs/${leftover.id}`);
    expect(job.data).toMatchObject({ status: 'outcome_unknown', attempts: 2 });
    expect(fake.requests).toHaveLength(0);
  });
});
