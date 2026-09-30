import type { ActorRef, CommentMention } from '@storyscript/contracts';
import { actorText, CREW_PRESETS } from './crew.ts';

/**
 * S4b — @mentions in a comment. Pure: what the picker offers, what the
 * textarea is asking for while someone types `@`, how a chosen name goes into
 * the text, and how the finished text turns back into the structured
 * mentions the server takes (`{ member }` or `{ role }`). The server checks
 * the roster again; this only keeps the form honest.
 *
 * The text keeps plain `@小林` / `@导演` tokens, so what is sent is what the
 * teammate reads. A role reaches everyone who holds it when the comment is
 * written (the server expands it).
 */

/** The bits of a group member the picker needs (a GroupMember fits). */
export interface RosterMember {
  id: string;
  name: string;
  crew_roles: readonly string[];
  /** the signed-in member */
  you?: boolean;
}

export interface MemberCandidate {
  kind: 'member';
  key: string;
  /** what follows the @ in the text */
  label: string;
  member: RosterMember;
}

export interface RoleCandidate {
  kind: 'role';
  key: string;
  label: string;
  role: string;
  /** everyone who holds it now, roster order */
  holders: readonly RosterMember[];
}

export type MentionCandidate = MemberCandidate | RoleCandidate;

/** Where a mention query starts and ends: `@小` with the caret after 小. */
export interface ActiveMention {
  start: number;
  end: number;
  query: string;
}

export const MENTION_QUERY_MAX = 20;

/**
 * The text after @ for each member: the name, and `name#2` for the second of
 * two people who share a name (names are not unique in a group).
 */
