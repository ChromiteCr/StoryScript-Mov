import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { BreakdownOutput, CameraAngle, Movement, ShotSize, ShotSubject } from '@storyscript/contracts';
import { analyzeVariety, VARIETY_RULES, VARIETY_SEVERE, varietyHints, type VarietyShot } from '../../src/index.ts';

/** S4c 镜头变化检查: each code at its threshold, the score and the severe rules. */

const person = (over: Partial<ShotSubject> = {}): ShotSubject => ({ alias: 'c1', screen: 'L', depth: 'mg', facing: '3q_right', pose: 'stand', ...over });

function shot(size: ShotSize, angle: CameraAngle = 'eye', movement: Movement = 'static', over: Partial<VarietyShot> = {}): VarietyShot {
  return { shot_size: size, angle, movement, subjects: [person()], subject_motion: 'none', action: '林川看着窗外', ...over };
}

/** a varied passage none of the rules complain about */
const VARIED: VarietyShot[] = [
  shot('WS', 'high', 'crane'),
  shot('MS', 'eye', 'track', { subjects: [person({ pose: 'walk' })], subject_motion: 'l2r', action: '林川走进教室' }),
  shot('MCU'),
  shot('MCU', 'eye', 'static', { subjects: [person({ alias: 'c2', screen: 'R' })] }),
  shot('INSERT', 'overhead', 'static', { subjects: [] }),
  shot('CU', 'low', 'push_in'),
];

const codes = (shots: VarietyShot[]) => analyzeVariety(shots).issues.map((x) => (x.item === null ? x.code : `${x.code}@${x.item}`));

