import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ApplyBreakdownResult, DraftDetail, Scene, Shot, ShotRevision } from '@storyscript/contracts';
import { BREAKDOWN_REQUEST, bookshopRoster, importFixture, makeM3App, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * AT-04: locked shots survive re-breakdown + apply(replace_existing); stale
 * expected_revision → 409 with nothing changed; other scenes untouched;
 * narrative order only rewrites narrative_pos (INV-01).
 * Uses --demo (ReplayChat over fixtures/replay): no network at all.
 */

let app: M3App;
let s1: Scene;
let s2: Scene;

async function breakdown(sceneId: string): Promise<DraftDetail> {
  const res = await app.post<{ job_id: string }>(`/api/v1/scenes/${sceneId}/breakdown`, BREAKDOWN_REQUEST);
  expect(res.status, res.text).toBe(202);
  const job = await waitJob(app, res.data.job_id);
  expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
  expect(job.remote).toBe(false);
  const d = await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`);
  return d.data;
}

async function applyAll(detail: DraftDetail, replace = false, expected: Record<string, number> = {}) {
  const n = (detail.draft.parsed as { shots: unknown[] }).shots.length;
  return app.post<ApplyBreakdownResult>(`/api/v1/drafts/${detail.draft.id}/apply`, {
    selected: [...Array(n).keys()],
    replace_existing: replace,
    expected_revisions: expected,
  });
}

const sceneShots = async (sceneId: string) => (await app.get<Shot[]>('/api/v1/shots')).data.filter((s) => s.scene_id === sceneId);

beforeEach(async () => {
  app = await makeM3App({ demo: true });
  const imported = await importFixture(app, '01-bookshop.txt', 'txt');
  [s1, s2] = imported.scenes as [Scene, Scene];
  await bookshopRoster(app);
  const d1 = await breakdown(s1.id);
  expect(d1.draft.issues.filter((i) => i.level === 'error')).toEqual([]);
  expect((await applyAll(d1)).status).toBe(200);
  const d2 = await breakdown(s2.id);
  expect((await applyAll(d2)).status).toBe(200);
});

afterEach(() => app.close());

describe('AT-04 lock & revision', () => {
  test('locked shot is untouched by re-breakdown + apply(replace_existing)', async () => {
    const before1 = await sceneShots(s1.id);
    const before2 = await sceneShots(s2.id);
    expect(before1).toHaveLength(12);
    expect(before2).toHaveLength(5);

    const target = before1[1]!;
    const locked = await app.patch<Shot>(`/api/v1/shots/${target.id}`, { expected_revision: 0, locked: true });
    expect(locked.status, locked.text).toBe(200);
    expect(locked.data).toMatchObject({ locked: true, revision: 1, content_hash: target.content_hash });

    // locked: content edits and archiving are refused
    const edit = await app.patch(`/api/v1/shots/${target.id}`, {
      expected_revision: 1,
      fields: { ...target.fields, action: '改动' },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error?.code).toBe('LOCKED_SHOT');
    const archive = await app.post(`/api/v1/shots/${target.id}/archive`, { expected_revision: 1, reason: '不要了' });
    expect(archive.body.error?.code).toBe('LOCKED_SHOT');

    // a manual shot in the same scene is not an AI shot → never archived by replace_existing
    const manual = await app.post<Shot>('/api/v1/shots', {
      scene_id: s1.id,
      fields: { ...before1[0]!.fields, narrative_purpose: '补一个空镜' },
      manual_note: '现场补拍',
    });
    expect(manual.status, manual.text).toBe(201);
    expect(manual.data).toMatchObject({ origin: 'manual', code: '013', revision: 0 });

    const lockedBefore = (await sceneShots(s1.id)).find((s) => s.id === target.id)!;
    const d3 = await breakdown(s1.id);
    const expected = Object.fromEntries((await sceneShots(s1.id)).map((s) => [s.id, s.revision]));
    const res = await applyAll(d3, true, expected);
    expect(res.status, res.text).toBe(200);
    expect(res.data.created).toHaveLength(12);
    expect(res.data.skipped_locked_ids).toEqual([target.id]);
    expect(res.data.archived_ids).toHaveLength(11);
    expect(res.data.archived_ids).not.toContain(target.id);
    expect(res.data.archived_ids).not.toContain(manual.data.id);

    const after1 = await sceneShots(s1.id);
    const lockedAfter = after1.find((s) => s.id === target.id)!;
    expect(lockedAfter).toEqual(lockedBefore);
    expect(after1.find((s) => s.id === manual.data.id)).toMatchObject({ archived: false, revision: 0 });
    expect(after1).toHaveLength(1 + 1 + 12);
    // new codes continue after the kept ones, never reusing a live code
    const codes = after1.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);

    // unrelated scene untouched
    expect(await sceneShots(s2.id)).toEqual(before2);

    // archived shots got a revision row with the reason
    const archivedId = res.data.archived_ids[0]!;
    const revs = await app.get<ShotRevision[]>(`/api/v1/shots/${archivedId}/revisions`);
    expect(revs.data.map((r) => r.revision)).toEqual([0, 1]);
    expect(revs.data[1]!.reason).toContain('替换');
  });

  test('stale expected_revision → 409 and the whole apply changes nothing', async () => {
    const shots = await sceneShots(s1.id);
    const edited = shots[2]!;
    const ok = await app.patch<Shot>(`/api/v1/shots/${edited.id}`, {
      expected_revision: 0,
      fields: { ...edited.fields, action: '林晓推门进来，停在门口' },
      reason: '改动作描述',
    });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.data.revision).toBe(1);
    expect(ok.data.content_hash).not.toBe(edited.content_hash);

    // stale PATCH
    const stale = await app.patch(`/api/v1/shots/${edited.id}`, { expected_revision: 0, code: '3A' });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('REVISION_CONFLICT');

    const d3 = await breakdown(s1.id);
    const snapshot = await app.get<Shot[]>('/api/v1/shots');
    const staleMap = Object.fromEntries(shots.map((s) => [s.id, s.revision])); // edited still at 0
    const res = await applyAll(d3, true, staleMap);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('REVISION_CONFLICT');
    expect(JSON.stringify(res.body.error?.details)).toContain(edited.id);

    // one shot missing from expected_revisions is a conflict as well
    const fresh = Object.fromEntries((await sceneShots(s1.id)).map((s) => [s.id, s.revision]));
    delete fresh[shots[5]!.id];
    const missing = await applyAll(d3, true, fresh);
    expect(missing.status).toBe(409);

    expect((await app.get<Shot[]>('/api/v1/shots')).data).toEqual(snapshot.data);
    const draft = await app.get<DraftDetail>(`/api/v1/drafts/${d3.draft.id}`);
    expect(draft.data.draft.status).toBe('pending');
    expect(draft.data.current_shots).toHaveLength(12);

    // revisions of the edited shot: 0 (ai) → 1 (manual, reason)
    const revs = await app.get<ShotRevision[]>(`/api/v1/shots/${edited.id}/revisions`);
    expect(revs.data.map((r) => [r.revision, r.origin, r.reason])).toEqual([
      [0, 'ai', expect.stringContaining('应用拆镜草案')],
      [1, 'manual', '改动作描述'],
    ]);
  });

  test('code edits keep content_hash; requirement changes need a reason and are recorded', async () => {
    const shot = (await sceneShots(s1.id))[0]!;
    const renamed = await app.patch<Shot>(`/api/v1/shots/${shot.id}`, { expected_revision: 0, code: '1A' });
    expect(renamed.data).toMatchObject({ code: '1A', revision: 1, content_hash: shot.content_hash });

    const noReason = await app.post(`/api/v1/shots/${shot.id}/requirement`, { expected_revision: 1, required_status: 'waived', reason: '' });
    expect(noReason.status).toBe(400);
    const waived = await app.post<Shot>(`/api/v1/shots/${shot.id}/requirement`, {
      expected_revision: 1,
      required_status: 'waived',
      reason: '光线不够，改用插入镜头',
    });
    expect(waived.data).toMatchObject({ required_status: 'waived', requirement_reason: '光线不够，改用插入镜头', revision: 2 });
    const revs = await app.get<ShotRevision[]>(`/api/v1/shots/${shot.id}/revisions`);
    expect(revs.data.at(-1)!.reason).toContain('光线不够，改用插入镜头');

    const restored = await app.post<Shot>(`/api/v1/shots/${shot.id}/requirement`, {
      expected_revision: 2,
      required_status: 'required',
      reason: '恢复',
    });
    expect(restored.data.required_status).toBe('required');

    const archived = await app.post<Shot>(`/api/v1/shots/${shot.id}/archive`, { expected_revision: 3, reason: '重复' });
    expect(archived.data).toMatchObject({ archived: true, revision: 4 });
    expect((await sceneShots(s1.id)).some((s) => s.id === shot.id)).toBe(false);
  });

  test('narrative order only rewrites narrative_pos (INV-01)', async () => {
    const before = await sceneShots(s1.id);
    const other = await sceneShots(s2.id);
    const revCounts = await Promise.all(before.map(async (s) => (await app.get<ShotRevision[]>(`/api/v1/shots/${s.id}/revisions`)).data.length));
    const reversed = [...before].reverse().map((s) => s.id);
    const res = await app.put<Shot[]>('/api/v1/shots/narrative-order', { scene_id: s1.id, shot_ids: reversed });
    expect(res.status, res.text).toBe(200);
    expect(res.data.map((s) => s.id)).toEqual(reversed);
    expect(res.data.map((s) => s.narrative_pos)).toEqual(reversed.map((_, i) => i + 1));
    for (const s of res.data) {
      const old = before.find((b) => b.id === s.id)!;
      expect({ ...s, narrative_pos: 0, updated_at: '' }).toEqual({ ...old, narrative_pos: 0, updated_at: '' });
    }
    const revCountsAfter = await Promise.all(before.map(async (s) => (await app.get<ShotRevision[]>(`/api/v1/shots/${s.id}/revisions`)).data.length));
    expect(revCountsAfter).toEqual(revCounts);
    expect(await sceneShots(s2.id)).toEqual(other);

    // incomplete list is refused
    const partial = await app.put('/api/v1/shots/narrative-order', { scene_id: s1.id, shot_ids: reversed.slice(1) });
    expect(partial.status).toBe(400);
  });

  test('manual shot creation checks the roster and requires manual_note', async () => {
    const base = (await sceneShots(s1.id))[1]!.fields;
    const unknown = await app.post('/api/v1/shots', {
      scene_id: s1.id,
      fields: { ...base, subjects: [{ alias: 'c7', screen: null, depth: null, facing: null, pose: null }] },
      manual_note: '手工',
    });
    expect(unknown.status).toBe(400);
    const noNote = await app.post('/api/v1/shots', { scene_id: s1.id, fields: base });
    expect(noNote.status).toBe(400);
    const ok = await app.post<Shot>('/api/v1/shots', { scene_id: s1.id, fields: base, manual_note: '导演要求加一个', code: 'X1' });
    expect(ok.status).toBe(201);
    expect(ok.data).toMatchObject({ code: 'X1', origin: 'manual', manual_note: '导演要求加一个', narrative_pos: 13 });
    expect(ok.data.source_anchor).toMatchObject({ paragraph_id: base.source.paragraph_id, match: 'manual' });
  });
});
