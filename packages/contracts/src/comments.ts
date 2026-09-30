import { z } from 'zod';
import { ActorRef, CrewRole, IsoTime, Uuid } from './common.ts';

// ---------------------------------------------------------------------------
// S4b — comments on shots (hosted server). A thread lives on a shot and may
// point at one board version; replies are one level deep. @-mentions name a
// member or a crew role (@导演 reaches whoever holds it when the comment is
// written). Deleted comments stay as 「已删除」 so a thread stays readable.
// ---------------------------------------------------------------------------

export const COMMENT_MAX = 2000;

export const CommentMention = z.union([z.object({ member: z.string().min(1) }), z.object({ role: CrewRole })]);
export type CommentMention = z.infer<typeof CommentMention>;

export const ShotComment = z.object({
  id: Uuid,
  shot_id: Uuid,
  /** the board version it is about, if any */
  board_id: Uuid.nullable(),
  board_version: z.number().int().positive().nullable(),
  parent_id: Uuid.nullable(),
  author: ActorRef,
  /** "" when deleted */
  body: z.string(),
  /** members reached (roles already expanded) */
  mentions: z.array(ActorRef),
  /** roles the author typed, e.g. 导演 */
  mention_roles: z.array(z.string()),
  resolved_at: IsoTime.nullable(),
  resolved_by: ActorRef.nullable(),
  edited_at: IsoTime.nullable(),
  deleted: z.boolean(),
  created_at: IsoTime,
  /** written by the signed-in account */
  mine: z.boolean(),
  /** someone else wrote it after this account last read the shot's comments */
  unread: z.boolean(),
});
export type ShotComment = z.infer<typeof ShotComment>;

export const CreateCommentInput = z.object({
  body: z.string().trim().min(1).max(COMMENT_MAX),
  board_id: Uuid.nullable().default(null),
  /** reply to a top-level comment */
  parent_id: Uuid.nullable().default(null),
  mentions: z.array(CommentMention).max(20).default([]),
});
export type CreateCommentInput = z.infer<typeof CreateCommentInput>;

export const UpdateCommentInput = z.object({
  body: z.string().trim().min(1).max(COMMENT_MAX),
  mentions: z.array(CommentMention).max(20).default([]),
});
export type UpdateCommentInput = z.infer<typeof UpdateCommentInput>;

export const CommentSummary = z.object({
  /** per shot with any comments: how many threads are open and how many comments are unread */
  shots: z.record(z.string(), z.object({ total: z.number().int(), unresolved: z.number().int(), unread: z.number().int() })),
  /** comments that mention the signed-in account and are not seen yet, newest first */
  mentions: z.array(
    z.object({
      comment_id: Uuid,
      shot_id: Uuid,
      scene_no: z.string().nullable(),
      shot_code: z.string().nullable(),
      author: ActorRef,
      excerpt: z.string(),
      at: IsoTime,
    }),
  ),
});
export type CommentSummary = z.infer<typeof CommentSummary>;
