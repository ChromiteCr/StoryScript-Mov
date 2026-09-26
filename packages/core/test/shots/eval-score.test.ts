import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ShotFields } from '@storyscript/contracts';
import {
  breakdownSummary,
  parseScript,
  scoreCharacters,
  scoreScenes,
  scoreSceneBreakdown,
  shotSatisfies,
  summarize,
  type ExpectedChecklist,
} from '../../src/index.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'scripts');
const checklist = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as ExpectedChecklist;
const bookshop = checklist.scripts[0]!;

function shot(over: Partial<ShotFields>): ShotFields {
  return {
    template: null,
    shot_size: 'MS',
    angle: 'eye',
    lens: 'normal',
    focal_mm: null,
    movement: 'static',
    subjects: [],
    props: [],
    env: null,
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 3,
    narrative_purpose: 'x',
    action: 'x',
    dialogue_quote: null,
    source: { paragraph_id: 'p-003', quote: '午后的光' },
    assumptions: [],
    questions: [],
    ...over,
  };
}

describe('eval scoring (docs/eval, fixtures/scripts/expected.json)', () => {
  test('scene checks pass on the rule-based split and fail on a wrong one', () => {
    const parsed = parseScript(readFileSync(join(FIXTURES, bookshop.file), 'utf8'), 'txt', []);
    expect(summarize(scoreScenes(bookshop, parsed))).toEqual({ total: 3, passed: 3, rate: 1 });
    const wrong = { scenes: [{ ...parsed.scenes[0]!, time_label: '夜' }] };
    const r = scoreScenes(bookshop, wrong);
    expect(r.map((c) => c.pass)).toEqual([false, false, false]);
  });

  test('characters: name + alias, and mentioned-only people must be absent', () => {
    const good = scoreCharacters(bookshop, {
      characters: [
        { name: '周明远', aliases: ['老周'] },
        { name: '林晓', aliases: [] },
      ],
      locations: [],
      props: [],
    });
    expect(good.every((c) => c.pass)).toBe(true);
    const bad = scoreCharacters(bookshop, {
      characters: [
        { name: '周明远', aliases: [] },
        { name: '沈映秋', aliases: [] },
      ],
      locations: [],
      props: [],
    });
    expect(bad.map((c) => [c.id.split('#')[1], c.pass])).toEqual([
      ['char-周明远', false], // alias 老周 missing
      ['char-林晓', false],
      ['absent-沈映秋', false],
    ]);
    expect(scoreCharacters(bookshop, null).filter((c) => c.pass).map((c) => c.kind)).toEqual(['absent']);
  });

  test('must_include criteria are all required on the same shot', () => {
    const item = bookshop.breakdown[0]!.must_include.find((m) => m.id === '1c')!; // INSERT/CU/ECU + quote
    expect(shotSatisfies(shot({ shot_size: 'INSERT', source: { paragraph_id: 'p-009', quote: '一本蓝色封面的日记本' } }), item)).toBe(true);
    expect(shotSatisfies(shot({ shot_size: 'MS', source: { paragraph_id: 'p-009', quote: '一本蓝色封面的日记本' } }), item)).toBe(false);
    expect(shotSatisfies(shot({ shot_size: 'CU', source: { paragraph_id: 'p-010', quote: '老周的手停住了' } }), item)).toBe(false);
    const dialogue = checklist.scripts[1]!.breakdown[2]!.must_include.find((m) => m.id === 't3b')!;
    expect(shotSatisfies(shot({ shot_size: 'MCU', dialogue_quote: '妈，我赶上了。' }), dialogue)).toBe(true);
    expect(shotSatisfies(shot({ shot_size: 'MCU', dialogue_quote: null }), dialogue)).toBe(false);
    const motion = checklist.scripts[1]!.breakdown[0]!.must_include.find((m) => m.id === 't1a')!;
    expect(shotSatisfies(shot({ subject_motion: 'toward', source: { paragraph_id: 'p-004', quote: '从楼梯口冲下来' } }), motion)).toBe(true);
    expect(shotSatisfies(shot({ subject_motion: 'none', source: { paragraph_id: 'p-004', quote: '从楼梯口冲下来' } }), motion)).toBe(false);
  });

  test('scene score: count range, quote locatability, off-roster aliases', () => {
    const expected = bookshop.breakdown[1]!; // scene 2: 2..8 shots, 2a, 2b
    const paragraphs = [
      { id: 'p-021', text: '老周领着林晓穿过一道布帘。后屋堆满纸箱，墙上挂着一张褪色的合影。' },
      { id: 'p-025', text: '林晓转头看他。老周避开她的目光，去整理一只并不乱的纸箱。' },
    ];
    const shots = [
      shot({ shot_size: 'INSERT', source: { paragraph_id: 'p-021', quote: '墙上挂着一张褪色的合影' } }),
      shot({
        subjects: [{ alias: 'c9', screen: null, depth: null, facing: null, pose: null }],
        pov_owner: 'c8',
        source: { paragraph_id: 'p-025', quote: '老周避开她的目光' },
      }),
      shot({ source: { paragraph_id: 'p-025', quote: '完全编造的一句话，不在剧本里' } }),
    ];
    const s = scoreSceneBreakdown(bookshop.file, expected, shots, { paragraphs, aliases: ['c1', 'c2'] });
    expect(s.checks.map((c) => [c.kind, c.pass])).toEqual([
      ['shot_count', true],
      ['must_include', true],
      ['must_include', true],
    ]);
    expect(s.quotes_located).toBe(2);
    expect(s.quotes_total).toBe(3);
    expect(s.off_roster).toBe(2);

    const tooFew = scoreSceneBreakdown(bookshop.file, expected, [shots[1]!], { paragraphs, aliases: ['c1', 'c2'] });
    expect(tooFew.checks.map((c) => c.pass)).toEqual([false, false, true]);
    expect(breakdownSummary([s, tooFew])).toEqual({ total: 6, passed: 4, rate: 4 / 6 });
    expect(summarize([])).toEqual({ total: 0, passed: 0, rate: 0 });
  });
});
