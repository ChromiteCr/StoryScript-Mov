import {
  CameraAngle,
  LensClass,
  Movement,
  ShotSize,
  STYLE_LIMITS,
  StyleResearchOutput,
  type DraftIssue,
  type ShotDraft,
  type StyleBias,
  type StyleCard,
  type StyleCardInput,
  type StyleLevel,
  type StyleLibrary,
} from '@storyscript/contracts';
import { styleCardInputFromResearch } from '@storyscript/core';
import { ANGLE_LABEL, LENS_LABEL, MOVEMENT_LABEL, SHOT_SIZE_LABEL } from './labels.ts';

/**
 * Pure helpers for the style library (S3): the card form, its validation,
 * the research draft, and which style/level a breakdown form starts with.
 * No DOM, no fetch.
 */

// ------------------------------------------------------------------- bias --

export type BiasKey = keyof StyleBias;

export interface BiasGroup {
  key: BiasKey;
  label: string;
  options: readonly string[];
  labels: Readonly<Record<string, string>>;
}

export const BIAS_GROUPS: readonly BiasGroup[] = [
  { key: 'shot_size', label: '景别', options: ShotSize.options, labels: SHOT_SIZE_LABEL },
  { key: 'angle', label: '角度', options: CameraAngle.options, labels: ANGLE_LABEL },
  { key: 'lens', label: '镜头', options: LensClass.options, labels: LENS_LABEL },
  { key: 'movement', label: '运镜', options: Movement.options, labels: MOVEMENT_LABEL },
];

/** Add or remove one value; the result keeps the vocabulary's own order. */
export function toggleBias(bias: StyleBias, key: BiasKey, value: string): StyleBias {
  const group = BIAS_GROUPS.find((g) => g.key === key);
  if (!group) return bias;
  const current: readonly string[] = bias[key];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { ...bias, [key]: group.options.filter((o) => next.includes(o)) } as StyleBias;
}

/** The groups that have a preference, with Chinese labels ("景别 · 特写、近景"). */
export function biasSummary(bias: StyleBias): { key: BiasKey; label: string; values: string[] }[] {
  return BIAS_GROUPS.flatMap((g) => {
    const values = bias[g.key].map((v) => g.labels[v] ?? v);
    return values.length > 0 ? [{ key: g.key, label: g.label, values }] : [];
  });
}

// ------------------------------------------------------------------- form --

export const emptyStyleInput = (): StyleCardInput => ({
  name: '',
  summary: '',
  grammar: '',
  bias: { shot_size: [], angle: [], lens: [], movement: [] },
  gear: '',
  low_budget: '',
});

export function cardToInput(card: StyleCard): StyleCardInput {
  return {
    name: card.name,
    summary: card.summary,
    grammar: card.grammar,
    bias: {
      shot_size: [...card.bias.shot_size],
      angle: [...card.bias.angle],
      lens: [...card.bias.lens],
      movement: [...card.bias.movement],
    },
    gear: card.gear,
    low_budget: card.low_budget,
  };
}

export type StyleFormErrors = Partial<Record<'name' | 'summary' | 'grammar' | 'gear' | 'low_budget', string>>;

/** Same limits as the contract (UTF-16 length, after trimming), in plain Chinese. */
export function validateStyleForm(f: StyleCardInput): StyleFormErrors {
  const e: StyleFormErrors = {};
  const over = (label: string, s: string, max: number) => `${label}最多 ${max} 个字，现在 ${s.trim().length} 个`;
  const name = f.name.trim();
  if (name === '') e.name = '请填写名称';
  else if (name.length > STYLE_LIMITS.name) e.name = over('名称', name, STYLE_LIMITS.name);
  if (f.summary.trim().length > STYLE_LIMITS.summary) e.summary = over('一句话概括', f.summary, STYLE_LIMITS.summary);
  const grammar = f.grammar.trim();
  if (grammar === '') e.grammar = '请写下镜头语言：运镜、镜头、构图和节奏';
  else if (grammar.length > STYLE_LIMITS.grammar) e.grammar = over('镜头语言', grammar, STYLE_LIMITS.grammar);
  if (f.gear.trim().length > STYLE_LIMITS.gear) e.gear = over('器材与人手', f.gear, STYLE_LIMITS.gear);
  if (f.low_budget.trim().length > STYLE_LIMITS.low_budget) e.low_budget = over('低成本替代', f.low_budget, STYLE_LIMITS.low_budget);
  return e;
}

