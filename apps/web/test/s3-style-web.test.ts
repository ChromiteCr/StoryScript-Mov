import { describe, expect, it } from 'vitest';
import { STYLE_LIMITS, StyleCardInput, type StyleCard, type StyleLibrary, type StyleResearchOutput } from '@storyscript/contracts';
import { BUILTIN_STYLES } from '@storyscript/core';
import {
  biasSummary,
  cardToInput,
  copyOfCard,
  copyStyleName,
  effectiveLevel,
  effectiveStyleId,
  emptyStyleInput,
  hasFormErrors,
  normalizeStyleForm,
  outgoingSentence,
  parseResearchDraft,
  pendingResearchDrafts,
  toggleBias,
  validateStyleForm,
} from '../src/lib/style-form.ts';
import { searchHint } from '../src/views/TextProviderPanel.tsx';
import { JOB_KIND_LABEL, STYLE_RESEARCH_SLOT } from '../src/lib/jobs.ts';
import { draft } from './fixtures.ts';

// S3 web logic: the style card form, research drafts, and what the breakdown
// form starts with. Original text only; no real people or titles.

const valid = (over: Partial<StyleCardInput> = {}): StyleCardInput => ({
  ...emptyStyleInput(),
  name: '雨夜霓虹',
  grammar: '反光：拍湿地面上的倒影。',
  ...over,
});

const RESEARCH: StyleResearchOutput = {
  name: '贴地速度：车载与长焦',
  summary: '低机位、车身硬挂和长焦压缩表现速度。',
  grammar: '贴地：机位放低。\n车载：三个固定视角。',
  shot_size_bias: ['CU', 'CU', 'WS'],
  angle_bias: ['low'],
  lens_bias: ['tele'],
  movement_bias: ['vehicle', 'aerial'],
  gear: '车载支架',
  low_budget: '用自行车代替',
  confidence: 'medium',
  caveats: ['  具体机位需要核实  ', ''],
};

describe('style card form validation', () => {
  it('an empty form asks for a name and the camera language', () => {
    const e = validateStyleForm(emptyStyleInput());
    expect(e).toEqual({ name: '请填写名称', grammar: '请写下镜头语言：运镜、镜头、构图和节奏' });
    expect(hasFormErrors(e)).toBe(true);
  });

  it('spaces alone do not count as a name or a grammar', () => {
    const e = validateStyleForm(valid({ name: '   ', grammar: '\n ' }));
    expect(Object.keys(e).sort()).toEqual(['grammar', 'name']);
  });

  it('a filled form has no errors; the optional fields may stay empty', () => {
    const e = validateStyleForm(valid());
    expect(e).toEqual({});
    expect(hasFormErrors(e)).toBe(false);
  });

  it('name up to 24 is fine, 25 is not; the message says how long it is', () => {
    expect(validateStyleForm(valid({ name: '字'.repeat(STYLE_LIMITS.name) })).name).toBeUndefined();
    expect(validateStyleForm(valid({ name: '字'.repeat(STYLE_LIMITS.name + 1) })).name).toBe('名称最多 24 个字，现在 25 个');
  });

  it('grammar up to 800, and the other limits, use the contract numbers', () => {
    expect(validateStyleForm(valid({ grammar: '镜'.repeat(800) })).grammar).toBeUndefined();
    expect(validateStyleForm(valid({ grammar: '镜'.repeat(801) })).grammar).toBe('镜头语言最多 800 个字，现在 801 个');
    const e = validateStyleForm(valid({ summary: '概'.repeat(81), gear: '器'.repeat(301), low_budget: '省'.repeat(301) }));
    expect(e.summary).toContain('80');
    expect(e.gear).toContain('300');
    expect(e.low_budget).toContain('300');
  });

  it('what passes the form passes the contract schema (after trimming)', () => {
    const f = valid({ name: '  雨夜霓虹  ', summary: ' 湿地面反光 ', grammar: '  反光  ' });
    expect(validateStyleForm(f)).toEqual({});
    const sent = normalizeStyleForm(f);
    expect(sent).toMatchObject({ name: '雨夜霓虹', summary: '湿地面反光', grammar: '反光' });
    expect(StyleCardInput.safeParse(sent).success).toBe(true);
  });
});

