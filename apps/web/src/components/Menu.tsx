import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** shown as the tooltip, e.g. why an item is disabled */
  hint?: string;
  /** destructive: a danger icon colour, the text stays graphite (AA) */
  danger?: boolean;
}

/** Open upwards when the nearest scrolling panel has too little room below the button. */
function opensUp(button: HTMLElement, count: number): boolean {
  const need = count * 28 + 16;
  let clip = window.innerHeight;
  for (let el = button.parentElement; el; el = el.parentElement) {
    const o = getComputedStyle(el).overflowY;
    if (o === 'auto' || o === 'scroll' || o === 'hidden') {
      clip = Math.min(clip, el.getBoundingClientRect().bottom);
      break;
    }
  }
  const r = button.getBoundingClientRect();
  return clip - r.bottom < need && r.top > need;
}

/** Small action menu: a 24px tool button and a popover list. Closes on outside click, Esc and selection. */
export function Menu({ label, items, align = 'right' }: { label: string; items: (MenuItem | 'separator')[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    // focus the first enabled item for keyboard users
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const list = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (list.length === 0) return;
    const i = list.findIndex((el) => el === document.activeElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = (i + 1) % list.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length;
    else if (e.key === 'End') next = list.length - 1;
    list[next]?.focus();
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) setUp(opensUp(e.currentTarget, items.length));
          setOpen((o) => !o);
        }}
        className={
          'inline-flex size-6 items-center justify-center rounded-control text-graphite-300 ' +
          'hover:bg-graphite-700 hover:text-graphite-100 aria-expanded:bg-graphite-700 aria-expanded:text-graphite-100'
        }
      >
        <MoreHorizontal aria-hidden className="size-3.5" />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          onClick={(e) => e.stopPropagation()}
          className={`absolute z-30 w-44 ${up ? 'bottom-full mb-1' : 'top-full mt-1'} rounded-panel border border-graphite-700 bg-graphite-800 py-1 ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {items.map((it, i) =>
            it === 'separator' ? (
              <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-graphite-700" />
            ) : (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                title={it.hint}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={
                  'flex h-7 w-full items-center gap-2 px-2.5 text-left text-sm text-graphite-100 focus-visible:outline-offset-[-2px] ' +
                  'hover:enabled:bg-graphite-700 disabled:cursor-not-allowed disabled:text-graphite-500'
                }
              >
                {it.icon ? (
                  <span aria-hidden className={`inline-flex size-4 shrink-0 items-center justify-center ${it.danger ? 'text-danger' : 'text-graphite-300'}`}>
                    {it.icon}
                  </span>
                ) : (
                  <span aria-hidden className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
