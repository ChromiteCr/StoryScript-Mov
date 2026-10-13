import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Movement, ShotGear, ShotTipsOutput, TIP_TEXT_MAX, type ShotFields, type ShotGear as Gear, type TimeOfDay } from '@storyscript/contracts';
import { shotFields, subject } from '../../src/board/fixtures/standard-shots.ts';
import { finalizeShotTips, flagFilmClaims, normalizeShotTipsJson, ruleTips, validateShotTips } from '../../src/index.ts';

/**
 * S5c 镜头拍摄提示 (core): the first guess from a shot's fields, the
 * normalisation of a model's answer (Chinese words for the enums, a string
 * where a list belongs), its checks (one item per shot, 2–3 short tips, a
 * common mistake, no film claims) and what is kept when the rounds run out.
 */

const REPLAY_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'replay');
const recording = (name: string) => (JSON.parse(readFileSync(join(REPLAY_DIR, name), 'utf8')) as { output_json: unknown }).output_json;

const people = (n: number) => Array.from({ length: n }, (_, i) => subject(`c${i + 1}`));
const guess = (p: Partial<ShotFields>, time?: TimeOfDay) => ruleTips(shotFields(p), time);
const refs = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

/** The order ruleTips adds gear in (S5c §3). */
const GEAR_ORDER: readonly Gear[] = ['tripod', 'gimbal', 'slider', 'drone', 'car_mount', 'external_mic', 'boom', 'light', 'reflector', 'phone_lens'];

