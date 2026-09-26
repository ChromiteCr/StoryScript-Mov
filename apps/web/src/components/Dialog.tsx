import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Modal built on the native <dialog> (focus trap, Esc, top layer) so no
 * library or inline style is needed (CSP: style-src 'self').
 * - center: small confirmation / form
 * - drawer: right-hand panel, full width on phones
 * - full:   whole viewport (draft diff view)
 */
export type DialogVariant = 'center' | 'drawer' | 'full';

const VARIANT: Record<DialogVariant, string> = {
  center: 'm-auto w-[calc(100%-2rem)] max-w-[520px] max-h-[calc(100dvh-2rem)] rounded-sheet border border-rule-strong',
  drawer:
    'fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-full border-l border-rule-strong sm:w-[640px] sm:max-w-[calc(100vw-2rem)]',
  full: 'fixed inset-0 m-0 h-dvh max-h-dvh w-full max-w-full',
};

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  variant?: DialogVariant;
  /** sticky footer (actions) */
  footer?: ReactNode;
  /** extra controls in the header, left of the close button */
  headerActions?: ReactNode;
  children: ReactNode;
  /** block Esc/backdrop close while a request is running */
  busy?: boolean;
}

export function Dialog({ open, onClose, title, description, variant = 'center', footer, headerActions, children, busy = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onMouseDown={(e) => {
        // click on the backdrop (the dialog box itself, outside the panel)
        if (e.target === ref.current && !busy) onClose();
      }}
      className={`bg-sheet p-0 text-ink shadow-[0_8px_32px_rgb(0_0_0/0.18)] backdrop:bg-graphite/35 ${VARIANT[variant]}`}
    >
      <div className="flex h-full max-h-[inherit] flex-col">
        <header className="flex shrink-0 items-start gap-3 border-b border-rule px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <div id={descId} className="mt-0.5 text-[13px] text-ink-2">
                {description}
              </div>
            ) : null}
          </div>
          {headerActions ? <div className="flex shrink-0 items-center gap-2">{headerActions}</div> : null}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 hover:enabled:bg-sheet-sunk hover:enabled:text-ink disabled:opacity-50"
            aria-label="关闭"
          >
            <X aria-hidden className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
        {footer ? <footer className="shrink-0 border-t border-rule bg-sheet px-4 py-3 sm:px-5">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
