import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ApplyBreakdownResult, Board, BoardSpec, BoardView, DraftDetail, Entity, Scene, Shot, ShotRevision } from '@storyscript/contracts';
import { BoardSpec as BoardSpecSchema } from '@storyscript/contracts';
import { layoutBoard, LOOK_WIDE_PENCIL, RENDERER_VERSION } from '@storyscript/core';
import { latestBoard, listShotBoards } from '../src/db/repos/board.ts';
import { insertShot } from '../src/db/repos/shot.ts';
import { shotSeed } from '../src/services/boards/context.ts';
import { BREAKDOWN_REQUEST, bookshopRoster, importFixture, makeM3App, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * AT-05 (server part): apply → boards laid out automatically in the same
 * transaction → an edited version is saved → the project is closed and
 * reopened and everything reads back identically. Editing a shot marks its
 * board stale; regenerate lays out anew (manual edits dropped), keep
 * re-baselines. Stale expected_revision → 409 with nothing written.
 * INV-09 precondition: board edits never write back to shot.fields.
 * --demo replay: no network.
 */

let app: M3App;
let scene1: Scene;
let roster: Entity[];

async function breakdownAndApply(sceneId: string): Promise<ApplyBreakdownResult> {
  const res = await app.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/breakdown`, BREAKDOWN_REQUEST);
  expect(res.status, res.text).toBe(202);
  const job = await waitJob(app, res.data.job_id);
  expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
  const detail = (await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`)).data;
  const n = (detail.draft.parsed as { shots: unknown[] }).shots.length;
  const applied = await app.post<ApplyBreakdownResult>(`/api/v1/drafts/${detail.draft.id}/apply`, {
    selected: [...Array(n).keys()],
    replace_existing: false,
    expected_revisions: {},
  });
  expect(applied.status, applied.text).toBe(200);
  return applied.data;
}

const db = () => app.handle.projectSession.require().db;
const boards = async () => {
  const res = await app.get<BoardView[]>('/api/v1/boards');
  expect(res.status, res.text).toBe(200);
  return res.data;
};
const shots = async () => (await app.get<Shot[]>('/api/v1/shots')).data;
const versions = async (shotId: string) => (await app.get<Board[]>(`/api/v1/shots/${shotId}/boards`)).data;

/** A user edit: move the first person 0.8 m to screen right, swap to 85 mm, raise the camera. */
function edited(spec: BoardSpec): BoardSpec {
  const next = structuredClone(spec);
  const s = next.scene.subjects[0];
  if (s) s.x = Math.round((s.x + 0.8) * 100) / 100;
  next.camera.focal_mm = 85;
  next.camera.y = Math.round((next.camera.y + 0.3) * 100) / 100;
  next.overlay.labels = next.overlay.labels.map((l) => ({ ...l, text: `${l.text} · 改` }));
  return next;
}

beforeEach(async () => {
  app = await makeM3App({ demo: true });
  const imported = await importFixture(app, '01-bookshop.txt', 'txt');
  scene1 = imported.scenes[0]!;
  roster = await bookshopRoster(app);
});

afterEach(() => app.close());

