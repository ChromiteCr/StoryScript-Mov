import { mkdirSync, symlinkSync } from 'node:fs';
import { appendFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job, MediaAssetView, SourceRoot } from '@storyscript/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateMedia, SAMPLE } from '../../../scripts/gen-media.ts';
import { addAndScan, FFMPEG, HAS_FFMPEG, makeWorkspace, NO_TOOLS, startApp, waitJob, type MediaApp, type Workspace } from './media-fixture.ts';

/**
 * AT-12 subset: two roots with equally named files keep both assets; after a
 * scan, a changed size/mtime is reported as source_changed by check and a
 * deleted file as offline. Plus the root rules (realpath, existing directory,
 * never the project folder, no overlap) and FFMPEG_MISSING.
 */

describe('source roots: rules', () => {
  let ws: Workspace;
  let app: MediaApp;

  beforeAll(async () => {
    ws = makeWorkspace();
    app = await startApp(ws, { create: true, tools: NO_TOOLS });
  });

  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  test('realpath is stored; the same folder twice returns the same root', async () => {
    const dir = join(ws.root, 'cards', 'A');
    mkdirSync(dir, { recursive: true });
    symlinkSync(dir, join(ws.root, 'alias-A'));
    const r1 = await app.post<SourceRoot>('/api/v1/media/roots', { abs_path: join(ws.root, 'alias-A') + '/' });
    expect(r1.status).toBe(201);
    expect(r1.data).toMatchObject({ abs_path: dir, label: 'A' });
    const r2 = await app.post<SourceRoot>('/api/v1/media/roots', { abs_path: dir, label: '另一个名字' });
    expect(r2.status).toBe(200);
    expect(r2.data.id).toBe(r1.data.id);
  });

  test('missing folders, files, relative paths and overlaps are refused', async () => {
    const missing = await app.post('/api/v1/media/roots', { abs_path: join(ws.root, 'nope') });
    expect(missing.status).toBe(400);
    await writeFile(join(ws.root, 'file.mp4'), 'x');
    const file = await app.post('/api/v1/media/roots', { abs_path: join(ws.root, 'file.mp4') });
    expect(file.status).toBe(400);
    const relative = await app.post('/api/v1/media/roots', { abs_path: 'cards/A' });
    expect(relative.status).toBe(400);
    mkdirSync(join(ws.root, 'cards', 'A', 'DCIM'), { recursive: true });
    const inner = await app.post('/api/v1/media/roots', { abs_path: join(ws.root, 'cards', 'A', 'DCIM') });
    expect(inner.status).toBe(400);
    const outer = await app.post('/api/v1/media/roots', { abs_path: join(ws.root, 'cards') });
    expect(outer.status).toBe(400);
  });

  test('the project folder and its subfolders can never be a root (their footage is the project root already)', async () => {
    mkdirSync(join(ws.projectDir, 'A-roll'), { recursive: true });
    for (const p of [ws.projectDir, join(ws.projectDir, 'A-roll'), ws.dataDir, join(ws.dataDir, 'derivatives', 'posters')]) {
      const r = await app.post('/api/v1/media/roots', { abs_path: p });
      expect(r.status, p).toBe(403);
      expect(r.body.error?.code).toBe('PATH_NOT_ALLOWED');
    }
  });

  test('without ffmpeg/ffprobe: scan → 409 FFMPEG_MISSING, everything else works', async () => {
    const roots = (await app.get<SourceRoot[]>('/api/v1/media/roots')).data;
    const scan = await app.post(`/api/v1/media/roots/${roots[0]!.id}/scan`);
    expect(scan.status).toBe(409);
    expect(scan.body.error?.code).toBe('FFMPEG_MISSING');
    expect((await app.post(`/api/v1/media/roots/${roots[0]!.id}/check`)).status).toBe(200);
    expect((await app.get('/api/v1/media/assets')).status).toBe(200);
    expect((await app.get('/api/v1/coverage')).status).toBe(200);
  });
});

