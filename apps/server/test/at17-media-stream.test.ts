import { copyFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaAssetView } from '@storyscript/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateMedia, SAMPLE } from '../../../scripts/gen-media.ts';
import { addAndScan, FFMPEG, HAS_FFMPEG, makeWorkspace, startApp, type MediaApp, type Workspace } from './media-fixture.ts';

/**
 * AT-17 (media part): originals are reachable only by asset id; the server
 * realpaths root + rel_path and refuses anything that leaves the root (a
 * symlink swapped in after the scan, `..` in a tampered row); every media
 * route, binary ones included, needs the session cookie.
 */

describe.skipIf(!HAS_FFMPEG)('AT-17 media routes: path confinement and session', () => {
  let ws: Workspace;
  let app: MediaApp;
  let card: string;
  let outside: string;
  let assets: MediaAssetView[];

  beforeAll(async () => {
    ws = makeWorkspace();
    app = await startApp(ws, { create: true });
    card = join(ws.root, 'card');
    outside = join(ws.root, 'private');
    await generateMedia(card, { ffmpeg: FFMPEG, small: true });
    mkdirSync(outside, { recursive: true });
    copyFileSync(join(card, SAMPLE.h264Mp4), join(outside, 'secret.mp4'));
    // a symlink present at scan time is never indexed
    symlinkSync(join(outside, 'secret.mp4'), join(card, 'S09-009-T09.mp4'));
    await addAndScan(app, card);
    assets = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
  }, 120_000);

  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  test('symlinks are not indexed by the scan', () => {
    expect(assets.map((a) => a.rel_path)).not.toContain('S09-009-T09.mp4');
  });

  test('a file replaced by a symlink to outside the root → 403 PATH_NOT_ALLOWED', async () => {
    const a = assets.find((x) => x.rel_path === SAMPLE.h264Mov)!;
    expect((await app.raw(a.stream_url!)).status).toBe(200);
    rmSync(join(card, SAMPLE.h264Mov));
    symlinkSync(join(outside, 'secret.mp4'), join(card, SAMPLE.h264Mov));
    const res = await app.raw(a.stream_url!);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PATH_NOT_ALLOWED');
    const ranged = await app.raw(a.stream_url!, { range: 'bytes=0-15' });
    expect(ranged.status).toBe(403);
  });

  test('a row whose rel_path climbs out with .. → 403, nothing is read', async () => {
    const a = assets.find((x) => x.rel_path === SAMPLE.timecodeMov)!;
    const db = app.handle.projectSession.require().db;
    db.run('UPDATE media_asset SET rel_path = ? WHERE id = ?', '../private/secret.mp4', a.id);
    const res = await app.raw(`/api/v1/media/assets/${a.id}/stream`);
    expect(res.status).toBe(403);
    db.run('UPDATE media_asset SET rel_path = ? WHERE id = ?', 'sub/../../private/secret.mp4', a.id);
    expect((await app.raw(`/api/v1/media/assets/${a.id}/stream`)).status).toBe(403);
    db.run('UPDATE media_asset SET rel_path = ? WHERE id = ?', join(outside, 'secret.mp4'), a.id);
    expect((await app.raw(`/api/v1/media/assets/${a.id}/stream`)).status).toBe(403);
  });

  test('ids that are not UUIDs are 404, not paths', async () => {
    expect((await app.raw('/api/v1/media/assets/..%2F..%2Fetc%2Fpasswd/stream')).status).toBe(404);
    expect((await app.raw('/api/v1/media/assets/00000000-0000-4000-8000-000000000000/stream')).status).toBe(404);
  });

  test('without the session cookie every media route answers 401', async () => {
    const a = assets.find((x) => x.rel_path === SAMPLE.h264Mp4)!;
    for (const p of [a.stream_url!, a.poster_url!, '/api/v1/media/assets', '/api/v1/media/roots', '/api/v1/links', '/api/v1/takes', '/api/v1/coverage']) {
      const res = await app.anonymous(p);
      expect(res.status, p).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    }
  });
});
