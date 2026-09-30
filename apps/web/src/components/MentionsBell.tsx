import { useEffect, useId, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { mentionLine } from '../lib/mentions.ts';
import { requestOpenShot } from '../lib/open-shot.ts';
import { useCommentSummary, useIsHosted } from '../lib/queries-comments.ts';
import { navigate } from '../lib/route.ts';
import { ErrorNotice } from './ErrorNotice.tsx';
import { Spinner } from './ui.tsx';
import { EmptyState } from './workspace.tsx';

/**
 * S4b — the 提到我的 bell in the title bar (hosted server only). The count is
 * the comments that @-mention the signed-in member and are not seen yet; the
 * popover lists them, and a click goes to the script page with that shot
 * open and its comments in view. Opening the shot marks its comments read,
 * so the count falls by itself.
 *
 * Mount it beside the account menu in the title bar's `account` slot.
 */
export function MentionsBell() {
  const hosted = useIsHosted();
  const summary = useCommentSummary((s) => s.mentions);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const headingId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!hosted) return null;

  const mentions = summary.data ?? [];
  const count = mentions.length;

  let body;
  if (summary.isPending) {
    body = (
      <div className="px-3 py-4">
        <Spinner label="正在读取…" />
      </div>
    );
  } else if (summary.isError) {
    body = (
      <div className="p-2">
        <ErrorNotice error={summary.error} />
      </div>
    );
  } else if (count === 0) {
    body = <EmptyState quiet title="没有人提到你。" description="组员在镜头批注里 @ 你或你的职务时，会显示在这里。" />;
  } else {
    body = (
      <ul className="max-h-[min(360px,60dvh)] divide-y divide-graphite-800 overflow-auto">
        {mentions.map((m) => (
          <li key={m.comment_id}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                requestOpenShot({ shotId: m.shot_id, comments: true, commentId: m.comment_id });
                navigate('script');
              }}
              className="block w-full px-3 py-2 text-left text-sm break-words text-graphite-100 hover:bg-graphite-800"
            >
              {mentionLine(m)}
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="提到我的批注"
        onClick={() => {
          setOpen((o) => !o);
          if (summary.isError) void summary.refetch();
        }}
        className={
          'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-control px-2 text-graphite-300 ' +
          'hover:bg-graphite-800 hover:text-graphite-100 aria-expanded:bg-graphite-800 aria-expanded:text-graphite-100'
        }
      >
        <Bell aria-hidden className="size-4" />
        {count > 0 ? (
          <span aria-hidden className="text-xs font-semibold text-graphite-100 tabular-nums">
            {count}
          </span>
        ) : null}
        <span className="sr-only">{count > 0 ? `提到我的：${count} 条未读` : '提到我的'}</span>
      </button>

      {open ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          className={
            'absolute top-full right-0 z-30 mt-1 w-[360px] overflow-hidden rounded-panel border border-graphite-700 bg-graphite-900 ' +
            // on a phone the popover spans the window, whatever else sits next to the bell in the title bar
            'max-md:fixed max-md:inset-x-2 max-md:top-9 max-md:mt-0 max-md:w-auto'
          }
        >
          <h2 id={headingId} className="flex h-7 items-center border-b border-graphite-950 bg-graphite-800 px-3 text-xs font-medium text-graphite-300">
            提到我的
          </h2>
          {body}
        </div>
      ) : null}
    </div>
  );
}