describe('copy of a card', () => {
  it('appends （副本）', () => {
    expect(copyStyleName('静观留白')).toBe('静观留白（副本）');
  });

  it('a long name is cut so the suffix and the whole stay within 24 characters', () => {
    const out = copyStyleName('长'.repeat(30));
    expect(out).toBe(`${'长'.repeat(20)}（副本）`);
    expect(out.length).toBe(STYLE_LIMITS.name);
    expect(copyStyleName('字'.repeat(20)).length).toBe(24);
  });

  it('a name that just fits is not cut', () => {
    expect(copyStyleName('a'.repeat(20))).toBe(`${'a'.repeat(20)}（副本）`);
  });

  it('every built-in card can be copied into a valid new card', () => {
    expect(BUILTIN_STYLES).toHaveLength(8);
    for (const card of BUILTIN_STYLES) {
      const copy = copyOfCard(card);
      expect(copy.name.endsWith('（副本）'), card.id).toBe(true);
      expect(validateStyleForm(copy), card.id).toEqual({});
      expect(StyleCardInput.safeParse(copy).success, card.id).toBe(true);
      // the copy is a fresh object: editing it never touches the built-in card
      expect(copy.bias).toEqual(card.bias);
      expect(copy.bias.movement).not.toBe(card.bias.movement);
    }
  });

  it('cardToInput keeps only the editable fields', () => {
    const card: StyleCard = { ...BUILTIN_STYLES[0]!, origin: 'researched', reference: '一个参考', unverified: true };
    expect(Object.keys(cardToInput(card)).sort()).toEqual(['bias', 'gear', 'grammar', 'low_budget', 'name', 'summary']);
  });
});

describe('preference chips', () => {
  const bias = { shot_size: [], angle: [], lens: [], movement: [] } as StyleCardInput['bias'];

  it('toggling adds and removes, keeping the vocabulary order and not mutating', () => {
    const a = toggleBias(bias, 'shot_size', 'CU');
    const b = toggleBias(a, 'shot_size', 'WS');
    expect(b.shot_size).toEqual(['WS', 'CU']); // ShotSize order, not click order
    expect(bias.shot_size).toEqual([]);
    expect(toggleBias(b, 'shot_size', 'WS').shot_size).toEqual(['CU']);
  });

  it('covers the new movements', () => {
    expect(toggleBias(bias, 'movement', 'orbit').movement).toEqual(['orbit']);
    expect(toggleBias(bias, 'movement', 'dolly_zoom').movement).toEqual(['dolly_zoom']);
  });

  it('the summary uses Chinese labels and skips empty groups', () => {
    const s = biasSummary({ shot_size: ['CU', 'ECU'], angle: [], lens: ['tele'], movement: ['vehicle', 'aerial'] });
    expect(s).toEqual([
      { key: 'shot_size', label: '景别', values: ['近景', '特写'] },
      { key: 'lens', label: '镜头', values: ['长焦'] },
      { key: 'movement', label: '运镜', values: ['车载', '航拍'] },
    ]);
    expect(biasSummary(bias)).toEqual([]);
  });
});

