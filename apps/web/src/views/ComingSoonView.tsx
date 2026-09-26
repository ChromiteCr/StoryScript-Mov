import { CalendarClock, Clapperboard, FileText, PanelsTopLeft, type LucideIcon } from 'lucide-react';
import type { View } from '../lib/route.ts';

type ProjectView = Exclude<View, 'settings'>;

interface Copy {
  icon: LucideIcon;
  title: string;
  lead: string;
  points: string[];
}

/** What each view is for. Plain description only: nothing here is clickable yet. */
const COPY: Record<ProjectView, Copy> = {
  script: {
    icon: FileText,
    title: '剧本与镜头',
    lead: '把剧本拆成有出处、可锁定的镜头表。',
    points: [
      '粘贴剧本，或导入 .txt、.md、.fountain 文件，按场景标题自动切场',
      '每个镜头都引用剧本原文；改了剧本，能看出哪些镜头需要重新对应',
      '模型按场拆镜，结果先进草案，逐条勾选后才写入；锁定的镜头不会被改动',
      '没有配置模型时，照样可以手工建镜头',
    ],
  },
  boards: {
    icon: PanelsTopLeft,
    title: '分镜',
    lead: '为每个镜头画出结构线稿和宽银幕铅笔分镜。',
    points: [
      '焦段、机位和景别由镜头参数算出，不需要任何 API key',
      '在画面里拖动人物站位和运动箭头，其余属性在侧栏修改',
      '俯视站位图与画面使用同一份机位数据',
      '导出分镜 PDF',
    ],
  },
  plan: {
    icon: CalendarClock,
    title: '拍摄计划',
    lead: '排出单日的拍摄顺序，批准前逐条校验。',
    points: [
      '登记演员、场地和设备的可用时间',
      '同一场地、同一机位朝向的镜头自动归为一组',
      '排期只改拍摄顺序，不会改动剧本里的叙事顺序',
      '导出拍摄单、打板卡和预填编号的场记模板',
    ],
  },
  media: {
    icon: Clapperboard,
    title: '场记与素材',
    lead: '现场记录条次，把素材挂回镜头，拍完查看漏拍清单。',
    points: [
      '快速录入打板编号、条次、评级和机内文件名',
      '登记素材目录后只读扫描，原片不会被改动或复制',
      '按打板编号和文件名给出关联候选，每一条都由你确认',
      '漏拍清单分开列出：没拍、没关联、没有可用条次、原片离线',
    ],
  },
};

export function ComingSoonView({ view }: { view: ProjectView }) {
  const { icon: Icon, title, lead, points } = COPY[view];
  return (
    <section aria-labelledby={`view-${view}-title`} className="max-w-[720px]">
      <div className="flex items-center gap-2.5">
        <Icon aria-hidden className="size-5 text-ink-2" />
        <h1 id={`view-${view}-title`} className="text-xl font-semibold">
          {title}
        </h1>
        <span className="rounded-control border border-rule-strong px-1.5 text-xs leading-5 text-ink-2">即将提供</span>
      </div>
      <p className="mt-2 text-[15px] text-ink-2">{lead}</p>

      <div className="mt-6 rounded-sheet border border-dashed border-rule-strong px-5 py-5 sm:px-6">
        <p className="text-[13px] font-medium text-ink">这个视图将用来</p>
        <ul className="mt-2 space-y-1.5">
          {points.map((p) => (
            <li key={p} className="flex gap-2.5 text-[13px] text-ink-2">
              <span aria-hidden className="mt-[9px] size-1 shrink-0 bg-ink-3" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
        <p className="mt-5 border-t border-rule pt-3 text-xs text-ink-3">这一部分还在开发中，当前版本里还不能使用。</p>
      </div>
    </section>
  );
}
