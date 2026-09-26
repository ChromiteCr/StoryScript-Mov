import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { PlanDetail, Resource, Setup, Shot } from '@storyscript/contracts';
import { W, expectOk, makePlanApp, makeResource, makeSetup, makeShot, seedWorld, shotsNow, type PlanApp, type World } from './helpers/plan-app.ts';

/**
 * AT-09 (HTTP): changing the shooting order never touches narrative order;
 * changing an input (a performer's window) makes the stored plan stale and
 * blocks approval until it is recomputed. INV-05 approval gate: unconfirmed
 * estimates or resources block approval with named blockers.
 */

let app: PlanApp;
let w: World;
let p1: Resource;
let X: Setup;
let Y: Setup;
let Z: Setup;
let shots: Shot[];

beforeEach(async () => {
  app = await makePlanApp();
  w = await seedWorld(app);
  const [s1, s2] = w.scenes as [(typeof w.scenes)[0], (typeof w.scenes)[0]];
  p1 = await makeResource(app, 'performer', '演员甲', [W('08:00', '18:00')], [w.c1.id]);
  await makeResource(app, 'performer', '演员乙', [W('08:00', '18:00')], [w.c2.id]);
  const a = await makeShot(app, s1, { subjects: [{ alias: w.c1.alias, facing: 'camera' }], action: '甲' });
  const b = await makeShot(app, s1, { subjects: [{ alias: w.c2.alias, facing: 'camera' }], action: '乙' });
  const c = await makeShot(app, s2, { action: '丙' });
  const d = await makeShot(app, s1, { subjects: [{ alias: w.c1.alias, facing: 'away' }], action: '丁' });
  X = await makeSetup(app, 'X', [a.id, d.id]);
  Y = await makeSetup(app, 'Y', [b.id]);
  Z = await makeSetup(app, 'Z', [c.id]);
  shots = await shotsNow(app);
});

afterEach(() => app.close());

const narrative = (list: Shot[]) => list.map((s) => [s.id, s.scene_id, s.narrative_pos, s.revision, s.code]);