describe('analyzeVariety', () => {
  test('a varied passage: no issues, high score, not severe', () => {
    const r = analyzeVariety(VARIED);
    expect(r.issues).toEqual([]);
    expect(r.severe).toBe(false);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.stats).toMatchObject({ shots: 6, distinct_sizes: 5, dominant_size: 'MCU', longest_run: 2, has_wide: true, people_shots: 5, off_center_shots: 5, motion_unset: 0 });
  });

  test('empty and tiny passages', () => {
    expect(analyzeVariety([])).toMatchObject({ issues: [], score: 1, severe: false });
    expect(analyzeVariety([shot('MCU')]).issues).toEqual([]);
  });

  test('every issue is a warning in DraftIssue shape', () => {
    const r = analyzeVariety(Array.from({ length: 8 }, () => shot('MCU', 'eye', 'static', { subjects: [person({ screen: 'C' })], action: '林川转身离开' })));
    expect(r.issues.length).toBeGreaterThan(0);
    for (const x of r.issues) {
      expect(x.level).toBe('warning');
      expect(x.code).toMatch(/^VARIETY_/);
      expect(x.message).toMatch(/[：:]/); // says what is monotone, then what to try
    }
  });

  test('SIZE_RUN: three in a row with the same size, angle and movement, one issue per run at its first shot', () => {
    const three = [shot('WS', 'high', 'pan'), shot('MCU'), shot('MCU'), shot('MCU'), shot('CU', 'low', 'push_in')];
    expect(codes(three)).toContain('VARIETY_SIZE_RUN@1');
    expect(analyzeVariety(three).issues.find((x) => x.code === 'VARIETY_SIZE_RUN')!.message).toBe(
      '第 2–4 个镜头都是近景、平视、固定：中间换一个景别或角度，或者让机位动起来',
    );
    const two = [shot('WS', 'high', 'pan'), shot('MCU'), shot('MCU'), shot('MCU', 'eye', 'push_in'), shot('CU', 'low', 'push_in')];
    expect(codes(two)).not.toContain('VARIETY_SIZE_RUN@1');
    expect(VARIETY_RULES.run).toBe(3);
  });

  test('SIZE_DOMINANT: from 5 shots, one size over 60%', () => {
    const over = [shot('WS', 'high', 'pan'), shot('MCU', 'low'), shot('MCU', 'eye', 'track'), shot('MCU', 'high'), shot('MCU', 'eye', 'push_in')];
    expect(codes(over)).toContain('VARIETY_SIZE_DOMINANT');
    expect(analyzeVariety(over).issues.find((x) => x.code === 'VARIETY_SIZE_DOMINANT')!.message).toContain('5 个镜头里有 4 个近景（80%）');
    const at60 = [shot('WS', 'high', 'pan'), shot('CU', 'low'), shot('MCU', 'eye', 'track'), shot('MCU', 'high'), shot('MCU', 'eye', 'push_in')];
    expect(codes(at60)).not.toContain('VARIETY_SIZE_DOMINANT');
    expect(codes(over.slice(1))).not.toContain('VARIETY_SIZE_DOMINANT'); // 4 shots: too few to say
  });

  test('FEW_SIZES: from 4 shots, fewer than 3 sizes', () => {
    const two = [shot('WS', 'high', 'pan'), shot('MCU', 'low'), shot('WS', 'eye', 'track'), shot('MCU', 'high', 'push_in')];
    expect(codes(two)).toContain('VARIETY_FEW_SIZES');
    expect(analyzeVariety(two).issues.find((x) => x.code === 'VARIETY_FEW_SIZES')!.message).toMatch(/^景别只有远景、近景：/);
    expect(codes([...two.slice(0, 3), shot('CU', 'high', 'push_in')])).not.toContain('VARIETY_FEW_SIZES');
    expect(codes(two.slice(0, 3))).not.toContain('VARIETY_FEW_SIZES');
  });

  test('NO_WIDE: from 4 shots, no EWS, WS, FS or MLS', () => {
    const close = [shot('MS', 'high', 'pan'), shot('MCU', 'low'), shot('CU', 'eye', 'track'), shot('INSERT', 'high', 'push_in')];
    expect(codes(close)).toContain('VARIETY_NO_WIDE');
    for (const wide of ['EWS', 'WS', 'FS', 'MLS'] as const) expect(codes([...close.slice(0, 3), shot(wide, 'high', 'push_in')])).not.toContain('VARIETY_NO_WIDE');
    expect(codes(close.slice(0, 3))).not.toContain('VARIETY_NO_WIDE');
  });

  test('ALL_EYE: from 6 shots, every one eye level', () => {
    const eye = (['WS', 'MS', 'MCU', 'CU', 'MS', 'INSERT'] as const).map((s, i) => shot(s, 'eye', i % 2 ? 'track' : 'push_in'));
    expect(codes(eye)).toContain('VARIETY_ALL_EYE');
    expect(codes(eye.slice(0, 5))).not.toContain('VARIETY_ALL_EYE');
    expect(codes([...eye.slice(0, 5), shot('INSERT', 'high', 'push_in')])).not.toContain('VARIETY_ALL_EYE');
  });

  test('MOSTLY_STATIC: from 4 shots, more than 70% static', () => {
    const still = [shot('WS', 'high'), shot('MS', 'low'), shot('CU', 'eye'), shot('MCU', 'high', 'push_in')];
    expect(codes(still)).toContain('VARIETY_MOSTLY_STATIC');
    expect(analyzeVariety(still).issues.find((x) => x.code === 'VARIETY_MOSTLY_STATIC')!.message).toContain('4 个镜头里有 3 个固定机位');
    const seventy = (['WS', 'MS', 'MCU', 'CU', 'MS', 'MCU', 'CU', 'WS', 'MS', 'INSERT'] as const).map((s, i) => shot(s, i % 2 ? 'low' : 'high', i < 7 ? 'static' : 'track'));
    expect(analyzeVariety(seventy).stats.static_share).toBe(0.7);
    expect(codes(seventy)).not.toContain('VARIETY_MOSTLY_STATIC');
  });

  test('ALL_CENTER: 3 or more shots with people, all centred or unplaced', () => {
    const centred = VARIED.map((s) => ({ ...s, subjects: s.subjects.map((p, i) => ({ ...p, screen: i % 2 ? null : ('C' as const) })) }));
    expect(codes(centred)).toContain('VARIETY_ALL_CENTER');
    expect(codes(centred.slice(3))).not.toContain('VARIETY_ALL_CENTER'); // CU only + an INSERT: 2 shots with people
    expect(codes(VARIED)).not.toContain('VARIETY_ALL_CENTER');
  });

  test('MOTION_UNSET: the action moves, the people stand still', () => {
    const moving = (action: string, over: Partial<VarietyShot> = {}) => codes([shot('MS', 'eye', 'static', { action, ...over })]);
    for (const action of ['林川走进教室', '她跑向门口', '两人追到天台', '他冲出门', '林晓推门进来', '老周转身', '林川离开了']) {
      expect(moving(action), action).toEqual(['VARIETY_MOTION_UNSET@0']);
    }
    expect(analyzeVariety([shot('MS', 'eye', 'static', { action: '林川走进教室' })]).issues[0]!.message).toBe(
      '动作里有「走」，但人物站着、也没有人物运动：把姿势改成走或跑，或填写人物运动方向',
    );
    expect(moving('林川走进教室', { subjects: [person({ pose: 'walk' })] })).toEqual([]);
    expect(moving('林川走进教室', { subjects: [person({ pose: null })], subject_motion: 'toward' })).toEqual([]);
    expect(moving('林川走进教室', { subjects: [] })).toEqual([]);
    expect(moving('林川走进教室', { subjects: [person({ pose: null })] })).toEqual(['VARIETY_MOTION_UNSET@0']);
    for (const still of ['走廊尽头站着一个人', '林晓追问日记的来历', '两人的冲突升级', '老周看着她']) expect(moving(still), still).toEqual([]);
  });

  test('score: 0–1 with two decimals, lower for monotone passages', () => {
    const flat = Array.from({ length: 6 }, () => shot('MCU', 'eye', 'static', { subjects: [person({ screen: 'C' })] }));
    const r = analyzeVariety(flat);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThan(0.2);
    expect(Math.round(r.score * 100) / 100).toBe(r.score);
    expect(analyzeVariety(VARIED).score).toBeGreaterThan(r.score);
    expect(analyzeVariety(VARIED)).toEqual(analyzeVariety(VARIED.map((s) => ({ ...s }))));
  });
});

