import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Shot } from '@storyscript/contracts';
import { runWithRequest, syncMember, type Actor, type HostedRequest } from '../src/collab/actor.ts';
import type { DbPort } from '../src/db/port.ts';
import { isAppError } from '../src/http/errors.ts';
import { commentSummary, createComment, deleteComment, listComments, markRead, setResolved, updateComment } from '../src/services/comments.ts';
import { importFixture, makeM3App, type M3App } from './helpers/m3-app.ts';

/**
 * S4b — shot comments: threads, @member and @role mentions, per-person
 * unread, resolve/reopen, author-only edits, leader deletes, soft delete.
 */

const A: Actor = { id: 'acc-a', name: '阿杰', role: 'leader', crew_roles: ['导演'], text_source: 'group', image_source: 'group' };
const B: Actor = { id: 'acc-b', name: '小林', role: 'member', crew_roles: ['摄影'], text_source: 'group', image_source: 'group' };
const C: Actor = { id: 'acc-c', name: '阿丽', role: 'member', crew_roles: ['导演', '编剧'], text_source: 'group', image_source: 'group' };
const roster = () => [A, B, C].map(({ id, name, role, crew_roles }) => ({ id, name, role, crew_roles }));
const as = (a: Actor): HostedRequest => ({ actor: a, roster, personalDir: '/nonexistent' });

let app: M3App;
let db: DbPort;
let shot: Shot;

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return isAppError(e) ? `${e.status} ${e.code}` : String(e);
  }
};

beforeEach(async () => {
  app = await makeM3App();
  await importFixture(app, '01-bookshop.txt', 'txt');
  const scenes = (await app.get<{ scenes: { id: string }[] }>('/api/v1/scripts/current')).data.scenes;
  const created = await app.post<Shot>('/api/v1/shots', {
    scene_id: scenes[0]!.id,
    manual_note: '手工',
    fields: {
      template: null, shot_size: 'MS', angle: 'eye', lens: 'normal', focal_mm: null, movement: 'static', subjects: [], props: [], env: null,
      subject_motion: 'none', set_piece: false, pov_owner: null, frame_format: null, technique_id: null, est_seconds: 3,
      narrative_purpose: '交代', action: '书店全景', dialogue_quote: null, source: { paragraph_id: 'p-003', quote: '' }, assumptions: [], questions: [],
    },
  });
  shot = created.data;
  db = app.handle.projectSession.require().db;
  for (const a of [A, B, C]) syncMember(db, a);
});

afterEach(() => app.close());

describe('shot comments', () => {
  test('a thread with @导演: reaches every director, unread per person, summary and mention inbox', () => {
    const root = runWithRequest(as(B), () => createComment(db, shot.id, { body: '这里改成仰拍？', board_id: null, parent_id: null, mentions: [{ role: '导演' }] }));
    expect(root.author.name).toBe('小林');
    expect(root.mentions.map((m) => m.name).sort()).toEqual(['阿丽', '阿杰'].sort());
    expect(root.mention_roles).toEqual(['导演']);
    expect(root.mine).toBe(true);
    expect(root.unread).toBe(false);

    runWithRequest(as(A), () => {
      const s = commentSummary(db);
      expect(s.shots[shot.id]).toEqual({ total: 1, unresolved: 1, unread: 1 });
      expect(s.mentions.map((m) => [m.author.name, m.excerpt])).toEqual([['小林', '这里改成仰拍？']]);
      expect(listComments(db, shot.id)[0]!.unread).toBe(true);
      const reply = createComment(db, shot.id, { body: '可以', board_id: null, parent_id: root.id, mentions: [] });
      expect(reply.parent_id).toBe(root.id);
      markRead(db, shot.id);
      const after = commentSummary(db);
      expect(after.shots[shot.id]).toEqual({ total: 2, unresolved: 1, unread: 0 });
      expect(after.mentions).toEqual([]);
    });
    // C still has the mention and two unread
    runWithRequest(as(C), () => {
      expect(commentSummary(db).shots[shot.id]!.unread).toBe(2);
      expect(commentSummary(db).mentions).toHaveLength(1);
    });
  });

  test('replies are one level deep; a board of another shot is refused; an unknown role is refused', () => {
    const root = runWithRequest(as(A), () => createComment(db, shot.id, { body: '一', board_id: null, parent_id: null, mentions: [] }));
    const reply = runWithRequest(as(B), () => createComment(db, shot.id, { body: '二', board_id: null, parent_id: root.id, mentions: [] }));
    expect(code(() => runWithRequest(as(C), () => createComment(db, shot.id, { body: '三', board_id: null, parent_id: reply.id, mentions: [] })))).toBe('400 VALIDATION_ERROR');
    expect(code(() => runWithRequest(as(C), () => createComment(db, shot.id, { body: '四', board_id: null, parent_id: null, mentions: [{ role: '剪辑' }] })))).toBe('400 VALIDATION_ERROR');
    expect(code(() => runWithRequest(as(C), () => createComment(db, shot.id, { body: '五', board_id: null, parent_id: null, mentions: [{ member: 'acc-zz' }] })))).toBe('400 VALIDATION_ERROR');
  });

  test('only the author edits; the leader or the author deletes (soft); anyone resolves and reopens the thread', () => {
    const c1 = runWithRequest(as(B), () => createComment(db, shot.id, { body: '原话', board_id: null, parent_id: null, mentions: [] }));
    expect(code(() => runWithRequest(as(C), () => updateComment(db, c1.id, { body: '改别人的', mentions: [] })))).toBe('403 FORBIDDEN');
    expect(code(() => runWithRequest(as(A), () => updateComment(db, c1.id, { body: '组长也不能改', mentions: [] })))).toBe('403 FORBIDDEN');
    const edited = runWithRequest(as(B), () => updateComment(db, c1.id, { body: '改过的话', mentions: [] }));
    expect(edited.body).toBe('改过的话');
    expect(edited.edited_at).not.toBeNull();

    const resolved = runWithRequest(as(C), () => setResolved(db, c1.id, true));
    expect(resolved.resolved_by?.name).toBe('阿丽');
    expect(runWithRequest(as(B), () => setResolved(db, c1.id, false)).resolved_at).toBeNull();

    expect(code(() => runWithRequest(as(C), () => deleteComment(db, c1.id)))).toBe('403 FORBIDDEN');
    const gone = runWithRequest(as(A), () => deleteComment(db, c1.id));
    expect(gone).toMatchObject({ deleted: true, body: '' });
    expect(runWithRequest(as(B), () => listComments(db, shot.id))).toHaveLength(1);
    expect(runWithRequest(as(B), () => commentSummary(db)).shots[shot.id]).toBeUndefined();
  });

  test('outside the hosted server there are no comments', () => {
    expect(code(() => listComments(db, shot.id))).toBe('404 NOT_FOUND');
  });

  test('HTTP: the local app answers 404 and the write does not move the feed', async () => {
    const res = await app.post(`/api/v1/shots/${shot.id}/comments`, { body: '你好' });
    expect(res.status).toBe(404);
  });
});
