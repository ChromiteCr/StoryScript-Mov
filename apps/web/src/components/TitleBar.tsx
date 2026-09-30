import type { Project } from '@storyscript/contracts';
import type { ReactNode } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import type { View } from '../lib/route.ts';
import { Button } from './ui.tsx';

/** App mark: a 2.39 frame with the 1.43 centre-safe guides the boards also use. */
export function AppGlyph({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 10" className={`h-2.5 w-6 shrink-0 ${className}`} fill="none">
      <rect x="0.5" y="0.5" width="23" height="9" rx="1" stroke="currentColor" />
      <path d="M5.12 0.5v9M18.88 0.5v9" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1.4 1.1" opacity="0.6" />
    </svg>
  );
}

export interface TitleBarProps {
  project: Project | null;
  view: View | null;
  /** hosted server: the account menu (no project switching there) */
  account: ReactNode | null;
  /** hosted server: the 提到我的 bell, left of the presence strip */
  alerts?: ReactNode;
  /** hosted server: who is online and the newest change, left of the account menu */
  presence?: ReactNode;
  switching: boolean;
  onSwitchProject: () => void;
}

/** 32px bar: app mark on the left, the project name centred (Resolve-style), project switch on the right. */
export function TitleBar({ project, view, account, alerts = null, presence = null, switching, onSwitchProject }: TitleBarProps) {
  const center = project ? project.name : view === 'settings' ? '设置' : '项目管理器';
  // hosted: the right side holds the presence strip, the bell and the account menu; below 1024px it takes the room it needs and the project name gives way
  const crowded = presence !== null || alerts !== null;
  return (
    <header
      className={
        'grid h-8 shrink-0 items-center gap-3 border-b border-graphite-800 bg-graphite-950 px-3 print:hidden ' +
        (crowded ? 'max-lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)]')
      }
    >
      <div className="flex min-w-0 items-center gap-2 text-graphite-100">
        <AppGlyph />
        <span className="truncate text-xs font-medium text-graphite-300 max-md:sr-only">StoryScript-Mov</span>
      </div>
      <p className="min-w-0 truncate text-center text-sm font-medium text-graphite-100" title={project?.name}>
        {center}
      </p>
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        {presence}
        {alerts}
        {account !== null ? (
          account
        ) : project ? (
          <Button variant="ghost" size="sm" onClick={onSwitchProject} busy={switching} title="关闭当前项目，回到项目管理器">
            {switching ? null : <ArrowLeftRight aria-hidden className="size-3.5" />}
            <span className="max-md:sr-only">切换项目</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