describe('AT-09 shooting order vs narrative order, stale plans', () => {
  test('reordering the shooting day leaves every narrative_pos (and shot revision) unchanged', async () => {
    const created = await expectOk<PlanDetail>(app.post('/api/v1/plans', { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' }), 201);
    const before = narrative(shots);
    const orders = [
      [Z.id, Y.id, X.id],
      [Y.id, Z.id, X.id],
      [X.id, Z.id, Y.id],
    ];
    let rev = created.plan.revision;
    for (const order of orders) {
      const r = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${created.plan.id}/reorder`, { expected_revision: rev, order }));
      rev = r.plan.revision;
      expect(r.plan.result.order).toEqual(order);
      // the shot blocks follow the new shooting order …
      const firstShoot = r.plan.result.blocks.filter((b) => b.kind === 'shoot').sort((p, q) => p.start_utc.localeCompare(q.start_utc))[0]!;
      expect(firstShoot.setup_id).toBe(order[0]);
      // … while narrative order is untouched
      expect(narrative(await shotsNow(app))).toEqual(before);
    }
    expect(rev).toBe(3);
  });

  test('changing a performer window makes the plan stale; approval is blocked until recompute', async () => {
    const created = await expectOk<PlanDetail>(app.post('/api/v1/plans', { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' }), 201);
    expect(created.plan.result.outcome).toBe('feasible');
    const approved = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${created.plan.id}/approve`, { expected_revision: 0 }));
    expect(approved.plan.status).toBe('approved');

    // the performer can now only come in the afternoon
    await expectOk(app.patch(`/api/v1/resources/${p1.id}`, { windows: [W('14:00', '18:00')] }));
    const stale = await expectOk<PlanDetail>(app.get(`/api/v1/plans/${created.plan.id}`));
    expect(stale.stale).toBe(true);
    expect(stale.approval.ok).toBe(false);
    // stored status stays, but the approval no longer holds (UI shows "已失效")
    expect(stale.plan.status).toBe('approved');

    const refused = await app.post(`/api/v1/plans/${created.plan.id}/approve`, { expected_revision: 1 });
    expect(refused.status).toBe(409);
    expect(refused.body.error!.details).toMatchObject({ stale: true });

    const recomputed = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${created.plan.id}/recompute`, { expected_revision: 1 }));
    expect(recomputed.stale).toBe(false);
    expect(recomputed.plan.status).toBe('draft');
    expect(recomputed.plan.revision).toBe(2);
    expect(recomputed.plan.input_hash).not.toBe(created.plan.input_hash);
    const xShoot = recomputed.plan.result.blocks.find((b) => b.setup_id === X.id && b.kind === 'shoot')!;
    expect(Date.parse(xShoot.start_utc)).toBeGreaterThanOrEqual(Date.parse(W('14:00', '18:00').start_utc));
    expect(recomputed.approval.ok).toBe(true);
    const again = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${created.plan.id}/approve`, { expected_revision: 2 }));
    expect(again.plan.status).toBe('approved');
  });

  test('recompute keeps a hand-set order', async () => {
    const created = await expectOk<PlanDetail>(app.post('/api/v1/plans', { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' }), 201);
    const order = [Z.id, X.id, Y.id];
    await expectOk(app.post(`/api/v1/plans/${created.plan.id}/reorder`, { expected_revision: 0, order }));
    await expectOk(app.patch(`/api/v1/setups/${Y.id}`, { label: 'Y（改）' }));
    expect((await expectOk<PlanDetail>(app.get(`/api/v1/plans/${created.plan.id}`))).stale).toBe(true);
    const r = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${created.plan.id}/recompute`, { expected_revision: 1 }));
    expect(r.plan.result.order).toEqual(order);
    expect(r.stale).toBe(false);
  });
});

describe('INV-05 approval gate', () => {
  test('unconfirmed estimates block approval until confirmed and recomputed', async () => {
    await expectOk(app.patch(`/api/v1/setups/${Y.id}`, { estimate_confirmed: false }));
    const created = await expectOk<PlanDetail>(app.post('/api/v1/plans', { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' }), 201);
    expect(created.plan.result.outcome).toBe('feasible');
    expect(created.approval.ok).toBe(false);
    expect(created.approval.blockers).toEqual([expect.objectContaining({ code: 'ESTIMATE_UNCONFIRMED', setup_id: Y.id })]);

    const refused = await app.post(`/api/v1/plans/${created.plan.id}/approve`, { expected_revision: 0 });
    expect(refused.status).toBe(409);
    const details = refused.body.error!.details as { blockers: { code: string }[]; stale: boolean; outcome: string };
    expect(details.stale).toBe(false);
    expect(details.outcome).toBe('feasible');
    expect(details.blockers.map((b) => b.code)).toEqual(['ESTIMATE_UNCONFIRMED']);
    // refusal changed nothing
    expect((await expectOk<PlanDetail>(app.get(`/api/v1/plans/${created.plan.id}`))).plan.revision).toBe(0);

    await expectOk(app.patch(`/api/v1/setups/${Y.id}`, { estimate_confirmed: true }));
    const stale = await expectOk<PlanDetail>(app.get(`/api/v1/plans/${created.plan.id}`));
    expect(stale.stale).toBe(true);
    expect(stale.approval.ok).toBe(false);
    const r = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${created.plan.id}/recompute`, { expected_revision: 0 }));
    expect(r.approval).toEqual({ ok: true, blockers: [] });
    expect((await expectOk<PlanDetail>(app.post(`/api/v1/plans/${created.plan.id}/approve`, { expected_revision: 1 }))).plan.status).toBe('approved');
  });

  test('an unconfirmed performer blocks approval', async () => {
    await expectOk(app.patch(`/api/v1/resources/${p1.id}`, { confirmed: false }));
    const created = await expectOk<PlanDetail>(app.post('/api/v1/plans', { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' }), 201);
    expect(created.approval.ok).toBe(false);
    expect(created.approval.blockers).toEqual([expect.objectContaining({ code: 'MISSING_INPUT', resource_id: p1.id })]);
  });
});
