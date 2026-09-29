import type { CastMatch, CastSuggestion } from '@storyscript/contracts';

/**
 * S3b: read the cast list at the top of a script ("人物：" and the lines
 * after it) and say who plays which character. No model: the script already
 * says it. Accepted line shapes:
 *   演员：角色：简介      周远：林川：主角
 *   角色：演员            林川：周远
 *   演员 饰 角色          周远 饰 林川
 *   角色（演员 饰）       林川（周远 饰）
 *   角色——演员           林川——周远
 * Which side is the character comes from the existing characters (name,
 * alias, or a near match); lines that match none take the orientation the
 * rest of the list uses. A description ("高二学生，沉默寡言") is never an actor.
 */

export interface CastCharacter {
  id: string;
  name: string;
  aliases: readonly string[];
  actor_name: string | null;
}

// no two adjacent \s* runs: this runs on whatever a user pastes (linear time on long lines)
const HEADER = /^[\s【[（(]*(?:主要)?(?:出场)?(?:人物(?:表|介绍|小传)?|角色(?:表|介绍)?|演员(?:表)?|演职人员(?:表)?|主演|cast(?: list)?)[\s】\]）)]*(?:[：:]\s*)?$/i;
/** the end of the cast block: the script body or a scene starts */
const END = /^\s*[【[]?\s*(?:剧本|正文|故事|剧情|梗概|大纲|简介|第.{1,4}[场幕集]|场景?\s*[一二三四五六七八九十百0-9])/;
const MAX_BLOCK = 60;
/** cast lines are short; longer lines are skipped before any pattern runs on them */
const MAX_LINE = 200;
/** "1、" "1." "(1)" "①" "一、" "- " "• " in front of a cast line */
const LIST_MARKER = /^(?:[-*+•·●▪◦–]|[①-⑳]|[（(]\s*(?:\d{1,3}|[一二三四五六七八九十]{1,3})\s*[）)]|(?:\d{1,3}|[一二三四五六七八九十]{1,3})\s*[.、．,，)）])\s*/;

/** Lines of the cast block among the paragraphs before the first scene (header found), else the lines that say 饰. */
export function castBlockLines(preScene: readonly string[]): string[] {
  const lines = preScene
    .flatMap((p) => p.split(/\r?\n/))
    .map((l) => l.trim())
    .filter((l) => l.length <= MAX_LINE)
    .map((l) => l.replace(LIST_MARKER, ''));
  const start = lines.findIndex((l) => HEADER.test(l));
  if (start >= 0) {
    const out: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (END.test(l) || HEADER.test(l)) break;
      if (l) out.push(l);
      if (out.length >= MAX_BLOCK) break;
    }
    return out;
  }
  return lines.filter((l) => /饰/.test(l)).slice(0, MAX_BLOCK);
}

