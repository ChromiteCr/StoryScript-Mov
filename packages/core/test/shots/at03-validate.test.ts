import { describe, expect, test } from 'vitest';
import { BreakdownOutput, type ShotFields } from '@storyscript/contracts';
import {
  breakdownRepairErrors,
  itemsWithErrors,
  normalizeBreakdownJson,
  normalizeEntitiesJson,
  shotContentHash,
  TECHNIQUES,
  validateBreakdown,
  validateShotFieldsBasic,
} from '../../src/index.ts';

const paragraphs = [
  { id: 'p-002', text: '1. 内景 旧书店 日' },
  { id: 'p-005', text: '门铃响了一声。林晓（二十多岁）推门进来，外套肩上还有雨点。' },
  { id: 'p-006', text: '林晓：请问……这里还收旧书吗？' },
];
const ctx = {
  paragraphs,
  aliases: ['c1', 'c2'],
  technique_ids: TECHNIQUES.map((t) => t.id),
  max_shots: 3,
};

function shot(over: Partial<ShotFields> = {}): ShotFields {
  return {
    template: 'single',
    shot_size: 'FS',
    angle: 'eye',
    lens: 'normal',
    focal_mm: 35,
    movement: 'static',
    subjects: [{ alias: 'c2', screen: 'C', depth: 'mg', facing: 'camera', pose: 'walk' }],
    props: ['door'],
    env: 'interior',
    subject_motion: 'toward',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 4,
    narrative_purpose: '林晓进入书店',
    action: '林晓推门进来',
    dialogue_quote: null,
    source: { paragraph_id: 'p-005', quote: '林晓（二十多岁）推门进来' },
    assumptions: [],
    questions: [],
    ...over,
  };
}

const codes = (v: ReturnType<typeof validateBreakdown>, level: 'error' | 'warning') =>
  v.issues.filter((i) => i.level === level).map((i) => `${i.code}@${i.item}`);

describe('AT-03 business validation', () => {
  test('a clean shot passes with an exact quote', () => {
    const v = validateBreakdown({ shots: [shot()] }, ctx);
    expect(v.error_count).toBe(0);
    expect(v.items[0]!.quote_match).toBe('exact');
    expect(v.issues).toEqual([]);
  });

  test('unknown character alias and pov owner are errors', () => {
    const v = validateBreakdown(
      { shots: [shot({ subjects: [{ alias: 'c9', screen: null, depth: null, facing: null, pose: null }], pov_owner: 'c7' })] },
      ctx,
    );
    expect(codes(v, 'error')).toEqual(['unknown_alias@0', 'unknown_pov_owner@0']);
    expect(itemsWithErrors(v)).toEqual([0]);
  });

  test('paragraph outside the scene is an error (with a hint where the quote really is)', () => {
    const v = validateBreakdown({ shots: [shot({ source: { paragraph_id: 'p-099', quote: '林晓（二十多岁）推门进来' } })] }, ctx);
    expect(codes(v, 'error')).toEqual(['paragraph_not_in_scene@0']);
    expect(v.issues[0]!.message).toContain('p-005');
    expect(v.items[0]!.quote_match).toBe('rejected');
  });

  test('tampered quote is rejected; a near miss is a fuzzy warning', () => {
    const tampered = validateBreakdown({ shots: [shot({ source: { paragraph_id: 'p-005', quote: '林晓撑着伞慢慢走进店里' } })] }, ctx);
    expect(codes(tampered, 'error')).toEqual(['quote_rejected@0']);
    const near = validateBreakdown(
      { shots: [shot({ source: { paragraph_id: 'p-005', quote: '林晓（二十多岁）推门进来，外套肩上还带有雨点' } })] },
      ctx,
    );
    expect(near.error_count).toBe(0);
    expect(near.items[0]!.quote_match).toBe('fuzzy');
    expect(codes(near, 'warning')).toEqual(['quote_fuzzy@0']);
  });

  test('too many shots: the extra items are errors, nothing is truncated', () => {
    const v = validateBreakdown({ shots: [shot(), shot(), shot(), shot(), shot()] }, ctx);
    expect(v.items).toHaveLength(5);
    expect(codes(v, 'error')).toEqual(['too_many_shots@3', 'too_many_shots@4', 'too_many_shots@null']);
    expect(itemsWithErrors(v)).toEqual([3, 4]);
    expect(breakdownRepairErrors(v)).toContain('共 5 个镜头，超过上限 3');
  });

  test('unknown technique and out-of-range duration are errors', () => {
    const v = validateBreakdown({ shots: [shot({ technique_id: 'famous_director_style', est_seconds: 0 }), shot({ est_seconds: 121 })] }, ctx);
    expect(codes(v, 'error')).toEqual(['unknown_technique@0', 'est_seconds_out_of_range@0', 'est_seconds_out_of_range@1']);
  });

  test('warnings: props / subjects over 4, template mismatch, dialogue not in scene, empty text', () => {
    const subjects = ['c1', 'c2', 'c1', 'c2', 'c1'].map((alias) => ({ alias, screen: null, depth: null, facing: null, pose: null }));
    const v = validateBreakdown(
      {
        shots: [
          shot({ props: ['door', 'table', 'chair', 'window', 'box'], subjects, template: 'single', dialogue_quote: '我从来没来过这里', action: ' ' }),
          shot({ template: 'ots', technique_id: 'dialogue_coverage' }),
        ],
      },
      ctx,
    );
    expect(v.error_count).toBe(0);
    expect(codes(v, 'warning')).toEqual([
      'duplicate_subject@0',
      'duplicate_subject@0',
      'duplicate_subject@0',
      'too_many_props@0',
      'too_many_subjects@0',
      'template_subjects@0',
      'empty_text@0',
      'dialogue_not_in_scene@0',
      'template_subjects@1',
    ]);
  });

  test('empty breakdown is a draft-level error; reference note marks advice as unverified', () => {
    expect(codes(validateBreakdown({ shots: [] }, ctx), 'error')).toEqual(['empty_breakdown@null']);
    const v = validateBreakdown({ shots: [shot()] }, { ...ctx, reference_note: '参考某导演的风格' });
    expect(v.issues).toEqual([expect.objectContaining({ level: 'warning', code: 'reference_unverified', item: null })]);
    expect(v.issues[0]!.message).toContain('通用手法建议（未核实）');
  });

  test('claim flags over narrative_purpose / action / assumptions (annotate only)', () => {
    const v = validateBreakdown(
      { shots: [shot({ narrative_purpose: '像《某片》那样开场', assumptions: ['参考 1999年 的做法'] })] },
      ctx,
    );
    expect(v.error_count).toBe(0);
    expect(v.claim_flags).toEqual([
      { item: 0, kind: 'title', text: '《某片》' },
      { item: 0, kind: 'year', text: '1999年' },
    ]);
  });

  test('manual-shot subset check: aliases must be on the roster', () => {
    expect(validateShotFieldsBasic(shot(), ctx)).toEqual([]);
    const bad = validateShotFieldsBasic(shot({ subjects: [{ alias: 'c3', screen: null, depth: null, facing: null, pose: null }] }), ctx);
    expect(bad.map((i) => i.code)).toEqual(['unknown_alias']);
  });
});