describe('ruleTips: gear', () => {
  const BY_MOVE: Record<Movement, Gear[]> = {
    static: ['tripod'],
    push_in: ['slider'],
    pull_out: ['slider'],
    pan: [],
    tilt: [],
    track: ['gimbal'],
    crane: ['gimbal'],
    handheld: ['gimbal'],
    vehicle: ['car_mount'],
    orbit: ['gimbal'],
    aerial: ['drone'],
    dolly_zoom: ['slider'],
  };

  test('every movement in the contracts has its gear (a medium shot, nobody in it, by day)', () => {
    expect(Object.keys(BY_MOVE).sort()).toEqual([...Movement.options].sort());
    for (const m of Movement.options) expect(guess({ movement: m }).gear, m).toEqual(BY_MOVE[m]);
  });

  test('a line of dialogue brings an external mic; two people talking also a boom', () => {
    const line = '你还记得这家店吗？';
    expect(guess({ dialogue_quote: line, subjects: people(1) }).gear).toEqual(['tripod', 'external_mic']);
    expect(guess({ dialogue_quote: line, subjects: people(2) }).gear).toEqual(['tripod', 'external_mic', 'boom']);
    expect(guess({ dialogue_quote: line, subjects: people(3), movement: 'handheld' }).gear).toEqual(['gimbal', 'external_mic', 'boom']);
    // two people without a line: no sound gear
    expect(guess({ subjects: people(2) }).gear).toEqual(['tripod']);
    // a blank line is no line
    expect(guess({ dialogue_quote: '   ', subjects: people(2) }).gear).toEqual(['tripod']);
  });

  test('night brings a light; dusk and day do not', () => {
    expect(guess({}, 'night').gear).toEqual(['tripod', 'light']);
    expect(guess({}, 'dusk').gear).toEqual(['tripod']);
    expect(guess({}, 'day').gear).toEqual(['tripod']);
  });

  test('a face close-up by day brings a reflector; not at night, not without people, not in a wider shot', () => {
    for (const size of ['CU', 'MCU'] as const) {
      expect(guess({ shot_size: size, subjects: people(1) }).gear, size).toEqual(['tripod', 'reflector']);
      expect(guess({ shot_size: size, subjects: people(1) }, 'dusk').gear, size).toEqual(['tripod', 'reflector']);
      expect(guess({ shot_size: size, subjects: people(1) }, 'night').gear, size).toEqual(['tripod', 'light']);
      expect(guess({ shot_size: size }).gear, size).toEqual(['tripod']);
    }
    expect(guess({ shot_size: 'MS', subjects: people(1) }).gear).toEqual(['tripod']);
    expect(guess({ shot_size: 'WS', subjects: people(2) }).gear).toEqual(['tripod']);
  });

  test('an insert or an ECU brings a phone lens (macro)', () => {
    expect(guess({ shot_size: 'INSERT', props: ['book'] }).gear).toEqual(['tripod', 'phone_lens']);
    expect(guess({ shot_size: 'INSERT', subjects: people(1) }).gear).toEqual(['tripod', 'phone_lens']);
    expect(guess({ shot_size: 'ECU' }).gear).toEqual(['tripod', 'phone_lens']);
    expect(guess({ shot_size: 'ECU', subjects: people(1) }).gear).toEqual(['tripod', 'reflector', 'phone_lens']);
    expect(guess({ shot_size: 'ECU', subjects: people(1) }, 'night').gear).toEqual(['tripod', 'light', 'phone_lens']);
  });

  test('everything at once: in the documented order', () => {
    expect(guess({ movement: 'push_in', shot_size: 'ECU', subjects: people(2), dialogue_quote: '走吧' }, 'night').gear).toEqual([
      'slider',
      'external_mic',
      'boom',
      'light',
      'phone_lens',
    ]);
    expect(guess({ movement: 'static', shot_size: 'CU', subjects: people(2), dialogue_quote: '走吧' }).gear).toEqual([
      'tripod',
      'external_mic',
      'boom',
      'reflector',
    ]);
  });

  test('never a duplicate, always in order, always from the list (every movement × size × time × people × line)', () => {
    const sizes = ['EWS', 'WS', 'FS', 'MLS', 'MS', 'MCU', 'CU', 'ECU', 'INSERT'] as const;
    const times: TimeOfDay[] = ['day', 'dusk', 'night'];
    for (const movement of Movement.options) {
      for (const shot_size of sizes) {
        for (const time of times) {
          for (const n of [0, 1, 2, 4]) {
            for (const dialogue_quote of [null, '好']) {
              const { gear } = guess({ movement, shot_size, subjects: people(n), dialogue_quote }, time);
              const where = `${movement} ${shot_size} ${time} ${n} ${dialogue_quote}`;
              expect(new Set(gear).size, where).toBe(gear.length);
              expect([...gear].sort((a, b) => GEAR_ORDER.indexOf(a) - GEAR_ORDER.indexOf(b)), where).toEqual(gear);
              for (const g of gear) expect(ShotGear.options, where).toContain(g);
            }
          }
        }
      }
    }
  });

  test('the time of day defaults to day', () => {
    const f = shotFields({ shot_size: 'CU', subjects: people(1) });
    expect(ruleTips(f)).toEqual(ruleTips(f, 'day'));
    expect(ruleTips(f).gear).toContain('reflector');
    expect(ruleTips(f).gear).not.toContain('light');
  });
});

