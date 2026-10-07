import type { Emotion, TimeOfDay } from '@storyscript/contracts';

/**
 * S5b: what people feel in a shot and what time of day it is, read from the
 * shot's own words when nobody said. Pure; no model.
 *
 * Emotions come from a keyword table over the shot's action text (longest
 * word first), each clause's feeling going to the first person it names, or
 * — Chinese drops the subject — to the last person named before it. A person
 * with several feelings keeps the last one: a shot usually ends on the
 * reaction.
 */

const WORDS: Record<Exclude<Emotion, 'neutral'>, readonly string[]> = {
  happy: ['笑', '微笑', '大笑', '笑着', '笑了', '开心', '高兴', '兴奋', '得意', '欣喜', '欢呼', '喜悦', '傻笑', '咧嘴'],
  sad: ['哭', '流泪', '泪', '难过', '伤心', '悲', '失落', '沮丧', '哽咽', '抽泣', '叹气', '苦笑', '落寞', '垂头'],
  angry: ['怒', '生气', '愤怒', '吼', '咆哮', '瞪', '骂', '拍桌', '摔门', '冷笑', '恼', '火冒'],
  afraid: ['害怕', '怕', '恐惧', '惊恐', '发抖', '颤抖', '后退', '退后', '躲', '吓'],
  surprised: ['吃惊', '惊讶', '震惊', '愣住', '愣', '目瞪口呆', '瞪大眼', '惊', '诧异'],
  tense: ['紧张', '不安', '焦急', '犹豫', '皱眉', '担心', '忐忑', '屏住呼吸', '咬唇', '攥紧'],
};

/** Every keyword, longest first (a longer word wins where both match: 苦笑 over 笑, 惊恐 over 惊). */
const KEYWORDS: readonly { word: string; emotion: Emotion }[] = Object.entries(WORDS)
  .flatMap(([emotion, words]) => words.map((word) => ({ word, emotion: emotion as Emotion })))
  .sort((a, b) => b.word.length - a.word.length || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));

/**
 * A word with a negation just before it does not count (没哭, 不笑, 不是害怕,
 * 没那么害怕); 不禁 / 忍不住 / 禁不住 / 不由得 are not negations (忍不住哭 is sad).
 */
const NEGATION = /[不没别未]/;
const NOT_NEGATION = /(不禁|忍不住|禁不住|不由得|不由|止不住|不住)/g;
const NEGATION_WINDOW = 4;

const CLAUSE = /[。！？!?；;，,、\n]+/;

export interface EmotionPerson {
  alias: string;
  label: string;
  /** other names the text may use (the character's aliases: 老林 for 林川) */
  names?: readonly string[];
}

interface Hit {
  at: number;
  emotion: Emotion;
}

/** The feelings in one clause, in reading order. */
function clauseHits(clause: string): Hit[] {
  const taken = new Array<boolean>(clause.length).fill(false);
  const hits: Hit[] = [];
  for (const { word, emotion } of KEYWORDS) {
    let from = 0;
    for (;;) {
      const at = clause.indexOf(word, from);
      if (at < 0) break;
      from = at + 1;
      let free = true;
      for (let i = at; i < at + word.length; i++) if (taken[i]) free = false;
      if (!free) continue;
      for (let i = at; i < at + word.length; i++) taken[i] = true;
      const before = clause.slice(Math.max(0, at - NEGATION_WINDOW), at).replace(NOT_NEGATION, '');
      if (NEGATION.test(before)) continue;
      hits.push({ at, emotion });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

const WORDISH = /[0-9A-Za-z_]/;

/** Where `name` first stands in `text` as a whole word: an ASCII name (c1) must not run on into letters or digits (c12). */
function findName(text: string, name: string): number {
  const ascii = /^[0-9A-Za-z_]+$/.test(name);
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at < 0 || !ascii) return at;
    if (!WORDISH.test(text[at - 1] ?? '') && !WORDISH.test(text[at + name.length] ?? '')) return at;
    from = at + 1;
  }
}

/** Who a clause is about: the first person named in it (by name, alias or code; the longest name first at a place). */
function firstNamed(clause: string, people: readonly EmotionPerson[]): string | null {
  let best: { at: number; len: number; alias: string } | null = null;
  for (const p of people) {
    for (const name of [p.label, ...(p.names ?? []), p.alias]) {
      if (!name) continue;
      const at = findName(clause, name);
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && name.length > best.len)) best = { at, len: name.length, alias: p.alias };
    }
  }
  return best?.alias ?? null;
}

/**
 * The feeling of each person in `people` that the text gives one to. Only
 * people in the list get one; with a single person and no name in the text,
 * the feeling is theirs.
 */
export function inferEmotions(text: string | null | undefined, people: readonly EmotionPerson[]): Map<string, Emotion> {
  const out = new Map<string, Emotion>();
  if (!text || people.length === 0) return out;
  let current: string | null = null;
  for (const clause of text.split(CLAUSE)) {
    if (!clause) continue;
    const named = firstNamed(clause, people);
    if (named) current = named;
    const hits = clauseHits(clause);
    if (hits.length === 0) continue;
    const who = current ?? (people.length === 1 ? (people[0] as EmotionPerson).alias : null);
    if (who) out.set(who, (hits[hits.length - 1] as Hit).emotion);
  }
  return out;
}

/** The action first; the shot's purpose only when the action gives nobody a feeling. */
export function shotEmotions(fields: { action: string; narrative_purpose: string }, people: readonly EmotionPerson[]): Map<string, Emotion> {
  const fromAction = inferEmotions(fields.action, people);
  return fromAction.size ? fromAction : inferEmotions(fields.narrative_purpose, people);
}

/** Words that are night whatever else the label says (凌晨 before the 晨 of dawn). */
const NIGHT = /(夜|深夜|午夜|凌晨|半夜|子夜|NIGHT|MIDNIGHT)/i;
/** A low sun: evening and the first light (早晨 / 早上 are plain morning: day). */
const DUSK = /(黄昏|傍晚|日落|夕阳|薄暮|昏|霞|清晨|黎明|拂晓|日出|破晓|^晨$|DUSK|DAWN|SUNSET|SUNRISE|EVENING)/i;
/** "Same time as the scene before" (Fountain CONTINUOUS / LATER, 稍后, 接上): the light of that scene. */
const CONTINUITY = /^(CONTINUOUS|CONT'?D|LATER|MOMENTS LATER|SAME|SAME TIME|稍后|片刻后|同时|接上|接上场|连续|同上)$/i;

/** Whether a time label means "same as the scene before" (the caller carries that scene's time). */
export function isContinuityTime(label: string | null | undefined): boolean {
  return !!label && CONTINUITY.test(label.trim());
}

/**
 * The light a scene heading's time asks for: 夜 / 晚上 / 凌晨 → night, 黄昏 /
 * 傍晚 / 清晨 / 晚霞 → dusk (a low sun), anything else (日, 早上, 早晨, 下午,
 * none) → day. 傍晚 is dusk, a bare 晚 (not 晚饭) is night. A continuity label
 * (CONTINUOUS, 稍后) is day here: resolve it to the scene before first.
 */
export function timeOfDay(label: string | null | undefined): TimeOfDay {
  if (!label) return 'day';
  const t = label.trim();
  if (NIGHT.test(t)) return 'night';
  if (DUSK.test(t)) return 'dusk';
  if (/晚(?!餐|饭|会)/.test(t)) return 'night';
  return 'day';
}
