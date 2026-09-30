import { afterEach, describe, expect, it } from 'vitest';
import { COMMENT_MAX, CommentMention, CreateCommentInput, ShotComment } from '@storyscript/contracts';
import { ApiClientError } from '../src/lib/api.ts';
import {
  buildThreads,
  canDelete,
  canEdit,
  canReply,
  canResolve,
  commentBadge,
  filterThreads,
  formatCommentTime,
  mentionTags,
  threadCounts,
  threadUnread,
  upsertComment,
} from '../src/lib/comments.ts';
import {
  activeMention,
  excerptOf,
  extractMentions,
  filterCandidates,
  heldRoles,
  insertAt,
  insertMention,
  mentionCandidates,
  mentionLine,
  mentionReach,
  reachText,
  shotWhere,
  type RosterMember,
} from '../src/lib/mentions.ts';
import {
  clearCommentsFocus,
  commentsFocusFor,
  OPEN_SHOT_TTL_MS,
  peekOpenShot,
  requestOpenShot,
  resetOpenShot,
  setCommentsFocus,
  takeOpenShot,
} from '../src/lib/open-shot.ts';
import { commentErrorText } from '../src/lib/queries-comments.ts';
import { uuid } from './fixtures.ts';

// S4b web logic: the @ picker and how a text turns into mentions, threads and
// who may do what, the badge on a shot row, times, and the request the bell
// makes to open a shot. Names are made up.

const A: RosterMember = { id: 'acc-a', name: '阿杰', crew_roles: ['导演'] };
const B: RosterMember = { id: 'acc-b', name: '小林', crew_roles: ['摄影'], you: true };
const C: RosterMember = { id: 'acc-c', name: '阿丽', crew_roles: ['导演', '编剧'] };
const D: RosterMember = { id: 'acc-d', name: '小周', crew_roles: [] };
const ROSTER = [A, B, C, D];

describe('mention candidates', () => {
  it('lists the members (not the signed-in one), then the roles somebody holds', () => {
    const c = mentionCandidates(ROSTER);
    expect(c.map((x) => x.label)).toEqual(['阿杰', '阿丽', '小周', '导演', '编剧', '摄影']);
    expect(c.filter((x) => x.kind === 'role').map((x) => x.label)).toEqual(['导演', '编剧', '摄影']);
  });

  it('keeps the signed-in member when asked (parsing a finished text)', () => {
    expect(mentionCandidates(ROSTER, { includeSelf: true }).map((x) => x.label)).toContain('小林');
  });

  it('a role nobody holds is not offered; presets keep their usual order, custom roles follow', () => {
    expect(heldRoles([{ id: 'x', name: '甲', crew_roles: ['副导演', '摄影'] }, { id: 'y', name: '乙', crew_roles: ['导演'] }])).toEqual(['导演', '摄影', '副导演']);
    expect(heldRoles([D])).toEqual([]);
  });

  it('tells two people with the same name apart', () => {
    const twins: RosterMember[] = [
      { id: '1', name: '小周', crew_roles: [] },
      { id: '2', name: '小周', crew_roles: ['录音'] },
      { id: '3', name: '阿杰', crew_roles: [] },
    ];
    expect(mentionCandidates(twins).map((x) => x.label)).toEqual(['小周#1', '小周#2', '阿杰', '录音']);
  });

  it('a role lists who holds it', () => {
    const director = mentionCandidates(ROSTER).find((x) => x.kind === 'role' && x.role === '导演');
    expect(director?.kind === 'role' ? director.holders.map((h) => h.name) : []).toEqual(['阿杰', '阿丽']);
  });
});

