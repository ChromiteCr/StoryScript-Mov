import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { CastSuggestion, CastSyncPreview, Entity, Resource } from '@storyscript/contracts';
import { importFixture, makeM3App, type M3App } from './helpers/m3-app.ts';

/**
 * S3b: the script's cast list → characters' actors (ticked by the user),
 * then the plan's performers and locations synced from the script. Names are
 * made up.
 */

const SCRIPT = [
  '人物：',
  '周远：裴明远：主角',
  '孙晴：林川：小孩子',
  '沈乐：林川长大后',
  '安老师：林川的母亲',
  '剧本：',
  '1. 内景 教室 日',
  '裴明远走进教室，林川抬起头。',
  '2. 外景 天台 夜',
  '林川长大后站在天台上。',
].join('\n');

let app: M3App;
const entities = async () => (await app.get<Entity[]>('/api/v1/entities')).data;
const resources = async () => (await app.get<Resource[]>('/api/v1/resources')).data;

beforeEach(async () => {
  app = await makeM3App();
  await importFixture(app, 'cast.txt', 'txt', SCRIPT);
  await app.post('/api/v1/entities', { type: 'character', name: '裴明远', aliases: [] });
  await app.post('/api/v1/entities', { type: 'character', name: '林川', aliases: ['林川长大后'] });
  await app.post('/api/v1/entities', { type: 'location', name: '天台', aliases: [] });
});

afterEach(() => app.close());

describe('cast list → actors', () => {
  test('suggestions from the lines before the first scene; apply sets actors and splits the alias', async () => {
    const s = (await app.get<CastSuggestion[]>('/api/v1/entities/cast')).data;
    expect(s.map((x) => [x.character_label, x.actor_name, x.match, x.split_alias])).toEqual([
      ['裴明远', '周远', 'exact', null],
      ['林川', '孙晴', 'exact', null],
      ['林川长大后', '沈乐', 'alias', '林川长大后'],
      ['林川的母亲', '安老师', 'none', null],
    ]);

    const applied = await app.post<Entity[]>('/api/v1/entities/cast', {
      items: s.map((x) => ({
        entity_id: x.entity_id,
        actor_name: x.actor_name,
        split_alias: x.split_alias,
        new_character_name: x.entity_id ? null : x.character_label,
      })),
    });
    expect(applied.status, applied.text).toBe(200);
    const byName = Object.fromEntries((await entities()).filter((e) => e.type === 'character').map((e) => [e.name, e]));
    expect(byName['裴明远']!.actor_name).toBe('周远');
    expect(byName['林川']).toMatchObject({ actor_name: '孙晴', aliases: [] });
    expect(byName['林川长大后']).toMatchObject({ actor_name: '沈乐', origin: 'manual' });
    expect(byName['林川的母亲']!.actor_name).toBe('安老师');

    // now everything is current
    const again = (await app.get<CastSuggestion[]>('/api/v1/entities/cast')).data;
    expect(again.filter((x) => x.entity_id).every((x) => x.current)).toBe(true);
  });

  test('actor_name on the entity: trimmed, "" clears, never on locations', async () => {
    const [c] = (await entities()).filter((e) => e.name === '裴明远');
    const set = await app.patch<Entity>(`/api/v1/entities/${c!.id}`, { actor_name: '  周  远 ' });
    expect(set.data.actor_name).toBe('周 远');
    const cleared = await app.patch<Entity>(`/api/v1/entities/${c!.id}`, { actor_name: '' });
    expect(cleared.data.actor_name).toBeNull();
    const [l] = (await entities()).filter((e) => e.type === 'location');
    const loc = await app.patch<Entity>(`/api/v1/entities/${l!.id}`, { actor_name: '某人' });
    expect(loc.data.actor_name).toBeNull();
  });
});

