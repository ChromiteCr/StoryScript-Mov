import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ScriptImportResult, ScriptPreview, Shot } from '@storyscript/contracts';
import { fixtureText, importFixture, makeM3App, type M3App } from './helpers/m3-app.ts';

/**
 * S2c: importing a shot list makes scenes from its headings (or its 场景
 * column) and one manual shot per shot line, anchored to that line; it is not
 * cut into one scene per shot. A screenplay imports exactly as before.
 */

let app: M3App;
beforeEach(async () => {
  app = await makeM3App();
});
afterEach(() => app.close());

const shots = async () => (await app.get<Shot[]>('/api/v1/shots')).data;

describe('importing a shot list', () => {
  test('the preview says it is a shot list and what each line will become', async () => {
    const r = await app.post<ScriptPreview>('/api/v1/scripts/preview', {
      text: fixtureText('04-shotlist.txt'),
      source_name: '04-shotlist.txt',
      format: 'txt',
      heading_overrides: [],
    });
    expect(r.status, r.text).toBe(200);
    expect(r.data.kind).toBe('shot_list');
    expect(r.data.scenes).toHaveLength(2);
    expect(r.data.shot_lines).toHaveLength(9);
    expect(r.data.shot_lines[3]!.info).toMatchObject({ shot_size: 'MS', movement: 'handheld', est_seconds: 5 });
  });

  test('line-by-line: 2 scenes and 9 manual shots, each anchored to its own line', async () => {
    const result = await importFixture(app, '04-shotlist.txt', 'txt');
    expect(result.scenes.map((s) => s.heading)).toEqual(['教室 日', '走廊 日']);
    expect(result.created_shot_ids).toHaveLength(9);
    const list = await shots();
    expect(list).toHaveLength(9);
    const byScene = (i: number) => list.filter((s) => s.scene_id === result.scenes[i]!.id);
    expect(byScene(0).map((s) => s.code)).toEqual(['001', '002', '003', '004', '005']);
    expect(byScene(1)).toHaveLength(4);
    const fourth = byScene(0)[3]!;
    expect(fourth).toMatchObject({ origin: 'manual', manual_note: '来自分镜脚本第 8 行（原镜号 4）' });
    expect(fourth.fields).toMatchObject({ shot_size: 'MS', movement: 'handheld', est_seconds: 5, action: '小林起身走向门口' });
    expect(fourth.source_anchor).toMatchObject({ quote: '4. 中景 手持跟拍 小林起身走向门口 5秒', match: 'manual' });
    const para = result.version.paragraphs.find((p) => p.id === fourth.source_anchor!.paragraph_id)!;
    expect(para.line).toBe(8);
  });

  test('table: a scene per location run, fields from the columns', async () => {
    const result = await importFixture(app, '05-shotlist-table.tsv', 'txt');
    expect(result.scenes.map((s) => s.heading)).toEqual(['天台', '楼梯间']);
    const list = await shots();
    expect(list).toHaveLength(5);
    expect(list.find((s) => s.fields.dialogue_quote === '你还会回来吗？')!.fields).toMatchObject({ shot_size: 'MS', movement: 'push_in', est_seconds: 4 });
  });

  test('importing the same shot list again as a new version does not duplicate shots', async () => {
    await importFixture(app, '04-shotlist.txt', 'txt');
    const again = await importFixture(app, '04-shotlist.txt', 'txt');
    expect(again.created_shot_ids).toEqual([]);
    expect(await shots()).toHaveLength(9);
    // one new line: one new shot
    const text = `${fixtureText('04-shotlist.txt')}10. 特写 小林的鞋带松了 2秒\n`;
    const third = await importFixture(app, '04-shotlist.txt', 'txt', text);
    expect(third.created_shot_ids).toHaveLength(1);
    expect(await shots()).toHaveLength(10);
  });

  test('a line forced back to plain text makes no shot', async () => {
    const r = await app.post<ScriptImportResult>('/api/v1/scripts', {
      text: fixtureText('04-shotlist.txt'),
      source_name: '04-shotlist.txt',
      format: 'txt',
      heading_overrides: [],
      shot_overrides: [{ line: 7, is_shot: false }],
    });
    expect(r.status, r.text).toBe(201);
    expect(r.data.created_shot_ids).toHaveLength(8);
  });
});

describe('a screenplay imports as before', () => {
  test('no shots are made from a screenplay without shot lines', async () => {
    const result = await importFixture(app, '01-bookshop.txt', 'txt');
    expect(result.scenes).toHaveLength(2);
    expect(result.created_shot_ids).toEqual([]);
    expect(await shots()).toEqual([]);
  });
});