describe('the @ being typed', () => {
  it('finds it at the start, after a space, after a full stop, and stops at whitespace', () => {
    expect(activeMention('@导', 2)).toEqual({ start: 0, end: 2, query: '导' });
    expect(activeMention('这里改成仰拍？ @', 9)).toEqual({ start: 8, end: 9, query: '' });
    expect(activeMention('请@导演', 4)).toEqual({ start: 1, end: 4, query: '导演' });
    expect(activeMention('@导演 你看', 6)).toBeNull();
    expect(activeMention('没有提到', 4)).toBeNull();
  });

  it('is not an address, and follows the caret rather than the end of the text', () => {
    expect(activeMention('写到 lin@school.test', 17)).toBeNull();
    expect(activeMention('@小 后面还有字', 2)).toEqual({ start: 0, end: 2, query: '小' });
    expect(activeMention('@'.padEnd(30, '一'), 30)).toBeNull(); // too long to be a name
  });

  it('filters: a label that starts with it first, then one that contains it, then roles and holders', () => {
    const c = mentionCandidates(ROSTER);
    expect(filterCandidates(c, '').length).toBe(c.length);
    expect(filterCandidates(c, '阿').map((x) => x.label)).toEqual(['阿杰', '阿丽']);
    expect(filterCandidates(c, '导').map((x) => x.label)).toEqual(['导演', '阿杰', '阿丽']); // the role itself, then members who hold it
    expect(filterCandidates(c, '摄').map((x) => x.label)).toEqual(['摄影']);
    expect(filterCandidates(c, '剪辑')).toEqual([]);
  });

  it('inserts the chosen name in place of what was typed, with a space after', () => {
    const c = mentionCandidates(ROSTER);
    const director = c.find((x) => x.label === '导演')!;
    const text = '这里改成仰拍？ @导';
    const active = activeMention(text, text.length)!;
    expect(insertMention(text, active, director)).toEqual({ text: '这里改成仰拍？ @导演 ', caret: 12 });
    // text after the caret is kept, and no second space when whitespace follows
    const mid = '@阿 你看';
    expect(insertMention(mid, activeMention(mid, 2)!, c[0]!)).toEqual({ text: '@阿杰 你看', caret: 4 });
  });

  it('the @ button starts a mention, with a space first after a word', () => {
    expect(insertAt('', 0)).toEqual({ text: '@', caret: 1 });
    expect(insertAt('看看', 2)).toEqual({ text: '看看 @', caret: 4 });
    expect(insertAt('看看 ', 3)).toEqual({ text: '看看 @', caret: 4 });
    expect(insertAt('前后', 1)).toEqual({ text: '前 @后', caret: 3 });
  });
});

describe('text to structured mentions', () => {
  const all = mentionCandidates(ROSTER, { includeSelf: true });

  it('reads @roles and @members once each, in the order written', () => {
    expect(extractMentions('这里改成仰拍？ @导演 @小林 再看一次 @导演', all)).toEqual([{ role: '导演' }, { member: 'acc-b' }]);
  });

  it('takes what was typed by hand as well as what the picker put in, even with words glued on', () => {
    expect(extractMentions('请@阿杰看看', all)).toEqual([{ member: 'acc-a' }]);
    expect(extractMentions('@摄影，@编剧', all)).toEqual([{ role: '摄影' }, { role: '编剧' }]);
  });

  it('ignores an unknown name, an address and a lone @', () => {
    expect(extractMentions('@没有这个人 @ 发到 lin@school.test', all)).toEqual([]);
    expect(extractMentions('', all)).toEqual([]);
  });

  it('the longest label wins where two start alike', () => {
    const twins: RosterMember[] = [
      { id: '1', name: '小周', crew_roles: [] },
      { id: '2', name: '小周', crew_roles: [] },
    ];
    const c = mentionCandidates(twins, { includeSelf: true });
    expect(extractMentions('@小周#2 看看', c)).toEqual([{ member: '2' }]);
    expect(extractMentions('@小周#1 和 @小周#2', c)).toEqual([{ member: '1' }, { member: '2' }]);
  });

  it('what it produces is valid for the contract and can be sent', () => {
    const mentions = extractMentions('@导演 @小林', all);
    for (const m of mentions) expect(CommentMention.safeParse(m).success).toBe(true);
    const parsed = CreateCommentInput.safeParse({ body: '  这里改成仰拍？ @导演  ', mentions });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ body: '这里改成仰拍？ @导演', board_id: null, parent_id: null });
    expect(CreateCommentInput.safeParse({ body: 'x'.repeat(COMMENT_MAX + 1), mentions: [] }).success).toBe(false);
  });
});