describe('severe', () => {
  test('rules', () => {
    expect(VARIETY_SEVERE).toEqual({ min_shots: 4, run: 4, codes: 2 });
  });

  test('rule 1: a run of four identical framings, even when nothing else is wrong', () => {
    const run4 = [shot('WS', 'eye', 'static'), shot('CU', 'low', 'pan'), ...Array.from({ length: 4 }, () => shot('MS', 'eye', 'track')), shot('MCU', 'high', 'push_in'), shot('INSERT', 'eye', 'static')];
    const r = analyzeVariety(run4);
    expect(r.issues.map((x) => x.code)).toEqual(['VARIETY_SIZE_RUN']);
    expect(r.stats.longest_run).toBe(4);
    expect(r.severe).toBe(true);
    const run3 = run4.filter((_, i) => i !== 2);
    expect(analyzeVariety(run3).issues.map((x) => x.code)).toEqual(['VARIETY_SIZE_RUN']);
    expect(analyzeVariety(run3).severe).toBe(false);
  });

  test('rule 2: two different framing codes', () => {
    const flatEye = (['WS', 'MS', 'MCU', 'CU', 'MS', 'MCU'] as const).map((s) => shot(s, 'eye', 'static'));
    const r = analyzeVariety(flatEye);
    expect(r.issues.map((x) => x.code)).toEqual(['VARIETY_ALL_EYE', 'VARIETY_MOSTLY_STATIC']);
    expect(r.stats.longest_run).toBe(1);
    expect(r.severe).toBe(true);
  });

  test('ALL_CENTER and MOTION_UNSET do not count; under 4 shots is never severe', () => {
    const r = analyzeVariety(VARIED.map((s) => ({ ...s, subjects: s.subjects.map((p) => ({ ...p, screen: 'C' as const, pose: 'stand' as const })), subject_motion: 'none', action: '林川走过来' })));
    expect(new Set(r.issues.map((x) => x.code))).toEqual(new Set(['VARIETY_ALL_CENTER', 'VARIETY_MOTION_UNSET']));
    expect(r.severe).toBe(false);
    const three = Array.from({ length: 3 }, () => shot('MCU'));
    expect(analyzeVariety(three).issues.map((x) => x.code)).toEqual(['VARIETY_SIZE_RUN']);
    expect(analyzeVariety(three).severe).toBe(false);
  });

  test("the reported 12-shot project (9 eye, 9 static, 7 MCU, nobody moving) is severe", () => {
    const c = (screen: 'C' | null, alias = 'c1') => [person({ alias, screen, facing: 'camera' })];
    const twelve: VarietyShot[] = [
      shot('MS', 'eye', 'static', { subjects: [...c('C'), ...c('C', 'c2')], action: '两人在天台上对峙' }),
      shot('MCU', 'eye', 'static', { subjects: c('C') }),
      shot('MCU', 'eye', 'static', { subjects: c('C', 'c2') }),
      shot('MCU', 'eye', 'static', { subjects: c('C') }),
      shot('MCU', 'eye', 'static', { subjects: c(null, 'c2') }),
      shot('CU', 'low', 'static', { subjects: c('C') }),
      shot('MCU', 'eye', 'static', { subjects: c('C', 'c2') }),
      shot('MCU', 'high', 'push_in', { subjects: c('C') }),
      shot('MS', 'eye', 'static', { subjects: c('C'), action: '林川转身离开' }),
      shot('MCU', 'eye', 'static', { subjects: c(null, 'c2') }),
      shot('WS', 'eye', 'pan', { subjects: [...c('C'), ...c('C', 'c2')] }),
      shot('CU', 'low', 'handheld', { subjects: c('C', 'c2') }),
    ];
    const r = analyzeVariety(twelve);
    expect(r.stats).toMatchObject({ shots: 12, eye_share: 0.75, static_share: 0.75, dominant_size: 'MCU', longest_run: 4, off_center_shots: 0, motion_unset: 1 });
    expect(r.stats.sizes.MCU).toBe(7);
    expect(r.issues.map((x) => (x.item === null ? x.code : `${x.code}@${x.item}`))).toEqual([
      'VARIETY_SIZE_RUN@1',
      'VARIETY_MOSTLY_STATIC',
      'VARIETY_ALL_CENTER',
      'VARIETY_MOTION_UNSET@8',
    ]);
    expect(r.severe).toBe(true);
    expect(r.score).toBe(0.67);
    expect(varietyHints(r)).toEqual([
      '第 2–5 个镜头都是近景、平视、固定：中间换一个景别或角度，或者让机位动起来',
      '12 个镜头里有 9 个固定机位：人物走动时跟拍或摇，紧张升级时慢慢推近',
      '有人物的镜头都把人放在画面正中或没填位置：单人镜头放到画左或画右的三分线上，视线一侧留空',
      '第 9 个镜头：动作里有「转身」，但人物站着、也没有人物运动：把姿势改成走或跑，或填写人物运动方向',
    ]);
  });

  test('the bookshop recordings (demo) are not severe: one more round would not be asked', () => {
    const replay = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'replay');
    for (const [file, expected] of [
      ['01-bookshop.breakdown-v1.scene-1.json', ['VARIETY_MOSTLY_STATIC']],
      ['01-bookshop.breakdown-v1.scene-2.json', ['VARIETY_NO_WIDE']],
    ] as const) {
      const out = (JSON.parse(readFileSync(join(replay, file), 'utf8')) as { output_json: BreakdownOutput }).output_json;
      const r = analyzeVariety(out.shots);
      expect(r.issues.map((x) => x.code), file).toEqual(expected);
      expect(r.severe, file).toBe(false);
    }
  });
});
