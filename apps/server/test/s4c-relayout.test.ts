import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Board, BoardSpec, BoardView, CollabChanges, RelayoutBoardsResult, Scene, Shot } from '@storyscript/contracts';
import { layoutBoard, LOOK_WIDE_PENCIL, RENDERER_VERSION } from '@storyscript/core';
import { latestBoard, listShotBoards } from '../src/db/repos/board.ts';
import { relayoutBoards } from '../src/services/boards/boards.ts';
import { shotSeed } from '../src/services/boards/context.ts';
import { importFixture, makeM3App, type M3App } from './helpers/m3-app.ts';
import { BASE_FIELDS } from './media-fixture.ts';

/**
 * S4c relayout ("用新画法重排"): POST /boards/relayout lays a new auto version
 * out for every live shot whose newest board was drawn by an older renderer
 * and not edited by hand. Edited boards are kept and counted, boards already
 * on the current renderer are skipped, archived shots are left out, AI redraw
 * rows are never touched. Compared against the renderer's current
 * RENDERER_VERSION: an "old" board is one stamped with anything else.
 */

const OLD = 'board-m1.0';

let app: M3App;
let scenes: Scene[];
/** scene 1: a, b, c; scene 2: d, e */
let shots: { a: Shot; b: Shot; c: Shot; d: Shot; e: Shot };

const db = () => app.handle.projectSession.require().db;
const boards = async () => (await app.get<BoardView[]>('/api/v1/boards')).data;
const relayout = (scene_id?: string | null) => app.post<RelayoutBoardsResult>('/api/v1/boards/relayout', scene_id === undefined ? {} : { scene_id });
const versionsOf = (s: Shot) => listShotBoards(db(), s.id);
const versionNumbers = (s: Shot) => versionsOf(s).map((b) => b.version);

async function makeShot(sceneIndex: number, code: string, action: string): Promise<Shot> {
  const r = await app.post<Shot>('/api/v1/shots', { scene_id: scenes[sceneIndex]!.id, fields: { ...BASE_FIELDS, action }, manual_note: '测试用手工镜头', code });
  expect(r.status, r.text).toBe(201);
  return r.data;
}

/** Make a shot's whole board chain look like an older renderer drew it. */
function makeOld(...list: Shot[]): void {
  for (const s of list) db().run('UPDATE board SET renderer_version = ? WHERE shot_id = ?', OLD, s.id);
}

function edited(spec: BoardSpec): BoardSpec {
  const next = structuredClone(spec);
  next.camera.focal_mm = 85;
  return next;
}

const rasterRows = () => db().all('SELECT * FROM board_raster ORDER BY id');

beforeEach(async () => {
  app = await makeM3App();
  const imported = await importFixture(app, '01-bookshop.txt', 'txt');
  scenes = imported.scenes;
  expect(scenes.length).toBeGreaterThanOrEqual(2);
  shots = {
    a: await makeShot(0, '001', '店主整理书架'),
    b: await makeShot(0, '002', '年轻人推门'),
    c: await makeShot(0, '003', '两人对视'),
    d: await makeShot(1, '001', '后屋的灯亮着'),
    e: await makeShot(1, '002', '桌上放着一本书'),
  };
});

afterEach(() => app.close());

