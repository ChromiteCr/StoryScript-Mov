import { useId, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { nextIndex } from '../lib/stages.ts';

/**
 * Workbench building blocks shared by every page (S0a).
 *
 *   <Workspace header={<PageHeader …/>} left={<Panel …/>} right={<Panel …><Inspector/></Panel>}>
 *     <Panel title="分镜稿"><PaperCanvas>…</PaperCanvas></Panel>
 *   </Workspace>
 *
 * Layering (Resolve-like, no shadows): window graphite-950 → panel body
 * graphite-900 → panel header graphite-800; panels sit 4px apart on the
 * window colour. Paper is only for work content (PaperCanvas).
 */

// ------------------------------------------------------------------ Workspace

export interface WorkspaceProps {
  /** full-width row above the panels, usually a PageHeader */
  header?: ReactNode;
  /** left column (240px): lists, bins, categories */
  left?: ReactNode;
  /** right column (288px): an Inspector panel */
  right?: ReactNode;
  /** full-width strip under the panels (about 30% of the height) */
  bottom?: ReactNode;
  /** the main area */
  children: ReactNode;
  className?: string;
}

type Key2 = `${boolean}${boolean}`;

/** Static class strings (Tailwind must see them verbatim). */
const COLS: Record<Key2, string> = {
  truetrue: 'lg:grid-cols-[240px_minmax(0,1fr)_288px]',
  truefalse: 'lg:grid-cols-[240px_minmax(0,1fr)]',
  falsetrue: 'lg:grid-cols-[minmax(0,1fr)_288px]',
  falsefalse: 'lg:grid-cols-[minmax(0,1fr)]',
};

const ROWS: Record<Key2, string> = {
  truetrue: 'lg:grid-rows-[auto_minmax(0,1fr)_minmax(140px,30%)]',
  truefalse: 'lg:grid-rows-[auto_minmax(0,1fr)]',
  falsetrue: 'lg:grid-rows-[minmax(0,1fr)_minmax(140px,30%)]',
  falsefalse: 'lg:grid-rows-[minmax(0,1fr)]',
};

const SLOT = 'flex min-h-0 min-w-0 flex-col';

/**
 * Page frame. At ≥1024px a full-height CSS grid whose panels scroll on their
 * own; below that the panels stack in reading order (left, main, right,
 * bottom) and the page scrolls. In print only the main area remains.
 */
export function Workspace({ header, left, right, bottom, children, className = '' }: WorkspaceProps) {
  const cols = COLS[`${left !== undefined}${right !== undefined}`];
  const rows = ROWS[`${header !== undefined}${bottom !== undefined}`];
  return (
    <div
      className={
        `flex min-h-full flex-col gap-1 p-1 lg:grid lg:h-full lg:min-h-0 ${cols} ${rows} ` +
        `print:block print:h-auto print:p-0 ${className}`
      }
    >
      {header !== undefined ? <div className="min-w-0 lg:col-span-full print:hidden">{header}</div> : null}
      {left !== undefined ? <div className={`${SLOT} print:hidden`}>{left}</div> : null}
      <div className={`${SLOT} min-h-[320px] lg:min-h-0 print:block`}>{children}</div>
      {right !== undefined ? <div className={`${SLOT} print:hidden`}>{right}</div> : null}
      {bottom !== undefined ? <div className={`${SLOT} lg:col-span-full print:hidden`}>{bottom}</div> : null}
    </div>
  );
}

// ----------------------------------------------------------------- PageHeader

export interface PageHeaderProps {
  title: string;
  icon?: LucideIcon;
  /** e.g. <Tag>开发中</Tag> */
  status?: ReactNode;
  /** one sentence on what the page is for */
  lead?: ReactNode;
  /** page-level buttons, right-aligned */
  actions?: ReactNode;
}

/** The page's h1 row: title, optional status tag and lead, actions on the right. */
export function PageHeader({ title, icon: Icon, status, lead, actions }: PageHeaderProps) {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5">
      <div className="flex shrink-0 items-center gap-2">
        {Icon ? <Icon aria-hidden className="size-4 text-graphite-300" /> : null}
        <h1 className="text-lg font-medium text-graphite-100">{title}</h1>
        {status}
      </div>
      {lead ? <p className="min-w-0 text-sm text-graphite-300">{lead}</p> : null}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------- Panel

export interface PanelProps {
  /** shown in the 28px header; also the panel's accessible name */
  title: string;
  /** right side of the header: IconButtons or a size="sm" Button */
  tools?: ReactNode;
  children?: ReactNode;
  /** 12px body padding (default); false for edge-to-edge lists */
  padded?: boolean;
  className?: string;
  bodyClassName?: string;
}

/** A titled region with its own scroll. Fills its Workspace slot. */
export function Panel({ title, tools, children, padded = true, className = '', bodyClassName = '' }: PanelProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-panel bg-graphite-900 ' +
        `print:overflow-visible print:rounded-none print:bg-transparent ${className}`
      }
    >
      <header className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-graphite-950 bg-graphite-800 pr-1 pl-3 print:hidden">
        <h2 id={titleId} className="truncate text-xs font-medium text-graphite-300">
          {title}
        </h2>
        {tools ? <div className="flex shrink-0 items-center gap-0.5">{tools}</div> : null}
      </header>
      <div className={`min-h-0 flex-1 overflow-auto print:overflow-visible print:p-0 ${padded ? 'p-3' : ''} ${bodyClassName}`}>
        {children}
      </div>
    </section>
  );
}

