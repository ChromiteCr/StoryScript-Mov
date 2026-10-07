import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { BoardView, Entity, RelayoutBoardsResult, Scene, Shot, ShotFields } from '@storyscript/contracts';
import { RENDERER_VERSION, shotContentHash } from '@storyscript/core';
import { latestBoard } from '../src/db/repos/board.ts';
import { importFixture, makeM3App, type M3App } from './helpers/m3-app.ts';
import { BASE_FIELDS } from './media-fixture.ts';

/**
 * S5b on the server: the board takes the scene heading's time (日 / 夜 /
 * 黄昏) for its light, each person's feeling (the shot's own or read from its
 * action), and the name of the object an insert is about (the shot's own or a
 * prop entity its action mentions). Shots saved without the new fields keep
 * their content hash; boards from the S4c renderer can be laid out again.
 */

const SCRIPT = `1. 内景 书店 日

小林在柜台后面整理旧书。

2. 外景 街口 夜

小林站在路灯下，低头叹气。

3. 内景 厨房 黄昏

桌上放着一罐黄桃罐头。
`;

let app: M3App;
let scenes: Scene[];
let roster: Entity[];

const db = () => app.handle.projectSession.require().db;

async function makeShot(sceneIndex: number, code: string, fields: Partial<ShotFields>): Promise<Shot> {
  const r = await app.post<Shot>('/api/v1/shots', { scene_id: scenes[sceneIndex]!.id, fields: { ...BASE_FIELDS, ...fields }, manual_note: '测试用手工镜头', code });
  expect(r.status, r.text).toBe(201);
  return r.data;
}

const boardOf = (s: Shot) => latestBoard(db(), s.id)!;

beforeEach(async () => {
  app = await makeM3App();
  scenes = (await importFixture(app, 's5b.txt', 'txt', SCRIPT)).scenes;
  expect(scenes.map((s) => s.time_label)).toEqual(['日', '夜', '黄昏']);
  roster = [(await app.post<Entity>('/api/v1/entities', { type: 'character', name: '小林', aliases: [] })).data];
  const prop = await app.post<Entity>('/api/v1/entities', { type: 'prop', name: '黄桃罐头', aliases: [] });
  expect(prop.status, prop.text).toBe(201);
});

afterEach(() => app.close());

describe('S5b boards', () => {
  test('the scene heading’s time sets the light: day as before, night and dusk marked', async () => {
    const day = await makeShot(0, '001', { subjects: [{ alias: roster[0]!.alias, screen: null, depth: null, facing: null, pose: null }] });
    const night = await makeShot(1, '001', { subjects: [{ alias: roster[0]!.alias, screen: null, depth: null, facing: null, pose: null }] });
    const dusk = await makeShot(2, '001', {});
    expect('time' in boardOf(day).spec.scene).toBe(false);
    expect(boardOf(day).spec.scene.light).toEqual({ azimuth_deg: 45, elevation_deg: 40 });
    expect(boardOf(night).spec.scene.time).toBe('night');
    expect(boardOf(dusk).spec.scene.time).toBe('dusk');
    expect(boardOf(night).renderer_version).toBe(RENDERER_VERSION);
  });

  test('a feeling read from the action, or set on the shot, reaches the board', async () => {
    const subject = { alias: roster[0]!.alias, screen: null, depth: null, facing: null, pose: null };
    const read = await makeShot(1, '001', { subjects: [subject], action: '小林站在路灯下，低头叹气' });
    expect(boardOf(read).spec.scene.subjects[0]!.emotion).toBe('sad');
    const own = await makeShot(1, '002', { subjects: [{ ...subject, emotion: 'angry' }], action: '小林站在路灯下，低头叹气' });
    expect(own.fields.subjects[0]!.emotion).toBe('angry');
    expect(boardOf(own).spec.scene.subjects[0]!.emotion).toBe('angry');
  });

  test('an insert names its object: the shot’s own name, else a prop entity its action mentions', async () => {
    const named = await makeShot(2, '001', { template: 'insert', shot_size: 'INSERT', props: ['table', 'can'], object_name: '水果罐头', action: '桌上的罐头' });
    const label = boardOf(named).spec.overlay.labels.find((l) => l.id === 'l-object');
    expect(label?.text).toBe('水果罐头');
    expect(boardOf(named).spec.scene.props.find((p) => p.id === label?.prop_id)?.kind).toBe('can');
    const fromEntity = await makeShot(2, '002', { template: 'insert', shot_size: 'INSERT', props: ['table', 'can'], action: '桌上放着一罐黄桃罐头' });
    expect(boardOf(fromEntity).spec.overlay.labels.find((l) => l.id === 'l-object')?.text).toBe('黄桃罐头');
  });

  test('empty new fields are not stored and keep the content hash', async () => {
    const subject = { alias: roster[0]!.alias, screen: null, depth: null, facing: null, pose: null };
    const s = await makeShot(0, '001', { subjects: [{ ...subject, emotion: null }], object_name: '  ' });
    expect('object_name' in s.fields).toBe(false);
    expect('emotion' in s.fields.subjects[0]!).toBe(false);
    expect(s.content_hash).toBe(shotContentHash({ ...BASE_FIELDS, subjects: [subject] }));
  });

  test('boards drawn by the S4c renderer are laid out again with the new rules', async () => {
    const s = await makeShot(1, '001', { subjects: [{ alias: roster[0]!.alias, screen: null, depth: null, facing: null, pose: null }], action: '小林低头叹气' });
    db().run('UPDATE board SET renderer_version = ? WHERE shot_id = ?', 'board-s4c', s.id);
    const res = await app.post<RelayoutBoardsResult>('/api/v1/boards/relayout', { scene_id: scenes[1]!.id });
    expect(res.status, res.text).toBe(200);
    expect(res.data.relaid).toBe(1);
    const b = boardOf(s);
    expect(b).toMatchObject({ version: 2, renderer_version: 'board-s5b' });
    expect(b.spec.scene.time).toBe('night');
    expect(b.spec.scene.subjects[0]!.emotion).toBe('sad');
    const views = (await app.get<BoardView[]>('/api/v1/boards')).data;
    expect(views.find((v) => v.shot_id === s.id)).toBeTruthy();
  });
});
