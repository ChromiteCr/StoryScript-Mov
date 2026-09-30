import { describe, expect, it } from 'vitest';
import { CREW_ROLE_PRESETS, CrewRole, type ActorRef, type ProvidersView, type TextProviderView } from '@storyscript/contracts';
import {
  actorPhrase,
  actorShortText,
  actorText,
  addCrewRole,
  crewRolesText,
  crewRoleProblem,
  isOtherActor,
  normalizeCrewRoles,
  roleChoices,
  rosterText,
  sameCrewRoles,
  toggleCrewRole,
} from '../src/lib/crew.ts';
import { ownChoiceWarning, ownConfigured, panelConfigured, textNotConfiguredReason } from '../src/lib/models.ts';
import { aiGateOf } from '../src/lib/queries.ts';

// S4 web logic: crew roles (what may be typed, what is sent), how a
// teammate is named beside their changes, and the copy around 我的模型.
// Names are made up.

const actor = (over: Partial<ActorRef> = {}): ActorRef => ({ id: 'a1', name: '阿杰', crew_roles: ['导演'], left: false, ...over });

describe('crew roles: what may be typed', () => {
  it('accepts a short role of one or more characters', () => {
    expect(crewRoleProblem('摄影')).toBeNull();
    expect(crewRoleProblem('副导演')).toBeNull();
    expect(crewRoleProblem('  灯光  ')).toBeNull(); // trimmed
    expect(crewRoleProblem('一二三四五六七八')).toBeNull(); // 8 characters
  });

  it('says what is wrong', () => {
    expect(crewRoleProblem('')).toBe('请填写职务');
    expect(crewRoleProblem('   ')).toBe('请填写职务');
    expect(crewRoleProblem('一二三四五六七八九')).toBe('职务最多 8 个字');
    expect(crewRoleProblem('美 术')).toBe('职务里不能有空格、@ 或逗号');
    expect(crewRoleProblem('@导演')).toBe('职务里不能有空格、@ 或逗号');
    for (const bad of ['导演,摄影', '导演，摄影', '导演、摄影']) expect(crewRoleProblem(bad)).toBe('职务里不能有空格、@ 或逗号');
  });

  it('refuses a repeat and a seventh role', () => {
    expect(crewRoleProblem('摄影', ['导演', '摄影'])).toBe('已经有「摄影」了');
    const six = ['导演', '编剧', '制片', '摄影', '美术', '录音'];
    expect(crewRoleProblem('剪辑', six)).toBe('最多 6 个职务，先去掉一个');
    expect(crewRoleProblem('剪辑', six.slice(0, 5))).toBeNull();
  });

  it('agrees with the contract on what is a valid role', () => {
    const samples = ['导演', ' 导演 ', '', ' ', '一二三四五六七八', '一二三四五六七八九', 'a b', 'a@b', 'a,b', 'a，b', 'a、b', 'DIT', '副导演', 'a\tb', 'a　b'];
    for (const x of samples) {
      expect({ x, ok: crewRoleProblem(x) === null }).toEqual({ x, ok: CrewRole.safeParse(x).success });
    }
    for (const preset of CREW_ROLE_PRESETS) expect(crewRoleProblem(preset)).toBeNull();
  });
});

