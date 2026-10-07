import { describe, expect, it } from 'vitest';
import { ScriptRiskCategory, ScriptRiskSeverity, type ScriptRisk, type UsagePrice, type UsageTotals } from '@storyscript/contracts';
import { clock, countsLine, RISK_CATEGORY_LABEL, RISK_SEVERITY_LABEL, riskList, scriptChars, spoken, targetNote } from '../src/lib/check.ts';
import { JOB_KIND_LABEL } from '../src/lib/jobs.ts';
import { capLine, costCaveat, estimateCost, formatMoney, formatTokens, parsePrice, shortDate, USAGE_KIND_LABEL } from '../src/lib/usage.ts';
import { uuid } from './fixtures.ts';

// S5 web logic: the check's times, target note and checklist grouping; the
// usage dashboard's numbers, cost estimate and price fields. Pure, no DOM.

const A = uuid();
const B = uuid();
const scenes = [
  { id: A, display_no: '1', heading: '内景 旧书店 日' },
  { id: B, display_no: '2', heading: '内景 旧书店后屋 日' },
];
const risk = (o: Partial<ScriptRisk>): ScriptRisk => ({
  id: uuid(),
  category: 'rain_water',
  severity: 'low',
  quote: '外套肩上还有雨点',
  problem: '外套要像刚淋过雨',
  alternative: '开拍前用喷壶喷水',
  paragraph_id: 'p-005',
  scene_id: A,
  stale: false,
  handled: null,
  ...o,
});

describe('check: times and the target', () => {
  it('m:ss and spoken lengths', () => {
    expect(clock(108)).toBe('1:48');
    expect(clock(7)).toBe('0:07');
    expect(clock(3725)).toBe('1:02:05');
    expect(spoken(145)).toBe('2 分 25 秒');
    expect(spoken(40)).toBe('40 秒');
    expect(spoken(300)).toBe('5 分钟');
  });

  it('over, under and on target; nothing without one', () => {
    expect(targetNote({ seconds: 145, target_seconds: 120 })).toEqual({ text: '目标 2 分钟，超出约 21%', over: true });
    expect(targetNote({ seconds: 210, target_seconds: 300 })).toEqual({ text: '目标 5 分钟，比目标短约 30%', over: false });
    expect(targetNote({ seconds: 302, target_seconds: 300 })!.text).toContain('基本吻合');
    expect(targetNote({ seconds: 145, target_seconds: null })).toBeNull();
  });

  it('every category and level has a label', () => {
    for (const c of ScriptRiskCategory.options) expect(RISK_CATEGORY_LABEL[c]).toBeTruthy();
    for (const s of ScriptRiskSeverity.options) expect(RISK_SEVERITY_LABEL[s]).toBeTruthy();
    expect(JOB_KIND_LABEL.check_script).toBe('剧本体检');
  });

  it('the characters sent leave out the title block and spaces', () => {
    expect(scriptChars([{ text: '旧书 样例', scene_idx: null }, { text: '1. 内景 书店', scene_idx: 0 }, { text: '他 走进来。', scene_idx: 0 }])).toBe(6 + 5);
  });
});

describe('check: the checklist', () => {
  const list = [
    risk({ scene_id: B, category: 'period' }),
    risk({ severity: 'high', category: 'stunt' }),
    risk({ handled: { at: '2026-10-07T01:00:00.000Z', actor: null } }),
    risk({ stale: true, paragraph_id: null, scene_id: null, category: 'vehicle' }),
    risk({ scene_id: null, paragraph_id: 'p-001', category: 'vfx' }),
  ];

  it('groups by scene in script order, items outside scenes last, stale apart', () => {
    const r = riskList(list, scenes, false);
    expect(r.groups.map((g) => [g.scene?.display_no ?? null, g.risks.map((x) => x.category)])).toEqual([
      ['1', ['stunt', 'rain_water']],
      ['2', ['period']],
      [null, ['vfx']],
    ]);
    expect(r.stale.map((x) => x.category)).toEqual(['vehicle']);
    expect(r.counts).toEqual({ total: 4, open: 3, high: 1, handled: 1, stale: 1 });
    expect(countsLine(r.counts)).toBe('4 条 · 未处理 3 · 很难 1');
  });

  it('hiding the handled ones keeps the counts', () => {
    const r = riskList(list, scenes, true);
    expect(r.groups[0]!.risks.map((x) => x.category)).toEqual(['stunt']);
    expect(r.counts.handled).toBe(1);
    expect(countsLine({ total: 2, open: 2, high: 0, handled: 0, stale: 0 })).toBe('2 条 · 未处理 2');
  });
});

describe('usage: numbers and the estimate', () => {
  const totals: UsageTotals = { jobs: 3, requests: 4, prompt_tokens: 1_200_000, completion_tokens: 300_000, total_tokens: 1_500_000, unknown_calls: 0, outcome_unknown: 0, images: 2 };
  const price: UsagePrice = { currency: 'CNY', input_per_m: 2, output_per_m: 8, per_image: 0.25 };

  it('tokens in 万 above a hundred thousand', () => {
    expect(formatTokens(1234)).toBe('1,234');
    expect(formatTokens(123_456)).toBe('12.3 万');
    expect(formatTokens(1_500_000)).toBe('150 万');
    expect(formatTokens(0)).toBe('0');
  });

  it('cost = input + output + images; no price → no estimate', () => {
    expect(estimateCost(totals, price)).toBeCloseTo(2.4 + 2.4 + 0.5, 6);
    expect(estimateCost(totals, { ...price, per_image: null })).toBeCloseTo(4.8, 6);
    expect(estimateCost(totals, { currency: 'USD', input_per_m: null, output_per_m: null, per_image: null })).toBeNull();
    expect(estimateCost({ prompt_tokens: 0, completion_tokens: 0, images: 0 }, price)).toBe(0);
    expect(formatMoney(5.3, 'CNY')).toBe('¥5.30');
    expect(formatMoney(0.0031, 'USD')).toBe('$0.0031');
    expect(formatMoney(0, 'USD')).toBe('$0');
  });

  it('caveats, caps, price fields and dates', () => {
    expect(costCaveat({ unknown_calls: 0, outcome_unknown: 0 })).toBeNull();
    expect(costCaveat({ unknown_calls: 2, outcome_unknown: 1 })).toBe('2 次请求服务没有返回用量，1 个任务结果未知，可能另有费用。');
    expect(capLine('文本', { limit: 200, used: 37, remaining: 163 })).toEqual({ text: '文本 37/200', ratio: 0.185, full: false });
    expect(capLine('图像', { limit: 20, used: 20, remaining: 0 }).full).toBe(true);
    expect(parsePrice('')).toBeNull();
    expect(parsePrice(' 2.5 ')).toBe(2.5);
    expect(parsePrice('-1')).toBeUndefined();
    expect(parsePrice('abc')).toBeUndefined();
    expect(parsePrice('20000')).toBeUndefined();
    expect(shortDate('2026-10-07')).toBe('10月7日');
    expect(USAGE_KIND_LABEL.check_script).toBe('剧本体检');
  });
});