describe('ruleTips: difficulty', () => {
  test('per movement (a medium shot, nobody in it, by day)', () => {
    const BY_MOVE: Record<Movement, 'easy' | 'medium' | 'hard'> = {
      static: 'easy',
      push_in: 'medium',
      pull_out: 'medium',
      pan: 'medium',
      tilt: 'medium',
      track: 'medium',
      crane: 'hard',
      handheld: 'medium',
      vehicle: 'hard',
      orbit: 'hard',
      aerial: 'hard',
      dolly_zoom: 'hard',
    };
    for (const m of Movement.options) expect(guess({ movement: m }).difficulty, m).toBe(BY_MOVE[m]);
  });

  test('hard: a set piece, or four people or more', () => {
    expect(guess({ set_piece: true }).difficulty).toBe('hard');
    expect(guess({ subjects: people(4) }).difficulty).toBe('hard');
    expect(guess({ subjects: people(5) }).difficulty).toBe('hard');
    expect(guess({ subjects: people(3) }).difficulty).toBe('easy');
  });

  test('medium: a moving subject, night, two people talking', () => {
    for (const motion of ['l2r', 'r2l', 'toward', 'away'] as const) expect(guess({ subject_motion: motion, subjects: people(1) }).difficulty, motion).toBe('medium');
    expect(guess({}, 'night').difficulty).toBe('medium');
    expect(guess({}, 'dusk').difficulty).toBe('easy');
    expect(guess({ dialogue_quote: '好', subjects: people(2) }).difficulty).toBe('medium');
    expect(guess({ dialogue_quote: '好', subjects: people(1) }).difficulty).toBe('easy');
  });

  test('hard wins over medium; easy otherwise', () => {
    expect(guess({ movement: 'crane', subject_motion: 'l2r' }, 'night').difficulty).toBe('hard');
    expect(guess({ set_piece: true, movement: 'track' }).difficulty).toBe('hard');
    expect(guess({ subjects: people(4), dialogue_quote: '好' }).difficulty).toBe('hard');
    expect(guess({ shot_size: 'INSERT', props: ['cup'] }).difficulty).toBe('easy');
    expect(guess({ shot_size: 'CU', subjects: people(1) }).difficulty).toBe('easy');
  });
});