function memberLabels(members: readonly RosterMember[]): string[] {
  const total = new Map<string, number>();
  for (const m of members) total.set(m.name, (total.get(m.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return members.map((m) => {
    if ((total.get(m.name) ?? 0) < 2) return m.name;
    const n = (seen.get(m.name) ?? 0) + 1;
    seen.set(m.name, n);
    return `${m.name}#${n}`;
  });
}

/** Roles that at least one member holds: the presets in their usual order, then any custom ones as they appear. */
export function heldRoles(members: readonly RosterMember[]): string[] {
  const held = new Set<string>();
  for (const m of members) for (const r of m.crew_roles) held.add(r);
  const presets = CREW_PRESETS.filter((r) => held.has(r));
  const custom: string[] = [];
  for (const m of members) for (const r of m.crew_roles) if (!CREW_PRESETS.includes(r) && !custom.includes(r)) custom.push(r);
  return [...presets, ...custom];
}

/**
 * Everything that can follow an @: the members (roster order), then the roles
 * somebody holds. `includeSelf` false leaves the signed-in member out of the
 * list the picker shows; parsing a finished text keeps them in.
 */
export function mentionCandidates(members: readonly RosterMember[], opts: { includeSelf?: boolean } = {}): MentionCandidate[] {
  const labels = memberLabels(members);
  const people: MentionCandidate[] = members
    .map((member, i): MemberCandidate => ({ kind: 'member', key: `member:${member.id}`, label: labels[i] ?? member.name, member }))
    .filter((c) => opts.includeSelf === true || c.member.you !== true);
  const roles: MentionCandidate[] = heldRoles(members).map(
    (role): RoleCandidate => ({ kind: 'role', key: `role:${role}`, label: role, role, holders: members.filter((m) => m.crew_roles.includes(role)) }),
  );
  return [...people, ...roles];
}

/** A word character in front of the @ means an address (a@b.com), not a mention. */
const WORD_BEFORE = /[A-Za-z0-9_]/;

/** The `@` the caret is in the middle of typing, or null. */
export function activeMention(text: string, caret: number): ActiveMention | null {
  const end = Math.max(0, Math.min(caret, text.length));
  const upto = text.slice(0, end);
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && WORD_BEFORE.test(upto.charAt(at - 1))) return null;
  const query = upto.slice(at + 1);
  if (/[\s@]/.test(query) || query.length > MENTION_QUERY_MAX) return null;
  return { start: at, end, query };
}

/** What the picker lists for this query: a label that starts with it, then one that contains it, then members whose role matches. Empty query: everything. */
export function filterCandidates(cands: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...cands];
  const scored: { c: MentionCandidate; score: number; i: number }[] = [];
  cands.forEach((c, i) => {
    const label = c.label.toLowerCase();
    let score: number | null = null;
    if (label.startsWith(q)) score = 0;
    else if (label.includes(q)) score = 1;
    else if (c.kind === 'member' && c.member.crew_roles.some((r) => r.toLowerCase().includes(q))) score = 2; // @摄 also finds the person who is 摄影
    if (score !== null) scored.push({ c, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((s) => s.c);
}

/** Put the chosen name where `@query` was. A space follows unless the text already has whitespace there; the caret goes past it. */
export function insertMention(text: string, active: ActiveMention, cand: MentionCandidate): { text: string; caret: number } {
  const token = `@${cand.label}`;
  const rest = text.slice(active.end);
  const gap = /^\s/.test(rest) ? '' : ' ';
  return { text: `${text.slice(0, active.start)}${token}${gap}${rest}`, caret: active.start + token.length + 1 };
}

/** Start a mention at the caret (the @ button): a space first when the caret follows a word. */
export function insertAt(text: string, caret: number): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const gap = before !== '' && !/\s$/.test(before) ? ' ' : '';
  return { text: `${before}${gap}@${text.slice(at)}`, caret: at + gap.length + 1 };
}

/**
 * The structured mentions a finished text carries: every `@label` that names
 * a candidate (the longest label wins where two start alike), once each, in
 * the order written. Text the person typed by hand counts the same as text
 * the picker inserted.
 */
export function extractMentions(text: string, cands: readonly MentionCandidate[]): CommentMention[] {
  const out: CommentMention[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== '@') continue;
    if (i > 0 && WORD_BEFORE.test(text.charAt(i - 1))) continue;
    const rest = text.slice(i + 1);
    const hits = cands.filter((c) => c.label !== '' && rest.startsWith(c.label));
    if (hits.length === 0) continue;
    const longest = Math.max(...hits.map((c) => c.label.length));
    for (const c of hits) {
      if (c.label.length !== longest || seen.has(c.key)) continue;
      seen.add(c.key);
      out.push(c.kind === 'member' ? { member: c.member.id } : { role: c.role });
    }
    i += longest;
  }
  return out;
}

/** Who a set of mentions reaches now (roles expanded), roster order, without the signed-in member. */
export function mentionReach(mentions: readonly CommentMention[], members: readonly RosterMember[]): RosterMember[] {
  const ids = new Set<string>();
  for (const m of mentions) {
    if ('member' in m) ids.add(m.member);
    else for (const h of members) if (h.crew_roles.includes(m.role)) ids.add(h.id);
  }
  return members.filter((m) => ids.has(m.id) && m.you !== true);
}

/** "会提醒：阿杰、阿丽"; empty when nobody else is reached. */
export function reachText(reach: readonly RosterMember[]): string {
  return reach.length === 0 ? '' : `会提醒：${reach.map((m) => m.name).join('、')}`;
}

/** One line of a comment: whitespace collapsed, cut to `max` characters with an ellipsis. */
export function excerptOf(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length <= max ? one : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** "第 3 场 002", "镜头 002", "第 3 场" or, with neither, "一个镜头". */
export function shotWhere(m: { scene_no: string | null; shot_code: string | null }): string {
  if (m.scene_no && m.shot_code) return `第 ${m.scene_no} 场 ${m.shot_code}`;
  if (m.shot_code) return `镜头 ${m.shot_code}`;
  if (m.scene_no) return `第 ${m.scene_no} 场`;
  return '一个镜头';
}

export interface MentionItem {
  author: Pick<ActorRef, 'name' | 'crew_roles'>;
  scene_no: string | null;
  shot_code: string | null;
  excerpt: string;
}

/** The bell's line: "阿杰（导演）在 第 3 场 002 提到了你：这里改成仰拍？" */
export function mentionLine(m: MentionItem): string {
  return `${actorText(m.author)}在 ${shotWhere(m)} 提到了你：${excerptOf(m.excerpt)}`;
}