describe('who a mention reaches', () => {
  it('expands a role to whoever holds it now, without the signed-in member, in roster order', () => {
    expect(mentionReach([{ role: '导演' }], ROSTER).map((m) => m.name)).toEqual(['阿杰', '阿丽']);
    expect(mentionReach([{ role: '摄影' }], ROSTER)).toEqual([]); // only the signed-in member holds it
    expect(mentionReach([{ member: 'acc-c' }, { role: '导演' }], ROSTER).map((m) => m.name)).toEqual(['阿杰', '阿丽']);
  });

  it('says it in a line, or nothing', () => {
    expect(reachText(mentionReach([{ role: '导演' }, { member: 'acc-d' }], ROSTER))).toBe('会提醒：阿杰、阿丽、小周');
    expect(reachText([])).toBe('');
  });
});

describe('the bell line', () => {
  it('cuts a long excerpt and flattens line breaks', () => {
    expect(excerptOf('这里改成\n仰拍？')).toBe('这里改成 仰拍？');
    const long = '一'.repeat(80);
    expect(Array.from(excerptOf(long, 20)).length).toBe(20);
    expect(excerptOf(long, 20).endsWith('…')).toBe(true);
    expect(excerptOf('短的', 20)).toBe('短的');
  });

  it('names where it is, with what is known', () => {
    expect(shotWhere({ scene_no: '3', shot_code: '002' })).toBe('第 3 场 002');
    expect(shotWhere({ scene_no: null, shot_code: '002' })).toBe('镜头 002');
    expect(shotWhere({ scene_no: '3', shot_code: null })).toBe('第 3 场');
    expect(shotWhere({ scene_no: null, shot_code: null })).toBe('一个镜头');
  });

  it('reads like a sentence: who (with roles), where, what', () => {
    expect(mentionLine({ author: { name: '阿杰', crew_roles: ['导演'] }, scene_no: '3', shot_code: '002', excerpt: '这里改成仰拍？' })).toBe(
      '阿杰（导演）在 第 3 场 002 提到了你：这里改成仰拍？',
    );
    expect(mentionLine({ author: { name: '小周', crew_roles: [] }, scene_no: null, shot_code: null, excerpt: '看一下' })).toBe('小周在 一个镜头 提到了你：看一下');
  });
});

// ------------------------------------------------------------------- threads

let clock = 0;
function comment(over: Partial<ShotComment> = {}): ShotComment {
  clock += 1;
  return {
    id: uuid(),
    shot_id: '00000000-0000-4000-8000-0000000000aa',
    board_id: null,
    board_version: null,
    parent_id: null,
    author: { id: 'acc-a', name: '阿杰', crew_roles: ['导演'], left: false },
    body: '这里改成仰拍？',
    mentions: [],
    mention_roles: [],
    resolved_at: null,
    resolved_by: null,
    edited_at: null,
    deleted: false,
    created_at: new Date(Date.UTC(2026, 8, 30, 8, 0, clock)).toISOString(),
    mine: false,
    unread: false,
    ...over,
  };
}