describe('AT-05 boards (server)', () => {
  test('apply lays out one v1 board per created shot in the same transaction', async () => {
    const applied = await breakdownAndApply(scene1.id);
    expect(applied.created).toHaveLength(12);

    // straight from the database, before any list call could lay out lazily
    for (const shot of applied.created) {
      const b = latestBoard(db(), shot.id);
      expect(b, shot.code).not.toBeNull();
      expect(b).toMatchObject({ version: 1, parent_board_id: null, user_edited: false, revision: 0, renderer_version: RENDERER_VERSION });
      expect(b!.basis_content_hash).toBe(shot.content_hash);
      // exactly core layoutBoard with the documented context
      const expected = layoutBoard(shot.fields, {
        scene_sides: scene1.screen_sides,
        roster: roster.map((e, i) => ({ alias: e.alias, label: e.name, badge: 'AB'[i]!, entity_id: e.id })),
        look: LOOK_WIDE_PENCIL,
        technique: null,
        aspect: shot.fields.frame_format ?? '2.39',
        seed: shotSeed(shot.id),
      });
      expect(b!.spec).toEqual(expected);
    }

    const list = await boards();
    expect(list.map((b) => b.shot_code)).toEqual(applied.created.map((s) => s.code));
    expect(list.every((b) => !b.stale && b.scene_id === scene1.id && b.adopted_raster_id === null)).toBe(true);

    // roster: badges by alias order, label = entity name, entity_id kept
    const people = list.flatMap((b) => b.spec.scene.subjects);
    expect(people.length).toBeGreaterThan(0);
    for (const p of people) {
      const e = roster.find((r) => r.id === p.entity_id);
      expect(e, p.label).toBeDefined();
      expect(p.label).toBe(e!.name);
      expect(p.badge).toBe(e!.alias === 'c1' ? 'A' : 'B');
    }
  });

  test('a manual shot gets its v1 board in the create transaction', async () => {
    const applied = await breakdownAndApply(scene1.id);
    const base = applied.created[1]!;
    const res = await app.post<Shot>('/api/v1/shots', {
      scene_id: scene1.id,
      fields: { ...base.fields, shot_size: 'CU', narrative_purpose: '补一个近景' },
      manual_note: '现场补拍',
    });
    expect(res.status, res.text).toBe(201);
    const b = latestBoard(db(), res.data.id);
    expect(b).toMatchObject({ version: 1, user_edited: false, basis_content_hash: res.data.content_hash });
  });

  test('save an edited version → reopen the project → identical', async () => {
    await breakdownAndApply(scene1.id);
    const before = await boards();
    const target = before[3]!; // the over-the-shoulder shot
    const spec = edited(target.spec);

    const saved = await app.patch<BoardView>(`/api/v1/boards/${target.id}`, { expected_revision: target.revision, spec });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.data).toMatchObject({
      shot_id: target.shot_id,
      version: 2,
      parent_board_id: target.id,
      user_edited: true,
      revision: 0,
      basis_content_hash: target.basis_content_hash,
      stale: false,
    });
    expect(saved.data.spec).toEqual(BoardSpecSchema.parse(spec));

    const vs = await versions(target.shot_id);
    expect(vs.map((v) => v.version)).toEqual([1, 2]);
    expect(vs[0]!.spec).toEqual(target.spec);

    const after = await boards();
    expect(after.find((b) => b.shot_id === target.shot_id)?.id).toBe(saved.data.id);

    // close and reopen: the same boards, versions and specs
    const closed = await app.post('/api/v1/projects/close');
    expect(closed.status).toBe(204);
    const reopened = await app.post('/api/v1/projects/open', { dir: app.projectDir });
    expect(reopened.status, reopened.text).toBe(200);
    expect(await boards()).toEqual(after);
    expect(await versions(target.shot_id)).toEqual(vs);
  });

  test('editing the shot marks its board stale; keep re-baselines, regenerate lays out anew', async () => {
    await breakdownAndApply(scene1.id);
    const list = await boards();
    const target = list[1]!; // MS single
    const shot = (await shots()).find((s) => s.id === target.shot_id)!;
    const saved = (await app.patch<BoardView>(`/api/v1/boards/${target.id}`, { expected_revision: 0, spec: edited(target.spec) })).data;

    // change the shot: MS → MCU
    const upd = await app.patch<Shot>(`/api/v1/shots/${shot.id}`, { expected_revision: shot.revision, fields: { ...shot.fields, shot_size: 'MCU' } });
    expect(upd.status, upd.text).toBe(200);
    const stale = (await boards()).find((b) => b.shot_id === shot.id)!;
    expect(stale).toMatchObject({ id: saved.id, stale: true, basis_content_hash: shot.content_hash });
    // other boards unaffected
    expect((await boards()).filter((b) => b.stale).map((b) => b.shot_id)).toEqual([shot.id]);

    // keep: same version and spec, re-based on the new content, revision + 1
    const kept = await app.post<BoardView>(`/api/v1/boards/${saved.id}/keep`, { expected_revision: 0 });
    expect(kept.status, kept.text).toBe(200);
    expect(kept.data).toMatchObject({ id: saved.id, version: 2, revision: 1, stale: false, basis_content_hash: upd.data.content_hash });
    expect(kept.data.spec).toEqual(saved.spec);
    expect((await versions(shot.id)).map((v) => v.version)).toEqual([1, 2]);

    // change again (MCU → CU), then regenerate: v3 from the fields, manual edits dropped
    const upd2 = await app.patch<Shot>(`/api/v1/shots/${shot.id}`, {
      expected_revision: upd.data.revision,
      fields: { ...upd.data.fields, shot_size: 'CU' },
    });
    expect(upd2.status).toBe(200);
    expect((await boards()).find((b) => b.shot_id === shot.id)!.stale).toBe(true);
    const regen = await app.post<BoardView>(`/api/v1/shots/${shot.id}/boards`);
    expect(regen.status, regen.text).toBe(201);
    expect(regen.data).toMatchObject({
      version: 3,
      parent_board_id: saved.id,
      user_edited: false,
      revision: 0,
      stale: false,
      basis_content_hash: upd2.data.content_hash,
    });
    const fresh = layoutBoard(upd2.data.fields, {
      scene_sides: scene1.screen_sides,
      roster: roster.map((e, i) => ({ alias: e.alias, label: e.name, badge: 'AB'[i]!, entity_id: e.id })),
      look: LOOK_WIDE_PENCIL,
      technique: null,
      aspect: '2.39',
      seed: shotSeed(shot.id),
    });
    expect(regen.data.spec).toEqual(fresh);
    expect(regen.data.spec.camera.focal_mm).not.toBe(85);
    expect((await boards()).find((b) => b.shot_id === shot.id)!.id).toBe(regen.data.id);
  });

  test('stale expected_revision or an old version → 409, nothing written', async () => {
    await breakdownAndApply(scene1.id);
    const target = (await boards())[0]!;
    const v2 = (await app.patch<BoardView>(`/api/v1/boards/${target.id}`, { expected_revision: 0, spec: edited(target.spec) })).data;
    const count = () => listShotBoards(db(), target.shot_id).length;
    expect(count()).toBe(2);

    // saving on top of v1 again (another tab still shows it)
    const old = await app.patch(`/api/v1/boards/${target.id}`, { expected_revision: 0, spec: target.spec });
    expect(old.status).toBe(409);
    expect(old.body.error).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(old.body.error?.details).toMatchObject({ latest_board_id: v2.id, latest_version: 2 });

    // keep bumps v2 to revision 1; a save that still expects 0 is refused
    expect((await app.post(`/api/v1/boards/${v2.id}/keep`, { expected_revision: 0 })).status).toBe(200);
    const stale = await app.patch(`/api/v1/boards/${v2.id}`, { expected_revision: 0, spec: v2.spec });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('REVISION_CONFLICT');
    const staleKeep = await app.post(`/api/v1/boards/${v2.id}/keep`, { expected_revision: 0 });
    expect(staleKeep.status).toBe(409);
    expect(count()).toBe(2);
    expect(latestBoard(db(), target.shot_id)).toMatchObject({ id: v2.id, revision: 1 });

    // the right revision goes through
    const ok = await app.patch<BoardView>(`/api/v1/boards/${v2.id}`, { expected_revision: 1, spec: v2.spec });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.data.version).toBe(3);

    // invalid spec → 400, unknown board → 404
    const bad = await app.patch(`/api/v1/boards/${ok.data.id}`, { expected_revision: 0, spec: { ...v2.spec, version: 2 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe('VALIDATION_ERROR');
    const missing = await app.patch('/api/v1/boards/00000000-0000-4000-8000-000000000000', { expected_revision: 0, spec: v2.spec });
    expect(missing.status).toBe(404);
    expect(count()).toBe(3);
  });

  test('INV-09 precondition: board edits never write back to the shot', async () => {
    await breakdownAndApply(scene1.id);
    const list = await boards();
    const before = await shots();
    const revs = async (id: string) => (await app.get<ShotRevision[]>(`/api/v1/shots/${id}/revisions`)).data;
    const revCounts = await Promise.all(before.map((s) => revs(s.id).then((r) => r.length)));

    for (const b of list.slice(0, 4)) {
      const spec = edited(b.spec);
      spec.frame.aspect = '1.43';
      spec.camera.pitch_deg = 12;
      const r = await app.patch<BoardView>(`/api/v1/boards/${b.id}`, { expected_revision: b.revision, spec });
      expect(r.status, r.text).toBe(200);
      await app.post(`/api/v1/boards/${r.data.id}/keep`, { expected_revision: 0 });
      await app.post(`/api/v1/shots/${b.shot_id}/boards`);
    }

    const after = await shots();
    expect(after).toEqual(before);
    expect(await Promise.all(after.map((s) => revs(s.id).then((r) => r.length)))).toEqual(revCounts);
  });

  test('listBoards lays out a missing v1 lazily and skips archived shots', async () => {
    const applied = await breakdownAndApply(scene1.id);
    // a shot written without going through the create route (e.g. an older project)
    const src = applied.created[0]!;
    const orphan: Shot = { ...src, id: '11111111-1111-4111-8111-111111111111', code: '099', narrative_pos: 99 };
    insertShot(db(), orphan);
    expect(latestBoard(db(), orphan.id)).toBeNull();
    const list = await boards();
    expect(list).toHaveLength(13);
    const lazy = list.find((b) => b.shot_id === orphan.id)!;
    expect(lazy).toMatchObject({ version: 1, user_edited: false, stale: false, shot_code: '099' });
    // a second call does not lay out again
    expect((await boards()).find((b) => b.shot_id === orphan.id)!.id).toBe(lazy.id);

    // archived: gone from the list, writes refused
    const victim = applied.created[2]!;
    const arch = await app.post(`/api/v1/shots/${victim.id}/archive`, { expected_revision: 0, reason: '不拍了' });
    expect(arch.status, arch.text).toBe(200);
    const listed = await boards();
    expect(listed.some((b) => b.shot_id === victim.id)).toBe(false);
    expect((await app.post(`/api/v1/shots/${victim.id}/boards`)).status).toBe(409);
    // versions of an archived shot stay readable
    expect((await versions(victim.id)).length).toBe(1);
    expect((await app.get('/api/v1/shots/00000000-0000-4000-8000-000000000000/boards')).status).toBe(404);
  });
});
