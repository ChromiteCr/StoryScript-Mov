import {
  RISK_ALTERNATIVE_MAX,
  RISK_PROBLEM_MAX,
  RISKS_MAX,
  RISKS_PER_SCENE_MAX,
  type Paragraph,
  type ScriptCheckItem,
  type ScriptCheckOutput,
  type ScriptRiskCategory,
  type ScriptRiskSeverity,
} from '@storyscript/contracts';
import { matchQuote, normalizeForMatch, quoteIsExact } from './quote.ts';

/**
 * S5 剧本体检 — checking the model's difficulties against the script:
 *
 * - normalizeScriptCheckJson: enum spellings (中文名, 大小写, synonyms) and
 *   paragraph ids (p3 → p-003) before zod
 * - validateScriptCheck: what a repair round should fix (a quote not in the
 *   script, an empty or overlong text); a quote found in another paragraph
 *   is simply moved there, and repeats are merged, neither is an error
 * - finalizeScriptCheck: what is kept once the rounds are used up (quotes not
 *   found are dropped, long texts cut, at most 4 a scene and 60 in all)
 * - anchorQuote / sameRisk: finding a difficulty again in a later script
 *   version, and recognising it in a re-check (so its tick carries over)
 */

type Para = Pick<Paragraph, 'id' | 'text' | 'scene_idx'>;

const CATEGORY_WORDS: Record<string, ScriptRiskCategory> = {
  夜外景: 'night_exterior', 夜景: 'night_exterior', 夜戏: 'night_exterior', 夜外: 'night_exterior', night: 'night_exterior', night_ext: 'night_exterior', night_exteriors: 'night_exterior', exterior_night: 'night_exterior',
  雨水: 'rain_water', 雨: 'rain_water', 雨戏: 'rain_water', 水: 'rain_water', 水戏: 'rain_water', rain: 'rain_water', water: 'rain_water', rain_and_water: 'rain_water', weather: 'rain_water',
  车辆: 'vehicle', 车: 'vehicle', 车戏: 'vehicle', vehicles: 'vehicle', car: 'vehicle', cars: 'vehicle', traffic: 'vehicle',
  人群: 'crowd', 群演: 'crowd', 群众演员: 'crowd', crowds: 'crowd', extras: 'crowd',
  动物: 'animal', animals: 'animal', pet: 'animal', pets: 'animal',
  危险动作: 'stunt', 动作: 'stunt', 特技: 'stunt', 打斗: 'stunt', stunts: 'stunt', action: 'stunt', danger: 'stunt', dangerous_action: 'stunt',
  需审批场地: 'permit_location', 审批场地: 'permit_location', 场地: 'permit_location', 场地审批: 'permit_location', location: 'permit_location', permit: 'permit_location', permits: 'permit_location', location_permit: 'permit_location',
  特效: 'vfx', 视效: 'vfx', sfx: 'vfx', effects: 'vfx', special_effects: 'vfx', visual_effects: 'vfx',
  年代服化: 'period', 年代: 'period', 服化: 'period', 服装: 'period', 化妆: 'period', costume: 'period', costumes: 'period', makeup: 'period', period_costume: 'period',
};
const CATEGORIES: readonly ScriptRiskCategory[] = ['night_exterior', 'rain_water', 'vehicle', 'crowd', 'animal', 'stunt', 'permit_location', 'vfx', 'period'];

const SEVERITY_WORDS: Record<string, ScriptRiskSeverity> = {
  留意: 'low', 低: 'low', 轻: 'low', 轻微: 'low', 一般: 'low', easy: 'low', minor: 'low',
  较难: 'medium', 中: 'medium', 中等: 'medium', 有难度: 'medium', med: 'medium', moderate: 'medium',
  很难: 'high', 高: 'high', 难: 'high', 严重: 'high', hard: 'high', severe: 'high', major: 'high',
};
const SEVERITY_RANK: Record<ScriptRiskSeverity, number> = { low: 0, medium: 1, high: 2 };

const key = (v: string) => v.trim().toLowerCase().replace(/[\s-]+/g, '_');

function normCategory(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const k = key(v);
  return (CATEGORIES as readonly string[]).includes(k) ? k : (CATEGORY_WORDS[k] ?? CATEGORY_WORDS[v.trim()] ?? k);
}

function normSeverity(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const k = key(v);
  return k === 'low' || k === 'medium' || k === 'high' ? k : (SEVERITY_WORDS[k] ?? SEVERITY_WORDS[v.trim()] ?? k);
}

function normParagraphId(v: unknown): unknown {
  if (typeof v === 'number' && Number.isInteger(v)) return `p-${String(v).padStart(3, '0')}`;
  if (typeof v !== 'string') return v;
  const m = /^\[?\s*p?-?(\d+)\s*\]?$/i.exec(v.trim());
  return m ? `p-${m[1]!.padStart(3, '0')}` : v.trim();
}

const text = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v.trim() : v);

export function normalizeScriptCheckJson(raw: unknown): unknown {
  let list: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    list = o.risks ?? o.items ?? o.difficulties ?? o.issues ?? [];
  }
  if (!Array.isArray(list)) return raw;
  return {
    risks: list.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const it = item as Record<string, unknown>;
      return {
        paragraph_id: normParagraphId(it.paragraph_id ?? it.paragraph ?? it.pid),
        category: normCategory(it.category ?? it.type),
        severity: normSeverity(it.severity ?? it.level),
        quote: text(it.quote),
        problem: text(it.problem ?? it.reason),
        alternative: text(it.alternative ?? it.suggestion),
      };
    }),
  };
}

const len = (s: string) => Array.from(s).length;
const cut = (s: string, max: number) => (len(s) <= max ? s : `${Array.from(s).slice(0, max - 1).join('')}…`);

