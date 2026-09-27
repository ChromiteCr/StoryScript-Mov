import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Job, JobKind, MediaAssetView } from '@storyscript/contracts';
import type { DbPort } from '../src/db/port.ts';
import { getJob, insertJob } from '../src/db/repos/job.ts';
import type { ToolsInfo } from '../src/diagnostics.ts';
import { scanJobSpec, scanRerunFactory, scanRootIdOf, scanRootKey } from '../src/jobs/media-scan.ts';
import {
  JobQueue,
  registeredReruns,
  registerRerun,
  RERUN_QUEUED_MESSAGE,
  RERUN_UNAVAILABLE_MESSAGE,
  type JobRunResult,
  type JobSpec,
  type RerunFactory,
} from '../src/jobs/queue.ts';
import { TEST_KEY, makeM3App, type M3App } from './helpers/m3-app.ts';
import { HAS_FFMPEG, makeWorkspace, startApp, waitJob, type MediaApp, type Workspace } from './media-fixture.ts';

/**
 * FR-11 hardening of the job queue:
 *   - lanes: 'image' (paid image model) and 'llm' (text model) run one job at
 *     a time each and never wait on each other; 'local' runs two at a time;
 *   - a remote runner can end a job as outcome_unknown (timeout / 5xx after
 *     sending), a local one cannot;
 *   - restart recovery: interrupted local jobs whose kind has a re-run
 *     factory run again under the same id and idempotency key (no second job
 *     row, no duplicate data); remote jobs are never re-run.
 */

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const OK: JobRunResult = { status: 'succeeded', attempts: 0, usage: null };
const FAKE_TOOLS: ToolsInfo = {
  ffmpeg: { path: '/nonexistent/ffmpeg', version: null },
  ffprobe: { path: '/nonexistent/ffprobe', version: null },
  h264_encoders: [],
};

let app: M3App;
let db: DbPort;

beforeEach(async () => {
  app = await makeM3App();
  db = app.handle.projectSession.require().db;
});

afterEach(() => app.close());

function spec(key: string, lane: JobSpec['lane'], run: JobSpec['run'], remote = false, kind: JobKind = 'breakdown_scene'): JobSpec {
  return { kind, idempotency_key: key, input_hash: `h-${key}`, remote, lane, run };
}

/** A runner that records start/end and waits for its gate. */
function gated(log: string[], name: string, gate: Promise<void>, result: JobRunResult = OK): JobSpec['run'] {
  return async () => {
    log.push(`${name}:start`);
    await gate;
    log.push(`${name}:end`);
    return result;
  };
}

