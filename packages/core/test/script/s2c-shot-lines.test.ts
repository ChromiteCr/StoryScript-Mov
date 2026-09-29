import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ParsedScript, ShotFields } from '@storyscript/contracts';
import { detectHeading, detectShotTable, isShotLine, parseScript, parseShotLine, parseTableRow, readsLikeHeading, shotFieldsFromLine } from '../../src/index.ts';

/**
 * S2c: a shot list (one shot per line, or a 镜号/景别/画面 table) must not be
 * cut into one scene per shot. Shot lines are never scene headings; a text
 * made mostly of them is a shot list whose lines become shots.
 */

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'scripts');
const read = (f: string) => readFileSync(join(FIXTURES, f), 'utf8');

describe('which lines are shots', () => {
  test.each([
    '3. 近景 小明推门进来',
    '12、特写 日记本',
    '镜头12 特写 日记本',
    '镜号 3：全景 操场',
    'Shot 4 CU hand',
    '3-2 小明推门进来',
    'S1-03 全景 操场',
    '特写：日记本上的字',
    '全景 教室里空无一人',
    '7. 手持 跟拍 小林跑下楼',
    '8. 仰拍 小林停下',
    '5. 过肩 小林回头',
  ])('shot: %s', (line) => {
    expect(isShotLine(line, readsLikeHeading)).toBe(true);
  });

  test.each([
    '1. 内景 教室 日',
    '1、内景 旧书店 日',
    '1-1 内景 客厅 日',
    '3、小明摇了摇头。',
    '他推开门走进来。',
    '5. 小明手持雨伞走进来',
    '远景是一片麦田。',
    '林晓：请问……这里还收旧书吗？',
  ])('not a shot: %s', (line) => {
    expect(isShotLine(line, readsLikeHeading)).toBe(false);
  });

  test('a scene heading is never taken for a shot, and a shot line never for a heading', () => {
    expect(detectHeading('1-1 内景 客厅 日')).not.toBeNull();
    const p = parseScript('1. 内景 教室 日\n\n2. 近景 小明 日\n\n小明看着窗外。', 'txt');
    expect(p.scenes.map((s) => s.heading)).toEqual(['内景 教室 日']);
    expect(p.detected_shot_lines).toEqual([3]);
  });
});

describe('what a shot line says', () => {
  test('size, movement, seconds, number and the rest as the action', () => {
    expect(parseShotLine('4. 中景 手持跟拍 小林起身走向门口 5秒')).toMatchObject({
      code: '4',
      shot_size: 'MS',
      movement: 'handheld',
      est_seconds: 5,
      action: '小林起身走向门口',
    });
    expect(parseShotLine('镜头3 仰拍 近景 小林停下')).toMatchObject({ code: '3', angle: 'low', shot_size: 'MCU', action: '小林停下' });
    expect(parseShotLine('3-2 推 小明推门进来')).toMatchObject({ code: '3-2', movement: 'push_in', action: '小明推门进来' });
    expect(parseShotLine('6. 大远景 俯拍 城市全貌 10s')).toMatchObject({ shot_size: 'EWS', angle: 'high', est_seconds: 10 });
    expect(parseShotLine('9. 空镜 夕阳照在走廊上')).toMatchObject({ shot_size: 'INSERT' });
    expect(parseShotLine('2. CU hand on the door')).toMatchObject({ shot_size: 'CU' });
  });

  test('dialogue in quotes or after 台词：', () => {
    expect(parseShotLine('7. 中近景 小周跑上来，“等等我！” 2秒')).toMatchObject({ dialogue: '等等我！', est_seconds: 2, shot_size: 'MCU' });
    expect(parseShotLine('8. 近景 小林回头 台词：你怎么来了')).toMatchObject({ dialogue: '你怎么来了', action: '小林回头' });
  });

  test('"推门" and "手持雨伞" are actions, not camera moves', () => {
    expect(parseShotLine('3. 近景 小明推门进来')).toMatchObject({ movement: null, action: '小明推门进来' });
    expect(parseShotLine('3. 近景 小明手持雨伞')).toMatchObject({ movement: null });
  });

  test('full ShotFields with stated defaults for what was not written', () => {
    const f = shotFieldsFromLine(parseShotLine('3. 小明推门进来'), { paragraph_id: 'p-003', quote: '3. 小明推门进来' });
    expect(ShotFields.parse(f)).toBeTruthy();
    expect(f).toMatchObject({ shot_size: 'MS', movement: 'static', angle: 'eye', est_seconds: 3, template: null });
    expect(f.assumptions).toEqual(['分镜脚本没写景别，暂按中景', '分镜脚本没写时长，暂按 3 秒']);
    const ots = shotFieldsFromLine(parseShotLine('5. 过肩 小林回头'), { paragraph_id: 'p-005', quote: 'x' });
    expect(ots.template).toBe('ots');
    expect(shotFieldsFromLine(parseShotLine('9. 空镜 夕阳'), { paragraph_id: 'p-009', quote: 'x' }).template).toBe('insert');
  });
});