describe('AT-03 lenient normalisation before zod', () => {
  test('enum case and common synonyms are normalised', () => {
    const raw = {
      shots: [
        {
          ...shot(),
          template: 'Over-the-Shoulder',
          shot_size: 'close-up',
          angle: 'Eye-Level',
          lens: 'Telephoto',
          movement: 'fixed',
          subjects: [{ alias: ' c1 ', screen: 'left', depth: 'Foreground', facing: '3/4 right', pose: 'Sitting' }],
          props: ['Doors', 'table'],
          env: 'indoor',
          subject_motion: 'left to right',
          frame_format: 2.39,
          focal_mm: '85mm',
          est_seconds: '4秒',
          set_piece: 'false',
        },
        { ...shot(), shot_size: 'medium', angle: 'eye_level', movement: 'Static', technique_id: '', pov_owner: 'none', frame_format: '1.9' },
      ],
    };
    const out = BreakdownOutput.parse(normalizeBreakdownJson(raw));
    expect(out.shots[0]).toMatchObject({
      template: 'ots',
      shot_size: 'CU',
      angle: 'eye',
      lens: 'tele',
      movement: 'static',
      subjects: [{ alias: 'c1', screen: 'L', depth: 'fg', facing: '3q_right', pose: 'sit' }],
      props: ['door', 'table'],
      env: 'interior',
      subject_motion: 'l2r',
      frame_format: '2.39',
      focal_mm: 85,
      est_seconds: 4,
      set_piece: false,
    });
    expect(out.shots[1]).toMatchObject({ shot_size: 'MS', angle: 'eye', movement: 'static', technique_id: null, pov_owner: null, frame_format: '1.90' });
  });

  test('missing nullable fields become null and missing arrays []', () => {
    const { template, focal_mm, env, pov_owner, frame_format, technique_id, dialogue_quote, subjects, props, assumptions, questions, ...rest } =
      shot();
    void [template, focal_mm, env, pov_owner, frame_format, technique_id, dialogue_quote, subjects, props, assumptions, questions];
    const out = BreakdownOutput.parse(normalizeBreakdownJson([{ ...rest, subjects: ['c2'] }]));
    expect(out.shots[0]).toMatchObject({
      template: null,
      focal_mm: null,
      env: null,
      pov_owner: null,
      frame_format: null,
      technique_id: null,
      dialogue_quote: null,
      subjects: [{ alias: 'c2', screen: null, depth: null, facing: null, pose: null }],
      props: [],
      assumptions: [],
      questions: [],
    });
  });

  test('no semantic guessing: unknown values stay and fail zod', () => {
    const out = normalizeBreakdownJson({ shots: [{ ...shot(), shot_size: 'cinematic', props: ['piano'], subject_motion: undefined }] });
    const r = BreakdownOutput.safeParse(out);
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['shots.0.shot_size', 'shots.0.props.0', 'shots.0.subject_motion']));
    // non-objects pass through untouched (zod reports them)
    expect(normalizeBreakdownJson('oops')).toBe('oops');
    expect(normalizeBreakdownJson(null)).toBe(null);
  });

  test('entities: missing lists and aliases are filled', () => {
    expect(normalizeEntitiesJson({ characters: [{ name: ' 林晓 ' }, '老周'] })).toEqual({
      characters: [
        { name: '林晓', aliases: [] },
        { name: '老周', aliases: [] },
      ],
      locations: [],
      props: [],
    });
  });

  test('content hash covers fields only and ignores key order', () => {
    const a = shot();
    const b = Object.fromEntries(Object.entries(a).reverse()) as ShotFields;
    expect(shotContentHash(a)).toBe(shotContentHash(b));
    expect(shotContentHash(a)).not.toBe(shotContentHash({ ...a, action: '另一个动作' }));
  });
});