function leftover(over: Partial<Job>): Job {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind: 'hash_asset',
    idempotency_key: `k-${randomUUID()}`,
    remote: false,
    status: 'running',
    attempts: 0,
    input_hash: 'h',
    progress: 0.4,
    error: null,
    usage: null,
    result_ref: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

const jobCount = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM job')!.n;

describe('lanes', () => {
  test('image lane: one paid image request at a time', async () => {
    const q = new JobQueue(db);
    const log: string[] = [];
    const gate = deferred();
    const a = q.enqueue(spec('img-a', 'image', gated(log, 'a', gate.promise), true, 'image_redraw'));
    const b = q.enqueue(spec('img-b', 'image', gated(log, 'b', Promise.resolve()), true, 'image_redraw'));
    await tick();
    expect(q.get(a.id)!.status).toBe('running');
    expect(q.get(b.id)!.status).toBe('queued');
    gate.resolve();
    await q.idle();
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  test('a long image job does not hold up the text-model lane, and vice versa', async () => {
    const q = new JobQueue(db);
    const log: string[] = [];
    const imageGate = deferred();
    const llmGate = deferred();
    const img = q.enqueue(spec('img', 'image', gated(log, 'img', imageGate.promise), true, 'image_redraw'));
    const llm = q.enqueue(spec('llm', 'llm', gated(log, 'llm', llmGate.promise), true));
    const local = q.enqueue(spec('local', 'local', gated(log, 'local', Promise.resolve()), false, 'scan_root'));
    await tick();
    // all three lanes are busy at once
    expect([q.get(img.id)!.status, q.get(llm.id)!.status]).toEqual(['running', 'running']);
    await vi.waitFor(() => expect(q.get(local.id)!.status).toBe('succeeded'));
    llmGate.resolve();
    await vi.waitFor(() => expect(q.get(llm.id)!.status).toBe('succeeded'));
    expect(q.get(img.id)!.status).toBe('running');
    imageGate.resolve();
    await q.idle();
    expect(q.get(img.id)!.status).toBe('succeeded');
    expect(log.indexOf('llm:end')).toBeLessThan(log.indexOf('img:end'));
  });

  test('local lane runs two jobs at a time', async () => {
    const q = new JobQueue(db);
    const log: string[] = [];
    const gate = deferred();
    const jobs = ['l1', 'l2', 'l3'].map((k) => q.enqueue(spec(k, 'local', gated(log, k, gate.promise), false, 'scan_root')));
    await tick();
    expect(jobs.map((j) => q.get(j.id)!.status)).toEqual(['running', 'running', 'queued']);
    gate.resolve();
    await q.idle();
    expect(jobs.map((j) => q.get(j.id)!.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  });
});

describe('outcome_unknown results', () => {
  test('a remote runner reporting outcome_unknown ends the job there (commit still runs), never re-sent', async () => {
    const q = new JobQueue(db);
    const run = vi.fn(async (ctx: { markSent(n: number): void }) => {
      ctx.markSent(1);
      return {
        status: 'outcome_unknown' as const,
        attempts: 1,
        usage: null,
        error: { code: 'PROVIDER_OUTCOME_UNKNOWN', message: '超时：请求可能仍在处理并计费' },
        commit: () => 'raster-row',
      };
    });
    const job = q.enqueue(spec('paid', 'image', run, true, 'image_redraw'));
    await q.idle();
    expect(q.get(job.id)).toMatchObject({
      status: 'outcome_unknown',
      attempts: 1,
      result_ref: 'raster-row',
      error: { code: 'PROVIDER_OUTCOME_UNKNOWN' },
    });
    // a restart does not touch a settled outcome_unknown job
    new JobQueue(db);
    expect(q.get(job.id)!.status).toBe('outcome_unknown');
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('a local runner cannot claim outcome_unknown (recorded as failed)', async () => {
    const q = new JobQueue(db);
    const job = q.enqueue(spec('local-unknown', 'local', async () => ({ status: 'outcome_unknown', attempts: 0, usage: null }), false, 'scan_root'));
    await q.idle();
    expect(q.get(job.id)!.status).toBe('failed');
  });
});

describe('restart recovery (FR-11)', () => {
  test('interrupted local job re-runs under the same id and key; no second job row', async () => {
    const row = leftover({ kind: 'hash_asset', idempotency_key: 'hash_asset:abc', input_hash: 'abc' });
    insertJob(db, row);
    const before = jobCount();
    const run = vi.fn(async (): Promise<JobRunResult> => ({ ...OK, commit: () => 'hashed-abc' }));
    const factory = vi.fn<RerunFactory>(({ job }) => ({ ...spec('ignored', 'local', run, false, 'hash_asset'), input_hash: job.input_hash }));

    const q = new JobQueue(db, { projectDir: app.projectDir, reruns: new Map([['hash_asset', factory]]) });
    // re-queued synchronously, the reason stays visible while it waits
    expect(q.get(row.id)).toMatchObject({ status: 'queued', error: { code: 'INTERRUPTED', message: RERUN_QUEUED_MESSAGE } });
    await q.idle();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]![0]).toMatchObject({ job: { id: row.id, idempotency_key: 'hash_asset:abc', input_hash: 'abc' }, projectDir: app.projectDir });
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.get(row.id)).toMatchObject({ status: 'succeeded', idempotency_key: 'hash_asset:abc', result_ref: 'hashed-abc', error: null, progress: 1 });
    expect(jobCount()).toBe(before);

    // a second restart finds nothing left to do
    const again = new JobQueue(db, { reruns: new Map([['hash_asset', factory]]) });
    await again.idle();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('the same key clicked while the re-run is pending joins it (no duplicate run)', async () => {
    const row = leftover({ kind: 'poster_asset', idempotency_key: 'poster_asset:x' });
    insertJob(db, row);
    const gate = deferred();
    const run = vi.fn(async () => {
      await gate.promise;
      return OK;
    });
    const q = new JobQueue(db, { reruns: new Map([['poster_asset', () => spec('x', 'local', run, false, 'poster_asset')]]) });
    const clicked = q.enqueue(spec('poster_asset:x', 'local', run, false, 'poster_asset'));
    expect(clicked.id).toBe(row.id);
    await tick();
    expect(q.enqueue(spec('poster_asset:x', 'local', run, false, 'poster_asset')).id).toBe(row.id);
    gate.resolve();
    await q.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.get(row.id)!.status).toBe('succeeded');
    expect(db.all('SELECT id FROM job WHERE idempotency_key LIKE ?', 'poster_asset:x%')).toHaveLength(1);
  });

  test('remote jobs are never re-run, even when their kind has a factory', async () => {
    const sent = leftover({ kind: 'hash_asset', remote: true, attempts: 1 });
    const notSent = leftover({ kind: 'hash_asset', remote: true, status: 'queued' });
    const breakdown = leftover({ kind: 'breakdown_scene', remote: true, attempts: 2 });
    for (const j of [sent, notSent, breakdown]) insertJob(db, j);
    const factory = vi.fn<RerunFactory>(() => spec('never', 'local', async () => OK, false, 'hash_asset'));
    const q = new JobQueue(db, { reruns: new Map([['hash_asset', factory], ['breakdown_scene' as JobKind, factory]]) });
    await q.idle();
    expect(factory).not.toHaveBeenCalled();
    expect(getJob(db, sent.id)).toMatchObject({ status: 'outcome_unknown', attempts: 1, error: { code: 'PROVIDER_OUTCOME_UNKNOWN' } });
    expect(getJob(db, notSent.id)).toMatchObject({ status: 'interrupted', attempts: 0 });
    expect(getJob(db, breakdown.id)).toMatchObject({ status: 'outcome_unknown', attempts: 2 });
    expect(q.listActive()).toEqual([]);
  });

  test('local kinds without a factory (and non-rerunnable kinds) stay interrupted', async () => {
    const probe = leftover({ kind: 'probe_asset' });
    const demoBreakdown = leftover({ kind: 'breakdown_scene', remote: false });
    for (const j of [probe, demoBreakdown]) insertJob(db, j);
    const factory = vi.fn<RerunFactory>(() => null);
    // breakdown_scene is not a local re-runnable kind: a factory for it is ignored
    const q = new JobQueue(db, { reruns: new Map([['breakdown_scene' as JobKind, factory]]) });
    await q.idle();
    expect(factory).not.toHaveBeenCalled();
    expect(getJob(db, probe.id)).toMatchObject({ status: 'interrupted', error: { code: 'INTERRUPTED' } });
    expect(getJob(db, demoBreakdown.id)!.status).toBe('interrupted');
    expect(() => registerRerun('breakdown_scene', factory)).toThrow(/not a local re-runnable kind/);
    expect(() => registerRerun('image_redraw', factory)).toThrow();
  });

  test('a factory that returns null or throws leaves the job interrupted with the reason (redacted)', async () => {
    const gone = leftover({ kind: 'hash_asset' });
    const broken = leftover({ kind: 'poster_asset' });
    for (const j of [gone, broken]) insertJob(db, j);
    const q = new JobQueue(db, {
      reruns: new Map<JobKind, RerunFactory>([
        ['hash_asset', () => null],
        [
          'poster_asset',
          () => {
            throw new Error(`boom Bearer ${TEST_KEY}`);
          },
        ],
      ]),
    });
    await q.idle();
    expect(getJob(db, gone.id)).toMatchObject({ status: 'interrupted', error: { code: 'INTERRUPTED', message: RERUN_UNAVAILABLE_MESSAGE } });
    const b = getJob(db, broken.id)!;
    expect(b.status).toBe('interrupted');
    expect(b.error!.message.startsWith(RERUN_UNAVAILABLE_MESSAGE)).toBe(true);
    expect(b.error!.message).not.toContain(TEST_KEY);
  });

  test('cancelling a re-queued job before its factory resolves → cancelled, never run', async () => {
    const row = leftover({ kind: 'hash_asset' });
    insertJob(db, row);
    const factoryGate = deferred();
    const run = vi.fn(async () => OK);
    const q = new JobQueue(db, {
      reruns: new Map<JobKind, RerunFactory>([
        [
          'hash_asset',
          async () => {
            await factoryGate.promise;
            return spec('h', 'local', run, false, 'hash_asset');
          },
        ],
      ]),
    });
    expect(q.cancel(row.id).status).toBe('cancelled');
    factoryGate.resolve();
    await q.idle();
    expect(run).not.toHaveBeenCalled();
    expect(getJob(db, row.id)!.status).toBe('cancelled');
  });

  test('scan_root registers its re-run factory at module load', () => {
    expect(registeredReruns().has('scan_root')).toBe(true);
    expect(scanRootIdOf({ idempotency_key: scanRootKey('r-1'), input_hash: 'x' })).toBe('r-1');
    expect(scanRootIdOf({ idempotency_key: `${scanRootKey('r-1')}~old-job`, input_hash: 'x' })).toBe('r-1');
    expect(scanRootIdOf({ idempotency_key: 'other', input_hash: 'r-2' })).toBe('r-2');
  });
});

describe('scan_root re-run after a restart (real scan, no ffmpeg needed)', () => {
  let ws: Workspace;
  let media: MediaApp;
  let card: string;

  beforeEach(async () => {
    ws = makeWorkspace('ssm-jobs-');
    media = await startApp(ws, { create: true, tools: FAKE_TOOLS });
    card = join(ws.root, 'card');
    mkdirSync(join(card, 'DAY1'), { recursive: true });
    for (const name of ['A001.mp4', 'A002.mov', 'DAY1/B001.wav']) writeFileSync(join(card, name), `clip ${name}`);
  });

  afterEach(() => {
    media.shutdown();
    ws.cleanup();
  });

  test('an interrupted scan is re-scanned under the same job; assets are not duplicated', async () => {
    const root = await media.post<{ id: string }>('/api/v1/media/roots', { abs_path: card });
    expect(root.status).toBe(201);
    const first = await media.post<{ job_id: string }>(`/api/v1/media/roots/${root.data.id}/scan`);
    expect(first.status).toBe(202);
    expect((await waitJob(media, first.data.job_id)).status).toBe('succeeded');
    expect((await media.get<MediaAssetView[]>('/api/v1/media/assets')).data).toHaveLength(3);

    // the server "dies" during a second scan: the row is left running, a new clip arrived meanwhile
    const pdb = media.handle.projectSession.require().db;
    pdb.run(`UPDATE job SET status = 'running', progress = 0.3, result_ref = NULL WHERE id = ?`, first.data.job_id);
    writeFileSync(join(card, 'A003.mp4'), 'clip A003');
    const jobsBefore = pdb.get<{ n: number }>('SELECT COUNT(*) AS n FROM job')!.n;

    const q = new JobQueue(pdb, { projectDir: ws.projectDir, reruns: new Map([['scan_root', scanRerunFactory(async () => FAKE_TOOLS)]]) });
    await q.idle();
    const job = q.get(first.data.job_id)!;
    expect(job).toMatchObject({ status: 'succeeded', idempotency_key: scanRootKey(root.data.id), error: null });
    expect(JSON.parse(job.result_ref!)).toMatchObject({ root_id: root.data.id, files: 4, added: 1 });
    const assets = pdb.all<{ rel_path: string; n: number }>('SELECT rel_path, COUNT(*) AS n FROM media_asset GROUP BY source_root_id, rel_path ORDER BY rel_path');
    expect(assets.map((a) => [a.rel_path, a.n])).toEqual([
      ['A001.mp4', 1],
      ['A002.mov', 1],
      ['A003.mp4', 1],
      ['DAY1/B001.wav', 1],
    ]);
    expect(pdb.get<{ n: number }>('SELECT COUNT(*) AS n FROM job')!.n).toBe(jobsBefore);
  });

  test('no re-run when the root is gone or ffmpeg is missing: the scan stays interrupted', async () => {
    const pdb = media.handle.projectSession.require().db;
    const orphan = leftover({ kind: 'scan_root', idempotency_key: scanRootKey(randomUUID()), input_hash: 'x' });
    insertJob(pdb, orphan);
    const q = new JobQueue(pdb, { projectDir: ws.projectDir, reruns: new Map([['scan_root', scanRerunFactory(async () => FAKE_TOOLS)]]) });
    await q.idle();
    expect(getJob(pdb, orphan.id)).toMatchObject({ status: 'interrupted', error: { message: RERUN_UNAVAILABLE_MESSAGE } });

    const root = await media.post<{ id: string }>('/api/v1/media/roots', { abs_path: card });
    const noTools = leftover({ kind: 'scan_root', idempotency_key: scanRootKey(root.data.id), input_hash: root.data.id });
    insertJob(pdb, noTools);
    const none: ToolsInfo = { ffmpeg: { path: null, version: null }, ffprobe: { path: null, version: null }, h264_encoders: [] };
    const q2 = new JobQueue(pdb, { projectDir: ws.projectDir, reruns: new Map([['scan_root', scanRerunFactory(async () => none)]]) });
    await q2.idle();
    expect(getJob(pdb, noTools.id)!.status).toBe('interrupted');
    expect(pdb.get<{ n: number }>('SELECT COUNT(*) AS n FROM media_asset')!.n).toBe(0);
  });

  test('scanJobSpec matches what the scan route enqueues (key, input_hash, local lane)', () => {
    const s = scanJobSpec({ db: media.handle.projectSession.require().db, projectDir: ws.projectDir, rootId: 'r', ffprobe: 'p', ffmpeg: 'f' });
    expect(s).toMatchObject({ kind: 'scan_root', idempotency_key: 'scan_root:r', input_hash: 'r', remote: false, lane: 'local' });
  });
});

describe.skipIf(!HAS_FFMPEG)('scan_root re-run over HTTP after reopening the project (registered factory, real ffmpeg)', () => {
  test('reopen → the polled job id finishes as succeeded, same row', async () => {
    const ws = makeWorkspace('ssm-jobs-http-');
    try {
      const card = join(ws.root, 'card');
      mkdirSync(card, { recursive: true });
      writeFileSync(join(card, 'C001.mp4'), 'not really a video');
      let media = await startApp(ws, { create: true });
      const root = await media.post<{ id: string }>('/api/v1/media/roots', { abs_path: card });
      const scan = await media.post<{ job_id: string }>(`/api/v1/media/roots/${root.data.id}/scan`);
      expect((await waitJob(media, scan.data.job_id)).status).toBe('succeeded');
      media.handle.projectSession.require().db.run(`UPDATE job SET status = 'running' WHERE id = ?`, scan.data.job_id);
      writeFileSync(join(card, 'C002.mp4'), 'another clip');
      media.shutdown();

      media = await startApp(ws, { create: false });
      try {
        const job = await waitJob(media, scan.data.job_id);
        expect(job).toMatchObject({ id: scan.data.job_id, status: 'succeeded' });
        const assets = (await media.get<MediaAssetView[]>('/api/v1/media/assets')).data;
        expect(assets.map((a) => a.rel_path).sort()).toEqual(['C001.mp4', 'C002.mp4']);
      } finally {
        media.shutdown();
      }
    } finally {
      ws.cleanup();
    }
  });
});
