import { CalendarClock, Clapperboard, Film, PackageCheck, PanelsTopLeft, ScrollText, type LucideIcon } from 'lucide-react';
import type { View } from '../lib/route.ts';
import { stageDef } from '../lib/stages.ts';
import { Tag } from '../components/ui.tsx';
import { Panel, PageHeader, Workspace } from '../components/workspace.tsx';

type ProjectView = Exclude<View, 'settings' | 'projects'>;

interface Copy {
  icon: LucideIcon;
  points: string[];
}

/** What each stage is for. Plain description only: nothing here is clickable yet. */
const COPY: Record<ProjectView, Copy> = {
  script: {
    icon: ScrollText,
    points: [
      '粘贴剧本，或导入 .txt、.md、.fountain 文件，按场次标题自动切场，分镜脚本逐行导入为镜头',
      '每个镜头都引用剧本原文；改了剧本，能看出哪些镜头需要重新对应',
      '模型按场拆镜，结果先进草案，逐条勾选后才写入；锁定的镜头不会被改动',
      '没有配置模型时，照样可以手工建镜头',
    ],
  },
  boards: {
    icon: PanelsTopLeft,
    points: [
      '焦段、机位和景别由镜头参数算出，不需要任何 API key',
      '在画面里拖动人物站位和运动箭头，其余属性在侧栏修改',
      '俯视站位图与画面使用同一份机位数据',
    ],
  },
  plan: {
    icon: CalendarClock,
    points: [
      '登记演员、场地和设备的可用时间',
      '同一场地、同一机位朝向的镜头自动归为一组',
      '排期只改拍摄顺序，不会改动剧本里的叙事顺序',
    ],
  },
  set: {
    icon: Clapperboard,
    points: [
      '快速录入打板编号、条次、机位、评级和机内文件名',
      '一条可以对应多个镜头；对不上的手写镜号先记下，稍后再对应',
    ],
  },
  media: {
    icon: Film,
    points: [
      '登记素材目录后只读扫描，原片不会被改动或复制',
      '按打板编号和文件名给出关联候选，每一条都由你确认',
      '漏拍清单分开列出：没拍、没关联、没有可用条次、原片离线',
    ],
  },
  deliver: {
    icon: PackageCheck,
    points: [
      '分镜、俯视站位、拍摄单、打板卡和漏拍报告导出为 PDF',
      '场记与覆盖情况导出为 CSV，项目导出为 JSON（不含密钥和原片）',
    ],
  },
};

/** Placeholder for a stage that is not built yet, inside the workbench frame. */
export function ComingSoonView({ view }: { view: ProjectView }) {
  const { icon, points } = COPY[view];
  const { label, lead } = stageDef(view);
  return (
    <Workspace header={<PageHeader title={label} icon={icon} status={<Tag>开发中</Tag>} lead={lead} />}>
      <Panel title="这个页面将用来">
        <div className="max-w-[640px]">
          <ul className="space-y-2">
            {points.map((p) => (
              <li key={p} className="flex gap-2.5 text-sm text-graphite-100">
                <span aria-hidden className="mt-[9px] size-1 shrink-0 bg-graphite-500" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <p className="mt-5 border-t border-graphite-800 pt-3 text-xs text-graphite-300">这一部分还在开发中，当前版本里还不能使用。</p>
        </div>
      </Panel>
    </Workspace>
  );
}