describe('threads', () => {
  it('parses what the server sends', () => {
    expect(ShotComment.safeParse(comment()).success).toBe(true);
  });

  it('puts replies under their comment, everything oldest first, whatever order the list comes in', () => {
    const root = comment({ body: '第一条' });
    const reply1 = comment({ parent_id: root.id, body: '回复一' });
    const other = comment({ body: '第二条' });
    const reply2 = comment({ parent_id: root.id, body: '回复二' });
    const threads = buildThreads([reply2, other, reply1, root]);
    expect(threads.map((t) => t.root.body)).toEqual(['第一条', '第二条']);
    expect(threads[0]?.replies.map((r) => r.body)).toEqual(['回复一', '回复二']);
    expect(threads[1]?.replies).toEqual([]);
  });

  it('a reply whose parent is missing stands on its own', () => {
    const orphan = comment({ parent_id: uuid() });
    expect(buildThreads([orphan]).map((t) => t.root.id)).toEqual([orphan.id]);
  });

  it('a thread is resolved by its top comment', () => {
    const open = comment();
    const done = comment({ resolved_at: '2026-09-30T09:00:00.000Z', resolved_by: { id: 'acc-b', name: '小林', crew_roles: [], left: false } });
    const threads = buildThreads([open, done]);
    expect(threads.map((t) => t.resolved)).toEqual([false, true]);
    expect(threadCounts(threads)).toEqual({ open: 1, resolved: 1 });
  });

  it('counts the unread comments in a thread, replies included', () => {
    const root = comment({ unread: true });
    const reply = comment({ parent_id: root.id, unread: true });
    const seen = comment({ parent_id: root.id });
    expect(threadUnread(buildThreads([root, reply, seen])[0]!)).toBe(2);
  });

  it('本版 keeps the threads opened on this board version, 全部 keeps all', () => {
    const v3 = comment({ board_id: 'board-3', board_version: 3 });
    const v2 = comment({ board_id: 'board-2', board_version: 2 });
    const plain = comment();
    const threads = buildThreads([v2, v3, plain]);
    expect(filterThreads(threads, 'board', 'board-3').map((t) => t.root.id)).toEqual([v3.id]);
    expect(filterThreads(threads, 'all', 'board-3')).toHaveLength(3);
    expect(filterThreads(threads, 'board', null)).toHaveLength(3); // no board in play: nothing to filter by
  });

  it('a comment the server returns replaces its old copy or joins the list', () => {
    const one = comment({ body: '原话' });
    const edited = { ...one, body: '改过的话', edited_at: '2026-09-30T10:00:00.000Z' };
    expect(upsertComment([one], edited)).toEqual([edited]);
    const two = comment();
    expect(upsertComment([one], two)).toEqual([one, two]);
    expect(upsertComment(undefined, two)).toEqual([two]);
  });
});

describe('who may do what', () => {
  it('reply and resolve are for top-level comments; a deleted one takes no reply', () => {
    const root = comment();
    const reply = comment({ parent_id: root.id });
    expect([canReply(root), canReply(reply), canReply(comment({ deleted: true }))]).toEqual([true, false, false]);
    expect([canResolve(root), canResolve(reply)]).toEqual([true, false]);
  });

  it('only the author edits; the author or the leader deletes; nothing on a deleted one', () => {
    const mine = comment({ mine: true });
    const theirs = comment();
    expect([canEdit(mine), canEdit(theirs)]).toEqual([true, false]);
    expect([canDelete(mine, false), canDelete(theirs, false), canDelete(theirs, true)]).toEqual([true, false, true]);
    const gone = comment({ mine: true, deleted: true, body: '' });
    expect([canEdit(gone), canDelete(gone, true)]).toEqual([false, false]);
  });
});

describe('the badge on a shot row', () => {
  it('shows nothing for a shot without comments', () => {
    expect(commentBadge(undefined)).toBeNull();
    expect(commentBadge({ total: 0, unresolved: 0, unread: 0 })).toBeNull();
  });

  it('counts the threads still open, and marks unread', () => {
    expect(commentBadge({ total: 3, unresolved: 2, unread: 0 })).toEqual({
      text: '批注 2',
      title: '2 条讨论还没解决，共 3 条批注',
      unread: false,
      quiet: false,
    });
    expect(commentBadge({ total: 3, unresolved: 2, unread: 1 })).toMatchObject({ unread: true, title: '2 条讨论还没解决，共 3 条批注；1 条未读' });
  });

  it('goes quiet, with the total, once every thread is resolved', () => {
    expect(commentBadge({ total: 4, unresolved: 0, unread: 0 })).toEqual({ text: '批注 4', title: '4 条批注，都已解决', unread: false, quiet: true });
  });
});

describe('the tags under a comment', () => {
  const who = (id: string, name: string, roles: string[]) => ({ id, name, crew_roles: roles, left: false });

  it('a role typed shows once, with who it reached; a member covered by it gets no tag of their own', () => {
    const tags = mentionTags({ mention_roles: ['导演'], mentions: [who('a', '阿杰', ['导演']), who('c', '阿丽', ['导演', '编剧'])] });
    expect(tags).toEqual([{ key: 'role:导演', text: '@导演', title: '阿杰、阿丽' }]);
  });

  it('a member named on purpose gets a tag', () => {
    const tags = mentionTags({ mention_roles: ['导演'], mentions: [who('a', '阿杰', ['导演']), who('d', '小周', [])] });
    expect(tags.map((t) => t.text)).toEqual(['@导演', '@小周']);
  });

  it('no mentions, no tags; a member who left is marked', () => {
    expect(mentionTags({ mention_roles: [], mentions: [] })).toEqual([]);
    expect(mentionTags({ mention_roles: [], mentions: [{ id: 'z', name: '阿飞', crew_roles: [], left: true }] })[0]?.title).toBe('已离开');
  });
});

