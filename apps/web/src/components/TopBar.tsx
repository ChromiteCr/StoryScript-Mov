import type { Project } from '@storyscript/contracts';
import { ArrowLeftRight, CalendarClock, Clapperboard, FileText, FolderOpen, PanelsTopLeft, Settings, type LucideIcon } from 'lucide-react';
import type { View } from '../lib/route.ts';
import { useSaveState } from '../lib/saveStatus.ts';
import { Button } from './ui.tsx';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}

const PROJECT_VIEWS: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'script', label: '剧本与镜头', icon: FileText },
  { view: 'boards', label: '分镜', icon: PanelsTopLeft },
  { view: 'plan', label: '拍摄计划', icon: CalendarClock },
  { view: 'media', label: '场记与素材', icon: Clapperboard },
  { view: 'settings', label: '设置', icon: Settings },
];

function navItems(project: Project | null, view: View | null): NavItem[] {
  if (project) {
    return PROJECT_VIEWS.map(({ view: v, label, icon }) => ({ href: `#/${v}`, label, icon, active: view === v }));
  }
  // No project: home (bare URL) and settings only.
  return [
    { href: '#', label: '项目', icon: FolderOpen, active: view !== 'settings' },
    { href: '#/settings', label: '设置', icon: Settings, active: view === 'settings' },
  ];
}

function SaveIndicator() {
  const s = useSaveState();
  let text: string;
  let dot: string;
  switch (s.kind) {
    case 'saving':
      text = '保存中…';
      dot = 'bg-ink-3';
      break;
    case 'saved':
      text = `已保存 ${s.at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      dot = 'bg-ok';
      break;
    case 'error':
      text = '保存失败';
      dot = 'bg-danger';
      break;
    default:
      text = '尚无改动';
      dot = 'bg-rule-strong';
  }
  return (
    <span className="hidden items-center gap-1.5 text-xs whitespace-nowrap text-ink-3 md:inline-flex" aria-live="polite">
      <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
      <span className={s.kind === 'error' ? 'text-danger' : undefined} title={s.kind === 'error' ? s.message : undefined}>
        {text}
      </span>
    </span>
  );
}

export interface TopBarProps {
  project: Project | null;
  view: View | null;
  onSwitchProject: () => void;
  switching: boolean;
}

export function TopBar({ project, view, onSwitchProject, switching }: TopBarProps) {
  return (
    <header className="border-b border-rule bg-sheet">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 px-4 sm:px-6">
        <div className="flex h-12 min-w-0 flex-1 items-center gap-3">
          <span className="flex shrink-0 items-center gap-2">
            <img src="/favicon.svg" alt="" className="size-5" />
            <span className="text-[13px] font-semibold tracking-tight">StoryScript-Mov</span>
          </span>
          {project ? (
            <>
              <span aria-hidden className="h-4 w-px shrink-0 bg-rule-strong" />
              <span className="min-w-0 truncate text-[13px] font-medium" title={project.name}>
                {project.name}
              </span>
              <SaveIndicator />
              <Button
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={onSwitchProject}
                busy={switching}
                title="关闭当前项目，回到项目列表"
              >
                {switching ? null : <ArrowLeftRight aria-hidden className="size-3.5" />}
                切换项目
              </Button>
            </>
          ) : null}
        </div>
        <nav aria-label="主视图" className="-mx-2 flex w-[calc(100%+1rem)] overflow-x-auto [scrollbar-width:none] sm:mx-0 sm:w-auto">
          {navItems(project, view).map(({ href, label, icon: Icon, active }) => (
            <a
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={
                'relative flex h-11 shrink-0 items-center gap-1.5 px-2.5 text-[13px] whitespace-nowrap sm:h-12 ' +
                'after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 ' +
                (active ? 'font-medium text-ink after:bg-graphite' : 'text-ink-2 hover:text-ink after:bg-transparent')
              }
            >
              <Icon aria-hidden className="size-4" />
              {label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
