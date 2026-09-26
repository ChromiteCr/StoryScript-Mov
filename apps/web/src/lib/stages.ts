import type { View } from './route.ts';

/**
 * The page bar's workflow: a live-action short moves through these stages in
 * this order. Pure data and helpers (no DOM, no React) so routing and keyboard
 * behaviour are unit-tested; icons live with the component.
 */

export interface StageDef {
  id: View;
  /** page bar label, two characters */
  label: string;
  /** one line for tooltips and page headers */
  lead: string;
}

export const STAGES = [
  { id: 'script', label: '剧本', lead: '导入剧本，按场切分，拆成有出处、可锁定的镜头表。' },
  { id: 'boards', label: '分镜', lead: '为每个镜头画出结构线稿和宽银幕铅笔分镜。' },
  { id: 'plan', label: '计划', lead: '排出单日拍摄顺序，批准前逐条校验。' },
  { id: 'set', label: '现场', lead: '拍摄现场快速录入场记：打板编号、条次、评级。' },
  { id: 'media', label: '素材', lead: '登记素材目录，把素材挂回镜头，查看漏拍清单。' },
  { id: 'deliver', label: '交付', lead: '导出分镜 PDF、拍摄单、场记 CSV 和项目 JSON。' },
] as const satisfies readonly StageDef[];

export type StageId = (typeof STAGES)[number]['id'];

/** Where the page bar can point: a stage, or the settings page (outside the flow). */
export type PageId = StageId | 'settings';

const STAGE_IDS: readonly string[] = STAGES.map((s) => s.id);

export function isStage(view: View | null): view is StageId {
  return view !== null && STAGE_IDS.includes(view);
}

export function stageIndex(id: StageId): number {
  return STAGE_IDS.indexOf(id);
}

export function stageDef(id: StageId): (typeof STAGES)[number] {
  const def = STAGES.find((s) => s.id === id);
  if (!def) throw new Error(`unknown stage: ${id}`);
  return def;
}

export function pageHref(id: PageId): string {
  return `#/${id}`;
}

/**
 * The page the bar marks with aria-current.
 * - settings is its own page, open or not;
 * - without a project the stages are unavailable, so none is current (home);
 * - with a project, the bare URL means the first stage.
 */
export function currentPage(view: View | null, projectOpen: boolean): PageId | null {
  if (view === 'settings') return 'settings';
  if (!projectOpen) return null;
  if (view === null) return STAGES[0].id;
  return isStage(view) ? view : null;
}

export type Orientation = 'horizontal' | 'vertical';

/**
 * Arrow-key movement in a row (page bar) or column (settings categories).
 * Returns the index to focus, or null when the key is not ours. Stops at the
 * ends instead of wrapping: the stages are a sequence, not a ring.
 */
export function nextIndex(current: number, key: string, count: number, orientation: Orientation = 'horizontal'): number | null {
  if (count <= 0) return null;
  const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const from = Math.min(Math.max(current, 0), count - 1);
  switch (key) {
    case prev:
      return Math.max(0, from - 1);
    case next:
      return Math.min(count - 1, from + 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