export function hasFormErrors(e: StyleFormErrors): boolean {
  return Object.keys(e).length > 0;
}

/** What is sent: text fields trimmed. */
export function normalizeStyleForm(f: StyleCardInput): StyleCardInput {
  return { ...f, name: f.name.trim(), summary: f.summary.trim(), grammar: f.grammar.trim(), gear: f.gear.trim(), low_budget: f.low_budget.trim() };
}

const COPY_SUFFIX = '（副本）';

/** "名称（副本）", the name cut (not the suffix) so the whole fits the 24-character limit. */
export function copyStyleName(name: string): string {
  const base = name.trim();
  const room = STYLE_LIMITS.name - COPY_SUFFIX.length;
  if (base.length <= room) return `${base}${COPY_SUFFIX}`;
  let kept = '';
  for (const ch of base) {
    if ((kept + ch).length > room) break;
    kept += ch;
  }
  return `${kept.trimEnd()}${COPY_SUFFIX}`;
}

/** A built-in or own card as the input of a new own card. */
export function copyOfCard(card: StyleCard): StyleCardInput {
  return { ...cardToInput(card), name: copyStyleName(card.name) };
}

// --------------------------------------------------------------- research --

export const CONFIDENCE_LABEL: Record<'high' | 'medium' | 'low', string> = { high: '高', medium: '中', low: '低' };

export interface ResearchReview {
  /** the editable card, clamped to the card limits */
  input: StyleCardInput;
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
}

/** The draft's output as a card to review; null when it does not read as a style. */
export function parseResearchDraft(draft: Pick<ShotDraft, 'parsed'>): ResearchReview | null {
  const r = StyleResearchOutput.safeParse(draft.parsed);
  if (!r.success) return null;
  return {
    input: styleCardInputFromResearch(r.data),
    confidence: r.data.confidence,
    caveats: r.data.caveats.map((c) => c.trim()).filter((c) => c !== ''),
  };
}

/** A pending research draft is worth resuming; the newest one first. */
export function pendingResearchDrafts(drafts: readonly Pick<ShotDraft, 'id' | 'kind' | 'status' | 'created_at'>[]): string[] {
  return drafts
    .filter((d) => d.kind === 'style' && d.status === 'pending')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((d) => d.id);
}

export function issuesOf(issues: readonly DraftIssue[], level: DraftIssue['level']): DraftIssue[] {
  return issues.filter((i) => i.level === level);
}

// ------------------------------------------------- breakdown form defaults --

/** The style the breakdown form shows: the user's own pick, else the group default; '' = 不指定. */
export function effectiveStyleId(chosen: string | null, library: Pick<StyleLibrary, 'cards' | 'defaults'> | undefined): string {
  if (!library) return chosen ?? '';
  const id = chosen ?? library.defaults.style_id ?? '';
  return id === '' || library.cards.some((c) => c.id === id) ? id : '';
}

export function effectiveLevel(chosen: StyleLevel | null, library: Pick<StyleLibrary, 'defaults'> | undefined): StyleLevel {
  return chosen ?? library?.defaults.level ?? 'steady';
}

/** "将发送本场 3 个段落、角色名单（2 人）、风格说明（名称）、你写的风格要求到" — what leaves the machine. */
export function outgoingSentence(a: { paragraphs: number; characters: number; styleName: string | null; hasStyleNote: boolean }): string {
  const items = [`本场 ${a.paragraphs} 个段落`, `角色名单（${a.characters} 人）`];
  if (a.styleName) items.push(`风格说明（${a.styleName}）`);
  if (a.hasStyleNote) items.push('你写的风格要求');
  return `将发送${items.join('、')}到`;
}