// --------------------------------------------------------------- PanelToolbar

/**
 * A 28px strip of tool buttons under a panel header. ARIA toolbar: Tab enters
 * once, arrow keys move between the buttons.
 */
export function PanelToolbar({ label, children }: { label: string; children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const to = nextIndex(at, e.key, items.length);
    if (to === null) return;
    e.preventDefault();
    items[to]?.focus();
  };
  return (
    <div
      role="toolbar"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex h-7 shrink-0 items-center gap-0.5 border-b border-graphite-800 px-1 print:hidden"
    >
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ Inspector

/** Right-hand property inspector: stacked groups split by 1px rules. */
export function Inspector({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col divide-y divide-graphite-800 ${className}`}>{children}</div>;
}

export interface InspectorGroupProps {
  title: string;
  /** small buttons on the group's title row */
  actions?: ReactNode;
  /** content between the title and the rows (a Notice, a sentence) */
  note?: ReactNode;
  /** InspectorRow elements */
  children?: ReactNode;
}

export function InspectorGroup({ title, actions, note, children }: InspectorGroupProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="py-3 first:pt-1">
      <div className="flex min-h-6 items-center justify-between gap-2 px-3">
        <h3 id={titleId} className="text-xs font-medium text-graphite-100">
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {note ? <div className="mt-1.5 px-3 text-sm">{note}</div> : null}
      {children ? (
        <dl className="mt-2 grid grid-cols-[minmax(84px,112px)_minmax(0,1fr)] gap-x-3 gap-y-2 px-3">{children}</dl>
      ) : null}
    </section>
  );
}

/** One label/value line. Values default to 13px graphite-100. */
export function InspectorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs leading-5 text-graphite-300">{label}</dt>
      <dd className="min-w-0 text-sm leading-5 text-graphite-100">{children}</dd>
    </>
  );
}

// ---------------------------------------------------------------- PaperCanvas

export interface PaperCanvasProps {
  children?: ReactNode;
  /**
   * sheet: a centred page up to 720px wide (script text, 15px / 1.8);
   * fill: covers its container (board sheets, print preview)
   */
  variant?: 'sheet' | 'fill';
  /** accessible name; given → the canvas becomes a labelled region */
  label?: string;
  className?: string;
}

/**
 * Warm paper for work content, like a sheet on a light box. Prints white with
 * black ink: styles.css forces every text colour inside [data-paper] to ink
 * in print, so muted notes on screen still print as solid black.
 */
export function PaperCanvas({ children, variant = 'sheet', label, className = '' }: PaperCanvasProps) {
  const size = variant === 'sheet' ? 'mx-auto w-full max-w-[720px] px-6 py-8 md:px-12 md:py-12' : 'h-full w-full p-4 md:p-6';
  return (
    <div
      role={label ? 'region' : undefined}
      aria-label={label}
      data-paper=""
      className={
        `rounded-paper bg-paper text-base text-ink [color-scheme:light] ${size} ` +
        `print:max-w-none print:rounded-none print:bg-print-paper print:p-0 print:text-print-ink ${className}`
      }
    >
      {children}
    </div>
  );
}

// ----------------------------------------------------------------- EmptyState

export interface EmptyStateProps {
  /** one sentence: what is here now (plain, no apology) */
  title: string;
  /** optional second line: what will appear, or why */
  description?: ReactNode;
  /** at most one next step: a Button or a link */
  action?: ReactNode;
  icon?: LucideIcon;
  /** chrome: on graphite panels; paper: inside a PaperCanvas */
  tone?: 'chrome' | 'paper';
  /** layout outlines: title in secondary text so several can share a page */
  quiet?: boolean;
  className?: string;
}

export function EmptyState({ title, description, action, icon: Icon, tone = 'chrome', quiet = false, className = '' }: EmptyStateProps) {
  const paper = tone === 'paper';
  const titleColor = paper ? 'text-ink' : quiet ? 'text-graphite-300' : 'text-graphite-100';
  const secondary = paper ? 'text-ink/75' : 'text-graphite-300';
  return (
    <div className={`flex h-full min-h-[112px] flex-col items-center justify-center gap-1.5 px-5 py-6 text-center ${className}`}>
      {Icon ? <Icon aria-hidden className={`mb-1 size-5 ${paper ? 'text-ink/60' : 'text-graphite-500'}`} /> : null}
      <p className={`max-w-[42ch] text-sm text-balance ${titleColor}`}>{title}</p>
      {description ? <p className={`max-w-[46ch] text-xs text-balance ${secondary}`}>{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
