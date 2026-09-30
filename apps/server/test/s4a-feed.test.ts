import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Api, type CollabChanges, type Shot } from '@storyscript/contracts';
import { AREA_OF, areasOf, CollabFeed, PRESENCE_TTL_MS, writeRouteOf } from '../src/collab/feed.ts';
import { importFixture, makeM3App, type M3App } from './helpers/m3-app.ts';

/**
 * S4a — the change feed: which writes move which areas, epoch and `since`
 * semantics, presence expiry, and the endpoint through a real app.
 */

describe('route table', () => {
  test('every write route in the contract is listed and matched back to itself', () => {
    const writes = (Object.keys(Api) as (keyof typeof Api)[]).filter((k) => Api[k].method !== 'GET');
    expect(Object.keys(AREA_OF).sort()).toEqual([...writes].sort());
    for (const k of writes) {
      const path = Api[k].path.replace(/:[a-z_]+/g, '00000000-0000-4000-8000-000000000001');
      expect(writeRouteOf(Api[k].method, path), k).toBe(k);
    }
  });

  test('static paths win over :id ("/shots/polish" is not a shot id)', () => {
    expect(writeRouteOf('POST', '/api/v1/shots/polish')).toBe('requestPolish');
    expect(writeRouteOf('PUT', '/api/v1/styles/defaults')).toBe('saveStyleDefaults');
    expect(writeRouteOf('PUT', '/api/v1/styles/style.oner')).toBe('updateStyle');
  });

  test('an unknown write moves every area; ignored ones move none', () => {
    expect(areasOf('POST', '/api/v1/something-new').areas.length).toBeGreaterThan(10);
    expect(areasOf('POST', '/api/v1/scripts/preview').areas).toEqual([]);
    expect(areasOf('PATCH', '/api/v1/shots/00000000-0000-4000-8000-000000000001').areas).toEqual(['shots', 'boards']);
  });
});

describe('CollabFeed', () => {
  let t = 1_000_000;
  const feed = () => new CollabFeed(() => t);
  const roster = [
    { id: 'a', name: '阿杰', role: 'leader' as const, crew_roles: ['导演'] },
    { id: 'b', name: '小林', role: 'member' as const, crew_roles: [] },
  ];
  const ctx = (me: string | null = 'a') => ({ roster, me, actor: (id: string | null) => (id ? { id, name: id, crew_roles: [], left: false } : null) });

  test('bump → area seq and events after since; a new epoch or a too-old since resets', () => {
    const f = feed();
    const first = f.changes({ since: 0, epoch: '' }, ctx());
    expect(first).toMatchObject({ seq: 0, reset: true, events: [] });
    f.bump(['shots', 'boards'], { actor_id: 'b', verb: 'changed', scene_no: '3', shot_code: '002' });
    f.bump(['plan'], { actor_id: 'a' });
    const c = f.changes({ since: 1, epoch: f.epoch }, ctx());
    expect(c.reset).toBe(false);
    expect(c.area_seq).toEqual({ shots: 1, boards: 1, plan: 2 });
    expect(c.events.map((e) => [e.seq, e.areas])).toEqual([[2, ['plan']]]);
    expect(f.changes({ since: 0, epoch: 'other' }, ctx()).reset).toBe(true);
    for (let i = 0; i < 60; i++) f.bump(['takes'], { actor_id: null });
    expect(f.changes({ since: 1, epoch: f.epoch }, ctx()).reset).toBe(true);
    expect(f.changes({ since: 60, epoch: f.epoch }, ctx()).events).toHaveLength(2);
  });

  test('presence: one entry per person, visible tab wins, hidden = away, gone after the TTL; unknown ids dropped', () => {
    const f = feed();
    f.touch('b', 'tab1', { page: 'boards', focus: null, hidden: true });
    f.touch('b', 'tab2', { page: 'script', focus: null, hidden: false });
    f.touch('a', 't', { page: 'plan', focus: null, hidden: false });
    f.touch('zz', 't', { page: 'plan', focus: null, hidden: false });
    const p = f.changes({ since: 0, epoch: f.epoch }, ctx('a')).presence;
    expect(p.map((x) => [x.actor.name, x.page, x.away, x.you])).toEqual([
      ['阿杰', 'plan', false, true],
      ['小林', 'script', false, false],
    ]);
    t += PRESENCE_TTL_MS + 1;
    f.touch('a', 't', { page: 'plan', focus: null, hidden: true });
    expect(f.changes({ since: 0, epoch: f.epoch }, ctx('a')).presence.map((x) => [x.actor.name, x.away])).toEqual([['阿杰', true]]);
  });

  test('members_rev follows names and crew roles', () => {
    const f = feed();
    const a = f.changes({ since: 0, epoch: '' }, ctx()).members_rev;
    const b = f.changes({ since: 0, epoch: '' }, { ...ctx(), roster: [roster[0]!, { ...roster[1]!, crew_roles: ['摄影'] }] }).members_rev;
    expect(a).not.toBe(b);
  });
});

describe('through the app', () => {
  let app: M3App;
  beforeEach(async () => {
    app = await makeM3App();
  });
  afterEach(() => app.close());

  const poll = async (since = 0, epoch = '') => (await app.get<CollabChanges>(`/api/v1/collab/changes?since=${since}&epoch=${epoch}&tab=t1&page=script`)).data;

  test('a successful write moves its areas with the shot code; a failed write moves nothing', async () => {
    const start = await poll();
    await importFixture(app, '01-bookshop.txt', 'txt');
    const afterImport = await poll(start.seq, start.epoch);
    expect(afterImport.events.map((e) => [e.verb, e.areas])).toEqual([['imported', ['script', 'shots', 'entities', 'boards']]]);

    const scenes = (await app.get<{ scenes: { id: string }[] }>('/api/v1/scripts/current')).data.scenes;
    const created = await app.post<Shot>('/api/v1/shots', {
      scene_id: scenes[0]!.id,
      manual_note: '手工',
      fields: {
        template: null, shot_size: 'MS', angle: 'eye', lens: 'normal', focal_mm: null, movement: 'static', subjects: [], props: [], env: null,
        subject_motion: 'none', set_piece: false, pov_owner: null, frame_format: null, technique_id: null, est_seconds: 3,
        narrative_purpose: '交代', action: '书店全景', dialogue_quote: null, source: { paragraph_id: 'p-003', quote: '' }, assumptions: [], questions: [],
      },
    });
    expect(created.status, created.text).toBe(201);
    const s1 = await poll(afterImport.seq, afterImport.epoch);
    await app.patch(`/api/v1/shots/${created.data.id}`, { expected_revision: 0, fields: { ...created.data.fields, action: '改了' } });
    const s2 = await poll(s1.seq, s1.epoch);
    expect(s2.events.map((e) => [e.verb, e.scene_no, e.shot_code])).toEqual([['changed', '1', created.data.code]]);

    const bad = await app.patch(`/api/v1/shots/${created.data.id}`, { expected_revision: 0, fields: created.data.fields });
    expect(bad.status).toBe(409);
    const s3 = await poll(s2.seq, s2.epoch);
    expect(s3.events).toEqual([]);
    expect(s3.seq).toBe(s2.seq);
  });

  test('previews and GETs move nothing; locally there is no presence', async () => {
    const start = await poll();
    await app.post('/api/v1/scripts/preview', { text: '1. 内景 教室 日\n林川走进教室。', source_name: 'x.txt', format: 'txt', heading_overrides: [] });
    await app.get('/api/v1/shots');
    const after = await poll(start.seq, start.epoch);
    expect(after.seq).toBe(start.seq);
    expect(after.presence).toEqual([]);
  });
});
