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
  danger?: boolean;
}

/** Small action menu: button + popover list. Closes on outside click, Esc and selection. */
export function Menu({ label, items, align = 'right' }: { label: string; items: (MenuItem | 'separator')[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // focus the first enabled item for keyboard users
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = list.findIndex((el) => el === document.activeElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
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
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-7 items-center justify-center rounded-control text-ink-2 hover:bg-sheet-sunk hover:text-ink"
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          onKeyDown={onMenuKey}
          className={`absolute top-full z-30 mt-1 w-48 rounded-sheet border border-rule-strong bg-sheet py-1 shadow-[0_4px_16px_rgb(0_0_0/0.12)] ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {items.map((it, i) =>
            it === 'separator' ? (
              <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-rule" />
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
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:enabled:bg-sheet-sunk focus-visible:bg-sheet-sunk ' +
                  'disabled:cursor-not-allowed disabled:text-ink-3 ' +
                  (it.danger ? 'text-danger' : 'text-ink')
                }
              >
                {it.icon ? <span className="inline-flex size-4 shrink-0 items-center justify-center text-ink-3">{it.icon}</span> : null}
                <span className="min-w-0 flex-1">{it.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
