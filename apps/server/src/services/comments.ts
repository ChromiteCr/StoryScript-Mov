import { randomUUID } from 'node:crypto';
import type { ActorRef, CommentMention, CommentSummary, CreateCommentInput, ShotComment, UpdateCommentInput } from '@storyscript/contracts';
import { actorResolver, currentActor, currentRequest, type Actor } from '../collab/actor.ts';
import type { DbPort } from '../db/port.ts';
import { getBoard } from '../db/repos/board.ts';
import { getScene } from '../db/repos/script.ts';
import { getShot } from '../db/repos/shot.ts';
import { AppError } from '../http/errors.ts';

/**
 * S4b — comments on shots. Only on the hosted server (a comment needs an
 * author). The author edits and deletes their own; the leader may delete any;
 * anyone in the group resolves or reopens a thread. Nobody edits someone
 * else's words. Deleting keeps the row (「已删除」) so replies still read.
 */

interface CommentRow {
  n: number;
  id: string;
  shot_id: string;
  board_id: string | null;
  parent_id: string | null;
  actor_id: string;
  body: string;
  mention_roles_json: string;
  resolved_at: string | null;
  resolved_by: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

const COLS = 'n, id, shot_id, board_id, parent_id, actor_id, body, mention_roles_json, resolved_at, resolved_by, edited_at, deleted_at, created_at';

function me(): Actor {
  const actor = currentActor();
  if (!actor) throw new AppError('NOT_FOUND', '只有服务器版有镜头批注', 404);
  return actor;
}

const parseList = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Mentions → the accounts they reach now (members by id, roles by who holds them), and the roles typed. */
function resolveMentions(mentions: readonly CommentMention[]): { accounts: string[]; roles: string[] } {
  const roster = currentRequest()?.roster() ?? [];
  const accounts = new Set<string>();
  const roles: string[] = [];
  for (const m of mentions) {
    if ('member' in m) {
      if (!roster.some((r) => r.id === m.member)) throw new AppError('VALIDATION_ERROR', '提到的人不在小组里', 400);
      accounts.add(m.member);
    } else {
      const holders = roster.filter((r) => r.crew_roles.includes(m.role));
      if (holders.length === 0) throw new AppError('VALIDATION_ERROR', `小组里还没有人担任「${m.role}」`, 400);
      if (!roles.includes(m.role)) roles.push(m.role);
      for (const h of holders) accounts.add(h.id);
    }
  }
  return { accounts: [...accounts], roles };
}

function readN(db: DbPort, accountId: string, shotId: string): number {
  return db.get<{ read_n: number }>('SELECT read_n FROM comment_read WHERE account_id = ? AND shot_id = ?', accountId, shotId)?.read_n ?? 0;
}

function toComment(db: DbPort, r: CommentRow, who: (id: string | null) => ActorRef | null, myId: string, read: number): ShotComment {
  const board = r.board_id ? getBoard(db, r.board_id) : null;
  const mentioned = db.all<{ account_id: string }>('SELECT account_id FROM comment_mention WHERE comment_id = ? ORDER BY account_id', r.id);
  const deleted = r.deleted_at !== null;
  return {
    id: r.id,
    shot_id: r.shot_id,
    board_id: r.board_id,
    board_version: board?.version ?? null,
    parent_id: r.parent_id,
    author: who(r.actor_id)!,
    body: deleted ? '' : r.body,
    mentions: deleted ? [] : mentioned.map((m) => who(m.account_id)!).filter(Boolean),
    mention_roles: deleted ? [] : parseList(r.mention_roles_json),
    resolved_at: r.resolved_at,
    resolved_by: who(r.resolved_by),
    edited_at: r.edited_at,
    deleted,
    created_at: r.created_at,
    mine: r.actor_id === myId,
    unread: r.actor_id !== myId && r.n > read,
  };
}

function requireComment(db: DbPort, id: string): CommentRow {
  const r = db.get<CommentRow>(`SELECT ${COLS} FROM comment WHERE id = ?`, id);
  if (!r) throw new AppError('NOT_FOUND', '批注不存在', 404);
  return r;
}

function one(db: DbPort, id: string): ShotComment {
  const r = requireComment(db, id);
  const actor = me();
  return toComment(db, r, actorResolver(db), actor.id, readN(db, actor.id, r.shot_id));
}

export function listComments(db: DbPort, shotId: string): ShotComment[] {
  const actor = me();
  if (!getShot(db, shotId)) throw new AppError('NOT_FOUND', '镜头不存在', 404);
  const who = actorResolver(db);
  const read = readN(db, actor.id, shotId);
  return db.all<CommentRow>(`SELECT ${COLS} FROM comment WHERE shot_id = ? ORDER BY n`, shotId).map((r) => toComment(db, r, who, actor.id, read));
}

export function createComment(db: DbPort, shotId: string, input: CreateCommentInput, now = new Date().toISOString()): ShotComment {
  const actor = me();
  return db.tx(() => {
    if (!getShot(db, shotId)) throw new AppError('NOT_FOUND', '镜头不存在', 404);
    if (input.board_id) {
      const board = getBoard(db, input.board_id);
      if (!board || board.shot_id !== shotId) throw new AppError('VALIDATION_ERROR', '这版分镜不属于这个镜头', 400);
    }
    if (input.parent_id) {
      const parent = requireComment(db, input.parent_id);
      if (parent.shot_id !== shotId || parent.parent_id !== null) throw new AppError('VALIDATION_ERROR', '只能回复同一镜头的一条批注', 400);
    }
    const { accounts, roles } = resolveMentions(input.mentions);
    const id = randomUUID();
    db.run(
      `INSERT INTO comment (id, shot_id, board_id, parent_id, actor_id, body, mention_roles_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      shotId,
      input.board_id,
      input.parent_id,
      actor.id,
      input.body,
      JSON.stringify(roles),
      now,
    );
    for (const a of accounts) if (a !== actor.id) db.run('INSERT OR IGNORE INTO comment_mention (comment_id, account_id) VALUES (?, ?)', id, a);
    // own comments are never unread; others' stay unread until the panel reports it showed them
    return one(db, id);
  });
}

export function updateComment(db: DbPort, id: string, input: UpdateCommentInput, now = new Date().toISOString()): ShotComment {
  const actor = me();
  return db.tx(() => {
    const r = requireComment(db, id);
    if (r.actor_id !== actor.id) throw new AppError('FORBIDDEN', '只能修改自己写的批注', 403);
    if (r.deleted_at) throw new AppError('VALIDATION_ERROR', '这条批注已删除', 409);
    const { accounts, roles } = resolveMentions(input.mentions);
    db.run('UPDATE comment SET body = ?, mention_roles_json = ?, edited_at = ? WHERE id = ?', input.body, JSON.stringify(roles), now, id);
    // people edited out of the text are no longer mentioned; those still in keep their "seen"
    const keep = accounts.filter((a) => a !== actor.id);
    db.run(
      `DELETE FROM comment_mention WHERE comment_id = ?${keep.length ? ` AND account_id NOT IN (${keep.map(() => '?').join(', ')})` : ''}`,
      id,
      ...keep,
    );
    for (const a of keep) db.run('INSERT OR IGNORE INTO comment_mention (comment_id, account_id) VALUES (?, ?)', id, a);
    return one(db, id);
  });
}

export function deleteComment(db: DbPort, id: string, now = new Date().toISOString()): ShotComment {
  const actor = me();
  return db.tx(() => {
    const r = requireComment(db, id);
    if (r.actor_id !== actor.id && actor.role !== 'leader') throw new AppError('FORBIDDEN', '只能删除自己写的批注；组长可以删除任何批注', 403);
    if (!r.deleted_at) {
      db.run('UPDATE comment SET deleted_at = ? WHERE id = ?', now, id);
      db.run('DELETE FROM comment_mention WHERE comment_id = ?', id);
    }
    return one(db, id);
  });
}

export function setResolved(db: DbPort, id: string, resolved: boolean, now = new Date().toISOString()): ShotComment {
  const actor = me();
  return db.tx(() => {
    const r = requireComment(db, id);
    if (r.parent_id !== null) throw new AppError('VALIDATION_ERROR', '回复不能单独标为已解决，请在第一条批注上操作', 400);
    if (resolved) db.run('UPDATE comment SET resolved_at = ?, resolved_by = ? WHERE id = ?', now, actor.id, id);
    else db.run('UPDATE comment SET resolved_at = NULL, resolved_by = NULL WHERE id = ?', id);
    return one(db, id);
  });
}

/** The account has read this shot's comments up to `upto` (the newest one the panel showed), and the mentions in them. */
export function markRead(db: DbPort, shotId: string, upto: string, now = new Date().toISOString()): void {
  const actor = me();
  db.tx(() => {
    const top = db.get<{ n: number }>('SELECT n FROM comment WHERE id = ? AND shot_id = ?', upto, shotId)?.n;
    if (top === undefined) return;
    db.run(
      'INSERT INTO comment_read (account_id, shot_id, read_n) VALUES (?, ?, ?) ON CONFLICT(account_id, shot_id) DO UPDATE SET read_n = MAX(read_n, excluded.read_n)',
      actor.id,
      shotId,
      top,
    );
    db.run(
      'UPDATE comment_mention SET seen_at = ? WHERE account_id = ? AND seen_at IS NULL AND comment_id IN (SELECT id FROM comment WHERE shot_id = ? AND n <= ?)',
      now,
      actor.id,
      shotId,
      top,
    );
  });
}

export function commentSummary(db: DbPort): CommentSummary {
  const actor = me();
  const shots: CommentSummary['shots'] = {};
  const rows = db.all<{ shot_id: string; total: number; unresolved: number; unread: number }>(
    `SELECT c.shot_id,
            COUNT(*) FILTER (WHERE c.deleted_at IS NULL) AS total,
            COUNT(*) FILTER (WHERE c.parent_id IS NULL AND c.deleted_at IS NULL AND c.resolved_at IS NULL) AS unresolved,
            COUNT(*) FILTER (WHERE c.actor_id != ? AND c.deleted_at IS NULL AND c.n > COALESCE(r.read_n, 0)) AS unread
       FROM comment c LEFT JOIN comment_read r ON r.shot_id = c.shot_id AND r.account_id = ?
      GROUP BY c.shot_id`,
    actor.id,
    actor.id,
  );
  for (const r of rows) if (r.total > 0) shots[r.shot_id] = { total: Number(r.total), unresolved: Number(r.unresolved), unread: Number(r.unread) };
  const who = actorResolver(db);
  const mentions = db
    .all<CommentRow>(
      `SELECT ${COLS.split(', ').map((c) => `c.${c}`).join(', ')} FROM comment c JOIN comment_mention m ON m.comment_id = c.id
        JOIN shot s ON s.id = c.shot_id
        WHERE m.account_id = ? AND m.seen_at IS NULL AND c.deleted_at IS NULL AND s.archived = 0 ORDER BY c.n DESC LIMIT 30`,
      actor.id,
    )
    .map((c) => {
      const shot = getShot(db, c.shot_id);
      const scene = shot ? getScene(db, shot.scene_id) : null;
      return {
        comment_id: c.id,
        shot_id: c.shot_id,
        scene_no: scene?.display_no ?? null,
        shot_code: shot?.code ?? null,
        author: who(c.actor_id)!,
        excerpt: [...c.body].slice(0, 60).join(''),
        at: c.created_at,
      };
    });
  return { shots, mentions };
}
