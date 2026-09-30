import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Entity, Resource, Setup, StyleCard } from '@storyscript/contracts';
import { makeM3App, type M3App } from './helpers/m3-app.ts';

/**
 * S4a — characters, resources, setups and style cards carry a revision; an
 * update naming an older one is refused (409), one naming none still wins
 * (older clients), and every change bumps the revision.
 */

let app: M3App;
beforeEach(async () => {
  app = await makeM3App();
});
afterEach(() => app.close());

const card = { name: '雨夜', summary: '', grammar: '湿地面反光。', bias: { shot_size: [], angle: [], lens: [], movement: [] }, gear: '', low_budget: '' };
const WINDOW = [{ start_utc: '2026-10-03T00:00:00.000Z', end_utc: '2026-10-03T10:00:00.000Z' }];

test('entity: stale expected_revision → 409; none → last write wins; every change bumps', async () => {
  const e = (await app.post<Entity>('/api/v1/entities', { type: 'character', name: '林川', aliases: [] })).data;
  expect(e.revision ?? 0).toBe(0);
  const a = await app.patch<Entity>(`/api/v1/entities/${e.id}`, { name: '林川川', expected_revision: 0 });
  expect(a.data.revision).toBe(1);
  const stale = await app.patch(`/api/v1/entities/${e.id}`, { name: '别的', expected_revision: 0 });
  expect(stale.status).toBe(409);
  expect(stale.text).toContain('REVISION_CONFLICT');
  const plain = await app.patch<Entity>(`/api/v1/entities/${e.id}`, { actor_name: '周远' });
  expect(plain.data).toMatchObject({ name: '林川川', actor_name: '周远', revision: 2 });
});

test('resource and setup', async () => {
  const r = (await app.post<Resource>('/api/v1/resources', { type: 'location', name: '天台', windows: WINDOW, cast_character_ids: [], confirmed: true })).data;
  const r1 = await app.patch<Resource>(`/api/v1/resources/${r.id}`, { name: '学校天台', expected_revision: 0 });
  expect(r1.data.revision).toBe(1);
  expect((await app.patch(`/api/v1/resources/${r.id}`, { name: 'x', expected_revision: 0 })).status).toBe(409);

  const s = (
    await app.post<Setup>('/api/v1/setups', {
      location_resource_id: r.id,
      label: '天台 · 平视',
      shot_ids: [],
      resource_ids: [],
      durations: { setup_min: 10, per_shot_min: 5, reset_min: 5 },
      estimate_confirmed: false,
    })
  ).data;
  const s1 = await app.patch<Setup>(`/api/v1/setups/${s.id}`, { label: '天台 · 仰拍', expected_revision: 0 });
  expect(s1.data).toMatchObject({ label: '天台 · 仰拍', revision: 1 });
  expect((await app.patch(`/api/v1/setups/${s.id}`, { label: 'x', expected_revision: 0 })).status).toBe(409);
});

test('style card', async () => {
  const c = (await app.post<StyleCard>('/api/v1/styles', card)).data;
  const c1 = await app.put<StyleCard>(`/api/v1/styles/${c.id}`, { ...card, name: '雨夜霓虹', expected_revision: 0 });
  expect(c1.data).toMatchObject({ name: '雨夜霓虹', revision: 1 });
  expect((await app.put(`/api/v1/styles/${c.id}`, { ...card, expected_revision: 0 })).status).toBe(409);
});