describe('crew roles: what is sent', () => {
  it('trims, drops empty and repeated roles, keeps the first six', () => {
    expect(normalizeCrewRoles([' 摄影 ', '', '摄影', '导演'])).toEqual(['摄影', '导演']);
    expect(normalizeCrewRoles(['导演', '编剧', '制片', '摄影', '美术', '录音', '剪辑'])).toEqual(['导演', '编剧', '制片', '摄影', '美术', '录音']);
    expect(normalizeCrewRoles([])).toEqual([]);
  });

  it('every normalised list passes the contract', () => {
    const list = normalizeCrewRoles(['导演', ' 摄影 ', '导演', '副导演']);
    expect(list.every((r) => CrewRole.safeParse(r).success)).toBe(true);
  });

  it('adds by hand and toggles presets, leaving the list alone on a problem', () => {
    expect(addCrewRole(['导演'], ' 副导演 ')).toEqual({ roles: ['导演', '副导演'], problem: null });
    expect(addCrewRole(['导演'], '导演')).toEqual({ roles: ['导演'], problem: '已经有「导演」了' });
    expect(toggleCrewRole(['导演'], '摄影')).toEqual({ roles: ['导演', '摄影'], problem: null });
    expect(toggleCrewRole(['导演', '摄影'], '导演')).toEqual({ roles: ['摄影'], problem: null });
    const six = ['导演', '编剧', '制片', '摄影', '美术', '录音'];
    expect(toggleCrewRole(six, '剪辑')).toEqual({ roles: six, problem: '最多 6 个职务，先去掉一个' });
    // taking one off is always allowed, even at the cap
    expect(toggleCrewRole(six, '录音').roles).toHaveLength(5);
  });

  it('compares lists in order', () => {
    expect(sameCrewRoles(['导演', '摄影'], ['导演', '摄影'])).toBe(true);
    expect(sameCrewRoles(['导演', '摄影'], ['摄影', '导演'])).toBe(false);
    expect(sameCrewRoles([], [])).toBe(true);
  });

  it('offers the presets first, then a role of one’s own', () => {
    expect(roleChoices([])).toEqual([...CREW_ROLE_PRESETS]);
    expect(roleChoices(['摄影', '副导演'])).toEqual([...CREW_ROLE_PRESETS, '副导演']);
  });
});

describe('naming a teammate beside their change', () => {
  it('shows the name with the roles', () => {
    expect(actorText(actor())).toBe('阿杰（导演）');
    expect(actorText(actor({ crew_roles: ['导演', '编剧'] }))).toBe('阿杰（导演、编剧）');
    expect(actorText(actor({ crew_roles: [] }))).toBe('阿杰');
    expect(crewRolesText(['导演', '摄影'])).toBe('导演、摄影');
  });

  it('wraps the name in a sentence, and says nothing without an actor', () => {
    expect(actorPhrase(actor(), '', '发起')).toBe('阿杰（导演）发起');
    expect(actorPhrase(actor(), '由 ', ' 批准')).toBe('由 阿杰（导演） 批准');
    expect(actorPhrase(actor(), '记录：')).toBe('记录：阿杰（导演）');
    expect(actorPhrase(null)).toBeNull();
    expect(actorPhrase(undefined, '由 ', ' 批准')).toBeNull();
  });

  it('gives the short form for a version list, marking someone who left', () => {
    expect(actorShortText(actor())).toBe('阿杰');
    expect(actorShortText(actor({ left: true }))).toBe('阿杰（已离开）');
    expect(`v3 · ${actorShortText(actor())} · 10:32`).toBe('v3 · 阿杰 · 10:32');
  });

  it('tells someone else’s row from one’s own, and treats a local app as nobody', () => {
    expect(isOtherActor(actor({ id: 'a1' }), 'a2')).toBe(true);
    expect(isOtherActor(actor({ id: 'a1' }), 'a1')).toBe(false);
    expect(isOtherActor(actor(), null)).toBe(false);
    expect(isOtherActor(null, 'a1')).toBe(false);
  });

  it('lists a group as one line', () => {
    expect(rosterText([{ name: '阿杰', crew_roles: ['导演'] }, { name: '小林', crew_roles: [] }, { name: '阿丽', crew_roles: ['摄影', '灯光'] }])).toBe('阿杰（导演）、小林、阿丽（摄影、灯光）');
  });
});

// ----------------------------------------------------------------- models --

const text = (over: Partial<TextProviderView> = {}): TextProviderView => ({
  base_url: 'https://llm.example.test/v1',
  model: 'model-a',
  key_last4: '1234',
  source: 'file',
  research_model: null,
  research_search: false,
  search_support: null,
  ...over,
});
const view = (over: Partial<ProvidersView> = {}): ProvidersView => ({ text: text(), image: null, editable: true, ...over });

describe('我的模型: the choice and its warning', () => {
  it('a filled-in model of one’s own has an address, a model name and a key', () => {
    expect(ownConfigured('text', view())).toBe(true);
    expect(ownConfigured('text', view({ text: text({ key_last4: null }) }))).toBe(false);
    expect(ownConfigured('text', view({ text: text({ model: '' }) }))).toBe(false);
    expect(ownConfigured('text', view({ text: null }))).toBe(false);
    expect(ownConfigured('image', view())).toBe(false);
    expect(ownConfigured('text', undefined)).toBe(false);
  });

  it('warns only when 我的模型 is chosen and not filled in', () => {
    expect(ownChoiceWarning('text', 'group', view({ text: null }))).toBeNull();
    expect(ownChoiceWarning('text', 'own', view())).toBeNull();
    const w = ownChoiceWarning('text', 'own', view({ text: null }));
    expect(w).toContain('你选了用自己的文本模型，但还没填好');
    expect(w).toContain('不会自动改用组的模型');
    expect(ownChoiceWarning('image', 'own', view())).toContain('图像模型');
  });
});

