import type { Take } from '@storyscript/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { takeAudit } from '../src/services/media/takes.ts';
import { makeWorkspace, NO_TOOLS, seedShots, startApp, type MediaApp, type Seeded, type Workspace } from './media-fixture.ts';

/**
 * Set log (FR-07) without any media or ffmpeg: take numbers, many shots per
 * take, unresolved hand-written labels, corrections with reason + revision.
 */

describe('takes: logging and corrections', () => {
  let ws: Workspace;
  let app: MediaApp;
  let seeded: Seeded;

  const base = { setup_id: null, camera_label: 'A', rating: 'unrated', clip_hint: null, notes: '', unresolved_labels: [] };

  beforeAll(async () => {
    ws = makeWorkspace();
    app = await startApp(ws, { create: true, tools: NO_TOOLS });
    seeded = await seedShots(app);
  });

  afterAll(() => {
    app?.shutdown();
    ws?.cleanup();
  });

  test('take numbers count per shot set, starting at 1', async () => {
    const [a, b] = seeded.s1;
    const t1 = await app.post<Take>('/api/v1/takes', { ...base, shot_ids: [a!.id] });
    const t2 = await app.post<Take>('/api/v1/takes', { ...base, shot_ids: [a!.id] });
    const both = await app.post<Take>('/api/v1/takes', { ...base, shot_ids: [b!.id, a!.id] });
    const both2 = await app.post<Take>('/api/v1/takes', { ...base, shot_ids: [a!.id, b!.id] });
    const explicit = await app.post<Take>('/api/v1/takes', { ...base, take_no: 7, shot_ids: [a!.id] });
    const after = await app.post<Take>('/api/v1/takes', { ...base, shot_ids: [a!.id] });
    expect([t1, t2, both, both2, explicit, after].map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect([t1.data.take_no, t2.data.take_no, both.data.take_no, both2.data.take_no, explicit.data.take_no, after.data.take_no]).toEqual([
      1, 2, 1, 2, 7, 8,
    ]);
    expect(both.data.shot_ids).toEqual([b!.id, a!.id]); // order kept
  });

  test('clip hint and notes are trimmed; unresolved labels are kept exactly as written', async () => {
    const r = await app.post<Take>('/api/v1/takes', {
      ...base,
      clip_hint: '  A001C007 ',
      camera_label: ' ',
      notes: ' 风太大 ',
      shot_ids: [],
      unresolved_labels: ['3A-2', ' 3A-2 ', '', '十二'],
    });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ clip_hint: 'A001C007', camera_label: null, notes: '风太大', shot_ids: [], unresolved_labels: ['3A-2', ' 3A-2 ', '十二'], take_no: 1 });
  });

  test('a take needs a shot or a hand-written label; unknown shots are refused', async () => {
    expect((await app.post('/api/v1/takes', { ...base, shot_ids: [] })).status).toBe(400);
    expect((await app.post('/api/v1/takes', { ...base, shot_ids: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(400);
    expect((await app.post('/api/v1/takes', { ...base, rating: 'perfect', shot_ids: [seeded.s1[0]!.id] })).status).toBe(400);
  });

  test('corrections need a reason and the current revision; the previous values are kept', async () => {
    const [a, , c] = seeded.s1;
    const t = (await app.post<Take>('/api/v1/takes', { ...base, rating: 'good', shot_ids: [c!.id] })).data;
    expect((await app.patch(`/api/v1/takes/${t.id}`, { expected_revision: 0, rating: 'reject' })).status).toBe(400);
    expect((await app.patch(`/api/v1/takes/${t.id}`, { expected_revision: 0, rating: 'reject', reason: '' })).status).toBe(400);
    const stale = await app.patch(`/api/v1/takes/${t.id}`, { expected_revision: 3, rating: 'reject', reason: '跑焦' });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('REVISION_CONFLICT');

    const ok = await app.patch<Take>(`/api/v1/takes/${t.id}`, { expected_revision: 0, rating: 'reject', shot_ids: [c!.id, a!.id], reason: '回看发现跑焦；也覆盖了 001' });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ rating: 'reject', revision: 1, shot_ids: [c!.id, a!.id], logged_at: t.logged_at, take_no: t.take_no });

    const audit = takeAudit(app.handle.projectSession.require().db, t.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ revision: 1, reason: '回看发现跑焦；也覆盖了 001', changed: ['评级', '镜头'] });
    expect(audit[0]!.before).toEqual(t);

    // no-op correction: nothing changes, no revision bump
    const same = await app.patch<Take>(`/api/v1/takes/${t.id}`, { expected_revision: 1, rating: 'reject', reason: '确认' });
    expect(same.data.revision).toBe(1);

    const list = (await app.get<Take[]>('/api/v1/takes')).data;
    expect(list.find((x) => x.id === t.id)).toEqual(ok.data);
  });

  test('coverage works without media: takes alone give attempted / no_link', async () => {
    const cov = await app.get<{ shot_id: string; status: string; missing_reason: string | null }[]>('/api/v1/coverage');
    expect(cov.status).toBe(200);
    const a = cov.data.find((x) => x.shot_id === seeded.s1[0]!.id)!;
    expect(a).toMatchObject({ status: 'attempted', missing_reason: 'no_link' });
    const d = cov.data.find((x) => x.shot_id === seeded.s2[0]!.id)!;
    expect(d).toMatchObject({ status: 'planned', missing_reason: 'no_take' });
  });
});
