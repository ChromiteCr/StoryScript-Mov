import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Job, ModelSource, UsagePrice, UsageReport } from '@storyscript/contracts';
import { runWithRequest, syncMember, type Actor, type HostedRequest } from '../src/collab/actor.ts';
import { insertJob } from '../src/db/repos/job.ts';
import type { AppDeps } from '../src/deps.ts';
import { isAppError } from '../src/http/errors.ts';
import { lastDates, localDate, saveUsagePrice, usageReport } from '../src/services/usage.ts';
import { makeM3App, type M3App } from './helpers/m3-app.ts';

/**
 * S5 用量看板: totals from the job rows (today in the project's zone, in all,
 * per kind, per day, per member), the group's key and the member's own kept
 * apart, the daily caps, and the unit prices beside the model settings.
 */

// 2026-10-07 01:30 in Shanghai (UTC+8): "today" there began 90 minutes ago
const NOW = Date.parse('2026-10-06T17:30:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const A: Actor = { id: 'acc-a', name: '阿杰', role: 'leader', crew_roles: ['导演'], text_source: 'group', image_source: 'group' };
const B: Actor = { id: 'acc-b', name: '小林', role: 'member', crew_roles: ['摄影'], text_source: 'own', image_source: 'group' };

let app: M3App;
const db = () => app.handle.projectSession.require().db;
const as = (a: Actor): HostedRequest => ({
  actor: a,
  roster: () => [A, B].map(({ id, name, role, crew_roles }) => ({ id, name, role, crew_roles })),
  personalDir: join(app.root, 'accounts', a.id),
});
const hosted = () => ({ ...app.handle.deps, hosted: { slug: 't', name: '一组', limits: { llm_jobs_per_day: 200, image_jobs_per_day: 20 } } }) as AppDeps;

function job(o: { kind?: Job['kind']; at: string; usage?: Record<string, number> | null; attempts?: number; status?: Job['status']; remote?: boolean; actor?: string | null; source?: ModelSource | null }): void {
  const j: Job = {
    id: randomUUID(),
    kind: o.kind ?? 'breakdown_scene',
    idempotency_key: randomUUID(),
    remote: o.remote ?? true,
    status: o.status ?? 'succeeded',
    attempts: o.attempts ?? 1,
    input_hash: 'x',
    progress: null,
    error: null,
    usage: o.usage === undefined ? { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, unknown_calls: 0 } : o.usage,
    result_ref: null,
    created_at: o.at,
    updated_at: o.at,
  };
  db().tx(() => insertJob(db(), j, { actor_id: o.actor ?? null, model_source: o.source ?? null }));
}

beforeEach(async () => {
  app = await makeM3App();
  for (const a of [A, B]) syncMember(db(), a);
});
afterEach(() => app.close());

describe('dates', () => {
  test('local dates in the project zone, the last two weeks oldest first', () => {
    expect(localDate(NOW, 'Asia/Shanghai')).toBe('2026-10-07');
    expect(localDate(NOW, 'UTC')).toBe('2026-10-06');
    expect(localDate(NOW, 'Not/AZone')).toBe('2026-10-06');
    const days = lastDates('2026-10-07', 14);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-09-24');
    expect(days.at(-1)).toBe('2026-10-07');
  });
});

describe('the local app', () => {
  test('today vs in all, per kind and per day; replayed jobs and local work add nothing', () => {
    job({ at: hoursAgo(1) }); // today in Shanghai
    job({ at: hoursAgo(2), kind: 'polish_shots', attempts: 2, usage: { prompt_tokens: 3000, completion_tokens: 500, total_tokens: 3500, unknown_calls: 1 } }); // yesterday there
    job({ at: hoursAgo(30), status: 'outcome_unknown', usage: null, attempts: 1 });
    job({ at: hoursAgo(1), remote: false }); // --demo replay
    job({ at: hoursAgo(1), kind: 'scan_root', remote: false, usage: null, attempts: 0 });
    const r = usageReport(app.handle.deps, NOW);
    expect(r).toMatchObject({ timezone: 'Asia/Shanghai', today: '2026-10-07', caps: null, demo: false });
    expect(r.sources).toHaveLength(1);
    const s = r.sources[0]!;
    expect(s).toMatchObject({ source: 'local', can_edit_price: true, by_member: null });
    expect(s.today).toMatchObject({ jobs: 1, requests: 1, total_tokens: 1200 });
    expect(s.total).toMatchObject({ jobs: 3, requests: 4, prompt_tokens: 4000, completion_tokens: 700, total_tokens: 4700, unknown_calls: 1, outcome_unknown: 1 });
    expect(s.by_kind.map((k) => [k.kind, k.totals.requests])).toEqual([
      ['polish_shots', 2],
      ['breakdown_scene', 2],
    ]);
    expect(s.days).toHaveLength(14);
    expect(s.days.at(-1)).toMatchObject({ date: '2026-10-07', requests: 1, total_tokens: 1200 });
    expect(s.days.at(-2)).toMatchObject({ date: '2026-10-06', requests: 2, total_tokens: 3500 });
    expect(s.days.at(-3)).toMatchObject({ date: '2026-10-05', requests: 1, total_tokens: 0 });
  });

  test('images count by the picture; image services report input/output tokens', () => {
    job({ at: hoursAgo(1), kind: 'image_redraw', usage: { input_tokens: 300, output_tokens: 4000, total_tokens: 4300 } });
    job({ at: hoursAgo(1), kind: 'image_redraw', status: 'failed', usage: null });
    const s = usageReport(app.handle.deps, NOW).sources[0]!;
    expect(s.total).toMatchObject({ jobs: 2, images: 1, prompt_tokens: 300, completion_tokens: 4000, total_tokens: 4300, unknown_calls: 0 });
  });

  test('a price is saved beside the settings (0600) and read back; over the bounds is refused', async () => {
    const price: UsagePrice = { currency: 'CNY', input_per_m: 2, output_per_m: 8, per_image: 0.3 };
    const saved = await app.put<UsagePrice>('/api/v1/usage/price', { source: 'local', price });
    expect(saved.status, saved.text).toBe(200);
    expect(statSync(join(app.stateDir, 'usage-price.json')).mode & 0o777).toBe(0o600);
    const got = await app.get<UsageReport>('/api/v1/usage');
    expect(got.status).toBe(200);
    expect(got.data.sources[0]!.price).toEqual(price);
    expect((await app.put('/api/v1/usage/price', { source: 'local', price: { ...price, input_per_m: -1 } })).status).toBe(400);
    expect((await app.put('/api/v1/usage/price', { source: 'group', price })).status).toBe(400);
  });
});

describe('the hosted server', () => {
  beforeEach(() => {
    job({ at: hoursAgo(1), actor: A.id, source: 'group' });
    job({ at: hoursAgo(3), actor: B.id, source: 'group', usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, unknown_calls: 0 } });
    job({ at: hoursAgo(40), actor: null, source: null }); // before S4: the group's key
    job({ at: hoursAgo(1), actor: B.id, source: 'own', usage: { prompt_tokens: 9000, completion_tokens: 1000, total_tokens: 10000, unknown_calls: 0 } });
    job({ at: hoursAgo(1), kind: 'image_redraw', actor: A.id, source: 'group', usage: null });
  });

  test('the group key: everyone sees it, per member; the cap counts it within 24 hours', () => {
    const r = runWithRequest(as(A), () => usageReport(hosted(), NOW));
    expect(r.caps).toEqual({ llm: { limit: 200, used: 2, remaining: 198 }, image: { limit: 20, used: 1, remaining: 19 } });
    const group = r.sources.find((s) => s.source === 'group')!;
    expect(group.total).toMatchObject({ jobs: 4, total_tokens: 2460, images: 1 });
    expect(group.can_edit_price).toBe(true);
    expect(group.by_member!.map((m) => [m.actor?.name ?? null, m.totals.jobs])).toEqual([
      ['阿杰', 2],
      [null, 1],
      ['小林', 1],
    ]);
    const asB = runWithRequest(as(B), () => usageReport(hosted(), NOW));
    expect(asB.sources.find((s) => s.source === 'group')!.can_edit_price).toBe(false);
  });

  test('my key: only my own jobs, and only I see them', () => {
    const mineA = runWithRequest(as(A), () => usageReport(hosted(), NOW)).sources.find((s) => s.source === 'own')!;
    expect(mineA.total.jobs).toBe(0);
    const mineB = runWithRequest(as(B), () => usageReport(hosted(), NOW)).sources.find((s) => s.source === 'own')!;
    expect(mineB.total).toMatchObject({ jobs: 1, total_tokens: 10000 });
    expect(mineB.by_member).toBeNull();
    expect(mineB.can_edit_price).toBe(true);
  });

  test('prices: the group price is the leader\'s to set; my price sits in my own folder', () => {
    const price: UsagePrice = { currency: 'USD', input_per_m: 0.5, output_per_m: 1.5, per_image: null };
    let err: unknown;
    try {
      runWithRequest(as(B), () => saveUsagePrice(hosted(), { source: 'group', price }));
    } catch (e) {
      err = e;
    }
    expect(isAppError(err) && err.status).toBe(403);
    runWithRequest(as(A), () => saveUsagePrice(hosted(), { source: 'group', price }));
    mkdirSync(join(app.root, 'accounts', B.id), { recursive: true });
    const own = { ...price, currency: 'CNY' as const, input_per_m: 1 };
    runWithRequest(as(B), () => saveUsagePrice(hosted(), { source: 'own', price: own }));
    expect(statSync(join(app.root, 'accounts', B.id, 'usage-price.json')).mode & 0o777).toBe(0o600);
    const r = runWithRequest(as(B), () => usageReport(hosted(), NOW));
    expect(r.sources.find((s) => s.source === 'group')!.price).toEqual(price);
    expect(r.sources.find((s) => s.source === 'own')!.price).toEqual(own);
    // A has no own price yet
    expect(runWithRequest(as(A), () => usageReport(hosted(), NOW)).sources.find((s) => s.source === 'own')!.price.input_per_m).toBeNull();
    expect(() => runWithRequest(as(A), () => saveUsagePrice(hosted(), { source: 'local', price }))).toThrow();
  });
});
