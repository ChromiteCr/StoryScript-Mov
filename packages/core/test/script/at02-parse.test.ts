import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ParsedScript, ScriptFormat } from '@storyscript/contracts';
import { detectHeading, paragraphId, parseScript, parseSceneNumeral } from '../../src/index.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'scripts');

interface ExpectedScene {
  display_no: string;
  heading_contains: string;
  time_label: string | null;
}
const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
  scripts: { file: string; format: string; scenes: ExpectedScene[] }[];
};

describe('AT-02 rule-based scene split matches the frozen checklist', () => {
  for (const script of expected.scripts) {
    test(script.file, () => {
      const text = readFileSync(join(FIXTURES, script.file), 'utf8');
      const parsed = parseScript(text, ScriptFormat.parse(script.format), []);
      expect(ParsedScript.parse(parsed)).toBeTruthy();
      expect(parsed.scenes.map((s) => s.display_no)).toEqual(script.scenes.map((s) => s.display_no));
      script.scenes.forEach((e, i) => {
        const got = parsed.scenes[i]!;
        expect(got.heading, `scene ${e.display_no}`).toContain(e.heading_contains);
        expect(got.time_label, `scene ${e.display_no}`).toBe(e.time_label);
      });
      // every scene starts with its heading paragraph, which is flagged
      for (const s of parsed.scenes) {
        const head = parsed.paragraphs.find((p) => p.id === s.paragraph_ids[0])!;
        expect(head.is_heading).toBe(true);
      }
      expect(parsed.detected_heading_lines).toHaveLength(script.scenes.length);
    });
  }
});

describe('AT-02 paragraphs and anchors', () => {
  const text = readFileSync(join(FIXTURES, '01-bookshop.txt'), 'utf8');
  const parsed = parseScript(text, 'txt', []);

  test('one anchor per non-empty paragraph, p-001 …, with the first line number', () => {
    expect(parsed.paragraphs).toHaveLength(25);
    expect(parsed.paragraphs[0]).toEqual({ id: 'p-001', text: '旧书（原创样例剧本，MIT 许可）', line: 1, is_heading: false, scene_idx: null });
    expect(parsed.paragraphs[1]).toMatchObject({ id: 'p-002', text: '1. 内景 旧书店 日', line: 3, is_heading: true, scene_idx: 0 });
    expect(parsed.paragraphs.find((p) => p.text === '老周：看是什么书。')).toMatchObject({ id: 'p-008', line: 15, scene_idx: 0 });
    expect(parsed.paragraphs.at(-1)).toMatchObject({ id: 'p-025', line: 49, scene_idx: 1 });
  });

  test('scene heading strips the number; location label is derived', () => {
    expect(parsed.scenes[0]).toMatchObject({ display_no: '1', heading: '内景 旧书店 日', time_label: '日', location_label: '旧书店' });
    expect(parsed.scenes[1]).toMatchObject({ display_no: '2', heading: '内景 旧书店后屋 日', location_label: '旧书店后屋' });
    expect(parsed.scenes[0]!.paragraph_ids[0]).toBe('p-002');
    expect(parsed.scenes[0]!.paragraph_ids.at(-1)).toBe('p-019');
    expect(parsed.scenes[1]!.paragraph_ids).toEqual(['p-020', 'p-021', 'p-022', 'p-023', 'p-024', 'p-025']);
  });

  test('ids grow past three digits', () => {
    expect(paragraphId(7)).toBe('p-007');
    expect(paragraphId(1234)).toBe('p-1234');
    const many = Array.from({ length: 1001 }, (_, i) => `段落${i}`).join('\n\n');
    const p = parseScript(many, 'txt', []).paragraphs;
    expect(p.at(-1)!.id).toBe('p-1001');
  });

  test('CRLF input parses the same as LF', () => {
    const crlf = parseScript(text.replace(/\n/g, '\r\n'), 'txt', []);
    expect(crlf).toEqual(parsed);
  });
});

describe('AT-02 Fountain', () => {
  const text = readFileSync(join(FIXTURES, '02-last-train.fountain'), 'utf8');
  const parsed = parseScript(text, 'fountain', []);

  test('title page does not produce a scene', () => {
    expect(parsed.paragraphs[0]).toMatchObject({ text: 'Title: 末班\nCredit: 原创样例剧本（MIT 许可）', scene_idx: null, is_heading: false });
    expect(parsed.scenes).toHaveLength(3);
    expect(parsed.detected_heading_lines).toEqual([4, 12, 18]);
  });

  test('forced character @阿哲 + parenthetical + dialogue form one paragraph', () => {
    const last = parsed.paragraphs.at(-1)!;
    expect(last.text).toBe('@阿哲\n(小声)\n妈，我赶上了。');
    expect(last.line).toBe(26);
    expect(last.scene_idx).toBe(2);
  });

  test('INT./EXT. headings keep their prefix; time and location come from "- NIGHT"', () => {
    expect(parsed.scenes[0]).toMatchObject({ heading: 'INT. 地铁站 站台 - NIGHT', time_label: 'NIGHT', location_label: '地铁站 站台' });
    expect(parsed.scenes[1]).toMatchObject({ display_no: '2', heading: 'EXT. 地铁站 出口 - NIGHT' });
  });

  test('scene numbers, forced headings and the other Fountain prefixes', () => {
    expect(detectHeading('INT. HOUSE - DAY #12A#')).toMatchObject({ display_no: '12A', heading: 'INT. HOUSE - DAY', time_label: 'DAY' });
    expect(detectHeading('.SNIPER SCOPE POV')).toMatchObject({ heading: 'SNIPER SCOPE POV', display_no: null });
    expect(detectHeading('...')).toBeNull();
    expect(detectHeading('...他停住了')).toBeNull();
    for (const h of ['int. kitchen - night', 'EXT HOUSE', 'EST. CITY - DAWN', 'INT./EXT. CAR - DAY', 'INT/EXT CAR', 'I/E CAR - NIGHT']) {
      expect(detectHeading(h), h).not.toBeNull();
    }
    expect(detectHeading('INTERIOR DESIGN')).toBeNull();
    // forced "." only for fountain / paste
    expect(parseScript('.旧书店\n\n文字', 'txt', []).scenes).toHaveLength(0);
    expect(parseScript('.旧书店\n\n文字', 'fountain', []).scenes).toHaveLength(1);
  });
});

