import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommentMention, CommentSummary, ShotComment } from '@storyscript/contracts';
import { api, isApiClientError } from './api.ts';
import { upsertComment, type ShotCommentCount } from './comments.ts';
import { describeError } from './errors.ts';
import { useHealth } from './queries.ts';

/**
 * S4b — shot comments (hosted server only; the local app answers 404). All
 * keys sit under ['comments', …], the root the change feed refreshes when a
 * teammate comments, resolves or deletes.
 */

export const commentKeys = {
  all: ['comments'] as const,
  summary: ['comments', 'summary'] as const,
  shot: (shotId: string) => ['comments', 'shot', shotId] as const,
};

/** Comments exist only on the hosted server. */
export function useIsHosted(): boolean {
  return useHealth().data?.hosted ?? false;
}

/** Per-shot counts and the mentions of the signed-in member; `select` narrows what one component re-renders on. */
export function useCommentSummary<T = CommentSummary>(select?: (s: CommentSummary) => T) {
  const hosted = useIsHosted();
  return useQuery({
    queryKey: commentKeys.summary,
    queryFn: ({ signal }) => api.call('commentSummary', undefined, { signal }),
    enabled: hosted,
    select,
  });
}

/** One shot's counts for the badge on its row (undefined: none, or not hosted). */
export function useShotCommentCount(shotId: string): ShotCommentCount | undefined {
  return useCommentSummary((s) => s.shots[shotId]).data;
}

/** A shot's comments, oldest first as the server sends them. Always fetched fresh when its panel opens. */
export function useShotComments(shotId: string, enabled = true) {
  return useQuery({
    queryKey: commentKeys.shot(shotId),
    queryFn: ({ signal }) => api.call('listComments', undefined, { signal, params: { id: shotId } }),
    enabled,
    refetchOnMount: 'always',
  });
}

/** Keep the list in step with what a write returned, and refresh the counts. */
function useCommentWrite(shotId: string) {
  const qc = useQueryClient();
  return (c: ShotComment) => {
    qc.setQueryData<ShotComment[]>(commentKeys.shot(shotId), (old) => upsertComment(old, c));
    void qc.invalidateQueries({ queryKey: commentKeys.summary });
  };
}

export interface NewComment {
  body: string;
  mentions: CommentMention[];
  /** the board version it is about (board page) */
  boardId?: string | null;
  /** a top-level comment to reply to */
  parentId?: string | null;
}

export function useCreateComment(shotId: string) {
  const wrote = useCommentWrite(shotId);
  return useMutation({
    mutationFn: (c: NewComment) =>
      api.call('createComment', { body: c.body, mentions: c.mentions, board_id: c.boardId ?? null, parent_id: c.parentId ?? null }, { params: { id: shotId } }),
    onSuccess: wrote,
  });
}

export function useUpdateComment(shotId: string) {
  const wrote = useCommentWrite(shotId);
  return useMutation({
    mutationFn: ({ id, body, mentions }: { id: string; body: string; mentions: CommentMention[] }) =>
      api.call('updateComment', { body, mentions }, { params: { id } }),
    onSuccess: wrote,
  });
}

export function useDeleteComment(shotId: string) {
  const wrote = useCommentWrite(shotId);
  return useMutation({ mutationFn: (id: string) => api.call('deleteComment', undefined, { params: { id } }), onSuccess: wrote });
}

/** Resolve (`resolved` true) or reopen a top-level comment's thread. */
export function useResolveComment(shotId: string) {
  const wrote = useCommentWrite(shotId);
  return useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) => api.call(resolved ? 'resolveComment' : 'reopenComment', undefined, { params: { id } }),
    onSuccess: wrote,
  });
}

/** The panel is showing this shot's comments: mark them (and the mentions) read, then refresh the counts and the bell. */
export function useMarkCommentsRead(shotId: string) {
  const qc = useQueryClient();
  return useMutation({
    // `upto`: the newest comment this panel has loaded; anything newer stays unread
    mutationFn: (upto: string) => api.call('markCommentsRead', { upto }, { params: { id: shotId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: commentKeys.summary }),
  });
}

/**
 * What to tell the person when a comment could not be saved. The server's
 * own sentence is kept for the codes that carry one about the comment itself
 * (a role nobody holds, a comment that is not theirs to edit).
 */
export function commentErrorText(error: unknown): { title: string; detail: string | null } {
  if (isApiClientError(error) && (error.code === 'VALIDATION_ERROR' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND') && error.status !== 0) {
    const notFound = error.code === 'NOT_FOUND';
    return { title: notFound ? '这条批注或镜头已经不在了' : '批注没有保存', detail: notFound ? '它可能已被删除或归档，刷新后再看。' : error.message };
  }
  const human = describeError(error, 'general');
  return { title: human.title, detail: human.detail };
}
