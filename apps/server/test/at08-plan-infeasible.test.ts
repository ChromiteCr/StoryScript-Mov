import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { PlanDetail } from '@storyscript/contracts';
import { L, W, expectOk, makePlanApp, makeResource, makeSetup, makeShot, seedWorld, type PlanApp, type World } from './helpers/plan-app.ts';

/**
 * AT-08 (HTTP): a heuristic miss on feasible data is `partial` with reasons
 * (and a manual reorder finds the valid plan); only explicit contradictions
 * are `proven_infeasible`, each with evidence.
 */

let app: PlanApp;
let w: World;

beforeEach(async () => {
  app = await makePlanApp();
  w = await seedWorld(app);
});

afterEach(() => app.close());

const createPlan = (call = '09:00', wrap = '18:00') => app.post<PlanDetail>('/api/v1/plans', { date: '2026-10-05', crew_call: call, crew_wrap: wrap });

describe('AT-08 partial vs proven_infeasible', () => {
  test('a heuristic order fails on feasible data → partial with a reason; the scheduler and a reorder find the plan', async () => {
    // X needs performer P only 14:00–15:00; Y is a 5 h setup at the same location.
    // Order X-first puts X at 14:00, leaving no 5 h stretch for Y. Valid: Y 09–14, X 14–15.
    const [s1] = w.scenes as [(typeof w.scenes)[0]];
    await makeResource(app, 'performer', '演员甲', [W('14:00', '15:00')], [w.c1.id]);
    const loc = await makeResource(app, 'location', '书店', [W('09:00', '18:00')], [w.shop.id]);
    const a = await makeShot(app, s1, { subjects: [{ alias: w.c1.alias, facing: 'camera' }] });
    const b = await makeShot(app, s1);
    const X = await makeSetup(app, 'X', [a.id], { location: loc.id, durations: { setup_min: 0, per_shot_min: 60, reset_min: 0 } });
    const Y = await makeSetup(app, 'Y', [b.id], { location: loc.id, durations: { setup_min: 60, per_shot_min: 180, reset_min: 60 } });

    const res = await createPlan();
    expect(res.status, res.text).toBe(201);
    // multi-start search finds the valid plan by itself
    expect(res.data.plan.result.outcome).toBe('feasible');
    // an explicit X-first order is kept as given and misses Y → partial, never "infeasible"
    const { plan, approval } = await expectOk<PlanDetail>(
      app.post(`/api/v1/plans/${res.data.plan.id}/reorder`, { expected_revision: 0, order: [X.id, Y.id] }),
    );
    expect(plan.result.outcome).toBe('partial');
    expect(plan.result.contradictions).toEqual([]);
    expect(plan.result.unplaced).toEqual([{ setup_id: Y.id, code: 'ORDER', reason: expect.stringMatching(/^ORDER: /) }]);
    expect(plan.result.violations.map((v) => v.code)).toEqual(['UNPLACED_REQUIRED']);
    expect(approval.ok).toBe(false);
    expect(approval.blockers.map((v) => v.code)).toContain('UNPLACED_REQUIRED');
    const blocked = await app.post(`/api/v1/plans/${plan.id}/approve`, { expected_revision: 1 });
    expect(blocked.status).toBe(409);

    const fixed = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${plan.id}/reorder`, { expected_revision: 1, order: [Y.id, X.id] }));
    expect(fixed.plan.result.outcome).toBe('feasible');
    expect(fixed.plan.result.order).toEqual([Y.id, X.id]);
    expect(fixed.plan.result.violations).toEqual([]);
    expect(fixed.plan.revision).toBe(2);
    expect(fixed.approval.ok).toBe(true);
    const shoot = fixed.plan.result.blocks.find((blk) => blk.setup_id === X.id && blk.kind === 'shoot')!;
    expect([shoot.start_utc, shoot.end_utc]).toEqual([L('14:00'), L('15:00')]);

    // a stale expected_revision is a conflict, not a silent overwrite
    const conflict = await app.post(`/api/v1/plans/${plan.id}/reorder`, { expected_revision: 1, order: [X.id, Y.id] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error!.code).toBe('REVISION_CONFLICT');
  });

  test('NO_WINDOW: a confirmed performer free only on another day → proven_infeasible with evidence', async () => {
    const [s1] = w.scenes as [(typeof w.scenes)[0]];
    const p = await makeResource(app, 'performer', '演员甲', [W('09:00', '18:00', '2026-10-06')], [w.c1.id]);
    const a = await makeShot(app, s1, { subjects: [{ alias: w.c1.alias, facing: 'camera' }] });
    const X = await makeSetup(app, 'X', [a.id]);
    const { plan, approval } = (await createPlan()).data;
    expect(plan.result.outcome).toBe('proven_infeasible');
    expect(plan.result.blocks).toEqual([]);
    expect(plan.result.contradictions).toEqual([
      { code: 'NO_WINDOW', message: expect.stringContaining('演员甲'), setup_ids: [X.id], resource_ids: [p.id] },
    ]);
    expect(approval.ok).toBe(false);
  });

  test('PRECEDENCE_CYCLE: X before Y and Y before X → proven_infeasible naming both setups', async () => {
    const [s1] = w.scenes as [(typeof w.scenes)[0]];
    const a = await makeShot(app, s1);
    const b = await makeShot(app, s1);
    const X = await makeSetup(app, 'X', [a.id]);
    const Y = await makeSetup(app, 'Y', [b.id]);
    await expectOk(app.post('/api/v1/constraints', { type: 'before', a_setup_id: X.id, b_setup_id: Y.id, confirmed: true }), 201);
    await expectOk(app.post('/api/v1/constraints', { type: 'before', a_setup_id: Y.id, b_setup_id: X.id, confirmed: true }), 201);
    const { plan } = (await createPlan()).data;
    expect(plan.result.outcome).toBe('proven_infeasible');
    expect(plan.result.contradictions.map((c) => [c.code, c.setup_ids])).toEqual([['PRECEDENCE_CYCLE', [X.id, Y.id].sort()]]);
  });

  test('unconfirmed constraints are drafts: the same cycle unconfirmed plans fine', async () => {
    const [s1] = w.scenes as [(typeof w.scenes)[0]];
    const a = await makeShot(app, s1);
    const b = await makeShot(app, s1);
    const X = await makeSetup(app, 'X', [a.id]);
    const Y = await makeSetup(app, 'Y', [b.id]);
    await expectOk(app.post('/api/v1/constraints', { type: 'before', a_setup_id: X.id, b_setup_id: Y.id, confirmed: false }), 201);
    await expectOk(app.post('/api/v1/constraints', { type: 'before', a_setup_id: Y.id, b_setup_id: X.id, confirmed: false }), 201);
    const { plan } = (await createPlan()).data;
    expect(plan.result.outcome).toBe('feasible');
  });

  test('missing data (setup with no per-shot duration) → needs_input', async () => {
    const [s1] = w.scenes as [(typeof w.scenes)[0]];
    const a = await makeShot(app, s1);
    await makeSetup(app, 'X', [a.id], { durations: { setup_min: 10, per_shot_min: 0, reset_min: 0 } });
    const { plan, approval } = (await createPlan()).data;
    expect(plan.result.outcome).toBe('needs_input');
    expect(plan.result.violations.map((v) => v.code)).toEqual(['MISSING_INPUT']);
    expect(approval.ok).toBe(false);
  });

  test('invalid local date or time is a 400', async () => {
    expect((await app.post('/api/v1/plans', { date: '2026-02-30', crew_call: '08:00', crew_wrap: '20:00' })).status).toBe(400);
    expect((await app.post('/api/v1/plans', { date: '2026-10-05', crew_call: '25:00', crew_wrap: '20:00' })).status).toBe(400);
  });
});
