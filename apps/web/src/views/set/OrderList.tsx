import { useRef, type KeyboardEvent } from 'react';
import { ZH_SHOT_SIZE } from '@storyscript/core';
import type { ShootingOrder, ShotRef } from './model.ts';

/**
 * Left column of the set page: shots in shooting order (approved plan) or
 * narrative order. Click = current shot; the checkbox adds a shot to the
 * take being logged (one take can cover several shots). ↑/↓ move the current
 * shot, as a slate operator steps through the day.
 */

export interface OrderListProps {
  order: ShootingOrder;
  currentId: string | null;
  included: ReadonlySet<string>;
  takeCounts: ReadonlyMap<string, number>;
  onSelect: (id: string) => void;
  onToggleInclude: (id: string) => void;
}

export function OrderList({ order, currentId, included, takeCounts, onSelect, onToggleInclude }: OrderListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const move = (delta: number) => {
    const at = order.refs.findIndex((r) => r.shot.id === currentId);
    const next = order.refs[Math.min(order.refs.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))];
    if (!next) return;
    onSelect(next.shot.id);
    listRef.current?.querySelector<HTMLButtonElement>(`button[data-shot="${next.shot.id}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    }
  };

  return (
    <div ref={listRef} onKeyDown={onKeyDown} className="flex flex-col">
      {order.groups.map((g) => (
        <section key={g.key} aria-label={g.title} className="border-b border-graphite-800 last:border-b-0">
          <div className="sticky top-0 z-10 flex min-h-7 items-baseline gap-2 bg-graphite-900 px-3 pt-2 pb-1">
            <h3 className="shrink-0 text-xs font-medium text-graphite-100">{g.title}</h3>
            {g.subtitle ? <p className="min-w-0 truncate text-xs text-graphite-300">{g.subtitle}</p> : null}
          </div>
          <ul className="pb-1">
            {g.refs.map((r) => (
              <Row
                key={r.shot.id}
                r={r}
                current={r.shot.id === currentId}
                included={included.has(r.shot.id)}
                takes={takeCounts.get(r.shot.id) ?? 0}
                onSelect={onSelect}
                onToggleInclude={onToggleInclude}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Row({
  r,
  current,
  included,
  takes,
  onSelect,
  onToggleInclude,
}: {
  r: ShotRef;
  current: boolean;
  included: boolean;
  takes: number;
  onSelect: (id: string) => void;
  onToggleInclude: (id: string) => void;
}) {
  const f = r.shot.fields;
  return (
    <li className={`relative flex items-stretch ${current ? 'bg-graphite-800' : 'hover:bg-graphite-800/60'}`}>
      {current ? <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" /> : null}
      <button
        type="button"
        data-shot={r.shot.id}
        aria-current={current ? 'true' : undefined}
        tabIndex={current ? 0 : -1}
        onClick={() => onSelect(r.shot.id)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-3 text-left focus-visible:outline-offset-[-2px]"
      >
        <span className={`w-14 shrink-0 text-sm tabular-nums ${current ? 'font-medium text-graphite-100' : 'text-graphite-100'}`}>{r.label}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-graphite-300">
            {ZH_SHOT_SIZE[f.shot_size]}
            {f.action ? ` · ${f.action}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-xs text-graphite-300 tabular-nums" aria-label={`${takes} 条`}>
          {takes > 0 ? `${takes} 条` : ''}
        </span>
      </button>
      <label
        className="flex w-8 shrink-0 cursor-pointer items-center justify-center"
        title={current ? '当前镜头总在本条里' : '并入正在记录的这一条'}
      >
        <input
          type="checkbox"
          className="size-3.5"
          checked={current || included}
          disabled={current}
          onChange={() => onToggleInclude(r.shot.id)}
          aria-label={`${r.label} 并入本条`}
        />
      </label>
    </li>
  );
}
