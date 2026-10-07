import { BoardSpec, Emotion, type ShotFields } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import { shotFields, standardBoard, STANDARD_LOOK, STANDARD_ROSTER, subject, VARIETY_SHOTS } from '../../src/board/fixtures/standard-shots.ts';
import { buildPencilPlan, nightAlpha, toneRaster } from '../../src/board/pencil-plan.ts';
import {
  buildFrameScene,
  buildPuppet,
  inferEmotions,
  layoutBoard,
  normalizeShotFieldsJson,
  OBJECT_NAME_MAX,
  objectNameFor,
  renderBoard,
  shotContentHash,
  shotEmotions,
  structureHash,
  TIME_LIGHT,
  timeOfDay,
  validateShotFieldsBasic,
  type LayoutContext,
} from '../../src/index.ts';

/**
 * S5b 分镜图表现力: feelings read from the action and drawn on faces and
 * bodies, the light of the time of day, and the name of an object a close-up
 * can only draw as a plain shape.
 */

const P = [
  { alias: 'c1', label: '小林' },
  { alias: 'c2', label: '阿杰' },
];

describe('feelings from the action text', () => {
  test('a clause goes to the first person it names; a clause without a name to the last one named', () => {
    const m = inferEmotions('小林推门进来，看见桌上的信，愣住了。阿杰在门口笑了', P);
    expect(m.get('c1')).toBe('surprised');
    expect(m.get('c2')).toBe('happy');
  });

  test('the first person named in a clause is its subject (小林看着阿杰哭)', () => {
    expect(Object.fromEntries(inferEmotions('小林看着阿杰哭', P))).toEqual({ c1: 'sad' });
  });

  test('a longer word wins over the word inside it: 苦笑 is sad, 冷笑 angry, 惊恐 afraid', () => {
    const one = [{ alias: 'c1', label: '小林' }];
    expect(inferEmotions('小林苦笑', one).get('c1')).toBe('sad');
    expect(inferEmotions('小林冷笑一声', one).get('c1')).toBe('angry');
    expect(inferEmotions('小林一脸惊恐', one).get('c1')).toBe('afraid');
  });

  test('a negated word does not count (没哭, 不笑, 没有生气)', () => {
    expect(inferEmotions('小林没哭', P).size).toBe(0);
    expect(inferEmotions('小林不笑', P).size).toBe(0);
    expect(inferEmotions('小林没有生气', P).size).toBe(0);
  });

  test('the last feeling of a person wins: the shot ends on the reaction', () => {
    expect(inferEmotions('小林笑着走进来，看到信后愣住了', P).get('c1')).toBe('surprised');
  });

  test('no name: the feeling is the only person’s; with two people nobody gets it', () => {
    expect(inferEmotions('他紧张地攥紧书包', [P[0]!]).get('c1')).toBe('tense');
    expect(inferEmotions('紧张地攥紧书包', P).size).toBe(0);
  });

  test('only people in the list; empty text gives nothing', () => {
    expect(inferEmotions('老陈哭了', P).size).toBe(0);
    expect(inferEmotions('', P).size).toBe(0);
    expect(inferEmotions(null, P).size).toBe(0);
  });

  test('a nickname counts; a code does not run on into a longer one (c1 is not c12)', () => {
    const people = [
      { alias: 'c1', label: '林川', names: ['老林'] },
      { alias: 'c12', label: '周远' },
    ];
    expect(inferEmotions('老林笑了，周远没说话', people).get('c1')).toBe('happy');
    expect(Object.fromEntries(inferEmotions('c12 哭了', [{ alias: 'c1', label: '林川' }, { alias: 'c2', label: '周远' }]))).toEqual({});
  });

  test('a negation a few characters before counts (不是害怕, 没那么生气); 忍不住 and 不禁 do not negate', () => {
    expect(inferEmotions('小林不是害怕', P).size).toBe(0);
    expect(inferEmotions('小林没那么生气', P).size).toBe(0);
    expect(inferEmotions('小林忍不住哭了', P).get('c1')).toBe('sad');
    expect(inferEmotions('小林不禁笑了', P).get('c1')).toBe('happy');
  });

  test('the purpose is read only when the action gives nobody a feeling', () => {
    expect(shotEmotions({ action: '小林坐着', narrative_purpose: '表现小林的不安' }, P).get('c1')).toBe('tense');
    expect(shotEmotions({ action: '小林笑了', narrative_purpose: '表现小林的不安' }, P).get('c1')).toBe('happy');
  });
});

