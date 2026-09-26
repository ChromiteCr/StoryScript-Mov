import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job, MediaAssetView } from '@storyscript/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateMedia, SAMPLE, type GenResult } from '../../../scripts/gen-media.ts';
import { addAndScan, FFMPEG, HAS_FFMPEG, makeWorkspace, sha256File, snapshotDir, startApp, type MediaApp, type Workspace } from './media-fixture.ts';

/**
 * AT-11 (v0.1: "needs a proxy" instead of generating one): a scan leaves every
 * original byte-identical and adds nothing to the source folder (INV-04);
 * stored SHA-256 equals an independent hash; non-H.264 clips are flagged as
 * needing a proxy; nothing in the index claims a backup (INV-08).
 */

describe.skipIf(!HAS_FFMPEG)('AT-11 read-only scan, hashes, proxy flag', () => {
  let ws: Workspace;
  let app: MediaApp;
  let card: string;
  let gen: GenResult;
  let before: Record<string, string>;
  let after: Record<string, string>;
  let job: Job;
  let assets: MediaAssetView[];

  beforeAll(async () => {
    ws = makeWorkspace();
    app = await startApp(ws, { create: true });
    card = join(ws.root, 'card');
    gen = await generateMedia(card, { ffmpeg: FFMPEG, small: true });
    before = await snapshotDir(card);
    ({ job } = await addAndScan(app, card));
    after = await snapshotDir(card);
    assets = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
  }, 120_000);

  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  test('the scan job succeeded and indexed only whitelisted, visible files', () => {
    expect(job.status).toBe('succeeded');
    const names = assets.map((a) => a.rel_path).sort();
    const expected = gen.files.map((f) => f.file).filter((f) => f !== SAMPLE.notes && f !== SAMPLE.appleDouble).sort();
    expect(names).toEqual(expected);
    expect(names).not.toContain(SAMPLE.appleDouble);
    expect(names).not.toContain(SAMPLE.notes);
  });

  test('INV-04: every source file is byte-identical and the folder gained nothing', () => {
    expect(after).toEqual(before);
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });

  test('stored SHA-256 equals an independent full hash of each original', async () => {
    for (const a of assets) {
      expect(a.hash_status, a.rel_path).toBe('done');
      expect(a.sha256, a.rel_path).toBe(await sha256File(join(card, a.rel_path)));
    }
  });

  test('posters are written to the project derivatives folder only', async () => {
    const posters = await readdir(join(ws.projectDir, 'derivatives', 'posters'));
    const videos = assets.filter((a) => a.kind === 'video');
    expect(videos.length).toBeGreaterThan(0);
    for (const v of videos) {
      expect(v.poster_url, v.rel_path).toBe(`/api/v1/media/assets/${v.id}/poster`);
      expect(posters).toContain(`${v.id}.jpg`);
      const res = await app.raw(v.poster_url!);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    }
    expect(posters.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  test('only H.264 8-bit 4:2:0 MP4/MOV is direct-play; everything else needs a proxy', async () => {
    for (const a of assets) {
      const v = a.probe?.streams.find((s) => s.index === a.video_stream_index);
      const h264 = v?.codec_name === 'h264';
      expect(a.playable_direct, a.rel_path).toBe(h264);
      expect(a.stream_url, a.rel_path).toBe(h264 ? `/api/v1/media/assets/${a.id}/stream` : null);
    }
    const proxy = assets.filter((a) => !a.playable_direct);
    expect(proxy.length).toBeGreaterThan(0); // HEVC Main10 / ProRes samples
    for (const a of proxy) {
      const res = await app.raw(`/api/v1/media/assets/${a.id}/stream`);
      expect(res.status).toBe(415);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNSUPPORTED_MEDIA');
    }
  });

  test('Range playback: 206 with the exact bytes, 416 past the end', async () => {
    const a = assets.find((x) => x.rel_path === SAMPLE.h264Mp4)!;
    const original = await readFile(join(card, a.rel_path));
    const part = await app.raw(a.stream_url!, { range: 'bytes=100-1123' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 100-1123/${original.length}`);
    expect(part.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await part.arrayBuffer()).equals(original.subarray(100, 1124))).toBe(true);

    const whole = await app.raw(a.stream_url!);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(original)).toBe(true);

    const past = await app.raw(a.stream_url!, { range: `bytes=${original.length + 10}-` });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${original.length}`);
  });

  test('INV-08: nothing in the index or the job claims a backup', async () => {
    const texts = [
      (await app.get('/api/v1/media/assets')).text,
      (await app.get('/api/v1/media/roots')).text,
      (await app.get(`/api/v1/jobs/${job.id}`)).text,
    ].join('\n');
    for (const word of ['备份', '已备份', '可以格式化', '格式化', 'backed up', 'backup', 'safe to format']) {
      expect(texts.toLowerCase()).not.toContain(word);
    }
  });
});