describe.skipIf(!HAS_FFMPEG)('AT-12 subset: same names in two roots, source_changed, offline', () => {
  let ws: Workspace;
  let app: MediaApp;
  let cardA: string;
  let cardB: string;
  let rootA: string;
  let rootB: string;

  beforeAll(async () => {
    ws = makeWorkspace();
    app = await startApp(ws, { create: true });
    cardA = join(ws.root, 'card-A');
    cardB = join(ws.root, 'card-B');
    await generateMedia(cardA, { ffmpeg: FFMPEG, small: true });
    await generateMedia(cardB, { ffmpeg: FFMPEG, small: true });
    // make B's copy of the shared name different content
    await appendFile(join(cardB, SAMPLE.h264Mp4), Buffer.from('trailing bytes'));
    ({ rootId: rootA } = await addAndScan(app, cardA, '卡 A'));
    ({ rootId: rootB } = await addAndScan(app, cardB, '卡 B'));
  }, 120_000);

  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  const list = async () => (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;

  test('the same file name under two roots stays two assets', async () => {
    const same = (await list()).filter((a) => a.rel_path === SAMPLE.h264Mp4);
    expect(same).toHaveLength(2);
    expect(new Set(same.map((a) => a.source_root_id))).toEqual(new Set([rootA, rootB]));
    expect(same.map((a) => a.root_label).sort()).toEqual(['卡 A', '卡 B']);
    expect(same[0]!.sha256).not.toBe(same[1]!.sha256);
    expect(same[0]!.id).not.toBe(same[1]!.id);
  });

  test('check: changed size/mtime → source_changed, deleted → offline, the rest online', async () => {
    const changed = join(cardA, SAMPLE.h264Mov);
    const touched = join(cardA, SAMPLE.timecodeMov);
    await appendFile(changed, Buffer.from('x'));
    await utimes(touched, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
    await rm(join(cardA, SAMPLE.vfrMp4));

    const before = (await list()).filter((a) => a.source_root_id === rootA);
    const res = await app.post<{ online: number; offline: number; changed: number }>(`/api/v1/media/roots/${rootA}/check`);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ online: before.length - 1, offline: 1, changed: 2 });

    const after = new Map((await list()).filter((a) => a.source_root_id === rootA).map((a) => [a.rel_path, a] as const));
    expect(after.get(SAMPLE.h264Mov)).toMatchObject({ hash_status: 'source_changed', availability: 'online' });
    expect(after.get(SAMPLE.timecodeMov)).toMatchObject({ hash_status: 'source_changed', availability: 'online' });
    expect(after.get(SAMPLE.vfrMp4)).toMatchObject({ availability: 'offline' });
    expect(after.get(SAMPLE.h264Mp4)).toMatchObject({ hash_status: 'done', availability: 'online' });
    // the recorded facts stay the original ones until a re-scan
    const orig = before.find((a) => a.rel_path === SAMPLE.h264Mov)!;
    expect(after.get(SAMPLE.h264Mov)).toMatchObject({ size: orig.size, sha256: orig.sha256 });
    // root B is untouched by root A's check
    for (const b of (await list()).filter((a) => a.source_root_id === rootB)) expect(b.availability).toBe('online');

    const offlineStream = await app.raw(`/api/v1/media/assets/${after.get(SAMPLE.vfrMp4)!.id}/stream`);
    expect(offlineStream.status).toBe(409);
    expect(((await offlineStream.json()) as { error: { code: string } }).error.code).toBe('SOURCE_OFFLINE');
  });

  test('a re-scan re-indexes changed files and keeps vanished ones offline', async () => {
    const scan = await app.post<{ job_id: string }>(`/api/v1/media/roots/${rootA}/scan`);
    const job = await waitJob(app, scan.data.job_id);
    expect(job.status).toBe('succeeded');
    const after = new Map((await list()).filter((a) => a.source_root_id === rootA).map((a) => [a.rel_path, a] as const));
    expect(after.get(SAMPLE.h264Mov)).toMatchObject({ hash_status: 'done', availability: 'online' });
    expect(after.get(SAMPLE.vfrMp4)).toMatchObject({ availability: 'offline' });
  });

  test('search: LIKE on name/path, 1–2 CJK characters, availability and link filters', async () => {
    mkdirSync(join(cardB, '第二天'), { recursive: true });
    await writeFile(join(cardB, '第二天', '雨夜_100%.wav'), Buffer.alloc(0));
    const scan = await app.post<{ job_id: string }>(`/api/v1/media/roots/${rootB}/scan`);
    expect((await waitJob(app, scan.data.job_id)).status).toBe('succeeded');

    const q = async (body: object) => (await app.post<MediaAssetView[]>('/api/v1/media/search', { availability: null, linked: null, ...body })).data;
    expect((await q({ q: '雨' })).map((a) => a.rel_path)).toEqual(['第二天/雨夜_100%.wav']);
    expect((await q({ q: '二天' })).map((a) => a.rel_path)).toEqual(['第二天/雨夜_100%.wav']);
    // % and _ are literal (as wildcards these would match many names)
    expect((await q({ q: '0%.' })).map((a) => a.rel_path)).toEqual(['第二天/雨夜_100%.wav']);
    expect(await q({ q: 'S01_001' })).toEqual([]);
    expect((await q({ q: 'a001' })).length).toBe(2); // case-insensitive, both roots
    expect((await q({ q: 's01 mp4' })).every((a) => a.rel_path.startsWith('S01') && a.rel_path.endsWith('.mp4'))).toBe(true);
    const offline = await q({ q: '', availability: 'offline' });
    expect(offline.map((a) => a.rel_path)).toEqual([SAMPLE.vfrMp4]);
    expect((await q({ q: '', linked: 'linked' })).length).toBe(0);
    expect((await q({ q: '', linked: 'unlinked' })).length).toBe((await list()).length);
  });

  test('a job for the same root is not started twice while running', async () => {
    const a = await app.post<{ job_id: string }>(`/api/v1/media/roots/${rootB}/scan`);
    const b = await app.post<{ job_id: string }>(`/api/v1/media/roots/${rootB}/scan`);
    expect(b.data.job_id).toBe(a.data.job_id);
    const job: Job = await waitJob(app, a.data.job_id);
    expect(job.status).toBe('succeeded');
  });
});