describe('time of day from the scene heading', () => {
  test.each([
    ['夜', 'night'],
    ['晚上', 'night'],
    ['深夜', 'night'],
    ['雨夜', 'night'],
    ['凌晨', 'night'],
    ['NIGHT', 'night'],
    ['黄昏', 'dusk'],
    ['傍晚', 'dusk'],
    ['清晨', 'dusk'],
    ['日落', 'dusk'],
    ['DUSK', 'dusk'],
    ['晚霞', 'dusk'],
    ['晨', 'dusk'],
    ['早晨', 'day'],
    ['早上', 'day'],
    ['CONTINUOUS', 'day'],
    ['日', 'day'],
    ['下午', 'day'],
    ['', 'day'],
    [null, 'day'],
  ] as const)('%s → %s', (label, time) => {
    expect(timeOfDay(label)).toBe(time);
  });
});

describe('faces and bodies', () => {
  const faceKey = (emotion: Emotion, view: 'front' | '3q' = 'front') =>
    JSON.stringify(
      buildPuppet('stand', view, false, 'regular', { gesture: 0, emotion })
        .lines.filter((l) => ['eye', 'pupil', 'brow', 'mouth', 'tear'].includes(l.key))
        .map((l) => [l.key, l.closed ?? false, l.pts.map((p) => p.map((v) => v.toFixed(4)))]),
    );

  test('every emotion draws a different face, front and three-quarter', () => {
    for (const view of ['front', '3q'] as const) expect(new Set(Emotion.options.map((e) => faceKey(e, view))).size).toBe(Emotion.options.length);
  });

  test('a calm face has solid pupils; a smile no pupils; wide eyes small pupils and, surprised, a solid open mouth', () => {
    const lines = (e: Emotion) => buildPuppet('stand', 'front', false, 'regular', { emotion: e }).lines;
    expect(lines('neutral').filter((l) => l.key === 'pupil' && l.closed)).toHaveLength(2);
    expect(lines('happy').some((l) => l.key === 'pupil')).toBe(false);
    expect(lines('surprised').filter((l) => l.key === 'pupil' && l.closed)).toHaveLength(2);
    expect(lines('surprised').find((l) => l.key === 'mouth')?.closed).toBe(true);
    expect(lines('neutral').find((l) => l.key === 'mouth')?.closed).toBeFalsy();
  });

  test('a solid shape repeats its first point (projections by segment stay closed)', () => {
    for (const l of buildPuppet('stand', 'front', false, 'regular', { emotion: 'surprised' }).lines.filter((x) => x.closed)) {
      expect(l.pts.at(-1)).toEqual(l.pts[0]);
    }
  });

  test('only a sad face has a tear, a close-up detail', () => {
    for (const e of Emotion.options) {
      const tear = buildPuppet('stand', 'front', false, 'regular', { emotion: e }).lines.filter((l) => l.key === 'tear');
      expect(tear.length > 0, e).toBe(e === 'sad');
      for (const t of tear) expect(t.kind).toBe('faceMinor');
    }
  });

  test('seen from behind there is no face, whatever the feeling', () => {
    for (const e of Emotion.options) expect(buildPuppet('stand', 'back', false, 'regular', { emotion: e }).lines.some((l) => l.kind === 'face')).toBe(false);
  });

  test('sad hangs the head, afraid lifts the shoulders', () => {
    const headTop = (e: Emotion) => {
      const head = buildPuppet('stand', 'front', false, 'regular', { gesture: 0, emotion: e }).parts.find((p) => p.key === 'head')!;
      return Math.max(...head.pts.map((p) => p[1]));
    };
    expect(headTop('sad')).toBeLessThan(headTop('neutral') - 0.01);
    const shoulderTop = (e: Emotion) => {
      const arm = buildPuppet('stand', 'front', false, 'regular', { gesture: 0, emotion: e }).parts.find((p) => p.key === 'upperArmA')!;
      return Math.max(...arm.pts.map((p) => p[1]));
    };
    expect(shoulderTop('afraid')).toBeGreaterThan(shoulderTop('neutral') + 0.008);
  });

  test('running and lying keep their bodies: only the face changes', () => {
    for (const pose of ['run', 'lie'] as const) {
      const body = (e: Emotion) => JSON.stringify(buildPuppet(pose, 'side', false, 'regular', { emotion: e }).parts.map((p) => p.pts));
      expect(body('angry')).toBe(body('neutral'));
    }
  });
});

