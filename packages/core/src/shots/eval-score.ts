import type { EntitiesOutput, ParsedScript, ShotFields } from '@storyscript/contracts';
import { matchQuote, normalizeForMatch } from '../script/quote.ts';

/**
 * Scoring of the breakdown evaluation against the pre-registered checklist
 * fixtures/scripts/expected.json (docs/eval). Pure: the eval script feeds it
 * the parse result, the extracted entities and the per-scene shot lists.
 */

export interface MustInclude {
  id: string;
  desc: string;
  any_of_sizes?: string[];
  any_of_templates?: string[];
  any_of_motion?: string[];
  quote_contains_any?: string[];
  dialogue_contains_any?: string[];
}

export interface ExpectedSceneBreakdown {
  scene: string;
  min_shots: number;
  max_shots: number;
  must_include: MustInclude[];
}

export interface ExpectedScript {
  file: string;
  format: string;
  scenes: { display_no: string; heading_contains: string; time_label: string | null }[];
  characters: { name: string; aliases_any: string[] }[];
  mentioned_not_present: string[];
  breakdown: ExpectedSceneBreakdown[];
}

export interface ExpectedChecklist {
  scripts: ExpectedScript[];
}

export type CheckKind = 'scene_count' | 'scene' | 'character' | 'absent' | 'shot_count' | 'must_include';

export interface CheckResult {
  id: string;
  kind: CheckKind;
  desc: string;
  pass: boolean;
  detail: string;
}

export interface SceneBreakdownScore {
  scene: string;
  shot_count: number;
  checks: CheckResult[];
  /** shots whose quote is exact/fuzzy in the cited paragraph */
  quotes_located: number;
  quotes_total: number;
  /** subject / pov aliases not on the roster */
  off_roster: number;
}

const has = (list: readonly string[] | undefined, v: string | null) => !list || list.length === 0 || (v !== null && list.includes(v));
const containsAny = (text: string | null, needles: readonly string[] | undefined) => {
  if (!needles || needles.length === 0) return true;
  if (text === null) return false;
  const t = normalizeForMatch(text);
  return needles.some((n) => t.includes(normalizeForMatch(n)));
};

/** Does one shot satisfy every criterion of a must_include item? */
export function shotSatisfies(shot: ShotFields, m: MustInclude): boolean {
  return (
    has(m.any_of_sizes, shot.shot_size) &&
    has(m.any_of_templates, shot.template) &&
    has(m.any_of_motion, shot.subject_motion) &&
    containsAny(shot.source.quote, m.quote_contains_any) &&
    containsAny(shot.dialogue_quote, m.dialogue_contains_any)
  );
}

export function scoreScenes(expected: ExpectedScript, parsed: Pick<ParsedScript, 'scenes'>): CheckResult[] {
  const out: CheckResult[] = [
    {
      id: `${expected.file}#scenes`,
      kind: 'scene_count',
      desc: '场景数量',
      pass: parsed.scenes.length === expected.scenes.length,
      detail: `期望 ${expected.scenes.length}，实际 ${parsed.scenes.length}`,
    },
  ];
  expected.scenes.forEach((e, i) => {
    const got = parsed.scenes[i];
    const pass =
      got !== undefined &&
      got.display_no === e.display_no &&
      got.heading.includes(e.heading_contains) &&
      got.time_label === e.time_label;
    out.push({
      id: `${expected.file}#scene-${e.display_no}`,
      kind: 'scene',
      desc: `场 ${e.display_no}：标题含「${e.heading_contains}」，时间 ${e.time_label ?? '无'}`,
      pass,
      detail: got ? `display_no=${got.display_no} heading=${got.heading} time=${got.time_label ?? 'null'}` : '缺失',
    });
  });
  return out;
}

function namesOf(e: { name: string; aliases: string[] }): string[] {
  return [e.name, ...e.aliases].map((s) => s.trim()).filter(Boolean);
}

export function scoreCharacters(expected: ExpectedScript, extracted: EntitiesOutput | null): CheckResult[] {
  const chars = extracted?.characters ?? [];
  const out: CheckResult[] = [];
  for (const c of expected.characters) {
    const hit = chars.find((x) => namesOf(x).includes(c.name));
    const aliasOk = c.aliases_any.length === 0 || (hit !== undefined && c.aliases_any.some((a) => namesOf(hit).includes(a)));
    out.push({
      id: `${expected.file}#char-${c.name}`,
      kind: 'character',
      desc: `角色「${c.name}」${c.aliases_any.length ? `（别名含 ${c.aliases_any.join('/')}）` : ''}`,
      pass: hit !== undefined && aliasOk,
      detail: hit ? `抽取为 ${hit.name}${hit.aliases.length ? `（${hit.aliases.join('、')}）` : ''}` : '未抽取到',
    });
  }
  for (const name of expected.mentioned_not_present) {
    const wrong = chars.find((x) => namesOf(x).some((n) => n === name || n.includes(name)));
    out.push({
      id: `${expected.file}#absent-${name}`,
      kind: 'absent',
      desc: `只被提及、未出场的「${name}」不应列为角色`,
      pass: wrong === undefined,
      detail: wrong ? `被列为 ${wrong.name}` : '未列入',
    });
  }
  return out;
}

export function scoreSceneBreakdown(
  file: string,
  expected: ExpectedSceneBreakdown,
  shots: readonly ShotFields[],
  ctx: { paragraphs: readonly { id: string; text: string }[]; aliases: readonly string[] },
): SceneBreakdownScore {
  const checks: CheckResult[] = [
    {
      id: `${file}#s${expected.scene}-count`,
      kind: 'shot_count',
      desc: `场 ${expected.scene} 镜头数在 [${expected.min_shots}, ${expected.max_shots}]`,
      pass: shots.length >= expected.min_shots && shots.length <= expected.max_shots,
      detail: `实际 ${shots.length}`,
    },
  ];
  for (const m of expected.must_include) {
    const idx = shots.findIndex((s) => shotSatisfies(s, m));
    checks.push({
      id: `${file}#${m.id}`,
      kind: 'must_include',
      desc: m.desc,
      pass: idx >= 0,
      detail: idx >= 0 ? `镜头 #${idx + 1}` : '无满足条件的镜头',
    });
  }
  const texts = new Map(ctx.paragraphs.map((p) => [p.id, p.text]));
  let located = 0;
  let off = 0;
  const roster = new Set(ctx.aliases);
  for (const s of shots) {
    const t = texts.get(s.source.paragraph_id);
    if (t !== undefined && matchQuote(s.source.quote, t).level !== 'rejected') located++;
    for (const sub of s.subjects) if (!roster.has(sub.alias)) off++;
    if (s.pov_owner !== null && !roster.has(s.pov_owner)) off++;
  }
  return { scene: expected.scene, shot_count: shots.length, checks, quotes_located: located, quotes_total: shots.length, off_roster: off };
}

export interface ScoreSummary {
  total: number;
  passed: number;
  /** 0..1, 0 when there is nothing to score */
  rate: number;
}

export function summarize(checks: readonly CheckResult[]): ScoreSummary {
  const passed = checks.filter((c) => c.pass).length;
  return { total: checks.length, passed, rate: checks.length ? passed / checks.length : 0 };
}

/** Breakdown pass rate as defined by expected.json: shot-count ranges + must_include items. */
export function breakdownSummary(scores: readonly SceneBreakdownScore[]): ScoreSummary {
  return summarize(scores.flatMap((s) => s.checks));
}
