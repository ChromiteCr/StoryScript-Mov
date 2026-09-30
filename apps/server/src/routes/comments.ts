import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, CommentSummary, CreateCommentInput, MarkCommentsReadInput, ShotComment, UpdateCommentInput } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { commentSummary, createComment, deleteComment, listComments, markRead, setResolved, updateComment } from '../services/comments.ts';

/** S4b — comments on shots (hosted server; 404 locally, where nobody signs in). */
export function registerCommentRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.commentSummary.path, (c) => respond(c, CommentSummary, commentSummary(db())));
  app.get(Api.listComments.path, (c) => respond(c, z.array(ShotComment), listComments(db(), idParam(c))));
  app.post(Api.createComment.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, CreateCommentInput);
    return respond(c, ShotComment, createComment(db(), id, input), 201);
  });
  app.post(Api.markCommentsRead.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, MarkCommentsReadInput);
    markRead(db(), id, input.upto);
    return c.body(null, 204);
  });
  app.patch(Api.updateComment.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, UpdateCommentInput);
    return respond(c, ShotComment, updateComment(db(), id, input));
  });
  app.delete(Api.deleteComment.path, (c) => respond(c, ShotComment, deleteComment(db(), idParam(c))));
  app.post(Api.resolveComment.path, (c) => respond(c, ShotComment, setResolved(db(), idParam(c), true)));
  app.post(Api.reopenComment.path, (c) => respond(c, ShotComment, setResolved(db(), idParam(c), false)));
}
