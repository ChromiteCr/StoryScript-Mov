import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './ui.tsx';

/**
 * Modal on the native <dialog> (focus trap, Esc, top layer), so no library or
 * inline style is needed (CSP: style-src 'self'). Graphite chrome like the
 * project manager's drawer; no shadows, layers step in lightness.
 * - center: small confirmation / form
 * - drawer: right-hand panel, full width on phones
 * - full:   whole viewport (draft diff view)
 */
export type DialogVariant = 'center' | 'drawer' | 'full';

const VARIANT: Record<DialogVariant, string> = {
  center: 'm-auto w-[calc(100%-2rem)] max-w-[480px] max-h-[calc(100dvh-2rem)] rounded-panel border border-graphite-700',
  drawer:
    'fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[min(440px,100vw)] max-w-none [border-width:0_0_0_1px] border-graphite-700',
  full: 'fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none',
};

const BODY: Record<DialogVariant, string> = {
  center: 'px-4 py-4',
  drawer: 'px-4 py-4',
  full: '',
};

export interface DialogProps {
  onClose: () => void;
  title: ReactNode;
  /** one line under the title bar */
  description?: ReactNode;
  variant?: DialogVariant;
  /** bottom bar (actions) */
  footer?: ReactNode;
  /** extra controls in the title bar, left of the close button */
  headerActions?: ReactNode;
  children: ReactNode;
  /** block Esc/backdrop close while a request is running */
  busy?: boolean;
  /** body classes (the full variant lays out its own panels) */
  bodyClassName?: string;
}

/** Always open while mounted: render it conditionally. */
export function Dialog({ onClose, title, description, variant = 'center', footer, headerActions, children, busy = false, bodyClassName }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose(); // backdrop
      }}
      className={`bg-graphite-900 p-0 text-graphite-100 ${VARIANT[variant]}`}
    >
      <div className={`flex h-full flex-col ${variant === 'center' ? 'max-h-[calc(100dvh-2rem)]' : ''}`}>
        <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-graphite-950 bg-graphite-800 py-1.5 pr-2 pl-4">
          <h2 id={titleId} className="min-w-0 flex-1 text-sm font-medium break-words text-graphite-100">
            {title}
          </h2>
          {headerActions ? <div className="flex shrink-0 items-center gap-1">{headerActions}</div> : null}
          <IconButton icon={X} label="关闭" onClick={onClose} disabled={busy} />
        </header>
        {description ? (
          <div id={descId} className="shrink-0 border-b border-graphite-800 px-4 py-2 text-xs text-graphite-300">
            {description}
          </div>
        ) : null}
        <div className={`min-h-0 flex-1 overflow-auto overscroll-contain ${bodyClassName ?? BODY[variant]}`}>{children}</div>
        {footer ? <footer className="shrink-0 border-t border-graphite-800 bg-graphite-900 px-4 py-2.5">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
