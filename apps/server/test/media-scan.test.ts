import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaAssetView, ShotMediaLink } from '@storyscript/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateMedia, SAMPLE } from '../../../scripts/gen-media.ts';
import { FFMPEG_SAFE_FLAGS, runTool } from '../src/adapters/media/ffmpeg.ts';
import { addAndScan, FFMPEG, HAS_FFMPEG, makeWorkspace, seedShots, snapshotDir, startApp, type MediaApp, type Seeded, type Workspace } from './media-fixture.ts';

/**
 * Scanner details: nested folders, hidden folders, stills and sound files,
 * and a root that happens to contain the project folder (its derivatives
 * must never be indexed as footage).
 */

describe.skipIf(!HAS_FFMPEG)('scan: folders, kinds, project folder inside a root', () => {
  let ws: Workspace;
  let app: MediaApp;
  let seeded: Seeded;
  let assets: Map<string, MediaAssetView>;
  let beforeShoot: Record<string, string>;

  beforeAll(async () => {
    ws = makeWorkspace();
    app = await startApp(ws, { create: true });
    seeded = await seedShots(app);
    const shoot = join(ws.root, 'shoot');
    const card = join(shoot, 'DCIM', '100');
    await generateMedia(card, { ffmpeg: FFMPEG, small: true });
    await mkdir(join(shoot, '.Trashes'), { recursive: true });
    await copyFile(join(card, SAMPLE.h264Mp4), join(shoot, '.Trashes', 'old.mp4'));
    await mkdir(join(shoot, 'SOUND'), { recursive: true });
    await mkdir(join(shoot, 'STILLS'), { recursive: true });
    const lavfi = async (src: string, out: string, extra: string[]) => {
      const r = await runTool(FFMPEG!, [...FFMPEG_SAFE_FLAGS, '-y', '-f', 'lavfi', '-i', src, ...extra, out]);
      expect(r.code, r.stderr).toBe(0);
    };
    await lavfi('sine=frequency=440:sample_rate=48000:duration=1', join(shoot, 'SOUND', 'T001.wav'), ['-c:a', 'pcm_s16le']);
    await lavfi('testsrc2=size=160x90:rate=1', join(shoot, 'STILLS', '场记板.png'), ['-frames:v', '1']);
    beforeShoot = await snapshotDir(shoot);
    // the whole temp root: contains the project folder (derivatives) and the shoot
    await addAndScan(app, ws.root, '整个工作区');
    assets = new Map((await app.get<MediaAssetView[]>('/api/v1/media/assets')).data.map((a) => [a.rel_path, a] as const));
  }, 120_000);

  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  test('nested folders use "/" in rel_path; hidden folders and the project folder are skipped', async () => {
    const names = [...assets.keys()];
    expect(names).toContain(`shoot/DCIM/100/${SAMPLE.h264Mp4}`);
    expect(names.some((n) => n.includes('.Trashes'))).toBe(false);
    expect(names.some((n) => n.startsWith('project/'))).toBe(false);
    // posters were written into the project, yet not picked up as media
    expect((await readdir(join(ws.dataDir, 'derivatives', 'posters'))).length).toBeGreaterThan(0);
    expect(await snapshotDir(join(ws.root, 'shoot'))).toEqual(beforeShoot);
  });

  test('stills get a poster, sound files are audio without one', async () => {
    const still = assets.get('shoot/STILLS/场记板.png')!;
    expect(still).toMatchObject({ kind: 'image', playable_direct: false, stream_url: null, hash_status: 'done' });
    expect(still.poster_url).not.toBeNull();
    const wav = assets.get('shoot/SOUND/T001.wav')!;
    expect(wav).toMatchObject({ kind: 'audio', poster_url: null, video_stream_index: null, hash_status: 'done' });
  });

  test('a sound file links on its audio stream; a still cannot be linked', async () => {
    const shot = seeded.s1[0]!;
    const wav = assets.get('shoot/SOUND/T001.wav')!;
    const r = await app.post<ShotMediaLink>('/api/v1/links', { shot_id: shot.id, media_asset_id: wav.id, take_id: null });
    expect(r.status).toBe(201);
    const audio = wav.probe!.streams.find((s) => s.codec_type === 'audio')!;
    expect(r.data.source_range).toMatchObject({ stream_index: audio.index, time_base_num: audio.time_base_num, time_base_den: audio.time_base_den });
    const still = assets.get('shoot/STILLS/场记板.png')!;
    const bad = await app.post('/api/v1/links', { shot_id: shot.id, media_asset_id: still.id, take_id: null });
    expect(bad.status).toBe(415);
    expect(bad.body.error?.code).toBe('UNSUPPORTED_MEDIA');
  });
});