interface Placed {
  item: ScriptCheckItem;
  /** null when the quote is nowhere in the script */
  paragraph: Para | null;
  index: number;
}

function place(out: ScriptCheckOutput, paragraphs: readonly Para[]): Placed[] {
  const byId = new Map(paragraphs.map((p) => [p.id, p] as const));
  return out.risks.map((item, index) => {
    const own = byId.get(item.paragraph_id);
    if (own && item.quote.trim() && matchQuote(item.quote, own.text).level !== 'rejected') return { item, paragraph: own, index };
    const other = item.quote.trim() ? paragraphs.find((p) => quoteIsExact(item.quote, p.text)) : undefined;
    return other ? { item: { ...item, paragraph_id: other.id }, paragraph: other, index } : { item, paragraph: null, index };
  });
}

export interface ScriptCheckValidation {
  /** messages for a repair round; empty when the answer is usable as is */
  errors: string[];
}

export function validateScriptCheck(out: ScriptCheckOutput, paragraphs: readonly Para[]): ScriptCheckValidation {
  const errors: string[] = [];
  for (const { item, paragraph, index } of place(out, paragraphs)) {
    const n = `第 ${index + 1} 条`;
    if (!paragraph) errors.push(`${n}：引用「${cut(item.quote, 24)}」在段落 ${item.paragraph_id} 里找不到，请从该段逐字复制一段连续原文`);
    if (!item.problem) errors.push(`${n}：problem 不能为空`);
    else if (len(item.problem) > RISK_PROBLEM_MAX) errors.push(`${n}：problem 超过 ${RISK_PROBLEM_MAX} 字，请缩短`);
    if (!item.alternative) errors.push(`${n}：alternative 不能为空，请给一条学生能做到的替代拍法`);
    else if (len(item.alternative) > RISK_ALTERNATIVE_MAX) errors.push(`${n}：alternative 超过 ${RISK_ALTERNATIVE_MAX} 字，请缩短`);
  }
  return { errors };
}

export interface FinalizedScriptCheck {
  items: ScriptCheckItem[];
  /** quotes not found in the script (or no alternative), left out */
  dropped: number;
  /** texts cut to the limit */
  truncated: number;
  /** repeats merged and items over the per-scene / total caps */
  merged: number;
  capped: number;
}

/** What is kept of an answer: found, merged, cut, capped, in script order. */
export function finalizeScriptCheck(out: ScriptCheckOutput, paragraphs: readonly Para[]): FinalizedScriptCheck {
  const order = new Map(paragraphs.map((p, i) => [p.id, i] as const));
  let dropped = 0;
  let truncated = 0;
  let merged = 0;
  const kept = new Map<string, { item: ScriptCheckItem; scene: number | null; index: number }>();
  for (const { item, paragraph, index } of place(out, paragraphs)) {
    if (!paragraph || !item.alternative) {
      dropped++;
      continue;
    }
    const problem = cut(item.problem, RISK_PROBLEM_MAX);
    const alternative = cut(item.alternative, RISK_ALTERNATIVE_MAX);
    if (problem !== item.problem || alternative !== item.alternative) truncated++;
    const k = `${paragraph.id}|${item.category}`;
    const prev = kept.get(k);
    if (prev) {
      merged++;
      if (SEVERITY_RANK[item.severity] > SEVERITY_RANK[prev.item.severity]) prev.item = { ...prev.item, severity: item.severity };
      continue;
    }
    kept.set(k, { item: { ...item, paragraph_id: paragraph.id, problem, alternative }, scene: paragraph.scene_idx, index });
  }
  // the worst first within a scene when capping, then back to script order
  const perScene = new Map<string, number>();
  let capped = 0;
  const ranked = [...kept.values()].sort(
    (a, b) => SEVERITY_RANK[b.item.severity] - SEVERITY_RANK[a.item.severity] || (order.get(a.item.paragraph_id) ?? 0) - (order.get(b.item.paragraph_id) ?? 0) || a.index - b.index,
  );
  const chosen: typeof ranked = [];
  for (const r of ranked) {
    const s = String(r.scene);
    const n = perScene.get(s) ?? 0;
    if (n >= RISKS_PER_SCENE_MAX || chosen.length >= RISKS_MAX) {
      capped++;
      continue;
    }
    perScene.set(s, n + 1);
    chosen.push(r);
  }
  chosen.sort((a, b) => (order.get(a.item.paragraph_id) ?? 0) - (order.get(b.item.paragraph_id) ?? 0) || a.index - b.index);
  return { items: chosen.map((r) => r.item), dropped, truncated, merged, capped };
}

/**
 * Where a quote is in (another version of) the script: its own paragraph if
 * the quote still matches there, else the first paragraph holding it
 * exactly; null when it is gone (the difficulty is then stale).
 */
export function anchorQuote(quote: string, paragraphId: string, paragraphs: readonly Pick<Paragraph, 'id' | 'text'>[]): string | null {
  if (!quote.trim()) return null;
  const own = paragraphs.find((p) => p.id === paragraphId);
  if (own && matchQuote(quote, own.text).level !== 'rejected') return own.id;
  return paragraphs.find((p) => quoteIsExact(quote, p.text))?.id ?? null;
}

/** The same difficulty in two checks: same kind, and one quote holds the other. */
export function sameRisk(a: { category: string; quote: string }, b: { category: string; quote: string }): boolean {
  if (a.category !== b.category) return false;
  const qa = normalizeForMatch(a.quote);
  const qb = normalizeForMatch(b.quote);
  return qa.length > 0 && qb.length > 0 && (qa.includes(qb) || qb.includes(qa));
}
