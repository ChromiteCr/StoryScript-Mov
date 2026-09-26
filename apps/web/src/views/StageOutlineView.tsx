import type { ReactNode } from 'react';
import { CalendarClock, Clapperboard, Film, PackageCheck, PanelsTopLeft, type LucideIcon } from 'lucide-react';
import { useHealth } from '../lib/queries.ts';
import { pageHref, stageDef, type StageId } from '../lib/stages.ts';
import { Notice, Tag } from '../components/ui.tsx';
import { EmptyState, PageHeader, PaperCanvas, Panel, Workspace } from '../components/workspace.tsx';

/**
 * Stages that are not built yet: the future panel layout, each panel saying in
 * one sentence what it will hold. No buttons, nothing pretends to work.
 */

type OutlineStage = Exclude<StageId, 'script'>;

const ICON: Record<OutlineStage, LucideIcon> = {
  boards: PanelsTopLeft,
  plan: CalendarClock,
  set: Clapperboard,
  media: Film,
  deliver: PackageCheck,
};

function Outline({ title, children }: { title: string; children: string }) {
  return (
    <Panel title={title}>
      <EmptyState quiet title={children} />
    </Panel>
  );
}

/** An empty board sheet: three 2.39 frames, as a page prints at ≥2.2 (FR-10). */
function BoardSheetOutline() {
  return (
    <PaperCanvas label="分镜稿（尚无内容）">
      <p className="text-sm text-ink/75">该面板将在纸面上显示分镜稿：画幅 2.2 及以上时每页 3 格。</p>
      <div aria-hidden className="mt-6 flex flex-col gap-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="aspect-[2.39/1] w-full border border-dashed border-ink/30" />
            <div className="h-px w-2/3 bg-ink/15" />
          </div>
        ))}
      </div>
    </PaperCanvas>
  );
}

/** An empty A4 portrait sheet for the print preview. */
function PrintPreviewOutline() {
  return (
    <div className="mx-auto w-full max-w-[420px]">
      <PaperCanvas variant="fill" label="打印预览（尚无内容）" className="aspect-[1/1.414]">
        <EmptyState tone="paper" title="该面板将显示导出前的打印预览。" description="PDF 由浏览器打印生成，纸面内容按白底黑字输出。" />
      </PaperCanvas>
    </div>
  );
}

function FfmpegMissingNote() {
  const health = useHealth();
  const h = health.data;
  if (!h || (h.ffmpeg.path && h.ffprobe.path)) return null;
  return (
    <Notice tone="warn" title="没有找到 ffmpeg，素材导入将不可用" className="mb-3">
      剧本、分镜、排期、场记和导出不受影响。安装方法见{' '}
      <a href={pageHref('settings')} className="text-graphite-100 underline underline-offset-2 hover:decoration-2">
        设置里的环境检查
      </a>
      。
    </Notice>
  );
}

interface Layout {
  left?: ReactNode;
  main: ReactNode;
  right?: ReactNode;
  bottom?: ReactNode;
}

function layoutFor(stage: OutlineStage): Layout {
  switch (stage) {
    case 'boards':
      return {
        left: <Outline title="镜头">该面板将按叙事顺序列出本场镜头的缩略图。</Outline>,
        main: (
          <Panel title="分镜稿">
            <BoardSheetOutline />
          </Panel>
        ),
        right: <Outline title="镜头属性">该面板将显示景别、焦段、机位高度和人物站位等参数。</Outline>,
      };
    case 'plan':
      return {
        left: <Outline title="资源">该面板将列出演员、场地和设备，以及各自的可用时间。</Outline>,
        main: <Outline title="拍摄顺序">该面板将按时间排出 setup 块；排期只改拍摄顺序，不改叙事顺序。</Outline>,
        right: <Outline title="校验">该面板将列出违规、未排项和待确认的工时。</Outline>,
      };
    case 'set':
      return {
        left: <Outline title="今日镜头">该面板将列出今天计划拍摄的镜头和打板编号。</Outline>,
        main: <Outline title="场记录入">该面板将提供快速录入：打板编号、条次、机位、评级、机内文件名和备注。</Outline>,
        right: <Outline title="本镜条次">该面板将显示当前镜头已经记录的条次。</Outline>,
      };
    case 'media':
      return {
        left: <Outline title="素材目录">该面板将列出登记过的素材目录；扫描只读，不改动原片。</Outline>,
        main: (
          <Panel title="素材库">
            <div className="flex h-full flex-col">
              <FfmpegMissingNote />
              <div className="min-h-0 flex-1">
                <EmptyState quiet title="该面板将以海报帧网格显示素材，可按打板编号检索。" />
              </div>
            </div>
          </Panel>
        ),
        right: <Outline title="关联审核">该面板将逐条列出素材与镜头的关联候选，每条由你确认。</Outline>,
        bottom: <Outline title="漏拍清单">该面板将按原因列出漏拍：没拍、没关联、没有可用条次、原片离线。</Outline>,
      };
    case 'deliver':
      return {
        left: <Outline title="导出项">该面板将列出可导出的内容：分镜、拍摄单、打板卡、漏拍报告、场记 CSV 和项目 JSON。</Outline>,
        main: (
          <Panel title="打印预览">
            <PrintPreviewOutline />
          </Panel>
        ),
        right: <Outline title="导出设置">该面板将提供纸张方向、每页格数和"AI 生成"角标等选项。</Outline>,
      };
  }
}

export function StageOutlineView({ stage }: { stage: OutlineStage }) {
  const { label, lead } = stageDef(stage);
  const { left, main, right, bottom } = layoutFor(stage);
  return (
    <Workspace
      header={<PageHeader title={label} icon={ICON[stage]} status={<Tag>开发中</Tag>} lead={lead} />}
      left={left}
      right={right}
      bottom={bottom}
    >
      {main}
    </Workspace>
  );
}
