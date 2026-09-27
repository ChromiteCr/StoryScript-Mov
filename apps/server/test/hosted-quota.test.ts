import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Job } from '@storyscript/contracts';
import type { AppDeps } from '../src/deps.ts';
import { insertJob } from '../src/db/repos/job.ts';
import { isAppError } from '../src/http/errors.ts';
import { assertJobQuota } from '../src/services/quota.ts';
import { makeM3App, type M3App } from './helpers/m3-app.ts';

/** S1d: on a hosted server each team has a cap on paid jobs per rolling 24 h. */

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
let app: M3App;
beforeEach(async () => {
  app = await makeM3App();
});
afterEach(() => app.close());

const db = () => app.handle.projectSession.require().db;
function job(kind: Job['kind'], remote: boolean, hoursAgo: number): void {
  const at = new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
  const j: Job = {
    id: randomUUID(),
    kind,
    idempotency_key: `${kind}:${randomUUID()}`,
    remote,
    status: 'succeeded',
    attempts: 1,
    input_hash: 'x',
    progress: null,
    error: null,
    usage: null,
    result_ref: null,
    created_at: at,
    updated_at: at,
  };
  db().tx(() => insertJob(db(), j));
}
const hosted = (llm: number, image: number) => ({ ...app.handle.deps, hosted: { slug: 't', name: '一组', limits: { llm_jobs_per_day: llm, image_jobs_per_day: image } } }) as AppDeps;

describe('paid job quota per team', () => {
  test('the local app has no cap', () => {
    for (let i = 0; i < 5; i++) job('breakdown_scene', true, 1);
    expect(() => assertJobQuota(app.handle.deps, db(), 'llm', NOW)).not.toThrow();
  });

  test('counts remote jobs of the lane within 24 h only', () => {
    job('breakdown_scene', true, 1);
    job('extract_entities', true, 23);
    job('suggest_order', false, 1); // demo replay / not paid
    job('breakdown_scene', true, 25); // older than a day
    job('scan_root', false, 1);
    expect(() => assertJobQuota(hosted(3, 1), db(), 'llm', NOW)).not.toThrow();
    let err: unknown;
    try {
      assertJobQuota(hosted(2, 1), db(), 'llm', NOW);
    } catch (e) {
      err = e;
    }
    expect(isAppError(err) && err.code).toBe('QUOTA_EXCEEDED');
    expect(isAppError(err) && (err.details as { used: number }).used).toBe(2);
  });

  test('image jobs have their own cap', () => {
    job('image_redraw', true, 2);
    expect(() => assertJobQuota(hosted(0, 5), db(), 'image', NOW)).not.toThrow();
    expect(() => assertJobQuota(hosted(100, 1), db(), 'image', NOW)).toThrow(/图像模型调用已达 1 次上限/);
  });
});
