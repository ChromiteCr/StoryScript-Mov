import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { CurrentScript, Entity, HealthInfo, Job, ProvidersView, Shot } from '@storyscript/contracts';
import { startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.ts';
import { BREAKDOWN_REQUEST, importFixture, makeM3App, type M3App } from './helpers/m3-app.ts';

/**
 * AT-16 (no key): every manual workflow works without a text model; AI
 * routes answer PROVIDER_NOT_CONFIGURED before anything is sent or queued.
 */

let app: M3App;
let fake: FakeOpenAI;

beforeEach(async () => {
  fake = await startFakeOpenAI();
  app = await makeM3App({ env: {} });
});

afterEach(async () => {
  app.close();
  await fake.close();
});

describe('AT-16 without any key', () => {
  test('manual entities / script import / shots all work', async () => {
    const health = await app.get<HealthInfo>('/api/v1/health');
    expect(health.data.text_provider_configured).toBe(false);
    const providers = await app.get<ProvidersView>('/api/v1/settings/providers');
    expect(providers.data).toEqual({ text: null, image: null, editable: true });

    const imported = await importFixture(app, '02-last-train.fountain', 'fountain');
    expect(imported.scenes).toHaveLength(3);
    const current = await app.get<CurrentScript>('/api/v1/scripts/current');
    expect(current.data.version.id).toBe(imported.version.id);

    const azhe = await app.post<Entity>('/api/v1/entities', { type: 'character', name: '阿哲', aliases: [] });
    expect(azhe.status).toBe(201);
    expect(azhe.data).toMatchObject({ alias: 'c1', origin: 'manual', confirmed: true });
    const station = await app.post<Entity>('/api/v1/entities', { type: 'location', name: '地铁站', aliases: ['站台'] });
    expect(station.data.alias).toBe('l1');
    const scene = imported.scenes[0]!;
    const patched = await app.patch(`/api/v1/scenes/${scene.id}`, { location_entity_id: station.data.id, screen_sides: { left: 'c1', right: null } });
    expect(patched.status, patched.text).toBe(200);

    const pid = scene.paragraph_ids[1]!;
    const para = imported.version.paragraphs.find((p) => p.id === pid)!;
    const shot = await app.post<Shot>('/api/v1/shots', {
      scene_id: scene.id,
      manual_note: '没有 AI 也能手工建镜头',
      fields: {
        template: 'single',
        shot_size: 'MS',
        angle: 'eye',
        lens: 'normal',
        focal_mm: 50,
        movement: 'handheld',
        subjects: [{ alias: 'c1', screen: 'C', depth: 'mg', facing: 'camera', pose: 'run' }],
        props: [],
        env: 'interior',
        subject_motion: 'toward',
        set_piece: false,
        pov_owner: null,
        frame_format: null,
        technique_id: null,
        est_seconds: 4,
        narrative_purpose: '阿哲赶车',
        action: '阿哲冲下楼梯',
        dialogue_quote: null,
        source: { paragraph_id: pid, quote: para.text.slice(0, 8) },
        assumptions: [],
        questions: [],
      },
    });
    expect(shot.status, shot.text).toBe(201);
    expect(shot.data.source_anchor?.match).toBe('manual');
    const updated = await app.patch<Shot>(`/api/v1/shots/${shot.data.id}`, { expected_revision: 0, locked: true });
    expect(updated.data.locked).toBe(true);
    expect((await app.get<Shot[]>('/api/v1/shots')).data).toHaveLength(1);
  });

  test('AI routes → PROVIDER_NOT_CONFIGURED, nothing queued, nothing sent', async () => {
    // base_url + model saved, but no key: still not configured
    const saved = await app.put<ProvidersView>('/api/v1/settings/providers/text', { base_url: fake.url, model: 'fake-model' });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.data.text).toEqual({ base_url: fake.url, model: 'fake-model', key_last4: null, source: 'file', research_model: null, research_search: false, search_support: null });

    const imported = await importFixture(app, '01-bookshop.txt', 'txt');
    const extract = await app.post('/api/v1/entities/extract');
    expect(extract.status).toBe(409);
    expect(extract.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    const bd = await app.post(`/api/v1/scenes/${imported.scenes[0]!.id}/breakdown`, BREAKDOWN_REQUEST);
    expect(bd.status).toBe(409);
    expect(bd.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    const probe = await app.post('/api/v1/settings/providers/text/test');
    expect(probe.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');

    expect((await app.get<Job[]>('/api/v1/jobs')).data).toEqual([]);
    const db = app.handle.projectSession.require().db;
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM job')!.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM shot_draft')!.n).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});
