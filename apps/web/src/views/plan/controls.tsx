import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { IconButton } from '../../components/ui.tsx';
import type { OutcomeTone } from '../../lib/labels-plan.ts';

/**
 * Plan-page controls built from S0a tokens: a centred modal (native
 * <dialog>: focus trap and Escape for free), a checkbox row, a status dot
 * and a disclosure menu. Kept local to the plan page (other tracks own the
 * shared components).
 */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), select, textarea')?.focus();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={
        `m-auto max-h-[min(720px,calc(100dvh-32px))] w-[calc(100vw-32px)] ${wide ? 'max-w-[560px]' : 'max-w-[440px]'} ` +
        'overflow-hidden rounded-page border border-graphite-700 bg-graphite-900 p-0 text-graphite-100'
      }
    >
      <div className="flex max-h-[min(720px,calc(100dvh-32px))] flex-col">
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-graphite-950 bg-graphite-800 pr-2 pl-4">
          <h2 id={titleId} className="text-sm font-medium">
            {title}
          </h2>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">{children}</div>
        {footer ? <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-graphite-800 px-4 py-2.5">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

export function CheckRow({
  checked,
  onChange,
  children,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="mt-[3px] size-3.5 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="text-graphite-100">{children}</span>
        {hint ? <span className="block text-xs text-graphite-300">{hint}</span> : null}
      </span>
    </label>
  );
}

const DOT: Record<OutcomeTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-graphite-500',
};

/** Coloured dot + label; colour is never the only carrier (the label says it). */
export function StatusPill({ tone, children }: { tone: OutcomeTone; children: ReactNode }) {
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-control border border-graphite-700 bg-graphite-800 px-2 text-xs font-medium text-graphite-100">
      <span aria-hidden className={`size-2 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

/** Button that opens a small list of actions below it; Escape or an outside click closes it. */
export function MenuButton({ label, icon: Icon, children }: { label: string; icon?: typeof ChevronDown; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-graphite-700 bg-graphite-800 px-3 text-sm whitespace-nowrap text-graphite-100 hover:border-graphite-500 hover:bg-graphite-700"
      >
        {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
        {label}
        <ChevronDown aria-hidden className="size-3.5 text-graphite-300" />
      </button>
      {open ? (
        <div
          id={menuId}
          className="absolute top-8 right-0 z-20 flex w-[min(280px,calc(100vw-24px))] flex-col rounded-panel border border-graphite-700 bg-graphite-800 py-1"
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({ onClick, children, hint, disabled }: { onClick: () => void; children: ReactNode; hint?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start px-3 py-1.5 text-left text-sm text-graphite-100 hover:enabled:bg-graphite-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
      {hint ? <span className="text-xs text-graphite-300">{hint}</span> : null}
    </button>
  );
}

/** "HH:mm" time field (native), 28px like the other controls. */
export function TimeField({ value, onChange, label, className = '' }: { value: string; onChange: (v: string) => void; label: string; className?: string }) {
  return (
    <input
      type="time"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        'h-7 min-w-0 rounded-control border border-graphite-700 bg-graphite-800 px-1.5 text-sm text-graphite-100 tabular-nums ' +
        `hover:border-graphite-500 focus-visible:border-accent ${className}`
      }
    />
  );
}
