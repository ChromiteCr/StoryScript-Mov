import { describe, expect, test } from 'vitest';
import { EnvKind, Pose, PropKind, type PolishedShotFields, type PolishOutput } from '@storyscript/contracts';
import { buildPolishMessages, POLISH_MODE_LABEL, POLISH_PROMPT_VERSION, polishVarietyIssues, TECHNIQUES, type PolishPromptShot } from '../../src/index.ts';

/** S4c polish-v2: the new vocabularies and 丰富变化 (vary) as one passage. */

const F: PolishedShotFields = {
  template: 'single',
  shot_size: 'MCU',
  angle: 'eye',
  lens: 'normal',
  focal_mm: null,
  movement: 'static',
  subjects: [{ alias: 'c1', screen: 'C', depth: 'mg', facing: 'camera', pose: 'stand' }],
  props: [],
  env: 'classroom',
  subject_motion: 'none',
  set_piece: false,
  pov_owner: null,
  frame_format: null,
  technique_id: null,
  est_seconds: 3,
  narrative_purpose: '林川的反应',
  action: '林川看着黑板',
  dialogue_quote: null,
  assumptions: [],
  questions: [],
};

const shots: PolishPromptShot[] = ['s1', 's2', 's3', 's4'].map((ref, i) => ({
  ref,
  scene: { display_no: '2', heading: '内景 教室 日' },
  source_text: '林川看着黑板，没有说话。',
  fields: i === 3 ? { ...F, action: '林川转身走出教室' } : F,
  prev: null,
  next: null,
}));

const build = (mode: 'vary' | 'improve') =>
  buildPolishMessages({ mode, instruction: null, shots, roster: [{ alias: 'c1', name: '林川', aliases: [] }], techniques: TECHNIQUES, style: null, level: 'steady', frame_format: '2.39' });

describe('polish-v2 prompt', () => {
  test('version and the new vocabularies', () => {
    expect(POLISH_PROMPT_VERSION).toBe('polish-v3');
    const system = build('improve')[0]!.content;
    expect(system).toContain(`pose: ${Pose.options.join(' | ')} | null`);
    expect(system).toContain(`props[]: ${PropKind.options.join(' | ')}`);
    expect(system).toContain(`env: ${EnvKind.options.join(' | ')} | null`);
    expect(system).toContain('丰富变化');
  });

  test('丰富变化: the shots as one passage, 【镜头变化】 and what the check finds now', () => {
    expect(POLISH_MODE_LABEL.vary).toBe('丰富变化');
    const user = build('vary')[1]!.content;
    expect(user).toContain('【方式：丰富变化】把这些镜头按下面的顺序当作连续的一段来设计');
    expect(user).toContain('不增删镜头');
    expect(user).toContain('【镜头变化】');
    expect(user).toContain('【现在的问题】（按下面的镜头顺序数）');
    expect(user).toContain('- 第 1–4 个镜头都是近景、平视、固定');
    expect(user).toContain('- 〔s4〕动作里有「转身」');
    expect(user.indexOf('【现在的问题】')).toBeLessThan(user.indexOf('【要润色的镜头】'));
  });

  test('other modes carry neither block', () => {
    const user = build('improve')[1]!.content;
    expect(user).not.toContain('【镜头变化】');
    expect(user).not.toContain('【现在的问题】');
  });
});

describe('polishVarietyIssues', () => {
  const item = (ref: string, over: Partial<PolishedShotFields> = {}) => ({ ref, change_note: '换了景别', fields: { ...F, ...over } });

  test('read in ref order; per-shot warnings point at the output item', () => {
    // the model answered s3, s1, s2 — the passage is s1, s2, s3
    const out: PolishOutput = { shots: [item('s3', { action: '林川跑出教室' }), item('s1'), item('s2')] };
    const issues = polishVarietyIssues(out, ['s1', 's2', 's3']);
    expect(issues.map((x) => `${x.code}@${x.item}`)).toEqual(['VARIETY_SIZE_RUN@1', 'VARIETY_ALL_CENTER@null', 'VARIETY_MOTION_UNSET@0']);
    expect(issues.every((x) => x.level === 'warning')).toBe(true);
  });

  test('a varied answer has no warnings; unknown and repeated refs are left out', () => {
    const out: PolishOutput = {
      shots: [
        item('s1', { shot_size: 'WS', angle: 'high', movement: 'crane', subjects: [{ ...F.subjects[0]!, screen: 'L' }] }),
        item('s2', { shot_size: 'MS', movement: 'push_in', subjects: [{ ...F.subjects[0]!, screen: 'R' }] }),
        item('s2'),
        item('s9'),
      ],
    };
    expect(polishVarietyIssues(out, ['s1', 's2'])).toEqual([]);
  });
});
