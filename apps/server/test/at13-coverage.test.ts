import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoverageDecision, CoverageResult, MediaAssetView, Shot, ShotMediaLink, Take } from '@storyscript/contracts';
import { computeCoverageAll } from '@storyscript/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateMedia, SAMPLE } from '../../../scripts/gen-media.ts';
import { listDecisions } from '../src/db/repos/coverage.ts';
import {
  addAndScan,
  BASE_FIELDS,
  FFMPEG,
  HAS_FFMPEG,
  makeWorkspace,
  seedShots,
  startApp,
  type MediaApp,
  type Workspace,
} from './media-fixture.ts';

/**
 * AT-13: coverage of a mixed project — required / optional / waived shots,
 * a take without media, media not yet confirmed, a usable decision, a file
 * gone offline, a manual pickup. The API result equals core computeCoverageAll
 * run on the same facts (COV), and a good rating never makes a shot usable.
 */

describe.skipIf(!HAS_FFMPEG)('AT-13 coverage and the missing-shot list', () => {
  let ws: Workspace;
  let app: MediaApp;
  let card: string;
  const shot = {} as Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H', Shot>;
  let assets: Map<string, MediaAssetView>;
  const link = {} as Record<'A' | 'B' | 'G' | 'H', ShotMediaLink>;

  const take = async (shotIds: string[], rating: Take['rating'] = 'good') => {
    const r = await app.post<Take>('/api/v1/takes', {
      setup_id: null,
      camera_label: 'A',
      rating,
      clip_hint: null,
      notes: '',
      shot_ids: shotIds,
      unresolved_labels: [],
    });
    expect(r.status).toBe(201);
    return r.data;
  };
  const manualLink = async (shotId: string, file: string, takeId: string | null) => {
    const r = await app.post<ShotMediaLink>('/api/v1/links', { shot_id: shotId, media_asset_id: assets.get(file)!.id, take_id: takeId });
    expect(r.status).toBe(201);
    return r.data;
  };
  const confirm = async (l: ShotMediaLink) => {
    const r = await app.patch<ShotMediaLink>(`/api/v1/links/${l.id}`, { expected_revision: l.revision, action: 'confirm' });
    expect(r.status).toBe(200);
    return r.data;
  };
  const coverage = async () => new Map((await app.get<CoverageResult[]>('/api/v1/coverage')).data.map((c) => [c.shot_id, c] as const));
  const decide = (shotId: string, body: object) => app.post<CoverageDecision>(`/api/v1/shots/${shotId}/coverage-decisions`, body);

  beforeAll(async () => {
    ws = makeWorkspace();
    app = await startApp(ws, { create: true });
    const seeded = await seedShots(app);
    [shot.A, shot.B, shot.C] = seeded.s1 as [Shot, Shot, Shot];
    shot.D = seeded.s2[0]!;
    const extra = async (code: string) =>
      (await app.post<Shot>('/api/v1/shots', { scene_id: seeded.scenes[1]!.id, fields: { ...BASE_FIELDS, action: code }, manual_note: '补充', code })).data;
    shot.E = await extra('002');
    shot.F = await extra('003');
    shot.G = await extra('004');
    shot.H = await extra('005');

    const opt = await app.post<Shot>(`/api/v1/shots/${shot.E.id}/requirement`, { expected_revision: shot.E.revision, required_status: 'optional', reason: '时间够再拍' });
    expect(opt.status).toBe(200);
    const waive = await app.post<Shot>(`/api/v1/shots/${shot.F.id}/requirement`, { expected_revision: shot.F.revision, required_status: 'waived', reason: '剪辑上不需要' });
    expect(waive.status).toBe(200);

    card = join(ws.root, 'card');
    await generateMedia(card, { ffmpeg: FFMPEG, small: true });
    await addAndScan(app, card);
    assets = new Map((await app.get<MediaAssetView[]>('/api/v1/media/assets')).data.map((a) => [a.rel_path, a] as const));

    // A: take + confirmed link (made usable below)
    const tA = await take([shot.A.id]);
    link.A = await confirm(await manualLink(shot.A.id, SAMPLE.h264Mp4, tA.id));
    // B: take + candidate link, never confirmed
    const tB = await take([shot.B.id]);
    link.B = await manualLink(shot.B.id, SAMPLE.h264Mov, tB.id);
    // C: take rated good, no media at all
    await take([shot.C.id], 'good');
    // D: nothing logged; E optional, F waived: nothing either
    // G: take + confirmed link, but the director calls a pickup
    const tG = await take([shot.G.id], 'alternate');
    link.G = await confirm(await manualLink(shot.G.id, SAMPLE.timecodeMov, tG.id));
    // H: take + confirmed link whose file will go offline
    const tH = await take([shot.H.id]);
    link.H = await confirm(await manualLink(shot.H.id, SAMPLE.vfrMp4, tH.id));
  }, 120_000);

  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  test('before any decision: ratings alone never make a shot usable', async () => {
    const cov = await coverage();
    expect(cov.get(shot.A.id)).toMatchObject({ status: 'attempted', missing_reason: 'no_confirmed_usable' });
    expect(cov.get(shot.B.id)).toMatchObject({ status: 'attempted', missing_reason: 'no_confirmed_usable' });
    expect(cov.get(shot.C.id)).toMatchObject({ status: 'attempted', missing_reason: 'no_link', facts: { take_count: 1, link_count: 0 } });
    expect(cov.get(shot.D.id)).toMatchObject({ status: 'planned', missing_reason: 'no_take' });
    expect(cov.get(shot.E.id)).toMatchObject({ status: 'planned', required_status: 'optional', missing_reason: null });
    expect(cov.get(shot.F.id)).toMatchObject({ status: 'waived', required_status: 'waived', missing_reason: null });
    for (const c of cov.values()) expect(c.status).not.toBe('usable');
  });

  test('usable needs confirmed, online links of this very shot, and a reason', async () => {
    expect((await decide(shot.B.id, { decision: 'usable', selected_link_ids: [link.B.id], reason: '看过了' })).status).toBe(400); // candidate
    expect((await decide(shot.A.id, { decision: 'usable', selected_link_ids: [link.G.id], reason: '看过了' })).status).toBe(400); // other shot
    expect((await decide(shot.A.id, { decision: 'usable', selected_link_ids: [], reason: '看过了' })).status).toBe(400);
    expect((await decide(shot.A.id, { decision: 'usable', selected_link_ids: [link.A.id], reason: '   ' })).status).toBe(400);
    expect((await decide(shot.A.id, { decision: 'usable', selected_link_ids: [link.A.id] })).status).toBe(400);
    expect((await decide(shot.G.id, { decision: 'needs_pickup', selected_link_ids: [link.G.id], reason: '补拍' })).status).toBe(400);

    const okA = await decide(shot.A.id, { decision: 'usable', selected_link_ids: [link.A.id], reason: '焦点准，表演可用' });
    expect(okA.status).toBe(201);
    expect(okA.data).toMatchObject({ decision: 'usable', basis_content_hash: shot.A.content_hash, selected_link_ids: [link.A.id] });
    const okH = await decide(shot.H.id, { decision: 'usable', selected_link_ids: [link.H.id], reason: '可用' });
    expect(okH.status).toBe(201);
    const pickup = await decide(shot.G.id, { decision: 'needs_pickup', selected_link_ids: [], reason: '穿帮，需要补拍' });
    expect(pickup.status).toBe(201);

    const cov = await coverage();
    expect(cov.get(shot.A.id)).toMatchObject({ status: 'usable', missing_reason: null, flags: [] });
    expect(cov.get(shot.H.id)).toMatchObject({ status: 'usable', missing_reason: null });
    expect(cov.get(shot.G.id)).toMatchObject({ status: 'needs_pickup', missing_reason: 'no_confirmed_usable' });
  });

  test('a usable clip that goes offline: previously_usable + source_offline, missing file_offline', async () => {
    await rm(join(card, SAMPLE.vfrMp4));
    const rootId = assets.get(SAMPLE.vfrMp4)!.source_root_id;
    const check = await app.post(`/api/v1/media/roots/${rootId}/check`);
    expect(check.status).toBe(200);
    const cov = await coverage();
    expect(cov.get(shot.H.id)).toMatchObject({
      status: 'attempted',
      flags: ['previously_usable', 'source_offline'],
      missing_reason: 'file_offline',
      facts: { offline_link_count: 1 },
    });
    // an offline link can no longer be chosen
    const again = await decide(shot.H.id, { decision: 'usable', selected_link_ids: [link.H.id], reason: '再试' });
    expect(again.status).toBe(400);
  });

  test('clear revokes a decision; decisions are append-only', async () => {
    const clear = await decide(shot.G.id, { decision: 'clear', selected_link_ids: [], reason: '补拍取消' });
    expect(clear.status).toBe(201);
    const cov = await coverage();
    expect(cov.get(shot.G.id)).toMatchObject({ status: 'attempted', missing_reason: 'no_confirmed_usable' });
    const db = app.handle.projectSession.require().db;
    const all = listDecisions(db).filter((d) => d.shot_id === shot.G.id);
    expect(all.map((d) => d.decision)).toEqual(['needs_pickup', 'clear']);
    expect(() => db.run('DELETE FROM coverage_decision WHERE id = ?', all[0]!.id)).toThrow(/append-only/);
  });

  test('editing the shot makes the usable decision stale', async () => {
    const edited = await app.patch<Shot>(`/api/v1/shots/${shot.A.id}`, {
      expected_revision: shot.A.revision,
      fields: { ...shot.A.fields, action: '改成推镜头' },
    });
    expect(edited.status).toBe(200);
    const cov = await coverage();
    expect(cov.get(shot.A.id)).toMatchObject({ status: 'attempted', flags: ['decision_stale'], missing_reason: 'no_confirmed_usable' });
  });

  test('COV: the API returns exactly core computeCoverageAll on the same facts', async () => {
    const shots = (await app.get<Shot[]>('/api/v1/shots')).data;
    const takes = (await app.get<Take[]>('/api/v1/takes')).data;
    const links = (await app.get<ShotMediaLink[]>('/api/v1/links')).data;
    const media = (await app.get<MediaAssetView[]>('/api/v1/media/assets')).data;
    const decisions = listDecisions(app.handle.projectSession.require().db);
    const expected = computeCoverageAll(
      shots.map((s) => ({ id: s.id, required_status: s.required_status, content_hash: s.content_hash })),
      { takes, links, assets: media.map((a) => ({ id: a.id, availability: a.availability, probe: a.probe })), decisions },
    );
    const api = (await app.get<CoverageResult[]>('/api/v1/coverage')).data;
    expect(api).toEqual(expected);
    expect(api.length).toBe(8);
  });
});