describe('research drafts', () => {
  it('a valid output becomes a clamped, de-duplicated card to review', () => {
    const r = parseResearchDraft(draft(RESEARCH, [], { kind: 'style', scope: { reference: '某个参考', notes: null } }));
    expect(r).not.toBeNull();
    expect(r!.input.name).toBe('贴地速度：车载与长焦');
    expect(r!.input.bias.shot_size).toEqual(['CU', 'WS']);
    expect(r!.input.bias.movement).toEqual(['vehicle', 'aerial']);
    expect(r!.confidence).toBe('medium');
    expect(r!.caveats).toEqual(['具体机位需要核实']);
    expect(StyleCardInput.safeParse(r!.input).success).toBe(true);
  });

  it('an over-long output is cut to the card limits so it can be saved', () => {
    const r = parseResearchDraft(draft({ ...RESEARCH, name: '名'.repeat(40), grammar: '语'.repeat(1200), gear: '器'.repeat(500) }));
    expect(r!.input.name.length).toBe(STYLE_LIMITS.name);
    expect(r!.input.grammar.length).toBe(STYLE_LIMITS.grammar);
    expect(r!.input.gear.length).toBe(STYLE_LIMITS.gear);
    expect(validateStyleForm(r!.input)).toEqual({});
  });

  it('output that is not a style reads as null', () => {
    expect(parseResearchDraft(draft(null))).toBeNull();
    expect(parseResearchDraft(draft({ shots: [] }))).toBeNull();
    expect(parseResearchDraft(draft({ ...RESEARCH, confidence: 'certain' }))).toBeNull();
  });

  it('pending style drafts come newest first; other kinds and settled drafts are left out', () => {
    const at = (d: string) => `2026-09-2${d}T08:00:00.000Z`;
    const mk = (kind: 'style' | 'breakdown', status: 'pending' | 'applied', day: string) => draft(null, [], { kind, status, created_at: at(day) });
    const a = mk('style', 'pending', '1');
    const b = mk('style', 'pending', '3');
    const list = [a, mk('style', 'applied', '4'), mk('breakdown', 'pending', '5'), b];
    expect(pendingResearchDrafts(list)).toEqual([b.id, a.id]);
    expect(pendingResearchDrafts([])).toEqual([]);
  });
});

describe('what the breakdown form starts with', () => {
  const cards = [BUILTIN_STYLES[0]!, BUILTIN_STYLES[1]!];
  const lib = (style_id: string | null, level: 'steady' | 'bold' | 'extreme' = 'steady'): Pick<StyleLibrary, 'cards' | 'defaults'> => ({
    cards,
    defaults: { style_id, level },
  });

  it('follows the group default until the user picks something', () => {
    expect(effectiveStyleId(null, lib(cards[1]!.id))).toBe(cards[1]!.id);
    expect(effectiveLevel(null, lib(null, 'bold'))).toBe('bold');
  });

  it('a pick wins over the default, including 不指定', () => {
    expect(effectiveStyleId(cards[0]!.id, lib(cards[1]!.id))).toBe(cards[0]!.id);
    expect(effectiveStyleId('', lib(cards[1]!.id))).toBe('');
    expect(effectiveLevel('extreme', lib(null, 'bold'))).toBe('extreme');
  });

  it('before the library loads: no style, steady; a pick is kept', () => {
    expect(effectiveStyleId(null, undefined)).toBe('');
    expect(effectiveStyleId('x', undefined)).toBe('x');
    expect(effectiveLevel(null, undefined)).toBe('steady');
  });

  it('a default that no longer exists is not offered', () => {
    expect(effectiveStyleId(null, lib('gone'))).toBe('');
    expect(effectiveStyleId('gone', lib(null))).toBe('');
  });

  it('the outgoing sentence adds the style and the note only when there are some', () => {
    expect(outgoingSentence({ paragraphs: 3, characters: 2, styleName: null, hasStyleNote: false })).toBe('将发送本场 3 个段落、角色名单（2 人）到');
    expect(outgoingSentence({ paragraphs: 3, characters: 2, styleName: '静观留白', hasStyleNote: true })).toBe(
      '将发送本场 3 个段落、角色名单（2 人）、风格说明（静观留白）、你写的风格要求到',
    );
  });
});

describe('labels', () => {
  it('the two new job kinds and the research slot', () => {
    expect(JOB_KIND_LABEL.research_style).toBe('风格研究');
    expect(JOB_KIND_LABEL.polish_shots).toBe('AI 润色');
    expect(STYLE_RESEARCH_SLOT).toBe('style-research');
  });

  it('the web-search hint follows what the service supports', () => {
    expect(searchHint('dashscope')).toBe('通义会用 enable_search 联网搜索。');
    expect(searchHint('openai')).toContain('search');
    expect(searchHint(null)).toBe('这个服务商没有我们已知的联网参数，研究时只用模型自己的知识。');
  });
});