describe('normalizeShotTipsJson', () => {
  const ITEM = { ref: 's1', difficulty: 'easy', gear: ['tripod'], tips: ['机位放在桌边', '对焦锁在脸上'], mistake: '曝光跳动' };
  const one = (over: Record<string, unknown>) => (normalizeShotTipsJson({ shots: [{ ...ITEM, ...over }] }) as { shots: Record<string, unknown>[] }).shots[0]!;

  test('Chinese and English words for the difficulty', () => {
    for (const d of ['易', '简单', '容易', '低', 'easy', 'Easy', ' simple ', 'low']) expect(one({ difficulty: d }).difficulty, d).toBe('easy');
    for (const d of ['中', '中等', '一般', 'medium', 'Moderate', 'normal']) expect(one({ difficulty: d }).difficulty, d).toBe('medium');
    for (const d of ['难', '困难', '较难', '高', 'hard', 'HARD', 'difficult']) expect(one({ difficulty: d }).difficulty, d).toBe('hard');
    // level is another name for it
    expect(one({ difficulty: undefined, level: '难' }).difficulty).toBe('hard');
    // anything else is left for zod to refuse
    expect(one({ difficulty: '超难' }).difficulty).toBe('超难');
    expect(ShotTipsOutput.safeParse(normalizeShotTipsJson({ shots: [{ ...ITEM, difficulty: '超难' }] })).success).toBe(false);
  });

  test('Chinese words for the gear', () => {
    const cases: [string, Gear][] = [
      ['三脚架', 'tripod'],
      ['脚架', 'tripod'],
      ['手机支架', 'tripod'],
      ['稳定器', 'gimbal'],
      ['手持稳定器', 'gimbal'],
      ['云台', 'gimbal'],
      ['滑轨', 'slider'],
      ['轨道', 'slider'],
      ['外接麦', 'external_mic'],
      ['领夹麦', 'external_mic'],
      ['小蜜蜂', 'external_mic'],
      ['枪麦', 'external_mic'],
      ['收音杆', 'boom'],
      ['挑杆', 'boom'],
      ['补光灯', 'light'],
      ['LED灯', 'light'],
      ['反光板', 'reflector'],
      ['微距镜头', 'phone_lens'],
      ['广角镜头', 'phone_lens'],
      ['手机外接镜头', 'phone_lens'],
      ['无人机', 'drone'],
      ['航拍器', 'drone'],
      ['车载支架', 'car_mount'],
      ['吸盘支架', 'car_mount'],
    ];
    for (const [word, gear] of cases) expect(one({ gear: [word] }).gear, word).toEqual([gear]);
    // English spellings and the ids themselves
    expect(one({ gear: ['Tripod', 'Boom Pole', 'shotgun-mic', 'gimbal', 'car_mount'] }).gear).toEqual(['tripod', 'boom', 'external_mic', 'gimbal', 'car_mount']);
  });

  test('gear as one string is split on 、，, and spaces; equipment is another name for it', () => {
    expect(one({ gear: '三脚架、补光灯，反光板' }).gear).toEqual(['tripod', 'light', 'reflector']);
    expect(one({ gear: 'tripod, light' }).gear).toEqual(['tripod', 'light']);
    expect(one({ gear: undefined, equipment: ['稳定器'] }).gear).toEqual(['gimbal']);
  });

  test('gear not in the list is left for zod to refuse', () => {
    expect(one({ gear: ['摇臂'] }).gear).toEqual(['摇臂']);
    expect(ShotTipsOutput.safeParse(normalizeShotTipsJson({ shots: [{ ...ITEM, gear: ['三脚架', '摇臂'] }] })).success).toBe(false);
  });

  test('tips written as one string become a list (numbered lines, bullets, semicolons)', () => {
    expect(one({ tips: '1. 机位放在柜台另一侧\n2. 刷书脊的动作放慢\n3. 多拍三条' }).tips).toEqual(['机位放在柜台另一侧', '刷书脊的动作放慢', '多拍三条']);
    expect(one({ tips: '1、先对焦\n2）再锁曝光' }).tips).toEqual(['先对焦', '再锁曝光']);
    expect(one({ tips: '- 先对焦\n• 再锁曝光\n· 多拍两条' }).tips).toEqual(['先对焦', '再锁曝光', '多拍两条']);
    expect(one({ tips: '先对焦；再锁曝光;多拍两条' }).tips).toEqual(['先对焦', '再锁曝光', '多拍两条']);
    expect(one({ tips: '\n\n先对焦\n\n' }).tips).toEqual(['先对焦']);
    // advice is another name for it
    expect(one({ tips: undefined, advice: ['先对焦', '再锁曝光'] }).tips).toEqual(['先对焦', '再锁曝光']);
  });

  test('refs: numbers, S1, #1, 01', () => {
    expect(one({ ref: 1 }).ref).toBe('s1');
    expect(one({ ref: 12 }).ref).toBe('s12');
    expect(one({ ref: 'S1' }).ref).toBe('s1');
    expect(one({ ref: '#3' }).ref).toBe('s3');
    expect(one({ ref: ' s 02 ' }).ref).toBe('s2');
    expect(one({ ref: '7' }).ref).toBe('s7');
    expect(one({ ref: undefined, shot: 's4' }).ref).toBe('s4');
    expect(one({ ref: undefined, id: 5 }).ref).toBe('s5');
    // not a shot number: kept (and refused by validation)
    expect(one({ ref: ' 镜头一 ' }).ref).toBe('镜头一');
  });

  test('the mistake: common_mistake and pitfall are other names; a list gives its first line', () => {
    expect(one({ mistake: undefined, common_mistake: ' 跑焦 ' }).mistake).toBe('跑焦');
    expect(one({ mistake: undefined, pitfall: '穿帮' }).mistake).toBe('穿帮');
    expect(one({ mistake: ['跑焦', '穿帮'] }).mistake).toBe('跑焦');
    expect(one({ mistake: [] }).mistake).toBe('');
  });

  test('null and missing values become empty, so the checks (not zod) explain what is wrong', () => {
    const n = one({ gear: null, tips: null, mistake: null });
    expect(n).toMatchObject({ gear: [], tips: [], mistake: '' });
    const parsed = ShotTipsOutput.parse(normalizeShotTipsJson({ shots: [{ ref: 's1', difficulty: 'easy' }] }));
    expect(parsed.shots[0]).toEqual({ ref: 's1', difficulty: 'easy', gear: [], tips: [], mistake: '' });
    expect(validateShotTips(parsed, ['s1']).errors.length).toBeGreaterThan(0);
  });

  test('other shapes: items, a bare array, tips at the top; anything else is left alone', () => {
    const items = normalizeShotTipsJson({ items: [ITEM] }) as { shots: unknown[] };
    expect(items.shots).toHaveLength(1);
    expect((normalizeShotTipsJson([ITEM]) as { shots: unknown[] }).shots).toHaveLength(1);
    expect((normalizeShotTipsJson({ tips: [ITEM] }) as { shots: unknown[] }).shots).toHaveLength(1);
    expect(normalizeShotTipsJson('不是 JSON 对象')).toBe('不是 JSON 对象');
    expect(normalizeShotTipsJson({ answer: 1 })).toEqual({ answer: 1 });
    expect(normalizeShotTipsJson(null)).toBeNull();
  });

  test('a loosely written answer parses after normalisation', () => {
    const loose = {
      items: [
        { shot: 'S1', level: '简单', equipment: '三脚架、领夹麦', advice: '1. 机位和眼睛齐平\n2. 先录一条环境声', common_mistake: ['人低头太深'] },
        { ref: 2, difficulty: '难', gear: ['稳定器', '小蜜蜂'], tips: ['先空走两遍', '膝盖微弯'], mistake: '跟得太近' },
      ],
    };
    const out = ShotTipsOutput.parse(normalizeShotTipsJson(loose));
    expect(out.shots).toEqual([
      { ref: 's1', difficulty: 'easy', gear: ['tripod', 'external_mic'], tips: ['机位和眼睛齐平', '先录一条环境声'], mistake: '人低头太深' },
      { ref: 's2', difficulty: 'hard', gear: ['gimbal', 'external_mic'], tips: ['先空走两遍', '膝盖微弯'], mistake: '跟得太近' },
    ]);
    expect(validateShotTips(out, ['s1', 's2']).errors).toEqual([]);
  });
});