describe('the status of a model panel', () => {
  const health = (over: Record<string, unknown> = {}) =>
    ({ hosted: true, text_provider_configured: true, image_provider_configured: false, text_model_source: 'group', image_model_source: 'group', ...over }) as Parameters<typeof panelConfigured>[0]['health'];

  it('local app: the health flag', () => {
    expect(panelConfigured({ kind: 'text', scope: 'group', health: health({ hosted: false, text_model_source: null }), view: null })).toBe(true);
    expect(panelConfigured({ kind: 'image', scope: 'group', health: health({ hosted: false, image_model_source: null }), view: null })).toBe(false);
  });

  it('the panel of the model in use follows the health flag', () => {
    expect(panelConfigured({ kind: 'text', scope: 'group', health: health(), view: text() })).toBe(true);
    expect(panelConfigured({ kind: 'text', scope: 'group', health: health({ text_provider_configured: false }), view: text() })).toBe(false);
    expect(panelConfigured({ kind: 'text', scope: 'me', health: health({ text_model_source: 'own', text_provider_configured: false }), view: text() })).toBe(false);
  });

  it('the other panel is judged from its own view', () => {
    // using the group's model: my own panel shows whether my own is filled in
    expect(panelConfigured({ kind: 'text', scope: 'me', health: health(), view: text() })).toBe(true);
    expect(panelConfigured({ kind: 'text', scope: 'me', health: health(), view: text({ key_last4: null }) })).toBe(false);
    expect(panelConfigured({ kind: 'text', scope: 'me', health: health(), view: null })).toBe(false);
    // using my own: the group's panel, seen by a member (no key digits), counts an address and a model name
    expect(panelConfigured({ kind: 'text', scope: 'group', health: health({ text_model_source: 'own' }), view: text({ key_last4: null }), readOnly: true })).toBe(true);
    expect(panelConfigured({ kind: 'text', scope: 'group', health: health({ text_model_source: 'own' }), view: text({ key_last4: null }) })).toBe(false);
    expect(panelConfigured({ kind: 'text', scope: 'group', health: undefined, view: text() })).toBe(false);
  });
});

describe('the AI gate says whose model is missing', () => {
  const off = { text_provider_configured: false, demo: false };

  it('a local app keeps its copy', () => {
    const g = aiGateOf({ ...off, hosted: false, text_model_source: null });
    expect(g.enabled).toBe(false);
    expect(g.reason).toBe('未配置文本模型：在"设置 → 模型"中填写后可用。手工流程不受影响。');
    expect(aiGateOf(off).reason).toBe(g.reason);
  });

  it('hosted, the group’s model: ask the leader', () => {
    const g = aiGateOf({ ...off, hosted: true, text_model_source: 'group' });
    expect(g.enabled).toBe(false);
    expect(g.reason).toContain('组长还没配置本组的模型');
    expect(g.reason).toContain('手工流程不受影响');
  });

  it('hosted, one’s own model: fill it in', () => {
    const g = aiGateOf({ ...off, hosted: true, text_model_source: 'own' });
    expect(g.enabled).toBe(false);
    expect(g.reason).toContain('你选了自己的文本模型，但还没填好');
    expect(textNotConfiguredReason({ hosted: true, text_model_source: 'own' })).toBe(g.reason);
  });

  it('a configured model, or the demo, opens the gate whatever the source', () => {
    expect(aiGateOf({ text_provider_configured: true, demo: false, hosted: true, text_model_source: 'own' })).toEqual({ enabled: true, reason: null, demo: false });
    expect(aiGateOf({ ...off, demo: true, hosted: true, text_model_source: 'group' })).toEqual({ enabled: true, reason: null, demo: true });
    expect(aiGateOf(undefined).enabled).toBe(false);
  });
});
