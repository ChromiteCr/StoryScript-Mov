import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildCandidatesOutput, MediaAssetView, ShotMediaLink, Take } from '@storyscript/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { generateMedia, SAMPLE } from '../../../scripts/gen-media.ts';
import {
  addAndScan,
  FFMPEG,
  HAS_FFMPEG,
  makeWorkspace,
  seedShots,
  sha256File,
  startApp,
  type MediaApp,
  type Seeded,
  type Workspace,
} from './media-fixture.ts';

/**
 * AT-10: takes are logged before any media exists (one take covering two
 * shots), the server restarts, footage is imported afterwards; candidates link
 * clips to shots many-to-many with exact whole-clip source ranges, and
 * removing one link deletes neither the file nor any other link (INV-06).
 */

type Candidates = z.infer<typeof BuildCandidatesOutput>;

describe.skipIf(!HAS_FFMPEG)('AT-10 take → restart → media → links', () => {
  let ws: Workspace;
  let app: MediaApp;
  let seeded: Seeded;
  let take1: Take;
  let card: string;

  beforeAll(async () => {
    ws = makeWorkspace();
    const first = await startApp(ws, { create: true });
    seeded = await seedShots(first);
    const [a, b] = seeded.s1;

    // on set, before any footage: one take covering two shots, clip name written down
    const t1 = await first.post<Take>('/api/v1/takes', {
      setup_id: null,
      camera_label: 'A',
      rating: 'good',
      clip_hint: 'A001C003',
      notes: '一条过两个镜头',
      shot_ids: [a!.id, b!.id],
      unresolved_labels: [],
    });
    expect(t1.status).toBe(201);
    take1 = t1.data;
    expect(take1).toMatchObject({ take_no: 1, shot_ids: [a!.id, b!.id], rating: 'good', clip_hint: 'A001C003' });

    // restart: a brand-new app instance opens the same project directory
    first.shutdown();
    app = await startApp(ws, { create: false });

    card = join(ws.root, 'card');
    await generateMedia(card, { ffmpeg: FFMPEG, small: true });
  }, 120_000);

  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  test('the take survived the restart unchanged, independent of media', async () => {
    const takes = await app.get<Take[]>('/api/v1/takes');
    expect(takes.status).toBe(200);
    expect(takes.data).toEqual([take1]);
    const links = await app.get<ShotMediaLink[]>('/api/v1/links');
    expect(links.data).toEqual([]);
  });

  test('import afterwards → candidates only, many-to-many, exact source ranges', async () => {
    const { job } = await addAndScan(app, card, '卡 A');
    expect(job.status).toBe('succeeded');
    const assets = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
    const byName = new Map(assets.map((x) => [x.rel_path, x] as const));

    const res = await app.post<Candidates>('/api/v1/media/candidates', { user_regex: null });
    expect(res.status).toBe(200);
    const [a, b, c] = seeded.s1;
    const clip = byName.get(SAMPLE.timecodeMov)!;
    const slate1 = byName.get(SAMPLE.h264Mp4)!;
    const slate3 = byName.get(SAMPLE.vfrMp4)!;

    // nothing is ever confirmed automatically
    expect(res.data.created.length).toBeGreaterThan(0);
    for (const l of res.data.created) expect(l.status).toBe('candidate');

    const pair = (shot: string, asset: string) => res.data.created.find((l) => l.shot_id === shot && l.media_asset_id === asset);
    // R2: the clip name written on set matches A001C003.mov → both shots of the take
    expect(pair(a!.id, clip.id)).toMatchObject({ evidence: 'R2', take_id: take1.id });
    expect(pair(b!.id, clip.id)).toMatchObject({ evidence: 'R2', take_id: take1.id });
    // R1: slate code S01-001-T01 → shot 001 of scene 1, take 1 (the same take)
    expect(pair(a!.id, slate1.id)).toMatchObject({ evidence: 'R1', take_id: take1.id });
    // R1 with a take number nobody logged → no take
    expect(pair(c!.id, slate3.id)).toMatchObject({ evidence: 'R1', take_id: null });

    // many-to-many: one clip → two shots, one shot → two clips
    expect(res.data.created.filter((l) => l.media_asset_id === clip.id)).toHaveLength(2);
    expect(res.data.created.filter((l) => l.shot_id === a!.id).length).toBeGreaterThanOrEqual(2);

    // source_range = [start_pts, start_pts + duration_ts) of the video stream, in its own time base
    for (const l of res.data.created) {
      const asset = assets.find((x) => x.id === l.media_asset_id)!;
      const v = asset.probe!.streams.find((s) => s.index === asset.video_stream_index)!;
      expect(l.source_range).toEqual({
        stream_index: v.index,
        in_pts: v.start_pts,
        out_pts: v.start_pts! + v.duration_ts!,
        time_base_num: v.time_base_num,
        time_base_den: v.time_base_den,
      });
      for (const k of ['stream_index', 'in_pts', 'out_pts', 'time_base_num', 'time_base_den'] as const) {
        expect(Number.isInteger(l.source_range[k])).toBe(true);
      }
    }

    // running the rules again creates nothing new (existing shot+asset pairs are skipped)
    const again = await app.post<Candidates>('/api/v1/media/candidates', { user_regex: null });
    expect(again.data.created).toEqual([]);
    expect(again.data.candidates.length).toBe(res.data.candidates.length);
  });

  test('unlinking one link keeps the file and every other link (INV-06)', async () => {
    const assets = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
    const clip = assets.find((x) => x.rel_path === SAMPLE.timecodeMov)!;
    const [a, b] = seeded.s1;
    const all = (await app.get<ShotMediaLink[]>('/api/v1/links')).data;
    const la = all.find((l) => l.shot_id === a!.id && l.media_asset_id === clip.id)!;
    const lb = all.find((l) => l.shot_id === b!.id && l.media_asset_id === clip.id)!;

    const ca = await app.patch<ShotMediaLink>(`/api/v1/links/${la.id}`, { expected_revision: 0, action: 'confirm' });
    const cb = await app.patch<ShotMediaLink>(`/api/v1/links/${lb.id}`, { expected_revision: 0, action: 'confirm' });
    expect(ca.data).toMatchObject({ status: 'confirmed', revision: 1 });
    expect(cb.data.status).toBe('confirmed');
    expect(cb.data.confirmed_at).not.toBeNull();

    // stale revision → 409
    const stale = await app.patch(`/api/v1/links/${la.id}`, { expected_revision: 0, action: 'unlink' });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('REVISION_CONFLICT');

    const filePath = join(card, SAMPLE.timecodeMov);
    const before = await sha256File(filePath);
    const others = all.filter((l) => l.id !== la.id);
    const un = await app.patch<ShotMediaLink>(`/api/v1/links/${la.id}`, { expected_revision: 1, action: 'unlink' });
    expect(un.status).toBe(200);

    expect(existsSync(filePath)).toBe(true);
    expect(await sha256File(filePath)).toBe(before);
    const after = (await app.get<ShotMediaLink[]>('/api/v1/links')).data;
    expect(after.find((l) => l.id === la.id)).toBeUndefined();
    // every other link is exactly as it was, except lb which we confirmed above
    for (const o of others) {
      const now = after.find((l) => l.id === o.id)!;
      expect(now).toBeDefined();
      if (o.id === lb.id) expect(now).toEqual(cb.data);
      else expect(now).toEqual(o);
    }
    const stillThere = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data.find((x) => x.id === clip.id)!;
    expect(stillThere).toMatchObject({ availability: 'online', link_count: 1 });
    // the take is untouched by any link operation
    expect((await app.get<Take[]>('/api/v1/takes')).data).toEqual([take1]);
  });

  test('a manual link starts as a candidate; one per shot+asset', async () => {
    const assets = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
    const hevc = assets.find((x) => x.rel_path === SAMPLE.hevcMov);
    const target = hevc ?? assets.find((x) => x.video_stream_index !== null)!;
    const shot = seeded.s2[0]!;
    const r = await app.post<ShotMediaLink>('/api/v1/links', { shot_id: shot.id, media_asset_id: target.id, take_id: null });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ evidence: 'manual', status: 'candidate', confirmed_at: null });
    const again = await app.post<ShotMediaLink>('/api/v1/links', { shot_id: shot.id, media_asset_id: target.id, take_id: null });
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(r.data.id);
    // a take that does not record this shot cannot be attached
    const other = assets.find((x) => x.rel_path === SAMPLE.h264Mov)!;
    const bad = await app.post('/api/v1/links', { shot_id: shot.id, media_asset_id: other.id, take_id: take1.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe('VALIDATION_ERROR');
  });
});