describe('plan sync', () => {
  const WINDOW = [{ start_utc: '2026-10-03T00:00:00.000Z', end_utc: '2026-10-03T12:00:00.000Z' }];

  test('preview → apply creates performers (one per actor) and the location; then in sync', async () => {
    const all = await entities();
    const id = (name: string) => all.find((e) => e.name === name)!.id;
    await app.patch(`/api/v1/entities/${id('裴明远')}`, { actor_name: '周远' });
    await app.patch(`/api/v1/entities/${id('林川')}`, { actor_name: '孙晴' });
    // an old performer who had 林川 in the plan
    await app.post('/api/v1/resources', { type: 'performer', name: '旧演员', windows: WINDOW, cast_character_ids: [id('林川')], confirmed: true });

    const preview = (await app.get<CastSyncPreview>('/api/v1/resources/cast-sync')).data;
    expect(preview.changes.map((c) => [c.kind, c.resource_name, c.entity_name])).toEqual([
      ['create_performer', '周远', '裴明远'],
      ['move_cast', '孙晴', '林川'],
      ['create_location', '天台', '天台'],
    ]);

    // without locations first
    const res = await app.post<Resource[]>('/api/v1/resources/cast-sync', { hash: preview.hash, include_locations: false, windows: WINDOW, confirmed: false });
    expect(res.status, res.text).toBe(200);
    const now = await resources();
    expect(now.find((r) => r.name === '周远')).toMatchObject({ type: 'performer', cast_character_ids: [id('裴明远')], confirmed: false, windows: WINDOW });
    expect(now.find((r) => r.name === '孙晴')!.cast_character_ids).toEqual([id('林川')]);
    expect(now.find((r) => r.name === '旧演员')!.cast_character_ids).toEqual([]);
    expect(now.some((r) => r.type === 'location')).toBe(false);

    // a stale hash is refused
    const stale = await app.post('/api/v1/resources/cast-sync', { hash: preview.hash, include_locations: true, windows: [], confirmed: false });
    expect(stale.status).toBe(409);

    const left = (await app.get<CastSyncPreview>('/api/v1/resources/cast-sync')).data;
    expect(left.changes.map((c) => c.kind)).toEqual(['create_location']);
    await app.post('/api/v1/resources/cast-sync', { hash: left.hash, include_locations: true, windows: WINDOW, confirmed: true });
    expect((await app.get<CastSyncPreview>('/api/v1/resources/cast-sync')).data.changes).toEqual([]);
    expect((await resources()).find((r) => r.type === 'location')).toMatchObject({ name: '天台', confirmed: true });
  });

  test('a bad window is refused', async () => {
    const all = await entities();
    await app.patch(`/api/v1/entities/${all.find((e) => e.name === '裴明远')!.id}`, { actor_name: '周远' });
    const preview = (await app.get<CastSyncPreview>('/api/v1/resources/cast-sync')).data;
    const res = await app.post('/api/v1/resources/cast-sync', {
      hash: preview.hash,
      include_locations: false,
      windows: [{ start_utc: '2026-10-03T12:00:00.000Z', end_utc: '2026-10-03T00:00:00.000Z' }],
      confirmed: false,
    });
    expect(res.status).toBe(400);
  });
});

describe('review fixes (server)', () => {
  test('two cast lines for one character keep both actors; "/" alone is no actor', async () => {
    const lin = (await entities()).find((e) => e.name === '林川')!;
    const res = await app.post<Entity[]>('/api/v1/entities/cast', {
      items: [
        { entity_id: lin.id, actor_name: '孙晴', split_alias: null, new_character_name: null },
        { entity_id: lin.id, actor_name: '周远', split_alias: null, new_character_name: null },
      ],
    });
    expect(res.data.find((e) => e.id === lin.id)!.actor_name).toBe('孙晴、周远');
    const slash = await app.patch<Entity>(`/api/v1/entities/${lin.id}`, { actor_name: ' / ' });
    expect(slash.data.actor_name).toBeNull();
  });
});
