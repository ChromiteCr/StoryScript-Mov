/**
 * Chinese copy of the deliver page (FR-10). Pure data, no React.
 * Wording rules: say what a file contains and whether it is a draft; never
 * promise more than the export does (no "backup", no "safe to format").
 */

export type DeliverItemId =
  | 'boards'
  | 'topview'
  | 'callsheet'
  | 'slates'
  | 'take-log'
  | 'shots-csv'
  | 'takes-media'
  | 'coverage-csv'
  | 'missing'
  | 'project-json';

export type DeliverFormat = 'PDF' | 'CSV' | 'JSON';

export interface DeliverItemCopy {
  title: string;
  formats: DeliverFormat[];
  /** one sentence: what is in the file */
  contains: string;
}

export const DELIVER_ITEM: Record<DeliverItemId, DeliverItemCopy> = {
  boards: {
    title: '分镜 PDF',
    formats: ['PDF'],
    contains: '每个镜头的铅笔分镜格，附镜号、动作、对白、景别·焦段·运镜和时长；画幅 2.2 及以上每页 3 格，其余 2 格。',
  },
  topview: {
    title: '俯视站位 PDF',
    formats: ['PDF'],
    contains: '每个镜头的俯视站位示意（非实景测量）和对应的分镜格，每页 3 个镜头。',
  },
  callsheet: {
    title: '拍摄单',
    formats: ['PDF', 'CSV'],
    contains: '拍摄日按时间排出的准备、拍摄、复位块，含镜头、演员、场地和设备；空档只出现在打印版。',
  },
  slates: {
    title: '打板卡',
    formats: ['PDF'],
    contains: '按拍摄顺序每镜一张，打板编号预填，条次留空现场手写。',
  },
  'take-log': {
    title: '场记模板',
    formats: ['CSV'],
    contains: '按拍摄顺序预填场次和镜号的空白场记表，列名为英文字段，便于导入其他工具。',
  },
  'shots-csv': {
    title: '镜头表',
    formats: ['CSV'],
    contains: '按叙事顺序的全部镜头：景别、角度、焦段、运镜、人物、内容、对白、必拍状态、锁定和剧本出处。',
  },
  'takes-media': {
    title: '场记与素材',
    formats: ['CSV'],
    contains: '每条场记 × 镜头 × 关联片段一行：条次、评级、机内文件名、素材文件与 sha256、关联状态，片段区间拆成五列整数（source_range）。',
  },
  'coverage-csv': {
    title: '覆盖状态',
    formats: ['CSV'],
    contains: '每个镜头一行：必拍状态、覆盖状态、漏拍原因和条次/关联计数；与素材页的覆盖面板同一次计算。',
  },
  missing: {
    title: '漏拍报告',
    formats: ['PDF'],
    contains: '按四种原因（无场记、无关联素材、无已确认的可用片段、原片离线）列出尚未可用的必拍镜头；可选和免拍镜头不计入。',
  },
  'project-json': {
    title: '项目 JSON',
    formats: ['JSON'],
    contains: '剧本各版本、场次、角色、镜头与修订、分镜各版本、AI 图记录、资源、setup、约束、计划、场记、素材元数据与关联、覆盖决定。',
  },
};

export interface DeliverGroupCopy {
  id: 'boards' | 'day' | 'set' | 'project';
  title: string;
  items: DeliverItemId[];
}

export const DELIVER_GROUPS: readonly DeliverGroupCopy[] = [
  { id: 'boards', title: '分镜', items: ['boards', 'topview'] },
  { id: 'day', title: '拍摄日', items: ['callsheet', 'slates', 'take-log'] },
  { id: 'set', title: '现场与素材', items: ['takes-media', 'coverage-csv', 'missing'] },
  { id: 'project', title: '项目', items: ['shots-csv', 'project-json'] },
];

/** What the project JSON never contains (shown next to it and in the settings panel). */
export const PROJECT_JSON_EXCLUDES = '不含原片、API key、任务与模型日志，也不含素材目录的绝对路径（只留目录名、相对路径和 sha256，便于重新关联）。';

export const NOT_PROVIDED = 'v0.1 未提供：项目 JSON 导入、场记 CSV 导入、剪辑软件（NLE）交换文件。';

export const BOM_HINT = 'Excel 直接打开时中文不乱码；导入其他软件时可以关掉。';

export const AI_BADGE_COPY = {
  label: '分镜导出带「AI 生成」角标',
  hint: '导出的分镜若使用了已采用的 AI 图，该格会带「AI 生成」角标。默认开启。',
  none: '本项目没有已采用的 AI 图：分镜导出全部是确定性铅笔稿，不需要角标。',
  some: (n: number) => `有 ${n} 格分镜已采用 AI 图。`,
  off: '已关闭角标：分享前请确认观看者知道哪些格由 AI 生成。',
} as const;

export const DRAFT_NOTE = {
  noBoards: '还没有分镜格：在剧本页新建或拆出镜头后自动生成。',
  boardsDraft: (unlocked: number, stale: number) =>
    [unlocked ? `${unlocked} 个镜头未锁定` : '', stale ? `${stale} 格镜头已改、分镜待更新` : ''].filter(Boolean).join('，') + '：这些页的页眉标「草案」。',
  boardsFinal: '全部镜头已锁定且分镜是最新的：页眉标「定稿」。',
  noPlan: '还没有拍摄计划：先在计划页新建一个拍摄日。',
  planDraft: '计划未批准：导出内容标「草案」。',
  planStale: '计划批准后输入有变（资源、setup 或镜头），需要重新计算并批准：导出内容标「草案」。',
  planApproved: (date: string) => `${date} 的计划已批准。`,
  noTakes: '还没有场记或素材关联：导出只有表头。',
  takes: (takes: number, links: number, candidates: number) =>
    `${takes} 条场记、${links} 条关联${candidates ? `（其中 ${candidates} 条候选待审核，状态列写明「候选」）` : ''}。`,
  noShots: '还没有镜头：导出只有表头。',
  shots: (n: number, unlocked: number) => `${n} 个镜头${unlocked ? `，${unlocked} 个未锁定（仍可修改）` : '，全部已锁定'}。`,
  coverage: (missing: number, usable: number) => `漏拍 ${missing} 个，可用 ${usable} 个。`,
  projectJson: '随时可导出，内容为当前数据库中的全部项目数据。',
} as const;

export const STATE_LABEL = {
  ready: '可导出',
  draft: '草案',
  empty: '暂无内容',
  unavailable: '不可用',
} as const;
export type DeliverState = keyof typeof STATE_LABEL;