const ctx = (o: Partial<LayoutContext> = {}): LayoutContext => ({ scene_sides: null, roster: STANDARD_ROSTER, look: STANDARD_LOOK, technique: null, aspect: '2.39', seed: 7, ...o });

describe('layout', () => {
  test('a feeling read from the action reaches the board; the shot’s own wins; calm is not stored', () => {
    const f = shotFields({ shot_size: 'MS', subjects: [subject('c1'), subject('c2')], action: '甲低头叹气，乙生气地瞪着他' });
    const spec = layoutBoard(f, ctx());
    expect(spec.scene.subjects.map((s) => s.emotion)).toEqual(['sad', 'angry']);
    const own = layoutBoard({ ...f, subjects: [subject('c1', { emotion: 'happy' }), subject('c2', { emotion: 'neutral' })] }, ctx());
    expect(own.scene.subjects[0]!.emotion).toBe('happy');
    expect('emotion' in own.scene.subjects[1]!).toBe(false);
  });

  test('the scene’s time sets the light; day stays exactly as before S5b', () => {
    const f = shotFields({ shot_size: 'MS', subjects: [subject('c1')] });
    const day = layoutBoard(f, ctx({ time_label: '日' }));
    expect('time' in day.scene).toBe(false);
    expect(day.scene.light).toEqual(TIME_LIGHT.day);
    expect(day.scene.light).toEqual({ azimuth_deg: 45, elevation_deg: 40 });
    const night = layoutBoard(f, ctx({ time_label: '夜' }));
    expect(night.scene.time).toBe('night');
    expect(night.scene.light).toEqual(TIME_LIGHT.night);
    expect(layoutBoard(f, ctx({ time_label: '黄昏' })).scene.time).toBe('dusk');
    expect(() => BoardSpec.parse(night)).not.toThrow();
  });
});

describe('hashes stay put for what was written before S5b', () => {
  const base = shotFields({ shot_size: 'MS', subjects: [subject('c1')], action: '甲坐着' });

  test('content hash of shots written before S5b, frozen (computed with the S3 cleaning)', () => {
    const talk = shotFields({ shot_size: 'MS', subjects: [subject('c1', { pose: 'sit' }), subject('c2')], props: ['table', 'cup'], action: '甲和乙隔着桌子说话', narrative_purpose: '交代关系' });
    const insert = { ...shotFields({ shot_size: 'INSERT', props: ['book'], action: '桌上的日记本' }), camera_notes: '  慢推  ' };
    expect(shotContentHash(talk)).toBe('19e7ff49cbe96b157bc61dc9d167');
    expect(shotContentHash(insert)).toBe('1c009e510eba54007716a78de7b8');
    // what a model or the editor writes for "nothing set" changes nothing
    const fromModel = normalizeShotFieldsJson({ ...talk, subjects: talk.subjects.map((s) => ({ ...s, emotion: '' })), object_name: '' }) as ShotFields;
    expect(shotContentHash(fromModel)).toBe('19e7ff49cbe96b157bc61dc9d167');
  });

  test('content hash: a null emotion or an empty object name is the same as none', () => {
    const h = shotContentHash(base);
    expect(shotContentHash({ ...base, subjects: [{ ...base.subjects[0]!, emotion: null }] })).toBe(h);
    expect(shotContentHash({ ...base, object_name: '' })).toBe(h);
    expect(shotContentHash({ ...base, object_name: null })).toBe(h);
    expect(shotContentHash({ ...base, object_name: '  ' })).toBe(h);
    expect(shotContentHash({ ...base, subjects: [{ ...base.subjects[0]!, emotion: 'sad' }] })).not.toBe(h);
    expect(shotContentHash({ ...base, object_name: '信' })).not.toBe(h);
  });

  test('structure hash: a calm face and daylight hash as absent; a feeling or night changes it', () => {
    const spec = layoutBoard(base, ctx());
    const h = structureHash(spec);
    const withSubject = (e: Emotion | null | undefined): BoardSpec => ({ ...spec, scene: { ...spec.scene, subjects: spec.scene.subjects.map((s) => ({ ...s, emotion: e })) } });
    expect(structureHash(withSubject(null))).toBe(h);
    expect(structureHash(withSubject(undefined))).toBe(h);
    expect(structureHash({ ...spec, scene: { ...spec.scene, time: 'day' } })).toBe(h);
    expect(structureHash(withSubject('angry'))).not.toBe(h);
    expect(structureHash({ ...spec, scene: { ...spec.scene, time: 'night' } })).not.toBe(h);
  });
});