/** A clean answer for `n` shots. */
function clean(n: number): ShotTipsOutput {
  return {
    shots: refs(n).map((ref, i) => ({
      ref,
      difficulty: 'easy',
      gear: ['tripod'],
      tips: [`第 ${i + 1} 个镜头：机位放在桌边齐眼高`, '对焦和曝光锁在脸上再开拍'],
      mistake: '自动曝光让画面忽明忽暗',
    })),
  };
}
const withItem = (out: ShotTipsOutput, i: number, over: Partial<ShotTipsOutput['shots'][number]>): ShotTipsOutput => ({
  shots: out.shots.map((it, k) => (k === i ? { ...it, ...over } : it)),
});
const SIXTY = '机'.repeat(TIP_TEXT_MAX);
const SIXTY_ONE = '机'.repeat(TIP_TEXT_MAX + 1);

describe('validateShotTips', () => {
  const R = refs(3);

  test('a clean answer has no errors', () => {
    expect(validateShotTips(clean(3), R)).toEqual({ errors: [] });
    // exactly at the limits
    expect(validateShotTips(withItem(clean(3), 0, { tips: [SIXTY, SIXTY, SIXTY], mistake: SIXTY }), R).errors).toEqual([]);
  });

  test('a ref that is not one of the scene\'s shots', () => {
    const errors = validateShotTips(withItem(clean(3), 2, { ref: 's9' }), R).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('第 3 项（s9）');
    expect(errors[0]).toContain('只能是 s1、s2、s3');
    expect(errors[1]).toContain('缺少 s3');
  });

  test('the same shot twice', () => {
    const errors = validateShotTips(withItem(clean(3), 2, { ref: 's1' }), R).errors;
    expect(errors[0]).toContain('第 3 项（s1）');
    expect(errors[0]).toContain('已经写过一项');
    expect(errors[1]).toContain('缺少 s3');
  });

  test('shots left out', () => {
    expect(validateShotTips({ shots: clean(3).shots.slice(0, 1) }, R).errors).toEqual([expect.stringContaining('缺少 s2、s3')]);
    expect(validateShotTips({ shots: [] }, R).errors).toEqual([expect.stringContaining('缺少 s1、s2、s3')]);
  });

  test('2–3 tips: one, four, and blank ones do not count', () => {
    expect(validateShotTips(withItem(clean(3), 0, { tips: ['只有一条'] }), R).errors).toEqual([expect.stringContaining('tips 要写 2–3 条（现在 1 条）')]);
    expect(validateShotTips(withItem(clean(3), 0, { tips: ['一', '二', '三', '四'] }), R).errors).toEqual([expect.stringContaining('现在 4 条')]);
    expect(validateShotTips(withItem(clean(3), 0, { tips: ['一', '   '] }), R).errors).toEqual([expect.stringContaining('现在 1 条')]);
    expect(validateShotTips(withItem(clean(3), 0, { tips: [] }), R).errors).toEqual([expect.stringContaining('现在 0 条')]);
  });

  test('a tip over 60 characters', () => {
    const errors = validateShotTips(withItem(clean(3), 1, { tips: ['好', SIXTY_ONE] }), R).errors;
    expect(errors).toEqual([expect.stringContaining('第 2 项（s2）：第 2 条提示超过 60 字')]);
  });

  test('the mistake: empty, blank, over 60 characters', () => {
    expect(validateShotTips(withItem(clean(3), 0, { mistake: '' }), R).errors).toEqual([expect.stringContaining('mistake 不能为空')]);
    expect(validateShotTips(withItem(clean(3), 0, { mistake: '  ' }), R).errors).toEqual([expect.stringContaining('mistake 不能为空')]);
    expect(validateShotTips(withItem(clean(3), 0, { mistake: SIXTY_ONE }), R).errors).toEqual([expect.stringContaining('mistake 超过 60 字')]);
  });

  test('film claims, as flagFilmClaims sees them, in a tip or in the mistake', () => {
    const claims = ['参考《某片》的开场', '像1994年那部片子一样', '在电影里这一段是长镜头', '01:02:03 那里的推镜'];
    for (const c of claims) {
      expect(flagFilmClaims(c).length, c).toBeGreaterThan(0);
      expect(validateShotTips(withItem(clean(3), 0, { tips: [c, '对焦锁在脸上'] }), R).errors, c).toEqual([expect.stringContaining('不要写片名')]);
      expect(validateShotTips(withItem(clean(3), 0, { mistake: c }), R).errors, c).toEqual([expect.stringContaining('不要写片名')]);
    }
    // plain advice with a number is not a claim
    expect(validateShotTips(withItem(clean(3), 0, { tips: ['机位离人 2 米', '多拍 3 条'] }), R).errors).toEqual([]);
  });

  test('several problems at once are all listed', () => {
    const bad: ShotTipsOutput = {
      shots: [
        { ref: 's1', difficulty: 'easy', gear: [], tips: ['一'], mistake: '' },
        { ref: 's1', difficulty: 'hard', gear: [], tips: ['一', '二'], mistake: '错' },
      ],
    };
    const errors = validateShotTips(bad, R).errors;
    expect(errors.some((e) => e.includes('现在 1 条'))).toBe(true);
    expect(errors.some((e) => e.includes('mistake 不能为空'))).toBe(true);
    expect(errors.some((e) => e.includes('已经写过一项'))).toBe(true);
    expect(errors.at(-1)).toContain('缺少 s2、s3');
  });
});

