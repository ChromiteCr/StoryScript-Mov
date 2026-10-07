import type { KeyboardEvent } from 'react';
import type { Project } from '@storyscript/contracts';
import {
  ClipboardPaste,
  CalendarClock,
  Check,
  CircleAlert,
  CircleDashed,
  Clapperboard,
  Film,
  FolderOpen,
  LoaderCircle,
  PackageCheck,
  PanelsTopLeft,
  ScrollText,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { navigate, type View } from '../lib/route.ts';
import { useSaveState, type SaveState } from '../lib/saveStatus.ts';
import { currentPage, nextIndex, pageHref, STAGES, type PageId, type StageId } from '../lib/stages.ts';
import { JobsIndicator } from './JobsIndicator.tsx';
import { openPaste } from '../lib/queries-paste.ts';

/**
 * The workflow page bar, fixed to the bottom of the window (Resolve's page
 * switcher, with our live-action stages). Left: project and save state.
 * Centre: the six stages in order, joined by flow connectors. Right: jobs and
 * settings (settings is not a stage). Below 720px only icons remain and the
 * stage strip scrolls sideways.
 */

const STAGE_ICON: Record<StageId, LucideIcon> = {
  script: ScrollText,
  boards: PanelsTopLeft,
  plan: CalendarClock,
  set: Clapperboard,
  media: Film,
  deliver: PackageCheck,
};

/** Shared look of page buttons (stages, settings, project manager). */
function pageButtonClass(current: boolean, width: string): string {
  return (
    `relative flex h-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-page focus-visible:outline-offset-[-2px] ${width} ` +
    (current ? 'text-accent' : 'text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100')
  );
}

/** 2px accent bar under the current page's icon; `place` sets its horizontal extent (about 20–24px). */
function CurrentMark({ place = 'inset-x-2 md:inset-x-4' }: { place?: string }) {
  return <span aria-hidden className={`absolute bottom-0 h-0.5 rounded-full bg-accent ${place}`} />;
}

/** Thin arrow between two stages: the direction of the workflow. */
function Connector() {
  return (
    <li aria-hidden className="flex w-2 shrink-0 items-center self-center text-graphite-500 md:w-4 md:self-start md:pt-[10px]">
      <svg viewBox="0 0 16 6" className="h-1.5 w-full" fill="none" preserveAspectRatio="none">
        <path d="M0 3h14.5" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d="M12.5 0.8L15.2 3l-2.7 2.2" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
    </li>
  );
}

function StageNav({ enabled, current }: { enabled: boolean; current: PageId | null }) {
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>('a[data-stage]'));
    const at = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0) return;
    const to = nextIndex(at, e.key, items.length);
    if (to === null) return;
    e.preventDefault();
    items[to]?.focus();
  };

  return (
    <nav aria-label="工作流程" className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] md:flex-none md:overflow-visible">
      <ol onKeyDown={enabled ? onKeyDown : undefined} className="mx-auto flex w-max items-center">
        {STAGES.map((stage, i) => {
          const Icon = STAGE_ICON[stage.id];
          const isCurrent = current === stage.id;
          const inner = (
            <>
              <Icon aria-hidden className="size-[18px]" strokeWidth={1.75} />
              <span className="text-xs leading-4 max-md:sr-only">{stage.label}</span>
              {isCurrent ? <CurrentMark /> : null}
            </>
          );
          return [
            i > 0 ? <Connector key={`c-${stage.id}`} /> : null,
            <li key={stage.id} className="shrink-0">
              {enabled ? (
                <a
                  href={pageHref(stage.id)}
                  data-stage={stage.id}
                  aria-current={isCurrent ? 'page' : undefined}
                  title={`${stage.label}：${stage.lead}`}
                  className={pageButtonClass(isCurrent, 'w-9 md:w-14')}
                >
                  {inner}
                </a>
              ) : (
                <span
                  aria-disabled="true"
                  title="打开项目后可用"
                  className="flex h-11 w-9 shrink-0 cursor-not-allowed flex-col items-center justify-center gap-0.5 text-graphite-500 md:w-14"
                >
                  {inner}
                </span>
              )}
            </li>,
          ];
        })}
      </ol>
    </nav>
  );
}

interface SaveLook {
  text: string;
  /** dot colour next to the text (≥720px) */
  dot: string;
  /** stand-alone icon when the text is hidden (<720px) */
  icon: LucideIcon;
  iconColor: string;
}