describe('the light of the time of day', () => {
  const shot = VARIETY_SHOTS.find((s) => s.key === 'v13-night-street')!;
  const meanTone = (spec: BoardSpec) => {
    const g = toneRaster(buildPencilPlan(spec), 8);
    let sum = 0;
    for (const v of g.data) sum += v;
    return sum / g.data.length;
  };

  test('a night frame is much darker than the same frame by day, and the people keep their light', () => {
    const night = standardBoard(shot);
    const day: BoardSpec = { ...night, scene: { ...night.scene, time: undefined, light: TIME_LIGHT.day } };
    expect(night.scene.time).toBe('night');
    expect(meanTone(night)).toBeGreaterThan(meanTone(day) + 0.6);
    const plan = buildPencilPlan(night);
    expect(plan.pool).not.toBeNull();
    for (const it of plan.items) if (it.type === 'subject' && it.item.head) expect(nightAlpha(plan.pool!, it.item.head[0], it.item.head[1] + 20)).toBeLessThan(0.3);
  });

  test('dusk darkens the top of the frame and stretches the shadows', () => {
    const dusk = standardBoard(VARIETY_SHOTS.find((s) => s.key === 'v14-dusk-field')!);
    const day: BoardSpec = { ...dusk, scene: { ...dusk.scene, time: undefined, light: TIME_LIGHT.day } };
    const rowMean = (spec: BoardSpec, frac: number) => {
      const g = toneRaster(buildPencilPlan(spec), 8);
      const row = Math.floor(g.h * frac);
      let s = 0;
      for (let c = 0; c < g.w; c++) s += g.data[row * g.w + c] as number;
      return s / g.w;
    };
    expect(rowMean(dusk, 0.05)).toBeGreaterThan(rowMean(day, 0.05) + 0.5);
    const shadowArea = (spec: BoardSpec) => {
      const it = buildPencilPlan(spec).items.find((i) => i.type === 'shadow' && i.owner.startsWith('s'));
      if (!it || it.type !== 'shadow') return 0;
      const xs = it.pts.map((p) => p[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(shadowArea(dusk)).toBeGreaterThan(shadowArea(day) * 1.8);
  });

  test('night and dusk boards render the same bytes twice, with only grey and no style attributes', () => {
    for (const key of ['v13-night-street', 'v14-dusk-field', 'v15-night-room']) {
      const spec = standardBoard(VARIETY_SHOTS.find((s) => s.key === key)!);
      const a = renderBoard(spec, 'pencil');
      expect(renderBoard(spec, 'pencil')).toBe(a);
      expect(a).not.toMatch(/style=|<style/);
      for (const m of a.matchAll(/#([0-9a-f]{6})/gi)) {
        const hex = m[1]!;
        expect(hex.slice(0, 2) === hex.slice(2, 4) && hex.slice(2, 4) === hex.slice(4, 6), `#${hex}`).toBe(true);
      }
    }
  });
});

describe('the name of the object a close-up is about', () => {
  const can = (o: Partial<ShotFields> = {}) =>
    shotFields({ template: 'insert', shot_size: 'INSERT', props: ['table', 'can'], action: '桌上的罐头', object_name: '水果罐头', ...o });

  test('an insert writes the name next to its object, with a leader to it, in pencil and in structure', () => {
    const spec = layoutBoard(can(), ctx());
    const label = spec.overlay.labels.find((l) => l.id === 'l-object')!;
    const prop = spec.scene.props.find((p) => p.kind === 'can')!;
    expect(label).toMatchObject({ text: '水果罐头', prop_id: prop.id });
    expect(label.x).toBeGreaterThanOrEqual(0.02);
    expect(label.y).toBeGreaterThanOrEqual(0.12);
    for (const mode of ['pencil', 'structure'] as const) {
      const svg = renderBoard(spec, mode);
      expect(svg).toContain('水果罐头');
      expect(svg).toContain(`data-leader="l-object"`);
    }
  });

  test('every angle of the close-up keeps the object in frame — overhead too', () => {
    for (const angle of ['eye', 'high', 'overhead', 'low', 'dutch'] as const) {
      const spec = layoutBoard(can({ angle }), ctx());
      const scene = buildFrameScene(spec);
      const it = scene.items.find((i) => i.type === 'prop' && i.id === spec.scene.props.find((p) => p.kind === 'can')!.id);
      expect(it && it.type === 'prop' && it.faces.length, angle).toBeGreaterThan(0);
      expect(spec.overlay.labels.some((l) => l.id === 'l-object'), angle).toBe(true);
    }
  });

  test('a project prop name is only taken when it fits the object drawn', () => {
    expect(objectNameFor({ object_name: null, action: '手机放在桌子上', narrative_purpose: '' }, ['桌子', '手机'], 'phone')).toBe('手机');
    expect(objectNameFor({ object_name: null, action: '手机旁一杯热咖啡', narrative_purpose: '' }, ['热咖啡'], 'phone')).toBeNull();
    expect(objectNameFor({ object_name: null, action: '书架上的旧书', narrative_purpose: '' }, ['书架'], 'book')).toBeNull();
    // a plain box stands in for any small thing, not for a big one
    expect(objectNameFor({ object_name: null, action: '桌上的日记本', narrative_purpose: '' }, ['日记本'], 'box')).toBe('日记本');
    expect(objectNameFor({ object_name: null, action: '桌上的录音笔', narrative_purpose: '' }, ['录音笔'], 'box')).toBe('录音笔');
    expect(objectNameFor({ object_name: null, action: '门口的书架', narrative_purpose: '' }, ['书架'], 'box')).toBeNull();
    // the shot's own name is always written
    expect(objectNameFor({ object_name: '热咖啡', action: '', narrative_purpose: '' }, [], 'phone')).toBe('热咖啡');
  });

  test('the name comes from the shot, else from a project prop its action mentions; none, no label', () => {
    expect(objectNameFor({ object_name: ' 录取通知书 ', action: '', narrative_purpose: '' })).toBe('录取通知书');
    expect(objectNameFor({ object_name: null, action: '桌上的旧日记本', narrative_purpose: '' }, ['日记', '旧日记本'])).toBe('旧日记本');
    expect(objectNameFor({ object_name: null, action: '桌上的盒子', narrative_purpose: '' }, ['日记本'])).toBeNull();
    expect(layoutBoard(can({ object_name: null }), ctx()).overlay.labels.map((l) => l.id)).toEqual(['l-shot']);
    expect(layoutBoard(can({ object_name: null, action: '桌上的黄桃罐头' }), ctx({ prop_names: ['黄桃罐头'] })).overlay.labels.at(-1)?.text).toBe('黄桃罐头');
  });

  test('a long name is cut on the board and warned about; the text is escaped', () => {
    const long = '一'.repeat(OBJECT_NAME_MAX + 4);
    expect(layoutBoard(can({ object_name: long }), ctx()).overlay.labels.at(-1)?.text).toBe('一'.repeat(OBJECT_NAME_MAX));
    expect(validateShotFieldsBasic(can({ object_name: long }), { aliases: [], technique_ids: [] }).some((i) => i.code === 'object_name_long')).toBe(true);
    const svg = renderBoard(layoutBoard(can({ object_name: '<罐&头>' }), ctx()), 'pencil');
    expect(svg).toContain('&lt;罐&amp;头&gt;');
    expect(svg).not.toContain('<罐');
  });

  test('a shot with a person names the small thing it lists when it is in frame', () => {
    const f = shotFields({ shot_size: 'MS', subjects: [subject('c2', { pose: 'sit', facing: '3q_right' })], props: ['table', 'can'], object_name: '水果罐头' });
    const spec = layoutBoard(f, ctx());
    expect(spec.overlay.labels.find((l) => l.id === 'l-object')?.text).toBe('水果罐头');
  });
});

describe('model output', () => {
  test('emotions and the new props in Chinese or English; an empty object name is null, an absent one stays absent', () => {
    const raw = {
      ...shotFields({}),
      subjects: [{ alias: 'c1', screen: null, depth: null, facing: null, pose: null, emotion: '开心' }, { alias: 'c2', emotion: 'Scared' }],
      props: ['罐头', 'tin can', '瓶子'],
      object_name: '  ',
    };
    const out = normalizeShotFieldsJson(raw) as ShotFields;
    expect(out.subjects.map((s) => s.emotion)).toEqual(['happy', 'afraid']);
    expect(out.props).toEqual(['can', 'can', 'bottle']);
    expect(out.object_name).toBeNull();
    const plain = normalizeShotFieldsJson(shotFields({ subjects: [subject('c1')] })) as ShotFields;
    expect('object_name' in plain).toBe(false);
    expect('emotion' in plain.subjects[0]!).toBe(false);
  });
});
