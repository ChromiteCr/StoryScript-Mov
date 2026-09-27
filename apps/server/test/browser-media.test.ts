import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { BrowserFilesOutput, MediaAssetView, ProbeNormalized, SourceRoot } from '@storyscript/contracts';
import { makeM3App, type M3App } from './helpers/m3-app.ts';

/**
 * S1b: footage read by the browser on a team member's computer. The server
 * gets file listings, probes, hashes and poster JPEGs — never a video file —
 * and applies the scan's rules (upsert by root + rel_path, changed files start
 * over, missing files go offline). Flags are derived on the server.
 */

const MEDIA = join(import.meta.dirname, '..', '..', '..', 'samples', 'demo-media');
const manifest = JSON.parse(readFileSync(join(MEDIA, 'media.json'), 'utf8')) as { clips: { rel_path: string; probe: ProbeNormalized; poster: string | null }[] };
const probeOf = (name: string) => manifest.clips.find((c) => c.rel_path === name)!.probe;
const posterBytes = (name: string) => readFileSync(join(MEDIA, manifest.clips.find((c) => c.rel_path === name)!.poster!));

const FILES = [
  { rel_path: 'A-roll/A001C003.mov', size: 1000, mtime_ms: 1_700_000_000_000 },
  { rel_path: 'B-roll/B002C001.mov', size: 2000, mtime_ms: 1_700_000_000_001 },
];

let app: M3App;
let root: SourceRoot;
beforeEach(async () => {
  app = await makeM3App();
  const r = await app.post<SourceRoot>('/api/v1/media/browser-roots', { label: '我的短片' });
  expect(r.status, r.text).toBe(201);
  root = r.data;
});
afterEach(() => app.close());

const report = (files: typeof FILES) => app.post<BrowserFilesOutput>(`/api/v1/media/browser-roots/${root.id}/files`, { files });
const assetByPath = async (rel: string) => (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data.find((a) => a.rel_path === rel)!;

describe('browser roots', () => {
  test('a browser root is not a path on the server', async () => {
    expect(root.kind).toBe('browser');
    expect(root.abs_path).toBe(`browser:${root.id}`);
    const roots = (await app.get<SourceRoot[]>('/api/v1/media/roots')).data;
    expect(roots.map((r) => r.id)).toContain(root.id);
  });

  test('the listing adds assets and says what the server still needs', async () => {
    const r = await report(FILES);
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ added: 2, changed: 0, offline: 0 });
    for (const a of r.data.assets) expect(a).toMatchObject({ probe: true, poster: true, hash: true });
    const v = await assetByPath('A-roll/A001C003.mov');
    expect(v).toMatchObject({ root_kind: 'browser', kind: 'video', availability: 'online', stream_url: null, poster_url: null });
  });

  test.each([
    ['../escape.mov'],
    ['/abs/clip.mov'],
    ['.storyscript-mov/index.mov'],
    ['A-roll\\clip.mov'],
    ['A-roll/notes.txt'],
  ])('rejects %s', async (rel) => {
    const r = await report([{ rel_path: rel, size: 1, mtime_ms: 1 }]);
    expect(r.status, r.text).toBe(400);
  });

  test('rejects duplicates in one listing', async () => {
    expect((await report([FILES[0]!, FILES[0]!])).status).toBe(400);
  });

  test('a file missing from the next listing goes offline; a changed one starts over', async () => {
    await report(FILES);
    const again = await report([{ ...FILES[0]!, size: 1001 }]);
    expect(again.data).toMatchObject({ added: 0, changed: 1, offline: 1 });
    expect((await assetByPath('B-roll/B002C001.mov')).availability).toBe('offline');
    const back = await report(FILES);
    expect(back.data.offline).toBe(0);
    expect((await assetByPath('B-roll/B002C001.mov')).availability).toBe('online');
  });
});