function saveLook(s: SaveState): SaveLook {
  switch (s.kind) {
    case 'saving':
      return { text: '保存中…', dot: 'bg-graphite-300', icon: LoaderCircle, iconColor: 'text-graphite-300 animate-spin motion-reduce:animate-none' };
    case 'saved':
      return {
        text: `已保存 ${s.at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
        dot: 'bg-ok',
        icon: Check,
        iconColor: 'text-ok',
      };
    case 'error':
      return { text: '保存失败', dot: 'bg-danger', icon: CircleAlert, iconColor: 'text-danger' };
    default:
      return { text: '尚无改动', dot: 'bg-graphite-500', icon: CircleDashed, iconColor: 'text-graphite-500' };
  }
}

/** Project name and save state ("已保存" only after a committed transaction, FR-01). */
function ProjectSlot({ project }: { project: Project }) {
  const s = useSaveState();
  const { text, dot, icon: Icon, iconColor } = saveLook(s);
  return (
    <div className="flex min-w-0 shrink-0 flex-col justify-center max-md:w-6 max-md:items-center md:shrink">
      <p className="truncate text-xs font-medium text-graphite-100 max-md:hidden" title={project.name}>
        {project.name}
      </p>
      <p
        aria-live="polite"
        title={s.kind === 'error' ? s.message : text}
        className="flex min-w-0 items-center gap-1.5 text-xs text-graphite-300"
      >
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full max-md:hidden ${dot}`} />
        <Icon aria-hidden className={`size-4 shrink-0 md:hidden ${iconColor}`} strokeWidth={1.75} />
        <span className={`truncate max-md:sr-only ${s.kind === 'error' ? 'text-graphite-100' : ''}`}>{text}</span>
      </p>
    </div>
  );
}

/** Without a project: the way back to the project manager, and why the stages are dimmed. */
function ManagerSlot({ current }: { current: boolean }) {
  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        navigate(null);
      }}
      aria-current={current ? 'page' : undefined}
      title="项目管理器：打开项目后可进入各阶段"
      className={
        'relative flex h-11 min-w-0 shrink-0 items-center gap-2 rounded-page px-1.5 focus-visible:outline-offset-[-2px] md:shrink md:justify-self-start md:px-2 ' +
        (current ? 'text-accent' : 'text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100')
      }
    >
      <FolderOpen aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
      <span className="flex min-w-0 flex-col max-md:sr-only">
        <span className="truncate text-xs font-medium">项目管理器</span>
        <span className="truncate text-xs text-graphite-300">打开项目后可进入各阶段</span>
      </span>
      {current ? <CurrentMark place="left-[3px] w-6 md:left-[5px]" /> : null}
    </a>
  );
}

export interface PageBarProps {
  project: Project | null;
  view: View | null;
}

export function PageBar({ project, view }: PageBarProps) {
  const open = project !== null;
  const current = currentPage(view, open);
  return (
    <footer className="flex h-[52px] shrink-0 items-center gap-1 border-t border-graphite-800 bg-graphite-950 px-2 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-4 md:px-3 print:hidden">
      {project ? <ProjectSlot project={project} /> : <ManagerSlot current={view !== 'settings'} />}
      <StageNav enabled={open} current={current} />
      <div className="flex shrink-0 items-center justify-end gap-1">
        {open ? (
          <button type="button" title="粘贴整理：把群聊里的档期、安排、场记和分工整理进项目" onClick={() => openPaste('auto')} className={pageButtonClass(false, 'w-9 md:w-10')}>
            <ClipboardPaste aria-hidden className="size-[18px]" strokeWidth={1.75} />
            <span className="sr-only">粘贴整理</span>
          </button>
        ) : null}
        <JobsIndicator enabled={open} />
        <a
          href={pageHref('settings')}
          aria-current={current === 'settings' ? 'page' : undefined}
          title="设置"
          className={pageButtonClass(current === 'settings', 'w-9 md:w-10')}
        >
          <Settings aria-hidden className="size-[18px]" strokeWidth={1.75} />
          <span className="sr-only">设置</span>
          {current === 'settings' ? <CurrentMark place="inset-x-2 md:inset-x-2.5" /> : null}
        </a>
      </div>
    </footer>
  );
}
