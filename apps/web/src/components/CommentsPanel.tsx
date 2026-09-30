import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { COMMENT_MAX, type CommentMention, type ShotComment } from '@storyscript/contracts';
import { AtSign, CircleCheck, MessageSquare, Pencil, Reply, RotateCcw, Trash2 } from 'lucide-react';
import {
  buildThreads,
  canDelete,
  canEdit,
  canReply,
  canResolve,
  commentBadge,
  commentDomId,
  commentsSectionDomId,
  filterThreads,
  formatCommentTime,
  mentionTags,
  threadUnread,
  type CommentScope,
  type Thread,
} from '../lib/comments.ts';
import {
  activeMention,
  extractMentions,
  filterCandidates,
  insertAt,
  insertMention,
  mentionCandidates,
  mentionReach,
  excerptOf,
  reachText,
  type MentionCandidate,
  type RosterMember,
} from '../lib/mentions.ts';
import {
  commentErrorText,
  useCreateComment,
  useDeleteComment,
  useMarkCommentsRead,
  useResolveComment,
  useShotCommentCount,
  useShotComments,
  useUpdateComment,
} from '../lib/queries-comments.ts';
import {
  clearCommentsFocus,
  commentsFocusFor,
  commentsFocusSnapshot,
  subscribeCommentsFocus,
} from '../lib/open-shot.ts';
import { ActorLabel } from './ActorLabel.tsx';
import { useMe } from './AccountMenu.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';
import { Menu, type MenuItem } from './Menu.tsx';
import { MentionPicker, mentionOptionId } from './MentionPicker.tsx';
import { Button, IconButton, Notice, Spinner, Tag, TextArea } from './ui.tsx';
import { InspectorGroup } from './workspace.tsx';

/**
 * S4b — a shot's comments (hosted server). Threads oldest first with one level
 * of replies; a resolved thread folds to one line. Anyone in the group writes,
 * replies, resolves and reopens; only the author edits; the author or the
 * leader deletes (the row stays as 「已删除」 so replies still read). `@` in the
 * box offers the members and the crew roles somebody holds.
 *
 * Shown under the shot editor on the script page, and on the board page with
 * `board` set: new comments are about that board version, and 本版 / 全部
 * filters the threads.
 */

const NO_MEMBERS: readonly RosterMember[] = [];

export interface CommentsBoard {
  id: string;
  version: number;
}

function scrollToId(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
}

function usePageVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

// ---------------------------------------------------------------------- badge

/** 「批注 2」 with a dot for unread, on a shot row. A tap opens the shot with its comments. Nothing for a shot without comments. */
export function CommentBadge({ shotId, label, onOpen }: { shotId: string; label: string; onOpen: () => void }) {
  const info = commentBadge(useShotCommentCount(shotId));
  if (!info) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={info.title}
      aria-label={`${label}：${info.title}`}
      className={
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-control border border-graphite-700 px-1.5 text-xs hover:border-graphite-500 hover:text-graphite-100 ' +
        (info.quiet ? 'text-graphite-300' : 'text-graphite-100')
      }
    >
      <MessageSquare aria-hidden className="size-3" />
      <span className="tabular-nums">{info.text}</span>
      {info.unread ? <span aria-hidden className="size-1.5 rounded-full bg-warn" /> : null}
    </button>
  );
}

// ------------------------------------------------------------------- composer

interface ComposerProps {
  /** accessible name of the box */
  label: string;
  placeholder?: string;
  /** a line above the box, e.g. 针对 v3 */
  hint?: string | null;
  members: readonly RosterMember[];
  initial?: string;
  submitLabel: string;
  submit: (body: string, mentions: CommentMention[]) => Promise<unknown>;
  onDone?: () => void;
  onCancel?: () => void;
  /** empty the box after a successful send (a new comment) */
  clearOnDone?: boolean;
  autoFocus?: boolean;
  rows?: number;
}

