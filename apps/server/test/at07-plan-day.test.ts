import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Constraint, PlanDetail, Resource, ScheduleBlock, Setup, Shot } from '@storyscript/contracts';
import { DUR, L, W, expectOk, makePlanApp, makeResource, makeShot, seedWorld, shotsNow, type PlanApp, type World } from './helpers/plan-app.ts';

/**
 * AT-07 (HTTP): one shooting day with two performers on different windows,
 * setup/reset durations and a locked block. Every block of the computed plan
 * passes validation, sits inside its resources' windows, and the plan can be
 * approved once estimates and resources are confirmed.
 */

let app: PlanApp;
let w: World;

beforeEach(async () => {
  app = await makePlanApp();
  w = await seedWorld(app);
});

afterEach(() => app.close());

const ms = (iso: string) => Date.parse(iso);

function inside(block: ScheduleBlock, windows: { start_utc: string; end_utc: string }[]): boolean {
  return windows.some((x) => ms(x.start_utc) <= ms(block.start_utc) && ms(block.end_utc) <= ms(x.end_utc));
}

describe('AT-07 plan a day end to end', () => {
  test('derive setups, two performer windows, durations, locked block → feasible, all blocks valid, approvable', async () => {
    const [s1, s2] = w.scenes as [(typeof w.scenes)[0], (typeof w.scenes)[0]];
    // performers cast to the two characters, windows differ
    const p1 = await makeResource(app, 'performer', '演员甲', [W('08:00', '12:00')], [w.c1.id]);
    const p2 = await makeResource(app, 'performer', '演员乙', [W('13:00', '19:00')], [w.c2.id]);
    const shop = await makeResource(app, 'location', '书店实景', [W('07:00', '21:00')], [w.shop.id]);
    const back = await makeResource(app, 'location', '后屋实景', [W('07:00', '21:00')], [w.backroom.id]);

    // bucket A: shop, eye, c1 facing camera ×2; bucket B: shop, eye, c2 screen_left; bucket C: backroom, low, no subject
    const a1 = await makeShot(app, s1, { subjects: [{ alias: w.c1.alias, facing: 'camera' }] });
    const a2 = await makeShot(app, s1, { subjects: [{ alias: w.c1.alias, facing: null }] });
    const b1 = await makeShot(app, s1, { subjects: [{ alias: w.c2.alias, facing: 'screen_left' }] });
    const c1 = await makeShot(app, s2, { angle: 'low' });

    const setups = await expectOk<Setup[]>(app.post('/api/v1/setups/derive', { keep_edited: false, default_durations: DUR }));
    expect(setups.map((s) => s.label)).toEqual(['场1 · 平视 · 面向镜头', '场1 · 平视 · 朝画左', '场2 · 仰拍 · 面向镜头']);
    const [A, B, C] = setups as [Setup, Setup, Setup];
    expect(A.shot_ids).toEqual([a1.id, a2.id]);
    expect(A.location_resource_id).toBe(shop.id);
    expect(B.shot_ids).toEqual([b1.id]);
    expect(C.shot_ids).toEqual([c1.id]);
    expect(C.location_resource_id).toBe(back.id);
    expect(setups.every((s) => !s.estimate_confirmed)).toBe(true);
    // shot.setup_id mirrors setup.shot_ids
    const byId = new Map((await shotsNow(app)).map((s) => [s.id, s] as const));
    expect(byId.get(a1.id)!.setup_id).toBe(A.id);
    expect(byId.get(b1.id)!.setup_id).toBe(B.id);
    expect(byId.get(c1.id)!.setup_id).toBe(C.id);

    // lock C to 12:00–13:00 (needs 20 + 15 + 10 = 45 min)
    await expectOk<Constraint>(
      app.post('/api/v1/constraints', { type: 'locked_block', setup_id: C.id, start_utc: L('12:00'), end_utc: L('13:00'), confirmed: true }),
      201,
    );
    // estimates confirmed
    for (const s of setups) await expectOk(app.patch(`/api/v1/setups/${s.id}`, { estimate_confirmed: true }));

    const created = await app.post<PlanDetail>('/api/v1/plans', { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' });
    expect(created.status, created.text).toBe(201);
    const { plan } = created.data;
    expect(plan.status).toBe('draft');
    expect(plan.revision).toBe(0);
    expect(plan.timezone).toBe('Asia/Shanghai');
    expect(plan.day_start_utc).toBe(L('08:00'));
    expect(plan.result.outcome).toBe('feasible');
    expect(plan.result.violations).toEqual([]);
    expect(plan.result.unplaced).toEqual([]);
    expect(created.data.stale).toBe(false);
    expect(created.data.approval).toEqual({ ok: true, blockers: [] });

    const blocks = plan.result.blocks;
    // each setup laid out setup → shoot → reset with the configured minutes
    for (const s of setups) {
      // (a locked setup's unused remainder of its span is a 'buffer' block)
      const parts = blocks.filter((b) => b.setup_id === s.id && b.kind !== 'buffer').sort((x, y) => ms(x.start_utc) - ms(y.start_utc));
      expect(parts.map((b) => b.kind)).toEqual(['setup', 'shoot', 'reset']);
      expect(parts.map((b) => (ms(b.end_utc) - ms(b.start_utc)) / 60_000)).toEqual([20, 15 * s.shot_ids.length, 10]);
      expect(parts[1]!.start_utc).toBe(parts[0]!.end_utc);
      expect(parts[2]!.start_utc).toBe(parts[1]!.end_utc);
    }
    // performer windows respected on shoot blocks
    const shootOf = (s: Setup) => blocks.find((b) => b.setup_id === s.id && b.kind === 'shoot')!;
    expect(inside(shootOf(A), p1.windows)).toBe(true);
    expect(shootOf(A).resource_ids).toContain(p1.id);
    expect(inside(shootOf(B), p2.windows)).toBe(true);
    expect(shootOf(B).resource_ids).toContain(p2.id);
    // the locked block starts exactly at its locked start
    const cParts = blocks.filter((b) => b.setup_id === C.id);
    expect(Math.min(...cParts.map((b) => ms(b.start_utc)))).toBe(ms(L('12:00')));
    expect(cParts.every((b) => b.locked)).toBe(true);
    // single crew: no two blocks overlap; everything inside the crew day
    const sorted = [...blocks].sort((x, y) => ms(x.start_utc) - ms(y.start_utc));
    for (let i = 1; i < sorted.length; i++) expect(ms(sorted[i]!.start_utc)).toBeGreaterThanOrEqual(ms(sorted[i - 1]!.end_utc));
    expect(inside(sorted[0]!, [W('08:00', '20:00')]) && inside(sorted.at(-1)!, [W('08:00', '20:00')])).toBe(true);

    // reading it back gives the same, and it can be approved
    const read = await expectOk<PlanDetail>(app.get(`/api/v1/plans/${plan.id}`));
    expect(read.stale).toBe(false);
    expect(read.plan).toEqual(plan);
    const approved = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${plan.id}/approve`, { expected_revision: 0 }));
    expect(approved.plan.status).toBe('approved');
    expect(approved.plan.revision).toBe(1);
    expect(approved.approval.ok).toBe(true);
    const list = await expectOk<{ id: string }[]>(app.get('/api/v1/plans'));
    expect(list.map((p) => p.id)).toEqual([plan.id]);
  });

  test('derive keep_edited keeps edited setups, regenerates derived ones with stable ids', async () => {
    const [s1] = w.scenes as [(typeof w.scenes)[0]];
    const a = await makeShot(app, s1, { subjects: [{ alias: w.c1.alias, facing: 'camera' }] });
    const b = await makeShot(app, s1, { subjects: [{ alias: w.c2.alias, facing: 'away' }] });
    const first = await expectOk<Setup[]>(app.post('/api/v1/setups/derive', { keep_edited: true, default_durations: DUR }));
    expect(first).toHaveLength(2);
    const [A, B] = first as [Setup, Setup];

    // user edits A; a new shot joins B's bucket
    const edited = await expectOk<Setup>(app.patch(`/api/v1/setups/${A.id}`, { durations: { setup_min: 45, per_shot_min: 30, reset_min: 5 } }));
    expect(edited.durations.setup_min).toBe(45);
    const b2 = await makeShot(app, s1, { subjects: [{ alias: w.c2.alias, facing: 'away' }] });
    const again = await expectOk<Setup[]>(app.post('/api/v1/setups/derive', { keep_edited: true, default_durations: { setup_min: 10, per_shot_min: 10, reset_min: 10 } }));
    expect(again).toHaveLength(2);
    const A2 = again.find((s) => s.id === A.id)!;
    const B2 = again.find((s) => s.id === B.id)!;
    expect(A2.durations).toEqual({ setup_min: 45, per_shot_min: 30, reset_min: 5 });
    expect(A2.shot_ids).toEqual([a.id]);
    expect(B2.shot_ids).toEqual([b.id, b2.id]);
    expect(B2.durations.setup_min).toBe(10);

    // keep_edited=false rebuilds everything (ids of the same buckets stay)
    const reset = await expectOk<Setup[]>(app.post('/api/v1/setups/derive', { keep_edited: false, default_durations: DUR }));
    expect(reset.map((s) => s.id).sort()).toEqual([A.id, B.id].sort());
    expect(reset.find((s) => s.id === A.id)!.durations).toEqual(DUR);

    // waived and archived shots are not grouped
    const shots = await shotsNow(app);
    const bNow = shots.find((s) => s.id === b2.id)!;
    await expectOk(app.post(`/api/v1/shots/${bNow.id}/requirement`, { expected_revision: bNow.revision, required_status: 'waived', reason: '不拍' }));
    const after = await expectOk<Setup[]>(app.post('/api/v1/setups/derive', { keep_edited: false, default_durations: DUR }));
    expect(after.find((s) => s.id === B.id)!.shot_ids).toEqual([b.id]);
    expect((await shotsNow(app)).find((s) => s.id === b2.id)!.setup_id).toBeNull();
  });

  test('setup edits move shots between setups and keep shot.setup_id in sync', async () => {
    const [s1] = w.scenes as [(typeof w.scenes)[0]];
    const a = await makeShot(app, s1);
    const b = await makeShot(app, s1);
    const X = await expectOk<Setup>(
      app.post('/api/v1/setups', { location_resource_id: null, label: '甲', shot_ids: [a.id, b.id], resource_ids: [], durations: DUR, estimate_confirmed: false }),
      201,
    );
    const Y = await expectOk<Setup>(
      app.post('/api/v1/setups', { location_resource_id: null, label: '乙', shot_ids: [b.id], resource_ids: [], durations: DUR, estimate_confirmed: false }),
      201,
    );
    const setups = await expectOk<Setup[]>(app.get('/api/v1/setups'));
    expect(setups.find((s) => s.id === X.id)!.shot_ids).toEqual([a.id]);
    expect(setups.find((s) => s.id === Y.id)!.shot_ids).toEqual([b.id]);
    let shots: Shot[] = await shotsNow(app);
    expect(shots.find((s) => s.id === b.id)!.setup_id).toBe(Y.id);

    await expectOk(app.del(`/api/v1/setups/${Y.id}`));
    shots = await shotsNow(app);
    expect(shots.find((s) => s.id === b.id)!.setup_id).toBeNull();
    expect((await app.get(`/api/v1/setups`)).data).toHaveLength(1);

    // validation: archived shots, non-location "location", empty label
    const bad = await app.post('/api/v1/setups', { location_resource_id: null, label: '  ', shot_ids: [], resource_ids: [], durations: DUR, estimate_confirmed: false });
    expect(bad.status).toBe(400);
    const perf = await makeResource(app, 'performer', '演员', [W('08:00', '12:00')], [w.c1.id]);
    const notLoc = await app.patch(`/api/v1/setups/${X.id}`, { location_resource_id: perf.id });
    expect(notLoc.status).toBe(400);
  });
});

describe('resources and constraints', () => {
  test('resource casting is type-checked; deleting a resource used by a setup is 409 with the references', async () => {
    const wrongCast = await app.post('/api/v1/resources', { type: 'performer', name: '甲', windows: [], cast_character_ids: [w.shop.id], confirmed: true });
    expect(wrongCast.status).toBe(400);
    const badWindow = await app.post('/api/v1/resources', {
      type: 'performer',
      name: '甲',
      windows: [{ start_utc: L('12:00'), end_utc: L('09:00') }],
      cast_character_ids: [],
      confirmed: true,
    });
    expect(badWindow.status).toBe(400);
    const gear = await app.post('/api/v1/resources', { type: 'equipment', name: '摇臂', windows: [], cast_character_ids: [w.c1.id], confirmed: true });
    expect(gear.status).toBe(400);

    // overnight window typed as 22:00–02:00 is explicitly on the next day
    const night = W('22:00', '02:00');
    expect(Date.parse(night.end_utc) - Date.parse(night.start_utc)).toBe(4 * 3_600_000);
    const loc = await makeResource(app, 'location', '书店', [night], [w.shop.id]);
    expect(loc.windows).toEqual([night]);

    const [s1] = w.scenes as [(typeof w.scenes)[0]];
    const shot = await makeShot(app, s1);
    const setup = await expectOk<Setup>(
      app.post('/api/v1/setups', { location_resource_id: loc.id, label: '夜景', shot_ids: [shot.id], resource_ids: [], durations: DUR, estimate_confirmed: false }),
      201,
    );
    const del = await app.del(`/api/v1/resources/${loc.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error!.details).toEqual({ setups: [{ id: setup.id, label: '夜景' }] });

    const renamed = await expectOk<Resource>(app.patch(`/api/v1/resources/${loc.id}`, { name: '书店（夜）', confirmed: false }));
    expect(renamed).toMatchObject({ name: '书店（夜）', confirmed: false, cast_character_ids: [w.shop.id] });

    await expectOk(app.patch(`/api/v1/setups/${setup.id}`, { location_resource_id: null }));
    await expectOk(app.del(`/api/v1/resources/${loc.id}`));
    expect((await app.get<Resource[]>('/api/v1/resources')).data).toEqual([]);
  });

  test('constraints: create, list, reject self-precedence and inverted locks, delete', async () => {
    const [s1] = w.scenes as [(typeof w.scenes)[0]];
    const a = await makeShot(app, s1);
    const b = await makeShot(app, s1);
    const X = await expectOk<Setup>(
      app.post('/api/v1/setups', { location_resource_id: null, label: 'X', shot_ids: [a.id], resource_ids: [], durations: DUR, estimate_confirmed: false }),
      201,
    );
    const Y = await expectOk<Setup>(
      app.post('/api/v1/setups', { location_resource_id: null, label: 'Y', shot_ids: [b.id], resource_ids: [], durations: DUR, estimate_confirmed: false }),
      201,
    );
    const before = await expectOk<Constraint>(app.post('/api/v1/constraints', { type: 'before', a_setup_id: X.id, b_setup_id: Y.id, confirmed: true }), 201);
    await expectOk<Constraint>(app.post('/api/v1/constraints', { type: 'not_before', setup_id: Y.id, at_utc: L('10:00'), confirmed: false }), 201);
    expect((await app.post('/api/v1/constraints', { type: 'before', a_setup_id: X.id, b_setup_id: X.id, confirmed: true })).status).toBe(400);
    expect(
      (await app.post('/api/v1/constraints', { type: 'locked_block', setup_id: X.id, start_utc: L('11:00'), end_utc: L('10:00'), confirmed: true })).status,
    ).toBe(400);
    expect((await app.post('/api/v1/constraints', { type: 'not_after', setup_id: X.id, at_utc: 'tomorrow', confirmed: true })).status).toBe(400);
    const list = await expectOk<Constraint[]>(app.get('/api/v1/constraints'));
    expect(list.map((c) => c.type)).toEqual(['before', 'not_before']);
    await expectOk(app.del(`/api/v1/constraints/${before.id}`));
    expect((await app.del(`/api/v1/constraints/${before.id}`)).status).toBe(404);
    // deleting a setup removes its constraints
    await expectOk(app.del(`/api/v1/setups/${Y.id}`));
    expect(await expectOk<Constraint[]>(app.get('/api/v1/constraints'))).toEqual([]);
  });
});
