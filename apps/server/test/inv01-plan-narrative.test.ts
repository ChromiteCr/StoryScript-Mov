import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { PlanDetail, Setup, Shot } from '@storyscript/contracts';
import { FakeChat } from '../src/adapters/llm/fake-chat.ts';
import { W, DUR, expectOk, makePlanApp, makeResource, makeShot, seedWorld, shotsNow, waitJob, type PlanApp } from './helpers/plan-app.ts';
import { llmEnv } from './helpers/m3-app.ts';

/**
 * INV-01: narrative order (shot.narrative_pos) and shooting order
 * (plan.result.order / blocks) are stored apart; no planning operation —
 * derive, create, reorder, recompute, approve, suggest + adopt — changes
 * narrative_pos, the narrative order of /shots, or a shot's revision.
 */

let app: PlanApp;
const chat = new FakeChat();

beforeEach(async () => {
  app = await makePlanApp({ env: llmEnv('http://127.0.0.1:9/v1'), ai: { chat: () => chat } });
});

afterEach(() => app.close());

const snapshot = (list: Shot[]) => list.map((s) => ({ id: s.id, scene: s.scene_id, pos: s.narrative_pos, rev: s.revision, hash: s.content_hash }));

describe('INV-01 planning never touches narrative order', () => {
  test('every plan operation leaves narrative_pos and the narrative sequence intact', async () => {
    const w = await seedWorld(app);
    const [s1, s2] = w.scenes as [(typeof w.scenes)[0], (typeof w.scenes)[0]];
    await makeResource(app, 'performer', '演员甲', [W('08:00', '20:00')], [w.c1.id]);
    await makeResource(app, 'performer', '演员乙', [W('08:00', '20:00')], [w.c2.id]);
    await makeResource(app, 'location', '书店', [W('08:00', '20:00')], [w.shop.id]);
    // narrative sequence deliberately alternates buckets, so shooting order must differ from it
    for (const [scene, alias, facing, angle] of [
      [s1, w.c1.alias, 'camera', 'eye'],
      [s1, w.c2.alias, 'screen_left', 'eye'],
      [s1, w.c1.alias, 'camera', 'eye'],
      [s2, null, null, 'high'],
      [s1, w.c2.alias, 'screen_left', 'eye'],
    ] as const) {
      await makeShot(app, scene, { subjects: alias ? [{ alias, facing }] : [], angle });
    }
    const before = snapshot(await shotsNow(app));
    const check = async () => expect(snapshot(await shotsNow(app))).toEqual(before);

    const setups = await expectOk<Setup[]>(app.post('/api/v1/setups/derive', { keep_edited: false, default_durations: DUR }));
    await check();
    for (const s of setups) await expectOk(app.patch(`/api/v1/setups/${s.id}`, { estimate_confirmed: true }));
    await check();

    let d = await expectOk<PlanDetail>(app.post('/api/v1/plans', { date: '2026-10-05', crew_call: '08:00', crew_wrap: '20:00' }), 201);
    await check();
    // the shooting order groups by setup, unlike the narrative alternation
    const shootOrder = d.plan.result.blocks.filter((b) => b.kind === 'shoot').flatMap((b) => b.shot_ids);
    expect(shootOrder).not.toEqual(before.map((s) => s.id));

    d = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${d.plan.id}/reorder`, { expected_revision: d.plan.revision, order: [...d.plan.result.order].reverse() }));
    await check();
    d = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${d.plan.id}/recompute`, { expected_revision: d.plan.revision }));
    await check();
    d = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${d.plan.id}/approve`, { expected_revision: d.plan.revision }));
    await check();

    const keys = d.plan.result.order.map((_, i) => `u${i + 1}`);
    chat.push({ content: JSON.stringify({ setup_order: [...keys].reverse(), rationale: '先拍场地集中的部分。' }) });
    const job = await expectOk<{ job_id: string }>(app.post(`/api/v1/plans/${d.plan.id}/suggest-order`), 202);
    const done = await waitJob(app, job.job_id);
    expect(done.status).toBe('succeeded');
    await check();
    d = await expectOk<PlanDetail>(app.post(`/api/v1/plans/${d.plan.id}/adopt-suggestion`, { expected_revision: d.plan.revision, draft_id: done.result_ref }));
    await check();
    expect(d.plan.status).toBe('draft');
  });
});