describe('S4c relayoutBoards', () => {
  test('boards already on the current renderer are skipped: nothing is written', async () => {
    const res = await relayout(null);
    expect(res.status, res.text).toBe(200);
    expect(res.data).toEqual({ relaid: 0, kept_edited: 0, already_current: 5 });
    for (const s of Object.values(shots)) expect(versionNumbers(s)).toEqual([1]);
    // an empty body means every scene
    expect((await relayout()).data).toEqual({ relaid: 0, kept_edited: 0, already_current: 5 });
  });

  test('one scene: old auto boards get a new version, an edited one is kept, a current one is skipped', async () => {
    const b1 = latestBoard(db(), shots.b.id)!;
    const savedB = await app.patch<BoardView>(`/api/v1/boards/${b1.id}`, { expected_revision: 0, spec: edited(b1.spec) });
    expect(savedB.status, savedB.text).toBe(200);
    // a, b (edited) and both shots of scene 2 are old; c is current
    makeOld(shots.a, shots.b, shots.d, shots.e);

    const res = await relayout(scenes[0]!.id);
    expect(res.status, res.text).toBe(200);
    expect(res.data).toEqual({ relaid: 1, kept_edited: 1, already_current: 1 });

    // a: v2, auto, on the current renderer, laid out from the shot as it is now
    const a2 = latestBoard(db(), shots.a.id)!;
    expect(a2).toMatchObject({ version: 2, user_edited: false, revision: 0, renderer_version: RENDERER_VERSION, basis_content_hash: shots.a.content_hash });
    expect(a2.parent_board_id).toBe(versionsOf(shots.a)[0]!.id);
    expect(a2.spec).toEqual(
      layoutBoard(shots.a.fields, {
        scene_sides: scenes[0]!.screen_sides,
        roster: [],
        look: LOOK_WIDE_PENCIL,
        technique: null,
        aspect: '2.39',
        seed: shotSeed(shots.a.id),
      }),
    );
    // b: still the saved edit; c: still v1; the other scene is untouched
    expect(latestBoard(db(), shots.b.id)).toMatchObject({ id: savedB.data.id, version: 2, user_edited: true });
    expect(versionNumbers(shots.b)).toEqual([1, 2]);
    expect(versionNumbers(shots.c)).toEqual([1]);
    expect(versionNumbers(shots.d)).toEqual([1]);
    expect(versionNumbers(shots.e)).toEqual([1]);
    expect(latestBoard(db(), shots.d.id)!.renderer_version).toBe(OLD);

    // every scene now: the two old boards of scene 2 follow; a is current, b stays edited
    const all = await relayout(null);
    expect(all.data).toEqual({ relaid: 2, kept_edited: 1, already_current: 2 });
    expect(versionNumbers(shots.d)).toEqual([1, 2]);
    expect(latestBoard(db(), shots.d.id)).toMatchObject({ user_edited: false, renderer_version: RENDERER_VERSION });

    // nothing left to do
    expect((await relayout(null)).data).toEqual({ relaid: 0, kept_edited: 1, already_current: 4 });
    const list = await boards();
    expect(list).toHaveLength(5);
    expect(list.filter((b) => b.renderer_version !== RENDERER_VERSION).map((b) => b.shot_id)).toEqual([shots.b.id]);
  });

  test('a hand-edited newest board is kept even when its renderer is old; an auto board over an edited parent is not', async () => {
    const b1 = latestBoard(db(), shots.b.id)!;
    const b2 = (await app.patch<BoardView>(`/api/v1/boards/${b1.id}`, { expected_revision: 0, spec: edited(b1.spec) })).data;
    makeOld(shots.b);
    expect((await relayout(null)).data.kept_edited).toBe(1);
    expect(latestBoard(db(), shots.b.id)!.id).toBe(b2.id);

    // regenerate drops the edit (v3, auto); once that one is old, relayout lays out v4
    expect((await app.post(`/api/v1/shots/${shots.b.id}/boards`)).status).toBe(201);
    makeOld(shots.b);
    const res = await relayout(scenes[0]!.id);
    expect(res.data).toMatchObject({ relaid: 1, kept_edited: 0 });
    expect(versionNumbers(shots.b)).toEqual([1, 2, 3, 4]);
    expect(latestBoard(db(), shots.b.id)).toMatchObject({ version: 4, user_edited: false, renderer_version: RENDERER_VERSION });
  });

  test('a stale auto board is re-based on the shot, like regenerate', async () => {
    const upd = await app.patch<Shot>(`/api/v1/shots/${shots.a.id}`, { expected_revision: shots.a.revision, fields: { ...shots.a.fields, shot_size: 'CU' } });
    expect(upd.status, upd.text).toBe(200);
    expect((await boards()).find((b) => b.shot_id === shots.a.id)!.stale).toBe(true);
    makeOld(shots.a);
    expect((await relayout(scenes[0]!.id)).data.relaid).toBe(1);
    const view = (await boards()).find((b) => b.shot_id === shots.a.id)!;
    expect(view).toMatchObject({ version: 2, stale: false, basis_content_hash: upd.data.content_hash });
    expect(view.spec.camera).not.toEqual(versionsOf(shots.a)[0]!.spec.camera);
  });

  test('archived shots are left out; AI redraw rows are never touched', async () => {
    makeOld(shots.d, shots.e);
    const v1 = latestBoard(db(), shots.d.id)!;
    db().run(
      `INSERT INTO board_raster (id, board_id, structure_hash, dialect, host, model, preset_id, size, quality, prompt_hash, control_sha256, file, sha256, status, outcome, usage_json, ai_label_on, source_type, created_at)
       VALUES ('00000000-0000-4000-8000-0000000000aa', ?, 'h', 'images', 'x.test', 'm', NULL, '1792x768', NULL, 'p', 'c', NULL, NULL, 'adopted', 'ok', NULL, 1, 'model_generated', '2026-10-05T00:00:00.000Z')`,
      v1.id,
    );
    const rastersBefore = rasterRows();
    expect(rastersBefore).toHaveLength(1);

    const arch = await app.post(`/api/v1/shots/${shots.e.id}/archive`, { expected_revision: 0, reason: '不拍了' });
    expect(arch.status, arch.text).toBe(200);

    const res = await relayout(scenes[1]!.id);
    expect(res.data).toEqual({ relaid: 1, kept_edited: 0, already_current: 0 });
    expect(versionNumbers(shots.e)).toEqual([1]);
    expect(latestBoard(db(), shots.e.id)!.renderer_version).toBe(OLD);
    expect(versionNumbers(shots.d)).toEqual([1, 2]);

    expect(rasterRows()).toEqual(rastersBefore);
    // the new version starts without an adopted picture; the old one keeps its own
    const view = (await boards()).find((b) => b.shot_id === shots.d.id)!;
    expect(view).toMatchObject({ version: 2, adopted_raster_id: null });
    expect((await app.get<Board[]>(`/api/v1/shots/${shots.d.id}/boards`)).data.map((b) => b.id)).toContain(v1.id);
  });

  test('a shot without a board gets its first one; all of it commits or none', async () => {
    // an older project: a shot whose v1 was never laid out
    db().run('DELETE FROM board WHERE shot_id = ?', shots.c.id);
    expect(latestBoard(db(), shots.c.id)).toBeNull();
    const res = await relayout(scenes[0]!.id);
    expect(res.data).toEqual({ relaid: 1, kept_edited: 0, already_current: 2 });
    expect(latestBoard(db(), shots.c.id)).toMatchObject({ version: 1, parent_board_id: null, renderer_version: RENDERER_VERSION });

    // one transaction: a failure part-way (here: the second insert) rolls the first back
    makeOld(shots.a, shots.b);
    let inserts = 0;
    const realRun = db().run.bind(db());
    const flaky = db();
    flaky.run = ((sql: string, ...params: never[]) => {
      if (sql.startsWith('INSERT INTO board ') && ++inserts === 2) throw new Error('disk full');
      return realRun(sql, ...params);
    }) as typeof flaky.run;
    try {
      expect(() => relayoutBoards(flaky, { scene_id: null })).toThrow('disk full');
    } finally {
      flaky.run = realRun;
    }
    expect(versionNumbers(shots.a)).toEqual([1]);
    expect(versionNumbers(shots.b)).toEqual([1]);
  });

  test('bad input: unknown scene 404, malformed scene id 400; the feed files it under boards', async () => {
    expect((await relayout('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    const bad = await relayout('not-a-uuid');
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe('VALIDATION_ERROR');

    makeOld(shots.a);
    const start = (await app.get<CollabChanges>('/api/v1/collab/changes?since=0&epoch=&tab=t1&page=boards')).data;
    expect((await relayout(null)).data.relaid).toBe(1);
    const after = (await app.get<CollabChanges>(`/api/v1/collab/changes?since=${start.seq}&epoch=${start.epoch}&tab=t1&page=boards`)).data;
    expect(after.events.map((e) => e.areas)).toEqual([['boards']]);
  });
});