describe('finalizeShotTips', () => {
  const R = refs(4);

  test('a clean answer is kept whole, in prompt order', () => {
    const out = clean(4);
    const fin = finalizeShotTips({ shots: [out.shots[2]!, out.shots[0]!, out.shots[3]!, out.shots[1]!] }, R);
    expect(fin.items.map((i) => i.ref)).toEqual(['s1', 's2', 's3', 's4']);
    expect(fin).toMatchObject({ dropped: 0, missing: [] });
    expect(fin.items[0]).toEqual({ ref: 's1', ...out.shots[0], gear: ['tripod'] });
  });

  test('dropped: an unknown shot, a repeated one, too few tips, no mistake, a claim in the mistake; missing: shots without an item', () => {
    const base = clean(4).shots;
    const fin = finalizeShotTips(
      {
        shots: [
          base[0]!,
          { ...base[0]!, tips: ['重复的一项', '不会被采用'] },
          { ...base[1]!, tips: ['只有一条'] },
          { ...base[2]!, mistake: ' ' },
          { ...base[3]!, mistake: '像《某片》那样拍糊了' },
          { ...base[3]!, ref: 's9' },
        ],
      },
      R,
    );
    expect(fin.items.map((i) => i.ref)).toEqual(['s1']);
    expect(fin.items[0]!.tips).toEqual(base[0]!.tips);
    expect(fin.dropped).toBe(5);
    expect(fin.missing).toEqual(['s2', 's3', 's4']);
  });

  test('texts over 60 characters are cut with …; more than 3 tips keep the first 3', () => {
    const fin = finalizeShotTips(withItem(clean(1), 0, { tips: [SIXTY_ONE, ` ${SIXTY} `, '三', '四'], mistake: '错'.repeat(80) }), ['s1']);
    const it = fin.items[0]!;
    expect(it.tips).toEqual([`${'机'.repeat(TIP_TEXT_MAX - 1)}…`, SIXTY, '三']);
    expect(Array.from(it.tips[0]!)).toHaveLength(TIP_TEXT_MAX);
    expect(it.mistake).toBe(`${'错'.repeat(TIP_TEXT_MAX - 1)}…`);
    expect(Array.from(it.mistake)).toHaveLength(TIP_TEXT_MAX);
  });

  test('tips with a film claim are left out; the item stays when two are left, else it is dropped', () => {
    const three = finalizeShotTips(withItem(clean(1), 0, { tips: ['机位齐眼高', '参考《某片》的开场', '多拍两条'] }), ['s1']);
    expect(three.items[0]!.tips).toEqual(['机位齐眼高', '多拍两条']);
    expect(three.dropped).toBe(0);
    const two = finalizeShotTips(withItem(clean(1), 0, { tips: ['机位齐眼高', '在电影里这一段是长镜头'] }), ['s1']);
    expect(two).toEqual({ items: [], dropped: 1, missing: ['s1'] });
  });

  test('blank tips are left out; gear is de-duplicated in its order', () => {
    const fin = finalizeShotTips(withItem(clean(1), 0, { tips: ['  ', '机位齐眼高', '', ' 多拍两条 '], gear: ['tripod', 'light', 'tripod', 'light', 'boom'] }), ['s1']);
    expect(fin.items[0]!.tips).toEqual(['机位齐眼高', '多拍两条']);
    expect(fin.items[0]!.gear).toEqual(['tripod', 'light', 'boom']);
  });

  test('nothing usable: no items, every shot missing', () => {
    expect(finalizeShotTips({ shots: [] }, R)).toEqual({ items: [], dropped: 0, missing: R });
  });
});

describe('the demo recordings (01-bookshop, tips-v1)', () => {
  const cases = [
    ['01-bookshop.tips-v1.scene-1.json', 12],
    ['01-bookshop.tips-v1.scene-2.json', 5],
  ] as const;

  for (const [file, n] of cases) {
    test(`${file}: ${n} shots, clean as recorded`, () => {
      const out = ShotTipsOutput.parse(normalizeShotTipsJson(recording(file)));
      expect(out.shots.map((s) => s.ref)).toEqual(refs(n));
      expect(validateShotTips(out, refs(n))).toEqual({ errors: [] });
      const fin = finalizeShotTips(out, refs(n));
      expect(fin).toMatchObject({ dropped: 0, missing: [] });
      expect(fin.items).toHaveLength(n);
      // nothing was cut: the recording keeps to the limits
      expect(fin.items.map((i) => [i.tips, i.mistake])).toEqual(out.shots.map((s) => [s.tips, s.mistake]));
    });
  }
});
