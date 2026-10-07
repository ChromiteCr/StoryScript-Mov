import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ScriptEstimate } from '@storyscript/contracts';
import { estimateScript, paragraphUnits, parseScript, sceneIntExt, textUnits } from '../../src/index.ts';

/** S5 预估片长: units, dialogue vs action, the per-scene rule and the heading tags. */

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'scripts');
const load = (name: string, format: 'txt' | 'fountain' | 'md') => {
  const parsed = parseScript(readFileSync(join(FIXTURES, name), 'utf8'), format);
  return { parsed, scenes: parsed.scenes.map((s, i) => ({ ...s, id: `00000000-0000-4000-8000-00000000000${i}` })) };
};

describe('units', () => {
  test('a CJK character is one unit, a Latin word one and a half, punctuation nothing', () => {
    expect(textUnits('请问……这里还收旧书吗？')).toBe(9);
    expect(textUnits('I got the last train.')).toBe(7.5);
    expect(textUnits('他看了一眼：00:02。')).toBe(5 + 3);
    expect(textUnits('，。！？“”（）')).toBe(0);
  });

  test('dialogue lines: a short name and a colon; parentheticals are not spoken', () => {
    expect(paragraphUnits('林晓：请问……这里还收旧书吗？')).toEqual({ dialogue: 9, action: 0 });
    expect(paragraphUnits('老周（低声）：看是什么书。')).toEqual({ dialogue: 5, action: 0 });
    expect(paragraphUnits('林晓：我（顿了顿）外婆留下的。')).toEqual({ dialogue: 6, action: 0 });
  });

  test('labels, long descriptions and 「写着」 are action, not speech', () => {
    expect(paragraphUnits('时间：傍晚').dialogue).toBe(0);
    expect(paragraphUnits('人物：林晓、老周').dialogue).toBe(0);
    expect(paragraphUnits('他看了一眼电子屏：00:02。').dialogue).toBe(0);
    expect(paragraphUnits('黑板上写着：明天考试').dialogue).toBe(0);
    expect(paragraphUnits('门铃响了一声。林晓推门进来。')).toEqual({ dialogue: 0, action: 12 });
  });

  test('Fountain blocks: a cue line (forced with @, or in capitals), then the lines spoken', () => {
    expect(paragraphUnits('@阿哲\n(小声)\n妈，我赶上了。')).toEqual({ dialogue: 5, action: 0 });
    expect(paragraphUnits('JOE (V.O.)\nI made it.')).toEqual({ dialogue: 4.5, action: 0 });
    // an action paragraph whose first line ends in punctuation is not a cue
    expect(paragraphUnits('门开了。\n他走进来。').dialogue).toBe(0);
  });
});

describe('scene tags', () => {
  test('内 / 外 from the heading', () => {
    expect(sceneIntExt('1. 内景 旧书店 日')).toBe('int');
    expect(sceneIntExt('场2 夜 外 高速公路服务区')).toBe('ext');
    expect(sceneIntExt('EXT. 地铁站 出口 - NIGHT')).toBe('ext');
    expect(sceneIntExt('INT./EXT. 车内 - 日')).toBe('int_ext');
    expect(sceneIntExt('3 内外 走廊与操场 日')).toBe('int_ext');
    expect(sceneIntExt('4 外婆家 日')).toBeNull();
    expect(sceneIntExt('5 门外 夜')).toBeNull();
  });
});

describe('estimateScript', () => {
  test('the sample script: about 1:48 and 0:37, the range around it, stable numbers', () => {
    const { parsed, scenes } = load('01-bookshop.txt', 'txt');
    const est = estimateScript(parsed.paragraphs, scenes, { target_seconds: 120 });
    expect(ScriptEstimate.safeParse(est).success).toBe(true);
    expect(est.scenes.map((s) => s.seconds)).toEqual([108, 37]);
    expect(est.seconds).toBe(145);
    expect(est.low_seconds).toBe(109);
    expect(est.high_seconds).toBe(189);
    expect(est.target_seconds).toBe(120);
    expect(est.scenes[0]).toMatchObject({ int_ext: 'int', time_label: '日', shots_seconds: null });
    expect(est.scenes[0]!.dialogue_units).toBeGreaterThan(60);
  });

  test('shot seconds per scene are summed in; a scene without text is 0', () => {
    const { parsed, scenes } = load('02-last-train.fountain', 'fountain');
    const est = estimateScript(parsed.paragraphs, scenes, { shotSeconds: new Map([[scenes[0]!.id, 12.25]]) });
    expect(est.scenes[0]!.shots_seconds).toBe(12.3);
    expect(est.scenes[1]!.shots_seconds).toBeNull();
    expect(est.scenes[2]!.dialogue_units).toBeGreaterThan(0);
    const empty = estimateScript([{ id: 'p-001', text: '1 内景 教室 日', is_heading: true }], [{ id: scenes[0]!.id, display_no: '1', heading: '内景 教室 日', paragraph_ids: ['p-001'], time_label: '日' }]);
    expect(empty.seconds).toBe(0);
  });
});
