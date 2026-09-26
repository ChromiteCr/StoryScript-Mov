import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';

/** Small shared primitives. Tailwind classes only (CSP: no inline style). */

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const BUTTON_BASE =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-3 text-sm ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-graphite text-sheet hover:enabled:bg-graphite-hover',
  secondary: 'border border-rule-strong bg-sheet text-ink hover:enabled:bg-sheet-sunk',
  ghost: 'text-ink-2 hover:enabled:bg-sheet-sunk hover:enabled:text-ink',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
}

export function Button({ variant = 'secondary', busy = false, className = '', children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
      {children}
    </button>
  );
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={
        'h-8 w-full min-w-0 rounded-control border border-rule-strong bg-sheet px-2.5 text-sm text-ink ' +
        'focus-visible:border-focus aria-[invalid=true]:border-danger ' +
        className
      }
      {...rest}
    />
  );
}

export function TextArea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={
        'w-full min-w-0 rounded-control border border-rule-strong bg-sheet px-2.5 py-1.5 text-sm leading-relaxed text-ink ' +
        'focus-visible:border-focus aria-[invalid=true]:border-danger ' +
        className
      }
      {...rest}
    />
  );
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={
        'h-8 w-full min-w-0 rounded-control border border-rule-strong bg-sheet px-2 text-sm text-ink ' +
        'focus-visible:border-focus disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger ' +
        className
      }
      {...rest}
    >
      {children}
    </select>
  );
}

export type TagTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'solid';

const TAG_TONE: Record<TagTone, string> = {
  neutral: 'border-rule-strong bg-sheet text-ink-2',
  ok: 'border-ok/40 bg-ok-bg text-ok',
  warn: 'border-warn-rule bg-warn-bg text-warn',
  danger: 'border-danger-rule bg-danger-bg text-danger',
  info: 'border-focus/30 bg-info-bg text-focus',
  solid: 'border-graphite bg-graphite text-sheet',
};

/** Small status label. */
export function Tag({ tone = 'neutral', className = '', children, title }: { tone?: TagTone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-control border px-1.5 text-[11.5px] leading-none whitespace-nowrap ${TAG_TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Inline note box (warn/info), used for explanations next to disabled AI buttons etc. */
export function Note({ tone = 'info', children, className = '' }: { tone?: 'info' | 'warn'; children: ReactNode; className?: string }) {
  const cls = tone === 'warn' ? 'border-warn-rule bg-warn-bg' : 'border-rule bg-sheet-sunk';
  return <div className={`rounded-sheet border px-3 py-2 text-[13px] text-ink-2 ${cls} ${className}`}>{children}</div>;
}

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** render prop receives ids to wire label/description */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-ink-3">
      <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
      {label}
    </span>
  );
}

/** Shell command with a copy button (clipboard works on 127.0.0.1). */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-control border border-rule bg-sheet-sunk py-0.5 pr-0.5 pl-2">
      <code className="truncate font-mono text-[12.5px] text-ink">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-sheet hover:text-ink"
        aria-label={copied ? '已复制' : `复制命令 ${command}`}
        title={copied ? '已复制' : '复制'}
      >
        {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
    </span>
  );
}

/** Section heading used by panels: a title and an optional one-line description. */
export function SectionHeading({ id, title, description, actions }: { id?: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 id={id} className="text-[15px] font-semibold text-ink">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-[13px] text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
