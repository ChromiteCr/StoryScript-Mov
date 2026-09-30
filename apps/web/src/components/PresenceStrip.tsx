import { useEffect, useState } from 'react';
import type { PresenceEntry } from '@storyscript/contracts';
import { Users } from 'lucide-react';
import { ACTIVITY_MS, activityLine, eventLine, initialOf, othersOnline, PAGE_LABEL, presenceTitle, useCollabFeed } from '../lib/collab.ts';
import { actorText } from '../lib/crew.ts';
import { Dialog } from './Dialog.tsx';
import { Tag } from './ui.tsx';

/**
 * S4a — who is in the project with you (hosted server), in the title bar:
 * up to five initials of the teammates online now (a teammate whose tab is
 * in the background is dimmed), and a button that opens the full list with
 * the page each one is on and the group's last events. Initials are text,
 * never images. On narrow screens the strip folds into one button with the
 * head count.
 */

const MAX_AVATARS = 5;

function Avatar({ entry }: { entry: PresenceEntry }) {
  return (
    <span
      title={presenceTitle(entry)}
      className={
        'inline-flex size-6 items-center justify-center rounded-full border border-graphite-950 bg-graphite-700 text-xs font-medium text-graphite-100 ' +
        (entry.away ? 'opacity-50' : '')
      }
    >
      {initialOf(entry.actor.name)}
    </span>
  );
}

export function PresenceStrip() {
  const { presence } = useCollabFeed();
  const [open, setOpen] = useState(false);
  const others = othersOnline(presence);
  const shown = others.slice(0, MAX_AVATARS);
  const label = others.length === 0 ? '谁在线：现在只有你' : `谁在线：${others.map((o) => o.actor.name).join('、')}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-control px-1 text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100"
      >
        {others.length === 0 ? (
          <Users aria-hidden className="size-3.5" />
        ) : (
          <>
            <span className="flex -space-x-1 max-md:hidden">
              {shown.map((p) => (
                <Avatar key={p.actor.id} entry={p} />
              ))}
            </span>
            <span className="inline-flex items-center gap-1 md:hidden">
              <Users aria-hidden className="size-3.5" />
              <span className="text-xs tabular-nums">{others.length}</span>
            </span>
            {others.length > MAX_AVATARS ? <span className="text-xs tabular-nums max-md:hidden">+{others.length - MAX_AVATARS}</span> : null}
          </>
        )}
      </button>
      {open ? <PresenceDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function PresenceDialog({ onClose }: { onClose: () => void }) {
  const { presence, events } = useCollabFeed();
  return (
    <Dialog title="谁在线" onClose={onClose} description="组员在哪一页，以及组里最近的改动。每几秒刷新一次。">
      <div className="flex flex-col gap-4">
        <section aria-labelledby="presence-online">
          <h3 id="presence-online" className="text-sm font-semibold text-graphite-100">
            在线 <span className="tabular-nums">{presence.length}</span>
          </h3>
          {presence.length === 0 ? (
            <p className="mt-1.5 text-xs text-graphite-300">现在没有人在线。</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {presence.map((p) => (
                <li key={p.actor.id} className="flex items-center gap-2">
                  <Avatar entry={p} />
                  <span className="min-w-0 flex-1 text-sm break-words text-graphite-100">{actorText(p.actor)}</span>
                  <span className="shrink-0 text-xs text-graphite-300">{PAGE_LABEL[p.page]}</span>
                  {p.you ? <Tag>你</Tag> : null}
                  {p.away ? <Tag>离开</Tag> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="presence-events">
          <h3 id="presence-events" className="text-sm font-semibold text-graphite-100">
            最近动态
          </h3>
          {events.length === 0 ? (
            <p className="mt-1.5 text-xs text-graphite-300">还没有动态。组员改了什么，会记在这里。</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {events.map((e) => (
                <li key={e.seq} className="text-xs leading-5 break-words text-graphite-100">
                  {eventLine(e)}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}

/**
 * 「阿杰刚改了 第 3 场 002」: the newest change of a teammate, for eight
 * seconds after it arrives. Hidden below 1024px (the title bar has no room
 * there); the popover keeps the list.
 */
export function ActivityLine() {
  const { latest } = useCollabFeed();
  const [shown, setShown] = useState<number | null>(null);
  const key = latest ? `${latest.event.seq}:${latest.shownAt}` : null;

  useEffect(() => {
    if (!latest) return;
    setShown(latest.shownAt);
    const t = window.setTimeout(() => setShown((cur) => (cur === latest.shownAt ? null : cur)), ACTIVITY_MS);
    return () => window.clearTimeout(t);
    // a new event (its key) restarts the eight seconds
  }, [key]);

  if (!latest || shown !== latest.shownAt) return null;
  return (
    <p role="status" className="max-w-72 min-w-0 truncate text-xs text-graphite-300 max-lg:hidden" title={eventLine(latest.event)}>
      {activityLine(latest.event)}
    </p>
  );
}