describe('AT-02 Chinese heading rules', () => {
  test.each([
    ['1. 内景 旧书店 日', '1', '内景 旧书店 日', '日', '旧书店'],
    ['1、内景 旧书店 日', '1', '内景 旧书店 日', '日', '旧书店'],
    ['12 外 街道 夜', '12', '外 街道 夜', '夜', '街道'],
    ['场1 夜 内 医院走廊', '1', '夜 内 医院走廊', '夜', '医院走廊'],
    ['场 3：日 外 河边', '3', '日 外 河边', '日', '河边'],
    ['第一场', '1', '第一场', null, null],
    ['第12场 内景 客厅 傍晚', '12', '内景 客厅 傍晚', '傍晚', '客厅'],
    ['第二十三场：外景 天台 清晨', '23', '外景 天台 清晨', '清晨', '天台'],
    ['内景 咖啡馆 日', null, '内景 咖啡馆 日', '日', '咖啡馆'],
    ['外 高速公路服务区 黄昏', null, '外 高速公路服务区 黄昏', '黄昏', '高速公路服务区'],
    ['内景·旧书店·夜', null, '内景·旧书店·夜', '夜', '旧书店'],
    ['## 3. 内景 客厅 夜', '3', '内景 客厅 夜', '夜', '客厅'],
  ])('%s', (line, no, heading, time, loc) => {
    const { explicit: _explicit, ...info } = detectHeading(line) ?? { explicit: false };
    expect(info).toEqual({ display_no: no, heading, time_label: time, location_label: loc });
  });

  test.each([
    '旧书（原创样例剧本，MIT 许可）',
    '两地（原创样例剧本，MIT 许可）',
    '# 两地（原创样例剧本，MIT 许可）',
    '老周：看是什么书。',
    '他看了一眼电子屏：00:02。',
    '23:40',
    '1. 他推门进来。',
    '门外，夜色很深。',
    '林晓：请问……这里还收旧书吗？',
  ])('not a heading: %s', (line) => {
    expect(detectHeading(line)).toBeNull();
  });

  test('Chinese numerals', () => {
    expect(parseSceneNumeral('十二')).toBe(12);
    expect(parseSceneNumeral('二十')).toBe(20);
    expect(parseSceneNumeral('一百零五')).toBe(105);
    expect(parseSceneNumeral('１２')).toBe(12);
    expect(parseSceneNumeral('甲')).toBeNull();
  });

  test('a heading glued to the following action still stands alone', () => {
    const parsed = parseScript('1. 内景 书店 日\n他走进来。\n她抬头。', 'txt', []);
    expect(parsed.paragraphs.map((p) => p.text)).toEqual(['1. 内景 书店 日', '他走进来。\n她抬头。']);
    expect(parsed.scenes[0]!.paragraph_ids).toEqual(['p-001', 'p-002']);
  });

  test('unnumbered headings are numbered in order of appearance', () => {
    const parsed = parseScript('内景 书店 日\n\n甲\n\n外景 街道 夜\n\n乙', 'txt', []);
    expect(parsed.scenes.map((s) => s.display_no)).toEqual(['1', '2']);
  });
});

describe('AT-02 heading overrides', () => {
  const text = '序\n\n1. 内景 书店 日\n\n他进门。\n\n回忆\n\n她笑了。';

  test('a line can be forced to be a heading', () => {
    const parsed = parseScript(text, 'txt', [{ line: 7, is_heading: true }]);
    expect(parsed.scenes.map((s) => s.heading)).toEqual(['内景 书店 日', '回忆']);
    expect(parsed.scenes[1]!.display_no).toBe('2');
    expect(parsed.detected_heading_lines).toEqual([3]);
  });

  test('a detected heading can be cancelled', () => {
    const parsed = parseScript(text, 'txt', [{ line: 3, is_heading: false }]);
    expect(parsed.scenes).toHaveLength(0);
    expect(parsed.paragraphs.every((p) => p.scene_idx === null && !p.is_heading)).toBe(true);
    expect(parsed.detected_heading_lines).toEqual([3]);
  });

  test('forcing a line inside a block splits the block', () => {
    const parsed = parseScript('甲\n乙场\n丙', 'txt', [{ line: 2, is_heading: true }]);
    expect(parsed.paragraphs.map((p) => p.text)).toEqual(['甲', '乙场', '丙']);
    expect(parsed.scenes[0]).toMatchObject({ heading: '乙场', paragraph_ids: ['p-002', 'p-003'] });
  });

  test('overrides on blank or missing lines are ignored', () => {
    const base = parseScript(text, 'txt', []);
    expect(parseScript(text, 'txt', [{ line: 2, is_heading: true }, { line: 999, is_heading: true }])).toEqual(base);
  });
});
