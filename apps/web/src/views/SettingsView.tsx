import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { HealthInfo, Project, ToolStatus } from '@storyscript/contracts';
import { RefreshCw, Settings } from 'lucide-react';
import { useCurrentProject, useHealth } from '../lib/queries.ts';
import { formatDuration } from '../lib/format.ts';
import { navigate } from '../lib/route.ts';
import { nextIndex } from '../lib/stages.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Button, CopyCommand, Notice, Spinner } from '../components/ui.tsx';
import { Inspector, InspectorGroup, InspectorRow, PageHeader, Panel, Workspace } from '../components/workspace.tsx';
import { TextProviderPanel } from './TextProviderPanel.tsx';
import { ImageProviderPanel } from './settings/ImageProviderPanel.tsx';

/**
 * Settings: category list on the left, an inspector on the right. Not a
 * workflow stage, so it lives behind the gear in the page bar.
 */

const CATEGORIES = [
  { id: 'general', label: '常规' },
  { id: 'environment', label: '环境检查' },
  { id: 'models', label: '模型' },
] as const;
type Category = (typeof CATEGORIES)[number]['id'];

function State({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${ok ? 'bg-ok' : 'bg-warn'}`} />
      <span>{children}</span>
    </span>
  );
}

/** Paths, templates, env vars and encoder ids: text the user may type or copy exactly. */
function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

/** Version numbers: tabular figures in the UI face, no monospace for short labels. */
function Num({ children }: { children: ReactNode }) {
  return <span className="tabular-nums">{children}</span>;
}

function ToolRow({ name, tool }: { name: string; tool: ToolStatus }) {
  return (
    <InspectorRow label={name}>
      {tool.path ? (
        <div className="flex flex-col gap-0.5">
          <State ok>
            已找到{tool.version ? '，版本 ' : ''}
            {tool.version ? <span className="tabular-nums">{tool.version}</span> : null}
          </State>
          <span className="text-graphite-300">
            <Mono>{tool.path}</Mono>
          </span>
        </div>
      ) : (
        <State ok={false}>未找到</State>
      )}
    </InspectorRow>
  );
}

function missingTools(health: HealthInfo): string[] {
  return [health.ffmpeg.path ? null : 'ffmpeg', health.ffprobe.path ? null : 'ffprobe'].filter((x): x is string => x !== null);
}

// ------------------------------------------------------------------ groups

function ProjectGroup({ project }: { project: Project }) {
  return (
    <InspectorGroup title="当前项目">
      <InspectorRow label="项目名">{project.name}</InspectorRow>
      <InspectorRow label="时区">{project.timezone}</InspectorRow>
      <InspectorRow label="默认画幅">
        <span className="tabular-nums">{project.default_aspect} : 1</span>
      </InspectorRow>
      <InspectorRow label="目标时长">
        {project.target_duration_s === null ? (
          <span className="text-graphite-300">未设定</span>
        ) : (
          <span className="tabular-nums">{formatDuration(project.target_duration_s)}</span>
        )}
      </InspectorRow>
      <InspectorRow label="打板编号格式">
        <Mono>{project.code_format}</Mono>
      </InspectorRow>
      <InspectorRow label="创建于">
        <span className="tabular-nums">{new Date(project.created_at).toLocaleString('zh-CN')}</span>
      </InspectorRow>
    </InspectorGroup>
  );
}

function General({ health, project }: { health: HealthInfo; project: Project | null }) {
  return (
    <Inspector>
      {project ? (
        <ProjectGroup project={project} />
      ) : (
        <InspectorGroup
          title="当前项目"
          note={
            <div className="flex flex-col items-start gap-2">
              <p className="text-graphite-300">没有打开的项目。打开后，这里显示它的时区、画幅和打板编号格式。</p>
              <Button size="sm" onClick={() => navigate(null)}>
                回到项目管理器
              </Button>
            </div>
          }
        />
      )}
      <InspectorGroup title="应用">
        <InspectorRow label="版本">
          <Num>{health.app_version}</Num>
        </InspectorRow>
        <InspectorRow label="运行模式">{health.demo ? '演示回放：模型输出来自录制的样例，不是真实调用' : '正常'}</InspectorRow>
      </InspectorGroup>
    </Inspector>
  );
}

function Environment({ health }: { health: HealthInfo }) {
  const missing = missingTools(health);
  return (
    <Inspector>
      <InspectorGroup
        title="媒体工具"
        note={
          <>
            <p className="text-graphite-300">素材扫描、元数据读取和海报帧都依赖本机安装的 ffmpeg 与 ffprobe。</p>
            {missing.length > 0 ? (
              <Notice tone="warn" title="素材导入不可用" className="mt-2">
                <p className="leading-7">
                  没有找到 {missing.join(' 和 ')}。用 Homebrew 安装 <CopyCommand command="brew install ffmpeg" />
                  （ffprobe 会一起装好），然后重启 storyscript-mov。剧本、分镜、排期、场记和导出不受影响。
                </p>
              </Notice>
            ) : null}
          </>
        }
      >
        <ToolRow name="ffmpeg" tool={health.ffmpeg} />
        <ToolRow name="ffprobe" tool={health.ffprobe} />
        <InspectorRow label="可用编码器">
          {health.encoders.length > 0 ? (
            <ul className="flex flex-wrap gap-1">
              {health.encoders.map((e) => (
                <li key={e} className="rounded-control border border-graphite-700 bg-graphite-800 px-1.5 font-mono text-xs leading-5">
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-graphite-300">未检测到</span>
          )}
        </InspectorRow>
      </InspectorGroup>
      <InspectorGroup title="运行环境">
        <InspectorRow label="Node">
          <Num>{health.node}</Num>
        </InspectorRow>
        <InspectorRow label="SQLite">
          <Num>{health.sqlite}</Num>
        </InspectorRow>
      </InspectorGroup>
    </Inspector>
  );
}

function Models() {
  return (
    <Inspector>
      <TextProviderPanel />
      <ImageProviderPanel />
    </Inspector>
  );
}

// --------------------------------------------------------------- category list

function CategoryList({
  value,
  onChange,
  warn,
  idFor,
}: {
  value: Category;
  onChange: (c: Category) => void;
  warn: ReadonlySet<Category>;
  idFor: (c: Category) => { tab: string; panel: string };
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = CATEGORIES.findIndex((c) => c.id === value);
    const to = nextIndex(at, e.key, CATEGORIES.length, 'vertical');
    if (to === null) return;
    e.preventDefault();
    const next = CATEGORIES[to];
    if (!next) return;
    onChange(next.id);
    document.getElementById(idFor(next.id).tab)?.focus();
  };

  return (
    <div role="tablist" aria-label="设置分类" aria-orientation="vertical" onKeyDown={onKeyDown} className="flex flex-col py-1">
      {CATEGORIES.map((c) => {
        const selected = c.id === value;
        return (
          <button
            key={c.id}
            id={idFor(c.id).tab}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={idFor(c.id).panel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(c.id)}
            className={
              'relative flex h-8 items-center justify-between gap-2 pr-3 pl-4 text-left text-sm focus-visible:outline-offset-[-2px] ' +
              (selected ? 'bg-graphite-800 font-medium text-graphite-100' : 'text-graphite-300 hover:bg-graphite-800/60 hover:text-graphite-100')
            }
          >
            {selected ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-graphite-300" /> : null}
            <span>{c.label}</span>
            {warn.has(c.id) ? (
              <span className="inline-flex items-center gap-1 text-xs text-graphite-300">
                <span aria-hidden className="size-1.5 rounded-full bg-warn" />
                <span className="sr-only">（有需要处理的问题）</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsView() {
  const health = useHealth();
  const project = useCurrentProject();
  const [category, setCategory] = useState<Category>('general');
  const base = useId();
  const idFor = (c: Category) => ({ tab: `${base}-tab-${c}`, panel: `${base}-panel-${c}` });

  const warn = new Set<Category>();
  if (health.data && missingTools(health.data).length > 0) warn.add('environment');

  const label = CATEGORIES.find((c) => c.id === category)?.label ?? '';

  let content: ReactNode;
  if (health.isPending) {
    content = (
      <div className="p-3">
        <Spinner label="正在检测…" />
      </div>
    );
  } else if (health.isError) {
    content = (
      <div className="p-3">
        <ErrorNotice error={health.error} />
      </div>
    );
  } else if (category === 'general') {
    content = <General health={health.data} project={project.data ?? null} />;
  } else if (category === 'environment') {
    content = <Environment health={health.data} />;
  } else {
    content = <Models />;
  }

  const recheck = (
    <Button variant="ghost" size="sm" onClick={() => void health.refetch()} busy={health.isFetching}>
      {health.isFetching ? null : <RefreshCw aria-hidden className="size-3" />}
      重新检测
    </Button>
  );

  return (
    <Workspace
      header={<PageHeader title="设置" icon={Settings} lead="本机运行环境、媒体工具和模型的配置状态。" />}
      left={
        <Panel title="分类" padded={false}>
          <CategoryList value={category} onChange={setCategory} warn={warn} idFor={idFor} />
        </Panel>
      }
    >
      <Panel title={label} padded={false} tools={category === 'environment' ? recheck : undefined}>
        <div id={idFor(category).panel} role="tabpanel" aria-labelledby={idFor(category).tab} className="max-w-[720px] py-2">
          {content}
        </div>
      </Panel>
    </Workspace>
  );
}