describe('shot tables pasted from Word or Excel', () => {
  test('header detection', () => {
    expect(detectShotTable('镜号\t场景\t景别\t运镜\t画面内容\t台词\t时长(秒)')).toEqual({
      sep: '\t',
      columns: ['code', 'location', 'size', 'movement', 'action', 'dialogue', 'seconds'],
    });
    expect(detectShotTable('| 镜号 | 景别 | 画面 |')?.columns).toEqual(['code', 'size', 'action']);
    expect(detectShotTable('姓名\t电话')).toBeNull();
    expect(detectShotTable('小林：你好')).toBeNull();
  });

  test('a row by its columns', () => {
    const table = detectShotTable('镜号\t场景\t景别\t运镜\t画面内容\t台词\t时长')!;
    expect(parseTableRow('2\t天台\t中景\t推\t小林转头看小周\t你还会回来吗？\t4', table)).toMatchObject({
      code: '2',
      location: '天台',
      shot_size: 'MS',
      movement: 'push_in',
      action: '小林转头看小周',
      dialogue: '你还会回来吗？',
      est_seconds: 4,
    });
  });
});

describe('new scene heading forms', () => {
  test.each([
    ['场景一：教室（日）', '1', '日', '教室'],
    ['场次3 操场 日', '3', '日', '操场'],
    ['一、教室 日', '1', '日', '教室'],
    ['S1 天台 夜', '1', '夜', '天台'],
    ['Sc.2 走廊 黄昏', '2', '黄昏', '走廊'],
    ['【教室·日·内】', null, '日', '教室'],
    ['教室（夜间）', null, null, null],
  ])('%s', (line, no, time, loc) => {
    const h = detectHeading(line);
    if (time === null) {
      expect(h).toBeNull();
      return;
    }
    expect(h).toMatchObject({ display_no: no, time_label: time, location_label: loc });
  });

  test('explicit markers win over shot rules', () => {
    expect(detectHeading('第3场 教室 日')?.explicit).toBe(true);
    expect(detectHeading('1. 内景 教室 日')?.explicit).toBe(false);
  });
});

describe('whole scripts', () => {
  test('line-by-line shot list: 2 scenes, 9 shots, each shot its own anchored paragraph', () => {
    const p = parseScript(read('04-shotlist.txt'), 'txt');
    expect(ParsedScript.parse(p)).toBeTruthy();
    expect(p.kind).toBe('shot_list');
    expect(p.scenes.map((s) => [s.display_no, s.heading])).toEqual([
      ['1', '教室 日'],
      ['2', '走廊 日'],
    ]);
    expect(p.shot_lines).toHaveLength(9);
    expect(p.shot_lines.map((s) => s.scene_idx)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1]);
    expect(p.shot_lines.map((s) => s.info.shot_size)).toEqual(['FS', 'MCU', 'CU', 'MS', null, 'FS', 'MCU', 'MCU', 'INSERT']);
    for (const s of p.shot_lines) {
      const para = p.paragraphs.find((x) => x.id === s.paragraph_id)!;
      expect(para.line).toBe(s.line);
      expect(para.is_heading).toBe(false);
      expect(p.scenes[s.scene_idx!]!.paragraph_ids).toContain(s.paragraph_id);
    }
  });

  test('table shot list without headings: a scene per location run', () => {
    const p = parseScript(read('05-shotlist-table.tsv'), 'txt', [], { untitledScene: '天台戏' });
    expect(p.kind).toBe('shot_list');
    expect(p.scenes.map((s) => s.heading)).toEqual(['天台', '楼梯间']);
    expect(p.shot_lines.map((s) => s.scene_idx)).toEqual([0, 0, 0, 1, 1]);
    expect(p.shot_lines[1]!.info).toMatchObject({ movement: 'push_in', dialogue: '你还会回来吗？', est_seconds: 4 });
  });

  test('a shot list with no scene information at all is one scene named after the file', () => {
    const p = parseScript('1. 全景 操场\n2. 近景 小林\n3. 特写 球鞋', 'paste', [], { untitledScene: '操场.txt' });
    expect(p.scenes.map((s) => s.heading)).toEqual(['操场.txt']);
    expect(p.shot_lines).toHaveLength(3);
  });

  test('a screenplay with one stray shot line stays a screenplay', () => {
    const p = parseScript('内景 书店 日\n\n林晓推门进来。\n\n特写：日记本\n\n老周抬起头。', 'txt');
    expect(p.kind).toBe('screenplay');
    expect(p.scenes).toHaveLength(1);
    expect(p.shot_lines.map((s) => s.line)).toEqual([5]);
  });

  test('overrides: a line can be made a shot, or taken back to plain text', () => {
    const text = '第1场 教室 日\n1. 全景 教室\n2. 小林写作业\n3. 近景 小林';
    const plain = parseScript(text, 'txt');
    expect(plain.shot_lines.map((s) => s.line)).toEqual([2, 4]);
    const forced = parseScript(text, 'txt', [], { shotOverrides: [{ line: 3, is_shot: true }, { line: 4, is_shot: false }] });
    expect(forced.shot_lines.map((s) => s.line)).toEqual([2, 3]);
    expect(forced.detected_shot_lines).toEqual([2, 4]);
  });
});