/** The box, the @ list, what a mention will reach, the counter and the send button. */
function Composer({
  label,
  placeholder,
  hint = null,
  members,
  initial = '',
  submitLabel,
  submit,
  onDone,
  onCancel,
  clearOnDone = false,
  autoFocus = false,
  rows = 3,
}: ComposerProps) {
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const box = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();
  const counterId = useId();

  const everyone = useMemo(() => mentionCandidates(members, { includeSelf: true }), [members]);
  const pickable = useMemo(() => mentionCandidates(members), [members]);
  const query = activeMention(text, caret);
  const queryStart = query?.start ?? -1;
  const queryText = query?.query ?? '';
  const options = useMemo(
    () => (queryStart >= 0 && dismissed !== queryStart ? filterCandidates(pickable, queryText) : []),
    [pickable, queryStart, queryText, dismissed],
  );
  const open = options.length > 0;
  const index = open ? Math.min(active, options.length - 1) : 0;
  const mentions = useMemo(() => extractMentions(text, everyone), [text, everyone]);
  const reach = reachText(mentionReach(mentions, members));
  const canSend = text.trim() !== '' && !busy;

  useEffect(() => {
    if (!autoFocus) return;
    const ta = box.current?.querySelector('textarea');
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [autoFocus]);

  // after the text changes under the caret (a picked name, the @ button), put the caret back where it belongs
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const ta = box.current?.querySelector('textarea');
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(at, at);
  });

  const edit = (next: { text: string; caret: number }) => {
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
    setDismissed(null);
  };

  const pick = (c: MentionCandidate) => {
    if (query) edit(insertMention(text, query, c));
  };

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await submit(text.trim(), mentions);
      if (clearOnDone) {
        setText('');
        setCaret(0);
      }
      onDone?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // an input method is choosing characters
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((index + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
        e.preventDefault();
        const chosen = options[index];
        if (chosen) pick(chosen);
        return;
      }
      if (e.key === 'Escape' && query) {
        e.preventDefault();
        setDismissed(query.start);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };

  const failure = error ? commentErrorText(error) : null;

  return (
    <div ref={box} className="flex flex-col gap-1.5">
      {hint ? <p className="text-xs text-graphite-300">{hint}</p> : null}
      <TextArea
        aria-label={label}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? mentionOptionId(listId, index) : undefined}
        aria-describedby={counterId}
        rows={rows}
        maxLength={COMMENT_MAX}
        value={text}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
          setDismissed(null);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {open ? <MentionPicker id={listId} candidates={options} active={index} onPick={pick} onHover={setActive} /> : null}
      <p role="status" className="sr-only">
        {open ? `${options.length} 个可选，用上下键选择，回车确认` : ''}
      </p>
      {reach ? <p className="text-xs text-graphite-300">{reach}</p> : null}
      {failure ? (
        <Notice tone="danger" title={failure.title}>
          {failure.detail}
        </Notice>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="primary" busy={busy} disabled={!canSend} onClick={() => void send()} title="Ctrl / ⌘ + 回车也可以发表">
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        ) : null}
        <IconButton icon={AtSign} label="提到组员或职务" disabled={busy} onClick={() => edit(insertAt(text, caret))} />
        <span id={counterId} className="ml-auto text-xs text-graphite-300 tabular-nums">
          {text.length} / {COMMENT_MAX}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one comment

interface Env {
  members: readonly RosterMember[];
  leader: boolean;
  board: CommentsBoard | null;
  fresh: ReadonlySet<string>;
  replyTo: string | null;
  setReplyTo: (id: string | null) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  create: ReturnType<typeof useCreateComment>;
  update: ReturnType<typeof useUpdateComment>;
  remove: ReturnType<typeof useDeleteComment>;
  resolve: ReturnType<typeof useResolveComment>;
}

function CommentView({ c, env, resolved }: { c: ShotComment; env: Env; resolved: boolean }) {
  const tags = mentionTags(c);
  const items: (MenuItem | 'separator')[] = [];
  if (canReply(c)) {
    items.push({
      key: 'reply',
      label: '回复',
      icon: <Reply className="size-3.5" />,
      onSelect: () => {
        env.setEditing(null);
        env.setReplyTo(c.id);
      },
    });
  }
  if (canEdit(c)) {
    items.push({
      key: 'edit',
      label: '编辑',
      icon: <Pencil className="size-3.5" />,
      onSelect: () => {
        env.setReplyTo(null);
        env.setEditing(c.id);
      },
    });
  }
  if (canResolve(c)) {
    items.push(
      resolved
        ? { key: 'reopen', label: '重新打开', icon: <RotateCcw className="size-3.5" />, onSelect: () => env.resolve.mutate({ id: c.id, resolved: false }) }
        : { key: 'resolve', label: '标为已解决', icon: <CircleCheck className="size-3.5" />, onSelect: () => env.resolve.mutate({ id: c.id, resolved: true }) },
    );
  }
  if (canDelete(c, env.leader)) {
    if (items.length > 0) items.push('separator');
    items.push({
      key: 'delete',
      label: '删除',
      icon: <Trash2 className="size-3.5" />,
      danger: true,
      onSelect: () => {
        if (window.confirm('删除这条批注？它会显示为「已删除」，对它的回复仍然保留。')) env.remove.mutate(c.id);
      },
    });
  }

  return (
    <article aria-label={`${c.author.name} 的批注`} className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-graphite-300">
        {env.fresh.has(c.id) ? (
          <>
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
            <span className="sr-only">未读</span>
          </>
        ) : null}
        <span className="min-w-0 font-medium text-graphite-100">
          <ActorLabel actor={c.author} />
        </span>
        {c.mine ? <Tag>我</Tag> : null}
        <time dateTime={c.created_at} className="tabular-nums">
          {formatCommentTime(c.created_at)}
        </time>
        {c.edited_at && !c.deleted ? <span>已编辑</span> : null}
        {c.board_version !== null ? <Tag title="这条批注针对的分镜版本">针对 v{c.board_version}</Tag> : null}
        {items.length > 0 ? (
          <div className="ml-auto">
            <Menu label={`批注操作（${c.author.name}）`} items={items} />
          </div>
        ) : null}
      </div>
      {env.editing === c.id ? (
        <div className="mt-1.5">
          <Composer
            label="修改批注"
            members={env.members}
            initial={c.body}
            submitLabel="保存"
            rows={3}
            autoFocus
            submit={(body, mentions) => env.update.mutateAsync({ id: c.id, body, mentions })}
            onDone={() => env.setEditing(null)}
            onCancel={() => env.setEditing(null)}
          />
        </div>
      ) : c.deleted ? (
        <p className="mt-1 text-sm text-graphite-300">已删除</p>
      ) : (
        <>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap text-graphite-100">{c.body}</p>
          {tags.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tags.map((t) => (
                <Tag key={t.key} title={t.title ?? undefined}>
                  {t.text}
                </Tag>
              ))}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

function ThreadView({ thread, env, expanded, onToggle }: { thread: Thread; env: Env; expanded: boolean; onToggle: () => void }) {
  const { root, replies, resolved } = thread;
  const unread = threadUnread(thread) > 0 || [root, ...replies].some((c) => env.fresh.has(c.id));
  // a thread with a reply or an edit being typed never folds (a teammate may resolve it meanwhile)
  const composing = env.replyTo === root.id || env.editing === root.id || replies.some((r) => env.editing === r.id);

  if (resolved && !expanded && !composing) {
    const by = root.resolved_by?.name ?? '组员';
    return (
      <li id={commentDomId(root.id)} className="py-2">
        <button
          type="button"
          aria-expanded={false}
          onClick={onToggle}
          title={excerptOf(root.deleted ? '已删除' : root.body, 80)}
          className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-control px-1 text-left text-xs text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100"
        >
          <CircleCheck aria-hidden className="size-3.5 shrink-0 text-ok" />
          <span className="min-w-0 truncate">
            已解决 · {by} · {root.resolved_at ? formatCommentTime(root.resolved_at) : ''}（展开）
          </span>
          {unread ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" /> : null}
        </button>
      </li>
    );
  }

  return (
    <li id={commentDomId(root.id)} className="flex flex-col gap-2 py-3">
      {resolved ? (
        <div className="flex items-center gap-1.5 text-xs text-graphite-300">
          <CircleCheck aria-hidden className="size-3.5 shrink-0 text-ok" />
          <span className="min-w-0 truncate">
            已解决 · {root.resolved_by?.name ?? '组员'} · {root.resolved_at ? formatCommentTime(root.resolved_at) : ''}
          </span>
          {composing ? null : (
            <Button size="sm" variant="ghost" className="ml-auto" aria-expanded onClick={onToggle}>
              收起
            </Button>
          )}
        </div>
      ) : null}
      <CommentView c={root} env={env} resolved={resolved} />
      {replies.length > 0 ? (
        <ol className="ml-2 flex flex-col gap-3 border-l border-graphite-700 pl-3">
          {replies.map((r) => (
            <li key={r.id} id={commentDomId(r.id)}>
              <CommentView c={r} env={env} resolved={false} />
            </li>
          ))}
        </ol>
      ) : null}
      {env.replyTo === root.id ? (
        <div className="ml-2 border-l border-graphite-700 pl-3">
          <Composer
            label={`回复 ${root.author.name}`}
            placeholder="回复…"
            hint={env.board ? `针对 v${env.board.version}` : null}
            members={env.members}
            submitLabel="发表回复"
            rows={2}
            autoFocus
            submit={(body, mentions) => env.create.mutateAsync({ body, mentions, boardId: env.board?.id ?? null, parentId: root.id })}
            onDone={() => env.setReplyTo(null)}
            onCancel={() => env.setReplyTo(null)}
          />
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------- panel

/** 本版 / 全部 on the board page, each with how many threads it holds. */
function ScopeToggle({ scope, onScope, here, all }: { scope: CommentScope; onScope: (s: CommentScope) => void; here: number; all: number }) {
  const options: { id: CommentScope; text: string }[] = [
    { id: 'board', text: `本版 ${here}` },
    { id: 'all', text: `全部 ${all}` },
  ];
  return (
    <div role="radiogroup" aria-label="批注范围" className="flex items-center gap-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={scope === o.id}
          onClick={() => onScope(o.id)}
          className={
            'h-5 rounded-control px-1.5 text-xs tabular-nums ' +
            (scope === o.id ? 'bg-graphite-700 text-graphite-100' : 'text-graphite-300 hover:bg-graphite-700 hover:text-graphite-100')
          }
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

export function CommentsPanel({ shotId, board = null }: { shotId: string; board?: CommentsBoard | null }) {
  const comments = useShotComments(shotId);
  const me = useMe();
  const create = useCreateComment(shotId);
  const update = useUpdateComment(shotId);
  const remove = useDeleteComment(shotId);
  const resolve = useResolveComment(shotId);
  const markRead = useMarkCommentsRead(shotId);
  const visible = usePageVisible();

  const members = me.data?.group?.members ?? NO_MEMBERS;
  const leader = me.data?.group?.role === 'leader';
  const [scope, setScope] = useState<CommentScope>('board');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());

  const list = comments.data;
  const boardId = board?.id ?? null;
  const threads = useMemo(() => buildThreads(list ?? []), [list]);
  const shown = useMemo(() => (boardId ? filterThreads(threads, scope, boardId) : threads), [threads, scope, boardId]);
  const hereCount = useMemo(() => (boardId ? filterThreads(threads, 'board', boardId).length : 0), [threads, boardId]);

  // What was unread when it arrived stays marked while this panel is open, even after the server has it as read.
  const unreadKey = (list ?? [])
    .filter((c) => c.unread)
    .map((c) => c.id)
    .join(',');
  useEffect(() => {
    if (unreadKey === '') return;
    const ids = unreadKey.split(',');
    setFresh((cur) => (ids.every((id) => cur.has(id)) ? cur : new Set([...cur, ...ids])));
  }, [unreadKey]);

  // Showing the comments is reading them: tell the server (once per set of new comments), then the counts and the bell refresh.
  const mark = markRead.mutate;
  const newest = list?.at(-1)?.id ?? null;
  useEffect(() => {
    if (unreadKey !== '' && visible && newest) mark(newest);
  }, [unreadKey, visible, newest, mark]);

  // Arriving from the bell or a row's badge: open the resolved thread it is in, then scroll to the comment.
  useSyncExternalStore(subscribeCommentsFocus, commentsFocusSnapshot, () => null);
  const focus = commentsFocusFor(shotId);
  const settled = comments.isSuccess && !comments.isFetching;
  useEffect(() => {
    if (!focus || !settled) return;
    const target = focus.commentId;
    const thread = target ? threads.find((t) => t.root.id === target || t.replies.some((r) => r.id === target)) : undefined;
    if (thread?.resolved) setExpanded((cur) => new Set(cur).add(thread.root.id));
    if (thread && boardId && thread.root.board_id !== boardId) setScope('all');
    clearCommentsFocus();
    window.requestAnimationFrame(() => scrollToId(thread ? commentDomId(target ?? thread.root.id) : commentsSectionDomId(shotId)));
  }, [focus, settled, threads, boardId, shotId]);

  const env: Env = { members, leader, board, fresh, replyTo, setReplyTo, editing, setEditing, create, update, remove, resolve };
  const actionError = resolve.error ?? remove.error;
  const dismissActionError = () => {
    resolve.reset();
    remove.reset();
  };
  const action = actionError ? commentErrorText(actionError) : null;

  // a failed refresh keeps showing what is there (and what is being typed); only a first load can fail the panel
  let body;
  if (list === undefined && !comments.isError) {
    body = <Spinner label="正在读取批注…" />;
  } else if (list === undefined) {
    body = (
      <div className="flex flex-col items-start gap-2">
        <ErrorNotice error={comments.error} className="w-full" />
        <Button size="sm" onClick={() => void comments.refetch()}>
          重试
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        {action ? (
          <Notice tone="danger" title={action.title}>
            <p>{action.detail}</p>
            <Button size="sm" variant="ghost" className="mt-1" onClick={dismissActionError}>
              知道了
            </Button>
          </Notice>
        ) : null}
        {shown.length === 0 ? (
          <p className="text-xs leading-5 text-graphite-300">
            {board && threads.length > 0 ? '这一版还没有批注。切到「全部」可以看其他版本的。' : '还没有批注。给组员留话，用 @ 提到人或职务，他们会收到提醒。'}
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-graphite-800">
            {shown.map((t) => (
              <ThreadView
                key={t.root.id}
                thread={t}
                env={env}
                expanded={expanded.has(t.root.id)}
                onToggle={() =>
                  setExpanded((cur) => {
                    const next = new Set(cur);
                    if (!next.delete(t.root.id)) next.add(t.root.id);
                    return next;
                  })
                }
              />
            ))}
          </ol>
        )}
        <Composer
          label="写批注"
          placeholder="写批注，输入 @ 提到组员或职务"
          hint={board ? `新批注针对 v${board.version}` : null}
          members={members}
          submitLabel="发表"
          clearOnDone
          submit={(text, mentions) => create.mutateAsync({ body: text, mentions, boardId: board?.id ?? null })}
        />
      </>
    );
  }

  return (
    // the group's own first-child padding is 8px; this wrapper makes it the 16px the other groups have
    <div id={commentsSectionDomId(shotId)} className="pt-2">
      <InspectorGroup
        title="批注"
        actions={board ? <ScopeToggle scope={scope} onScope={setScope} here={hereCount} all={threads.length} /> : undefined}
        note={<div className="flex flex-col gap-3 text-sm text-graphite-100">{body}</div>}
      />
    </div>
  );
}
