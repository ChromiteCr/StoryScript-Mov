import { describe, expect, it } from 'vitest';
import { PlanOutcome, UnplacedCode, ViolationCode, type Resource, type Setup, type Shot, type Violation } from '@storyscript/contracts';
import {
  OUTCOME,
  UNPLACED_TEXT,
  approvalState,
  blockerLines,
  constraintText,
  contradictionText,
  unplacedText,
  violationText,
  type NameLookup,
} from '../src/lib/labels-plan.ts';

const S = '00000000-0000-4000-8000-000000000001';
const T = '00000000-0000-4000-8000-000000000002';
const R = '00000000-0000-4000-8000-000000000003';
const SH = '00000000-0000-4000-8000-000000000004';

const names: NameLookup = {
  setup: (id) => (id === S ? ({ id: S, label: '场1 · 平视 · 面向镜头' } as Setup) : id === T ? ({ id: T, label: '场2 · 仰拍' } as Setup) : undefined),
  resource: (id) => (id === R ? ({ id: R, name: '演员甲' } as Resource) : undefined),
  shot: (id) => (id === SH ? ({ id: SH, code: '003', scene_id: 'x' } as Shot) : undefined),
  sceneNo: () => '1',
};

const v = (code: Violation['code'], o: Partial<Violation> = {}): Violation => ({
  code,
  message: 'raw english message',
  block_id: null,
  setup_id: S,
  resource_id: null,
  shot_id: null,
  ...o,
});

const CJK = /[一-鿿]/;

describe('plan labels', () => {
  it('every outcome and unplaced code has Chinese copy', () => {
    for (const o of PlanOutcome.options) {
      expect(OUTCOME[o].label).toMatch(CJK);
      expect(OUTCOME[o].explain).toMatch(CJK);
    }
    for (const c of UnplacedCode.options) expect(UNPLACED_TEXT[c]).toMatch(CJK);
    expect(OUTCOME.partial.explain).toContain('不等于无解');
  });

  it('every violation code becomes a Chinese sentence naming the setup, never the raw message', () => {
    for (const code of ViolationCode.options) {
      const text = violationText(v(code, { resource_id: R, shot_id: SH }), names);
      expect(text, code).toMatch(CJK);
      expect(text, code).not.toContain('raw english');
    }
    expect(violationText(v('ESTIMATE_UNCONFIRMED'), names)).toBe('「场1 · 平视 · 面向镜头」的工时还是估算，需要确认');
    expect(violationText(v('UNPLACED_REQUIRED', { shot_id: SH }), names)).toBe('必拍镜头 1-003（「场1 · 平视 · 面向镜头」）没有排入');
    expect(violationText(v('OUTSIDE_WINDOW', { resource_id: R }), names)).toContain('「演员甲」的可用时间之外');
  });

  it('maps the known MISSING_INPUT shapes', () => {
    const mi = (message: string, o: Partial<Violation> = {}) => violationText(v('MISSING_INPUT', { message, ...o }), names);
    expect(mi('resource "P" is not confirmed', { setup_id: null, resource_id: R })).toBe('资源「演员甲」还没有确认');
    expect(mi('resource "P" is unconfirmed and has no time window', { resource_id: R })).toContain('没有填写可用时间');
    expect(mi('setup "X" has no per-shot duration')).toBe('「场1 · 平视 · 面向镜头」：每镜工时为 0，无法排期');
    expect(mi('crew window is missing, malformed or empty', { setup_id: null })).toContain('剧组工作时间');
    expect(mi('something new', { setup_id: null })).toBe('缺少必需的数据');
  });

  it('contradictions carry their evidence, with numbers lifted from the core message', () => {
    expect(
      contradictionText(
        { code: 'BLOCK_EXCEEDS_WINDOWS', message: '"X" shoot needs 180 min, but the longest common free stretch of "P" is 120 min', setup_ids: [S], resource_ids: [R] },
        names,
      ),
    ).toBe('「场1 · 平视 · 面向镜头」需要连续 180 分钟，但最长的共同空闲只有 120 分钟（「演员甲」）');
    expect(contradictionText({ code: 'NO_WINDOW', message: '', setup_ids: [S, T], resource_ids: [R] }, names)).toContain('需要它的：「场1 · 平视 · 面向镜头」、「场2 · 仰拍」');
    expect(contradictionText({ code: 'PRECEDENCE_CYCLE', message: '', setup_ids: [S, T], resource_ids: [] }, names)).toContain('形成了环');
  });

  it('unplaced and constraints read as sentences', () => {
    expect(unplacedText({ setup_id: T, code: 'ORDER', reason: 'ORDER: …' }, names)).toBe(`「场2 · 仰拍」没有排入：${UNPLACED_TEXT.ORDER}`);
    const t = (iso: string) => iso.slice(11, 16);
    expect(constraintText({ id: SH, type: 'before', a_setup_id: S, b_setup_id: T, confirmed: true }, names, t)).toBe(
      '「场1 · 平视 · 面向镜头」须在「场2 · 仰拍」开始前拍完',
    );
    expect(constraintText({ id: SH, type: 'locked_block', setup_id: T, start_utc: '2026-10-05T04:00:00.000Z', end_utc: '2026-10-05T05:00:00.000Z', confirmed: true }, names, t)).toBe(
      '「场2 · 仰拍」锁定在 04:00–05:00',
    );
  });

  it('folds unplaced required shots per setup, keeps other blockers one line each', () => {
    const SH2 = '00000000-0000-4000-8000-000000000005';
    const lookup: NameLookup = {
      ...names,
      shot: (x) => (x === SH ? ({ id: SH, code: '003', scene_id: 'x' } as Shot) : x === SH2 ? ({ id: SH2, code: '004', scene_id: 'x' } as Shot) : undefined),
    };
    const lines = blockerLines(
      [
        v('UNPLACED_REQUIRED', { shot_id: SH, message: 'a' }),
        v('ESTIMATE_UNCONFIRMED', { setup_id: T }),
        v('UNPLACED_REQUIRED', { shot_id: SH2, message: 'b' }),
        v('UNPLACED_REQUIRED', { setup_id: T, shot_id: SH, message: 'c' }),
      ],
      lookup,
    );
    expect(lines.map((l) => l.text)).toEqual([
      '「场1 · 平视 · 面向镜头」有 2 个必拍镜头没有排入：1-003、1-004',
      '「场2 · 仰拍」的工时还是估算，需要确认',
      '必拍镜头 1-003（「场2 · 仰拍」）没有排入',
    ]);
    expect(lines[0]!.raw).toBe('a\nb');
    expect(new Set(lines.map((l) => l.key)).size).toBe(3);
  });

  it('approval state: approved turns into 已失效 when stale', () => {
    expect(approvalState('approved', false)).toEqual({ label: '已批准', tone: 'ok' });
    expect(approvalState('approved', true)).toEqual({ label: '已失效', tone: 'warn' });
    expect(approvalState('draft', true).label).toBe('草案');
  });
});
