import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ApplyBreakdownResult, CurrentScript, DraftDetail, Scene, ScriptPreview, ScriptFormat, Shot } from '@storyscript/contracts';
import { getScriptVersion, listScenes } from '../src/db/repos/script.ts';
import { BREAKDOWN_REQUEST, bookshopRoster, FIXTURES, fixtureText, importFixture, makeM3App, waitJob, type M3App } from './helpers/m3-app.ts';

/**
 * AT-02 over HTTP: the three fixture scripts import with the frozen scene
 * list of fixtures/scripts/expected.json; re-importing an edited 01 keeps
 * every shot whose quote is still verbatim and flags the one whose line
 * changed (needs_relink), while the old version stays readable.
 */

interface Expected {
  scripts: { file: string; format: ScriptFormat; scenes: { display_no: string; heading_contains: string; time_label: string | null }[] }[];
}
const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as Expected;

const ORIGINAL_LINE = '老周：看是什么书。';
const EDITED_LINE = '老周：先看看是什么书。';

let app: M3App | null = null;
afterEach(() => {
  app?.close();
  app = null;
});

describe('AT-02 script import over HTTP', () => {
  test('three fixtures: scene split matches expected.json; preview is pure', async () => {
    app = await makeM3App();
    for (const exp of EXPECTED.scripts) {
      const text = fixtureText(exp.file);
      const preview = await app.post<ScriptPreview>('/api/v1/scripts/preview', { text, source_name: exp.file, format: exp.format, heading_overrides: [] });
      expect(preview.status, preview.text).toBe(200);
      expect(preview.data.scenes).toHaveLength(exp.scenes.length);
      expect(preview.data.detected_heading_lines.length).toBeGreaterThanOrEqual(exp.scenes.length);

      const imported = await importFixture(app, exp.file, exp.format, text);
      expect(imported.scenes.map((s) => s.display_no)).toEqual(exp.scenes.map((s) => s.display_no));
      imported.scenes.forEach((s, i) => {
        expect(s.heading).toContain(exp.scenes[i]!.heading_contains);
        expect(s.time_label).toBe(exp.scenes[i]!.time_label);
      });
      expect(imported.version.source_name).toBe(exp.file);
      expect(imported.needs_relink_shot_ids).toEqual([]);

      const current = await app.get<CurrentScript>('/api/v1/scripts/current');
      expect(current.data.version.id).toBe(imported.version.id);
      expect(current.data.scenes.map((s) => s.id)).toEqual(imported.scenes.map((s) => s.id));
    }
    const versions = await app.get<{ id: string; scene_count: number; source_name: string }[]>('/api/v1/scripts/versions');
    expect(versions.data.map((v) => [v.source_name, v.scene_count])).toEqual(
      [...EXPECTED.scripts].reverse().map((s) => [s.file, s.scenes.length]),
    );
  });

  test('heading_overrides turn a detected heading off (and a line on)', async () => {
    app = await makeM3App();
    const text = fixtureText('01-bookshop.txt');
    const lines = text.split('\n');
    const scene2Line = lines.findIndex((l) => l.startsWith('2. 内景')) + 1;
    const firstBodyLine = lines.findIndex((l) => l.startsWith('老周没有抬头')) + 1;
    const input = {
      text,
      source_name: '01-bookshop.txt',
      format: 'txt',
      heading_overrides: [
        { line: scene2Line, is_heading: false },
        { line: firstBodyLine, is_heading: true },
      ],
    };
    const preview = await app.post<ScriptPreview>('/api/v1/scripts/preview', input);
    expect(preview.data.detected_heading_lines).toContain(scene2Line);
    expect(preview.data.scenes.map((s) => s.heading)).toEqual(['内景 旧书店 日', '老周没有抬头。']);
    const res = await app.post<{ scenes: Scene[] }>('/api/v1/scripts', input);
    expect(res.status).toBe(201);
    expect(res.data.scenes).toHaveLength(2);
    // no project data changed by preview; import created exactly one version
    const versions = await app.get<unknown[]>('/api/v1/scripts/versions');
    expect(versions.data).toHaveLength(1);
  });

  test('invalid input is rejected with VALIDATION_ERROR', async () => {
    app = await makeM3App();
    const res = await app.post('/api/v1/scripts', { text: '', source_name: 'x', format: 'txt', heading_overrides: [] });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    const none = await app.get('/api/v1/scripts/current');
    expect(none.status).toBe(200);
    expect(none.data).toBeNull();
  });

  test('re-import edited 01: the shot quoting the changed line needs relink, the rest carry over', async () => {
    app = await makeM3App({ demo: true });
    const v1 = await importFixture(app, '01-bookshop.txt', 'txt');
    const [s1, s2] = v1.scenes as [Scene, Scene];
    const [c1, c2] = await bookshopRoster(app);

    // scene settings are carried to the matching scene of the next version
    const sides = await app.patch<Scene>(`/api/v1/scenes/${s1.id}`, { screen_sides: { left: c1!.alias, right: c2!.alias } });
    expect(sides.status, sides.text).toBe(200);
    expect(sides.data.screen_sides).toEqual({ left: 'c1', right: 'c2' });

    for (const scene of [s1, s2]) {
      const res = await app.post<{ job_id: string }>(`/api/v1/scenes/${scene.id}/breakdown`, BREAKDOWN_REQUEST);
      const job = await waitJob(app, res.data.job_id);
      const detail = (await app.get<DraftDetail>(`/api/v1/drafts/${job.result_ref}`)).data;
      const n = (detail.draft.parsed as { shots: unknown[] }).shots.length;
      const applied = await app.post<ApplyBreakdownResult>(`/api/v1/drafts/${detail.draft.id}/apply`, {
        selected: [...Array(n).keys()],
        replace_existing: false,
        expected_revisions: {},
      });
      expect(applied.status, applied.text).toBe(200);
    }
    // a manual shot quoting the whole line that will change
    const line = v1.version.paragraphs.find((p) => p.text === ORIGINAL_LINE)!;
    const manual = await app.post<Shot>('/api/v1/shots', {
      scene_id: s1.id,
      fields: {
        ...(await app.get<Shot[]>('/api/v1/shots')).data[4]!.fields,
        source: { paragraph_id: line.id, quote: ORIGINAL_LINE },
      },
      manual_note: '手工补的反应镜头',
    });
    expect(manual.status, manual.text).toBe(201);

    const before = (await app.get<Shot[]>('/api/v1/shots')).data;
    expect(before).toHaveLength(12 + 5 + 1);
    const quoting = before.filter((s) => s.source_anchor?.quote === ORIGINAL_LINE).map((s) => s.id);
    expect(quoting).toHaveLength(2); // AI shot #5 of scene 1 + the manual one

    const original = fixtureText('01-bookshop.txt');
    expect(original).toContain(ORIGINAL_LINE);
    const edited = original.replace(ORIGINAL_LINE, EDITED_LINE);
    const v2 = await importFixture(app, '01-bookshop.txt', 'txt', edited);
    expect(v2.version.parent_id).toBe(v1.version.id);
    expect([...v2.needs_relink_shot_ids].sort()).toEqual([...quoting].sort());

    const after = (await app.get<Shot[]>('/api/v1/shots')).data;
    expect(after).toHaveLength(before.length);
    const newScene1 = v2.scenes[0]!;
    const newScene2 = v2.scenes[1]!;
    expect(newScene1.screen_sides).toEqual({ left: 'c1', right: 'c2' });
    const paragraphs = new Map(v2.version.paragraphs.map((p) => [p.id, p.text]));
    for (const s of after) {
      const old = before.find((b) => b.id === s.id)!;
      if (quoting.includes(s.id)) {
        expect(s.needs_relink).toBe(true);
        // suggestion only: the old anchor is left as it was
        expect(s.source_anchor).toEqual(old.source_anchor);
      } else {
        expect(s.needs_relink).toBe(false);
        expect(s.source_anchor!.script_version_id).toBe(v2.version.id);
        expect(paragraphs.get(s.source_anchor!.paragraph_id)).toContain(s.source_anchor!.quote);
        expect(s.source_anchor!.match).toBe(old.source_anchor!.match);
      }
      // shots move with their scene; content, code, revision untouched
      expect(s.scene_id).toBe(old.scene_id === s1.id ? newScene1.id : newScene2.id);
      expect([s.code, s.revision, s.content_hash, s.locked]).toEqual([old.code, old.revision, old.content_hash, old.locked]);
    }

    // the old version is still readable and unchanged
    const versions = await app.get<{ id: string; scene_count: number }[]>('/api/v1/scripts/versions');
    expect(versions.data.map((v) => v.id)).toEqual([v2.version.id, v1.version.id]);
    const db = app.handle.projectSession.require().db;
    const old = getScriptVersion(db, v1.version.id)!;
    expect(old.raw_text).toBe(original);
    expect(old.paragraphs.find((p) => p.id === line.id)!.text).toBe(ORIGINAL_LINE);
    expect(listScenes(db, v1.version.id)).toHaveLength(2);
    const current = await app.get<CurrentScript>('/api/v1/scripts/current');
    expect(current.data.version.id).toBe(v2.version.id);

    // a breakdown on an old-version scene is refused
    const oldScene = await app.post(`/api/v1/scenes/${s1.id}/breakdown`, BREAKDOWN_REQUEST);
    expect(oldScene.status).toBe(409);
  });

  test('scene location must be a location entity', async () => {
    app = await makeM3App();
    const v = await importFixture(app, '01-bookshop.txt', 'txt');
    const [c1] = await bookshopRoster(app);
    const bad = await app.patch(`/api/v1/scenes/${v.scenes[0]!.id}`, { location_entity_id: c1!.id });
    expect(bad.status).toBe(400);
    const loc = await app.post<{ id: string }>('/api/v1/entities', { type: 'location', name: '旧书店', aliases: [] });
    const ok = await app.patch<Scene>(`/api/v1/scenes/${v.scenes[0]!.id}`, { location_entity_id: loc.data.id });
    expect(ok.data.location_entity_id).toBe(loc.data.id);
  });
});