describe('time', () => {
  const now = new Date('2026-09-30T06:00:00.000Z');
  const tz = 'Asia/Shanghai';

  it('is the clock time for today, the date and time for other days', () => {
    expect(formatCommentTime('2026-09-30T02:32:00.000Z', now, tz)).toBe('10:32');
    expect(formatCommentTime('2026-09-28T02:32:00.000Z', now, tz)).toBe('9月28日 10:32');
    expect(formatCommentTime('2025-12-31T02:32:00.000Z', now, tz)).toBe('2025年12月31日 10:32');
  });

  it('follows the day where the reader is, not UTC', () => {
    // 15:30 UTC on the 29th is 23:30 that evening in Shanghai, not "today" for a reader on the 30th
    expect(formatCommentTime('2026-09-29T15:30:00.000Z', now, tz)).toBe('9月29日 23:30');
    expect(formatCommentTime('not a time', now, tz)).toBe('');
  });
});

// ------------------------------------------------------- opening a shot

describe('opening a shot from the bell', () => {
  afterEach(() => resetOpenShot());

  it('a request waits until the workspace takes it, once', () => {
    requestOpenShot({ shotId: 's1', comments: true, commentId: 'c1' }, 1000);
    expect(peekOpenShot(1000)).toEqual({ shotId: 's1', comments: true, commentId: 'c1' });
    expect(takeOpenShot(1500)).toEqual({ shotId: 's1', comments: true, commentId: 'c1' });
    expect(takeOpenShot(1500)).toBeNull();
  });

  it('a request nobody took is dropped, so a stale one never opens a shot later', () => {
    requestOpenShot({ shotId: 's1' }, 1000);
    expect(peekOpenShot(1000 + OPEN_SHOT_TTL_MS + 1)).toBeNull();
    expect(takeOpenShot(1000 + OPEN_SHOT_TTL_MS + 1)).toBeNull();
  });

  it('a newer request replaces an older one', () => {
    requestOpenShot({ shotId: 's1' }, 1000);
    requestOpenShot({ shotId: 's2', comments: true }, 1100);
    expect(takeOpenShot(1200)).toEqual({ shotId: 's2', comments: true, commentId: null });
  });

  it('the comments focus belongs to one shot, expires and clears', () => {
    setCommentsFocus({ shotId: 's1', commentId: 'c1' }, 1000);
    expect(commentsFocusFor('s2', 1000)).toBeNull();
    expect(commentsFocusFor('s1', 1000)).toEqual({ shotId: 's1', commentId: 'c1' });
    expect(commentsFocusFor('s1', 1000 + OPEN_SHOT_TTL_MS + 1)).toBeNull();
    clearCommentsFocus();
    expect(commentsFocusFor('s1', 1000)).toBeNull();
  });
});

describe('when a comment cannot be saved', () => {
  const err = (code: ApiClientError['code'], status: number, message: string) => new ApiClientError({ code, message, status, retryable: false });

  it('keeps the server’s sentence for a problem with the comment itself', () => {
    expect(commentErrorText(err('VALIDATION_ERROR', 400, '小组里还没有人担任「剪辑」'))).toEqual({ title: '批注没有保存', detail: '小组里还没有人担任「剪辑」' });
    expect(commentErrorText(err('FORBIDDEN', 403, '只有作者能修改批注'))).toEqual({ title: '批注没有保存', detail: '只有作者能修改批注' });
    expect(commentErrorText(err('NOT_FOUND', 404, 'x')).title).toBe('这条批注或镜头已经不在了');
  });

  it('a problem caught before sending, or a network one, gets the general wording', () => {
    expect(commentErrorText(err('VALIDATION_ERROR', 0, 'body: too small')).title).toBe('填写的内容有误');
    expect(commentErrorText(err('NETWORK_ERROR', 0, 'x')).title).toBe('连接不上本地服务');
  });
});