describe('facts and posters from the browser', () => {
  test('the server derives kind and flags from the probe; the stream URL stays null', async () => {
    const listed = await report(FILES);
    const a = listed.data.assets.find((x) => x.rel_path === 'A-roll/A001C003.mov')!;
    const r = await app.put<MediaAssetView>(`/api/v1/media/assets/${a.asset_id}/facts`, { size: a.size, mtime_ms: a.mtime_ms, probe: probeOf('A001C003.mov') });
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ kind: 'video', has_timecode: true, playable_direct: true, video_stream_index: 0, stream_url: null });
    // ProRes: never directly playable, whatever the browser might claim
    const b = listed.data.assets.find((x) => x.rel_path === 'B-roll/B002C001.mov')!;
    const pr = await app.put<MediaAssetView>(`/api/v1/media/assets/${b.asset_id}/facts`, { size: b.size, mtime_ms: b.mtime_ms, probe: probeOf('B002C001.mov'), playable_direct: true });
    expect(pr.status, pr.text).toBe(200);
    expect(pr.data.playable_direct).toBe(false);
    const next = await report(FILES);
    expect(next.data.assets.every((x) => x.probe === false)).toBe(true);
  });

  test('facts for another version of the file are refused', async () => {
    const a = (await report(FILES)).data.assets[0]!;
    const r = await app.put(`/api/v1/media/assets/${a.asset_id}/facts`, { size: a.size + 1, mtime_ms: a.mtime_ms, probe: null });
    expect(r.status).toBe(409);
  });

  test('hash done, failed, and a file that changed while it was hashed', async () => {
    const [a, b] = (await report(FILES)).data.assets;
    const done = await app.put<MediaAssetView>(`/api/v1/media/assets/${a!.asset_id}/facts`, { size: a!.size, mtime_ms: a!.mtime_ms, sha256: 'a'.repeat(64) });
    expect(done.data).toMatchObject({ hash_status: 'done', sha256: 'a'.repeat(64) });
    const changed = await app.put<MediaAssetView>(`/api/v1/media/assets/${b!.asset_id}/facts`, { size: b!.size, mtime_ms: b!.mtime_ms, hash_problem: 'source_changed' });
    expect(changed.data.hash_status).toBe('source_changed');
    // the next listing re-indexes it even with the same size/mtime
    expect((await report(FILES)).data.changed).toBe(1);
    expect((await app.put(`/api/v1/media/assets/${a!.asset_id}/facts`, { size: a!.size, mtime_ms: a!.mtime_ms, sha256: 'not-hex' })).status).toBe(400);
  });

  test('poster JPEG upload is stored in the project and served back', async () => {
    const a = (await report(FILES)).data.assets[0]!;
    const jpeg = posterBytes('A001C003.mov');
    const res = await app.raw('PUT', `/api/v1/media/assets/${a.asset_id}/poster`, jpeg, { 'content-type': 'image/jpeg' });
    expect(res.status, await res.clone().text()).toBe(200);
    const v = (await res.json()) as { data: MediaAssetView };
    expect(v.data.poster_url).toBe(`/api/v1/media/assets/${a.asset_id}/poster`);
    const back = await app.raw('GET', v.data.poster_url!);
    expect(Buffer.from(await back.arrayBuffer()).equals(jpeg)).toBe(true);
    expect((await report(FILES)).data.assets.find((x) => x.asset_id === a.asset_id)!.poster).toBe(false);
  });

  test.each([
    ['not a JPEG', Buffer.from('<svg/>'), 'image/jpeg', 415],
    ['wrong content type', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/png', 415],
    ['empty', Buffer.alloc(0), 'image/jpeg', 400],
    ['too large', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(600 * 1024)]), 'image/jpeg', 413],
  ])('poster upload refused: %s', async (_what, body, type, status) => {
    const a = (await report(FILES)).data.assets[0]!;
    const res = await app.raw('PUT', `/api/v1/media/assets/${a.asset_id}/poster`, body, { 'content-type': type });
    expect(res.status).toBe(status);
  });
});

describe('the server never reads a browser root, and browser uploads never touch server roots', () => {
  test('scan, check and stream of a browser root are refused', async () => {
    const a = (await report(FILES)).data.assets[0]!;
    await app.put(`/api/v1/media/assets/${a.asset_id}/facts`, { size: a.size, mtime_ms: a.mtime_ms, probe: probeOf('A001C003.mov') });
    expect((await app.post(`/api/v1/media/roots/${root.id}/scan`)).status).toBe(409);
    expect((await app.post(`/api/v1/media/roots/${root.id}/check`)).status).toBe(409);
    const stream = await app.raw('GET', `/api/v1/media/assets/${a.asset_id}/stream`);
    expect(stream.status).toBe(409);
  });

  test('listings, facts and posters are refused for a server-side root', async () => {
    const dir = join(app.root, 'footage');
    mkdirSync(dir);
    const fsRoot = await app.post<SourceRoot>('/api/v1/media/roots', { abs_path: dir });
    expect(fsRoot.data.kind).toBe('fs');
    expect((await app.post(`/api/v1/media/browser-roots/${fsRoot.data.id}/files`, { files: FILES })).status).toBe(409);
  });
});
