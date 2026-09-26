import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Check, CircleAlert, Copy, Info, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';

/**
 * Small shared primitives on the graphite chrome. Tailwind token classes only
 * (CSP: no inline style). Export names and props of the M0 primitives are
 * stable; other tracks import them.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'md' | 'sm';

const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: 'h-7 px-3 text-sm',
  sm: 'h-6 px-2 text-xs',
};

/**
 * primary: the one decisive action of a form, light on graphite (no accent:
 * the accent is reserved for the current page and focus).
 */
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-graphite-100 font-medium text-graphite-950 hover:enabled:bg-graphite-100/85',
  secondary:
    'border border-graphite-700 bg-graphite-800 text-graphite-100 hover:enabled:border-graphite-500 hover:enabled:bg-graphite-700',
  ghost: 'text-graphite-300 hover:enabled:bg-graphite-800 hover:enabled:text-graphite-100',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** md = 28px (default), sm = 24px for panel headers and bars */
  size?: ButtonSize;
  busy?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  icon: LucideIcon;
  /** accessible name, also shown as the tooltip */
  label: string;
}

/** 24px square tool button for panel headers and toolbars. */
export function IconButton({ icon: Icon, label, className = '', type = 'button', title, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={
        'inline-flex size-6 shrink-0 items-center justify-center rounded-control text-graphite-300 ' +
        'hover:enabled:bg-graphite-700 hover:enabled:text-graphite-100 disabled:cursor-not-allowed disabled:opacity-50 ' +
        className
      }
      {...rest}
    >
      <Icon aria-hidden className="size-3.5" />
    </button>
  );
}

const FIELD_CONTROL =
  'h-7 w-full min-w-0 rounded-control border border-graphite-700 bg-graphite-800 px-2 text-sm text-graphite-100 ' +
  'hover:border-graphite-500 focus-visible:border-accent aria-[invalid=true]:border-danger';

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${FIELD_CONTROL} ${className}`} {...rest} />;
}

export function SelectInput({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${FIELD_CONTROL} pr-1 ${className}`} {...rest}>
      {children}
    </select>
  );
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
      <label htmlFor={id} className="text-xs font-medium text-graphite-100">
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        // Red text on graphite misses AA at 12px: the icon and border carry the colour.
        <p id={errorId} className="flex items-start gap-1 text-xs text-graphite-100">
          <CircleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-danger" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-graphite-300">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-graphite-300">
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
    <span className="inline-flex max-w-full items-center gap-1 rounded-control border border-graphite-700 bg-graphite-950 py-px pr-px pl-2 align-middle">
      <code className="truncate font-mono text-xs text-graphite-100">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100"
        aria-label={copied ? '已复制' : `复制命令 ${command}`}
        title={copied ? '已复制' : '复制'}
      >
        {copied ? <Check aria-hidden className="size-3.5 text-ok" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
    </span>
  );
}

/** Section heading used inside panels: a title and an optional one-line description. */
export function SectionHeading({ id, title, description, actions }: { id?: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-medium text-graphite-100">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-xs text-graphite-300">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Small outlined status label, e.g. "开发中". Neutral: it describes, it does not alarm. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-control border border-graphite-700 px-1.5 text-xs text-graphite-300">
      {children}
    </span>
  );
}

type NoticeTone = 'danger' | 'warn' | 'info';

const NOTICE_ICON: Record<NoticeTone, LucideIcon> = { danger: CircleAlert, warn: TriangleAlert, info: Info };
const NOTICE_EDGE: Record<NoticeTone, string> = {
  danger: 'border-l-danger',
  warn: 'border-l-warn',
  info: 'border-l-graphite-500',
};
const NOTICE_ICON_COLOR: Record<NoticeTone, string> = { danger: 'text-danger', warn: 'text-warn', info: 'text-graphite-300' };

export interface NoticeProps {
  tone: NoticeTone;
  title: string;
  children?: ReactNode;
  className?: string;
  /** alert for errors that just happened; note for standing conditions */
  role?: 'alert' | 'note' | 'status';
}

/**
 * Status box: the tone lives in a 2px left edge and the icon; the text stays
 * graphite-100/300 so it keeps AA contrast whatever the tone.
 */
export function Notice({ tone, title, children, className = '', role }: NoticeProps) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div
      role={role ?? (tone === 'danger' ? 'alert' : 'note')}
      className={`flex gap-2.5 rounded-panel border border-l-2 border-graphite-700 bg-graphite-800 px-3 py-2.5 ${NOTICE_EDGE[tone]} ${className}`}
    >
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${NOTICE_ICON_COLOR[tone]}`} />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-graphite-100">{title}</p>
        {children ? <div className="mt-0.5 text-graphite-300">{children}</div> : null}
      </div>
    </div>
  );
}
