import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildCandidatesOutput, MediaAssetView, ShotMediaLink, Take } from '@storyscript/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { generateMedia, SAMPLE } from '../../../scripts/gen-media.ts';
import { addAndScan, FFMPEG, HAS_FFMPEG, makeWorkspace, seedShots, startApp, type MediaApp, type Seeded, type Workspace } from './media-fixture.ts';

/**
 * Candidate rules through the API (FR-09): R3 user patterns, configuration
 * errors reported (never thrown), conflicts flagged, rejected pairs never
 * proposed again, nothing confirmed automatically.
 */

type Out = z.infer<typeof BuildCandidatesOutput>;

describe.skipIf(!HAS_FFMPEG)('link candidates', () => {
  let ws: Workspace;
  let app: MediaApp;
  let seeded: Seeded;
  let assets: Map<string, MediaAssetView>;

  beforeAll(async () => {
    ws = makeWorkspace();
    app = await startApp(ws, { create: true });
    seeded = await seedShots(app);
    const card = join(ws.root, 'card');
    await generateMedia(card, { ffmpeg: FFMPEG, small: true });
    // a camera-style name only a user pattern can read: scene 2, shot 1, take 3
    await rename(join(card, SAMPLE.proresMov), join(card, 'SC2_SH1_TK3.mov'));
    await addAndScan(app, card);
    assets = new Map((await app.get<MediaAssetView[]>('/api/v1/media/assets')).data.map((a) => [a.rel_path, a] as const));
  }, 120_000);

  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  test('a bad user pattern is reported, the built-in rules still run', async () => {
    const r = await app.post<Out>('/api/v1/media/candidates', { user_regex: '(?<shot>[' });
    expect(r.status).toBe(200);
    expect(r.data.errors.map((e) => e.code)).toContain('INVALID_REGEX');
    const noGroup = await app.post<Out>('/api/v1/media/candidates', { user_regex: 'SC(\\d+)' });
    expect(noGroup.data.errors.map((e) => e.code)).toContain('INVALID_REGEX');
    expect(r.data.created.every((l) => l.evidence === 'R1' || l.evidence === 'R2')).toBe(true);
  });

  test('R3: named groups scene / shot / take', async () => {
    const r = await app.post<Out>('/api/v1/media/candidates', { user_regex: 'SC(?<scene>\\d+)_SH(?<shot>\\d+)_TK(?<take>\\d+)' });
    const clip = assets.get('SC2_SH1_TK3.mov')!;
    const created = r.data.created.filter((l) => l.media_asset_id === clip.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ shot_id: seeded.s2[0]!.id, evidence: 'R3', status: 'candidate', take_id: null });
    // ProRes: still linkable (review) even though it cannot be played directly
    expect(clip.playable_direct).toBe(false);
  });

  test('one clip claimed by two unrelated shots is a conflict', async () => {
    // a take whose clip hint names the S01-002 clip, but logged for shot 003
    const [, , c] = seeded.s1;
    const t = await app.post<Take>('/api/v1/takes', {
      setup_id: null,
      camera_label: 'B',
      rating: 'unrated',
      clip_hint: 'S01-002-T01',
      notes: '',
      shot_ids: [c!.id],
      unresolved_labels: [],
    });
    expect(t.status).toBe(201);
    const r = await app.post<Out>('/api/v1/media/candidates', { user_regex: null });
    const clip = assets.get(SAMPLE.h264Mov)!;
    const mine = r.data.candidates.filter((x) => x.media_asset_id === clip.id);
    expect(new Set(mine.map((x) => x.shot_id)).size).toBe(2);
    expect(mine.every((x) => x.conflict)).toBe(true);
    const links = (await app.get<ShotMediaLink[]>('/api/v1/links')).data.filter((l) => l.media_asset_id === clip.id);
    expect(links.every((l) => l.status === 'candidate')).toBe(true);
  });

  test('a rejected pair is never proposed again', async () => {
    const all = (await app.get<ShotMediaLink[]>('/api/v1/links')).data;
    const target = all.find((l) => l.status === 'candidate')!;
    const rej = await app.patch<ShotMediaLink>(`/api/v1/links/${target.id}`, { expected_revision: target.revision, action: 'reject' });
    expect(rej.data).toMatchObject({ status: 'rejected', confirmed_at: null });
    const r = await app.post<Out>('/api/v1/media/candidates', { user_regex: null });
    expect(r.data.created.find((l) => l.shot_id === target.shot_id && l.media_asset_id === target.media_asset_id)).toBeUndefined();
    const again = (await app.get<ShotMediaLink[]>('/api/v1/links')).data.find((l) => l.id === target.id)!;
    expect(again.status).toBe('rejected');
  });
});
