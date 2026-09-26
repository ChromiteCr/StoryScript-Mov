import type { ReactNode } from 'react';
import type { HealthInfo, Project, ToolStatus } from '@storyscript/contracts';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useCurrentProject, useHealth } from '../lib/queries.ts';
import { formatDuration } from '../lib/format.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Button, CopyCommand, SectionHeading, Spinner } from '../components/ui.tsx';
import { TextProviderPanel } from './TextProviderPanel.tsx';

function Panel({ children }: { children: ReactNode }) {
  return <section className="rounded-sheet border border-rule bg-sheet px-5 py-4 sm:px-6">{children}</section>;
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2.5 text-[13px] sm:grid-cols-[9rem_minmax(0,1fr)]">{children}</dl>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-3 sm:pt-px">{label}</dt>
      <dd className="-mt-2 min-w-0 text-ink sm:mt-0">{children}</dd>
    </>
  );
}

function State({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${ok ? 'bg-ok' : 'bg-warn'}`} />
      <span className={ok ? 'text-ink' : 'text-warn'}>{children}</span>
    </span>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12.5px] break-all">{children}</span>;
}

function ToolRow({ name, tool }: { name: string; tool: ToolStatus }) {
  return (
    <Row label={name}>
      {tool.path ? (
        <div className="flex flex-col gap-0.5">
          <State ok>已找到{tool.version ? `，版本 ${tool.version}` : ''}</State>
          <Mono>{tool.path}</Mono>
        </div>
      ) : (
        <State ok={false}>未找到</State>
      )}
    </Row>
  );
}

function MediaTools({ health }: { health: HealthInfo }) {
  const missing = [health.ffmpeg.path ? null : 'ffmpeg', health.ffprobe.path ? null : 'ffprobe'].filter((x): x is string => x !== null);
  return (
    <Panel>
      <SectionHeading title="媒体工具" description="素材扫描、元数据读取和海报帧都依赖本机安装的 ffmpeg 与 ffprobe。" />
      {missing.length > 0 ? (
        <div role="note" className="mt-3 flex gap-2.5 rounded-sheet border border-warn-rule bg-warn-bg px-3 py-2.5 text-[13px]">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0">
            <p className="font-medium text-warn">素材导入不可用</p>
            <p className="mt-0.5 leading-7 text-ink-2">
              没有找到 {missing.join(' 和 ')}。用 Homebrew 安装 <CopyCommand command="brew install ffmpeg" />
              （ffprobe 会一起装好），然后重启 storyscript-mov。剧本、分镜、排期、场记和导出不受影响。
            </p>
          </div>
        </div>
      ) : null}
      <Rows>
        <ToolRow name="ffmpeg" tool={health.ffmpeg} />
        <ToolRow name="ffprobe" tool={health.ffprobe} />
        <Row label="可用编码器">
          {health.encoders.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {health.encoders.map((e) => (
                <li key={e} className="rounded-control border border-rule bg-sheet-sunk px-1.5 font-mono text-xs leading-5">
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-ink-3">未检测到</span>
          )}
        </Row>
      </Rows>
    </Panel>
  );
}

function Models({ health }: { health: HealthInfo }) {
  return (
    <Panel>
      <SectionHeading title="图像模型（实验）" description="密钥只保存在本机服务端，页面上不会显示。" />
      <Rows>
        <Row label="状态">
          <div className="flex flex-col gap-0.5">
            <State ok={health.image_provider_configured}>{health.image_provider_configured ? '已配置' : '未配置'}</State>
            {health.image_provider_configured ? null : (
              <p className="text-ink-2">
                只有 AI 铅笔重绘用到图像模型。铅笔分镜本身由本机渲染，不需要它。配置项同样是 base_url、key、model 三项，环境变量前缀为{' '}
                <Mono>STORYSCRIPT_IMAGE_</Mono>。
              </p>
            )}
          </div>
        </Row>
      </Rows>
    </Panel>
  );
}

function Runtime({ health }: { health: HealthInfo }) {
  return (
    <Panel>
      <SectionHeading title="运行环境" />
      <Rows>
        <Row label="StoryScript-Mov">
          <Mono>{health.app_version}</Mono>
        </Row>
        <Row label="Node">
          <Mono>{health.node}</Mono>
        </Row>
        <Row label="SQLite">
          <Mono>{health.sqlite}</Mono>
        </Row>
        <Row label="运行模式">{health.demo ? '演示回放：模型输出来自录制的样例，不是真实调用' : '正常'}</Row>
      </Rows>
    </Panel>
  );
}

function ProjectInfo({ project }: { project: Project }) {
  return (
    <Panel>
      <SectionHeading title="当前项目" description="新建项目时填写的设置。" />
      <Rows>
        <Row label="项目名">{project.name}</Row>
        <Row label="时区">
          <Mono>{project.timezone}</Mono>
        </Row>
        <Row label="默认画幅">
          <span className="tabular-nums">{project.default_aspect} : 1</span>
        </Row>
        <Row label="目标时长">
          {project.target_duration_s === null ? (
            <span className="text-ink-3">未设定</span>
          ) : (
            <span className="tabular-nums">{formatDuration(project.target_duration_s)}</span>
          )}
        </Row>
        <Row label="打板编号格式">
          <Mono>{project.code_format}</Mono>
        </Row>
        <Row label="创建于">
          <span className="tabular-nums">{new Date(project.created_at).toLocaleString('zh-CN')}</span>
        </Row>
      </Rows>
    </Panel>
  );
}

export function SettingsView() {
  const health = useHealth();
  const project = useCurrentProject();

  return (
    <div className="max-w-[820px]">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">设置</h1>
          <p className="mt-1 text-[13px] text-ink-2">本机运行环境、媒体工具和模型的配置状态。</p>
        </div>
        <Button onClick={() => void health.refetch()} busy={health.isFetching}>
          {health.isFetching ? null : <RefreshCw aria-hidden className="size-3.5" />}
          重新检测
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-4">
        {health.isPending ? <Spinner label="正在检测…" /> : null}
        {health.isError ? <ErrorNotice error={health.error} /> : null}
        {health.data ? (
          <>
            <TextProviderPanel />
            <MediaTools health={health.data} />
            <Models health={health.data} />
            <Runtime health={health.data} />
          </>
        ) : null}
        {project.data ? <ProjectInfo project={project.data} /> : null}
      </div>
    </div>
  );
}