/** "周远、孙晴 / 沈乐" → ["周远", "孙晴", "沈乐"] */
export function splitActorNames(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[、，,;；/]/)) {
    const t = part.trim().replace(/\s+/g, ' ');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const SENTENCE = /[，。；！？,.;!?]/;
/** could be a person's name (or "某老师加一位同学"): short, no sentence punctuation */
function actorLike(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && [...t].length <= 16 && !SENTENCE.test(t);
}

/** a description, not a name: "高二学生" "林川的同桌" "17岁" "男主" */
const DESCRIPTION = /[的0-9０-９]|(?:学生|同学|同桌|主角|男主|女主|配角|岁)$/;
function nameLike(s: string): boolean {
  return actorLike(s) && !DESCRIPTION.test(s.trim());
}

/** Kinship and similar words: 父亲/母亲 differ by one character but are different people. */
const DISTINCT = new Set([...'父母男女兄弟姐妹哥爷奶叔姨舅婶伯公婆夫妻儿孙老少大小前后甲乙丙丁一二三四']);

function oneEditApart(a: string, b: string): boolean {
  const x = [...a];
  const y = [...b];
  if (x.length !== y.length || x.length < 3) return false;
  const diff = x.map((c, i) => [c, y[i]!] as const).filter(([c, d]) => c !== d);
  return diff.length === 1 && !DISTINCT.has(diff[0]![0]) && !DISTINCT.has(diff[0]![1]);
}

interface Hit {
  c: CastCharacter;
  match: Exclude<CastMatch, 'none'>;
  /** the alias that matched (match = alias) */
  alias: string | null;
}

function matchOne(label: string, chars: readonly CastCharacter[]): Hit | null {
  const t = label.trim();
  if (!t) return null;
  // "林川（主角）" / "林川（男，17岁）": a trailing note in brackets is not part of the name
  const bare = t.replace(/\s*[（(][^（）()]*[）)]\s*$/, '');
  if (bare && bare !== t) {
    const h = matchOne(bare, chars);
    if (h) return h;
  }
  const exact = chars.find((c) => c.name === t);
  if (exact) return { c: exact, match: 'exact', alias: null };
  const alias = chars.find((c) => c.aliases.includes(t));
  if (alias) return { c: alias, match: 'alias', alias: t };
  // "图书馆的老师" → 老师; "利奥波得" ~ "利奥波德"
  const suffix = chars.find((c) => [...c.name].length >= 2 && t.endsWith(c.name) && t.slice(0, t.length - c.name.length).endsWith('的'));
  if (suffix) return { c: suffix, match: 'near', alias: null };
  const near = chars.find((c) => oneEditApart(t, c.name) || c.aliases.some((a) => oneEditApart(t, a)));
  return near ? { c: near, match: 'near', alias: null } : null;
}

/** "教授，校领导" → both; a single label → itself */
function matchLabels(label: string, chars: readonly CastCharacter[]): { label: string; hit: Hit | null }[] {
  const whole = matchOne(label, chars);
  if (whole) return [{ label: label.trim(), hit: whole }];
  const parts = label.split(/[、，,/]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [{ label: label.trim(), hit: null }];
  const hits = parts.map((p) => ({ label: p, hit: matchOne(p, chars) }));
  return hits.some((h) => h.hit) ? hits : [{ label: label.trim(), hit: null }];
}

interface Raw {
  line: string;
  actor: string;
  labels: { label: string; hit: Hit | null }[];
}

type Orientation = 'actor_first' | 'character_first';

/** "曹某 饰" / "饰演：曹某" → "曹某" */
function cleanActor(s: string): string {
  return s.replace(/^(?:饰演?|演员)\s*[：:]?\s*/, '').replace(/\s*饰演?$/, '').trim();
}

/** One line → the actor and the character label(s), or null when the line names no actor. */
function readLine(line: string, chars: readonly CastCharacter[], orientation: Orientation | null): Raw | null {
  // 角色（演员 饰） / 角色（饰演：演员）
  let m = /^(.+?)\s*[（(]\s*(?:饰演?[：:]?\s*)?([^（）()]+?)\s*(?:饰演?)?\s*[）)]\s*.*$/.exec(line);
  if (m && /[（(]\s*(?:饰演?[：:]?\s*)?[^（）()]*?\s*饰演?\s*[）)]|[（(]\s*饰演?[：:]?/.test(line)) {
    const [, label, actor] = m;
    return actorLike(actor!) ? { line, actor: cleanActor(actor!), labels: matchLabels(label!, chars) } : null;
  }
  // 演员 饰 角色（简介）
  m = /^(.+?)\s*饰演?\s*[：:]?\s*([^：:，,（(]+).*$/.exec(line);
  // a colon or dash before 饰 means the colon format ("周远：林川：服饰讲究"), not "演员 饰 角色"
  if (m && !/[：:]|——|—|--|－/.test(cleanActor(m[1]!))) {
    const [, actor, label] = m;
    return actorLike(actor!) ? { line, actor: cleanActor(actor!), labels: matchLabels(label!, chars) } : null;
  }
  // colon or dash separated
  const parts = line
    .split(/\s*(?:[：:]|——|—|--|－)\s*/)
    .map((p) => cleanActor(p))
    .filter(Boolean);
  if (parts.length < 2) return null;
  const [p0, p1] = [parts[0]!, parts[1]!];
  const m0 = matchLabels(p0, chars);
  const m1 = matchLabels(p1, chars);
  const hit0 = m0.some((x) => x.hit);
  const hit1 = m1.some((x) => x.hit);
  if (hit1 && !hit0 && actorLike(p0)) return { line, actor: p0, labels: m1 };
  if (hit0 && !hit1 && nameLike(p1)) return { line, actor: p1, labels: m0 };
  if (!hit0 && !hit1 && actorLike(p0) && actorLike(p1)) {
    // nothing known: follow the rest of the list (演员：角色 by default when a description follows)
    const first = orientation ?? (parts.length >= 3 ? 'actor_first' : null);
    if (first === 'actor_first') return { line, actor: p0, labels: m1 };
    if (first === 'character_first' && nameLike(p1)) return { line, actor: p1, labels: m0 };
  }
  return null;
}

function orientationOf(lines: readonly string[], chars: readonly CastCharacter[]): Orientation | null {
  let a = 0;
  let c = 0;
  for (const line of lines) {
    const parts = line.split(/\s*(?:[：:]|——|—|--|－)\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2 || /饰/.test(line)) continue;
    const h0 = matchLabels(parts[0]!, chars).some((x) => x.hit);
    const h1 = matchLabels(parts[1]!, chars).some((x) => x.hit);
    if (h1 && !h0) a++;
    if (h0 && !h1) c++;
  }
  return a === c ? null : a > c ? 'actor_first' : 'character_first';
}

/**
 * Who plays whom, from the paragraphs before the first scene. A label that
 * is only an alias of a character another actor plays ("林川长大后") is
 * offered as its own character (split_alias).
 */
export function readCastList(preScene: readonly string[], characters: readonly CastCharacter[]): CastSuggestion[] {
  const lines = castBlockLines(preScene);
  const orientation = orientationOf(lines, characters);
  const raws = lines.map((l) => readLine(l, characters, orientation)).filter((r): r is Raw => r !== null);

  // the actor each character gets from lines naming it directly (not through an alias)
  const direct = new Map<string, string>();
  for (const r of raws) for (const { hit } of r.labels) if (hit && hit.match !== 'alias' && !direct.has(hit.c.id)) direct.set(hit.c.id, r.actor);

  const out: CastSuggestion[] = [];
  const seen = new Set<string>();
  for (const r of raws) {
    for (const { label, hit } of r.labels) {
      let split: string | null = null;
      if (hit?.match === 'alias') {
        const main = direct.get(hit.c.id) ?? hit.c.actor_name;
        if (main && main !== r.actor) split = hit.alias;
      }
      const key = `${hit && !split ? hit.c.id : `label:${label}`}|${r.actor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        line: r.line,
        actor_name: r.actor,
        character_label: label,
        entity_id: hit ? hit.c.id : null,
        entity_name: hit ? hit.c.name : null,
        match: hit ? hit.match : 'none',
        split_alias: split,
        current: !!hit && !split && splitActorNames(hit.c.actor_name ?? '').includes(r.actor),
      });
    }
  }
  return out;
}
