import type { ShotComment } from '@storyscript/contracts';

/**
 * S4b — the shape of a shot's comments on the page. Pure: threads (a
 * top-level comment and its one level of replies, oldest first), the 本版 /
 * 全部 filter on the board page, the small badge on a shot row, who may do
 * what, the tags for a comment's mentions, and the time as people read it.
 */

export interface Thread {
  root: ShotComment;
  replies: ShotComment[];
  resolved: boolean;
}

/** By time only: the sort is stable, so two comments in the same millisecond keep the order the server sent (its write order). */
const byTime = (a: ShotComment, b: ShotComment): number => a.created_at.localeCompare(b.created_at);

/**
 * Threads oldest first. A reply whose parent is not in the list (it should
 * not happen) stands on its own rather than disappearing.
 */
export function buildThreads(comments: readonly ShotComment[]): Thread[] {
  const sorted = [...comments].sort(byTime);
  const ids = new Set(sorted.map((c) => c.id));
  const roots = sorted.filter((c) => c.parent_id === null || !ids.has(c.parent_id));
  return roots.map((root) => ({
    root,
    replies: sorted.filter((c) => c.parent_id === root.id),
    resolved: root.resolved_at !== null,
  }));
}

export type CommentScope = 'board' | 'all';

/** On the board page 本版 keeps the threads that were opened on this board version. */
export function filterThreads(threads: readonly Thread[], scope: CommentScope, boardId: string | null): Thread[] {
  if (scope === 'all' || boardId === null) return [...threads];
  return threads.filter((t) => t.root.board_id === boardId);
}

/** Comments in a thread that someone else wrote after this person last read the shot. */
export function threadUnread(t: Thread): number {
  return [t.root, ...t.replies].filter((c) => c.unread).length;
}

export function threadCounts(threads: readonly Thread[]): { open: number; resolved: number } {
  const resolved = threads.filter((t) => t.resolved).length;
  return { open: threads.length - resolved, resolved };
}

/** Put a comment the server just returned into the list: replace the one with its id, else add it. */
export function upsertComment(list: readonly ShotComment[] | undefined, c: ShotComment): ShotComment[] {
  const base = list ?? [];
  return base.some((x) => x.id === c.id) ? base.map((x) => (x.id === c.id ? c : x)) : [...base, c];
}

// ---------------------------------------------------------------- permissions

export const canReply = (c: ShotComment): boolean => c.parent_id === null && !c.deleted;
export const canEdit = (c: ShotComment): boolean => c.mine && !c.deleted;
/** The author, or the group's leader (deleting keeps the row as 「已删除」). */
export const canDelete = (c: ShotComment, leader: boolean): boolean => !c.deleted && (c.mine || leader);
/** Anyone in the group may resolve or reopen a thread; replies have no state of their own. */
export const canResolve = (c: ShotComment): boolean => c.parent_id === null;

// ---------------------------------------------------------------------- badge

export interface ShotCommentCount {
  total: number;
  unresolved: number;
  unread: number;
}

export interface CommentBadgeInfo {
  text: string;
  title: string;
  unread: boolean;
  /** every thread is resolved: the badge is quieter */
  quiet: boolean;
}

/** The mark on a shot row: 「批注 2」 (open threads; the total when all are resolved) and a dot when something is unread. */
export function commentBadge(c: ShotCommentCount | undefined): CommentBadgeInfo | null {
  if (!c || c.total <= 0) return null;
  const quiet = c.unresolved <= 0;
  const unread = c.unread > 0;
  const base = quiet ? `${c.total} 条批注，都已解决` : `${c.unresolved} 条讨论还没解决，共 ${c.total} 条批注`;
  return {
    text: `批注 ${quiet ? c.total : c.unresolved}`,
    title: unread ? `${base}；${c.unread} 条未读` : base,
    unread,
    quiet,
  };
}

// ----------------------------------------------------------------------- tags

export interface MentionTag {
  key: string;
  text: string;
  title: string | null;
}

/**
 * The mentions of one comment as tags: a role the author typed (@导演, with
 * who it reached as the tooltip), and a member only when no typed role
 * already covers them.
 */
export function mentionTags(c: Pick<ShotComment, 'mentions' | 'mention_roles'>): MentionTag[] {
  const tags: MentionTag[] = c.mention_roles.map((role) => {
    const who = c.mentions.filter((m) => m.crew_roles.includes(role)).map((m) => m.name);
    return { key: `role:${role}`, text: `@${role}`, title: who.length > 0 ? who.join('、') : null };
  });
  for (const m of c.mentions) {
    if (m.crew_roles.some((r) => c.mention_roles.includes(r))) continue;
    tags.push({ key: `member:${m.id}`, text: `@${m.name}`, title: m.left ? '已离开' : null });
  }
  return tags;
}

// ----------------------------------------------------------------------- time

/**
 * "10:32" for today, "9月28日 10:32" for other days of the year, with the
 * year when it is another year. `timeZone` is for tests; the page uses the
 * browser's.
 */
export function formatCommentTime(iso: string, now: Date = new Date(), timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  if (day(d) === day(now)) return clock;
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const sameYear = get('year') === new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric' }).format(now).replace(/\D/g, '');
  return `${sameYear ? '' : `${get('year')}年`}${get('month')}月${get('day')}日 ${clock}`;
}

/** DOM ids: a comment (to scroll to it from the bell) and a shot's comments section. */
export const commentDomId = (id: string): string => `comment-${id}`;
export const commentsSectionDomId = (shotId: string): string => `comments-${shotId}`;
