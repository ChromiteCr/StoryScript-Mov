import type { ApplyPasteResult, PasteHint, PasteItem, PasteItemView, PasteKind, PasteSlot, ScheduleRule, Todo } from '@storyscript/contracts';

/**
 * S5a 粘贴整理 in the browser: labels, one-line summaries of the items, what
 * applying would do, the default selection and the result line. Pure.
 */

export const PASTE_KIND_LABEL: Record<PasteKind, string> = {
  person: '演员档期',
  location: '场地',
  equipment: '器材',
  prop: '道具和服装',
  schedule: '拍摄安排',
  take: '场记',
  todo: '待办和分工',
  other: '其他',
};

/** Review order: what feeds the plan first, notes last. */
export const PASTE_KIND_ORDER: readonly PasteKind[] = ['person', 'location', 'equipment', 'schedule', 'prop', 'todo', 'take', 'other'];

/** Kinds an item may be moved between in the review (they share the name field). */
export const NAMED_KINDS: readonly PasteKind[] = ['person', 'location', 'equipment', 'prop'];

export const PASTE_HINT_LABEL: Record<PasteHint, string> = { auto: '自动', plan: '偏向计划', set: '偏向现场' };

const RULE_TEXT: Record<ScheduleRule, string> = {
  within: '在这段时间拍',
  not_before: '不早于',
  not_after: '不晚于',
  before: '先于',
  after: '晚于',
};

const RATING_TEXT = { good: '可用', alternate: '备用', reject: '废弃', unrated: '未评' } as const;

/** 「10月10日 周六 14:00–18:00」, 「10月16日 周五」 */
export function slotText(s: PasteSlot): string {
  const [, m, d] = s.date.split('-');
  const day = `${Number(m)}月${Number(d)}日${s.weekday ? ` ${s.weekday}` : ''}`;
  if (s.start && s.end) return `${day} ${s.start}–${s.end}`;
  if (s.start) return `${day} ${s.start} 起`;
  if (s.end) return `${day} ${s.end} 前`;
  return day;
}

const scenesText = (nos: readonly string[]) => nos.map((n) => `第 ${n} 场`).join('、');

/** One line for the review list. */
export function itemSummary(it: PasteItem): string {
  const when = it.slots.map(slotText).join('；');
  switch (it.kind) {
    case 'person':
      return [it.name, it.character ? `饰 ${it.character}` : null, when || null].filter(Boolean).join(' · ');
    case 'location':
      return [it.name, when || null, it.detail].filter(Boolean).join(' · ');
    case 'equipment':
      return [`${it.name}${it.quantity && it.quantity > 1 ? ` ×${it.quantity}` : ''}`, it.owner ? `${it.owner} 负责` : null, when || null].filter(Boolean).join(' · ');
    case 'prop':
      return [it.name, it.owner ? `${it.owner} 准备` : null, it.detail].filter(Boolean).join(' · ');
    case 'schedule':
      if (it.rule === 'before' || it.rule === 'after') return `${scenesText(it.scenes)} ${RULE_TEXT[it.rule]} ${scenesText(it.other_scenes)}`;
      return `${scenesText(it.scenes)} ${it.rule ? RULE_TEXT[it.rule] : ''} ${when}`.replace(/\s+/g, ' ').trim();
    case 'take': {
      const code = [it.scenes[0] ? `${it.scenes[0]} 场` : null, it.shot ? `${it.shot} 镜` : null, it.take ? `第 ${it.take} 条` : null].filter(Boolean).join(' ');
      return [code, it.rating ? RATING_TEXT[it.rating] : null, it.detail, it.clip ? `素材 ${it.clip}` : null].filter(Boolean).join(' · ');
    }
    case 'todo':
      return [it.assignee ? `${it.assignee}：${it.task}` : it.task, it.slots[0] ? `${slotText({ ...it.slots[0], start: null })}前` : null].filter(Boolean).join(' · ');
    case 'other':
      return it.detail ?? it.quote;
  }
}

/** What applying it does, in a few words. */
export function resolutionText(v: Pick<PasteItemView, 'item' | 'resolution'>): string | null {
  const { item, resolution: r } = v;
  switch (item.kind) {
    case 'person':
    case 'location':
    case 'equipment': {
      const what = item.kind === 'person' ? '演员' : item.kind === 'location' ? '场地' : '器材';
      const extra = item.kind === 'equipment' && item.owner ? '，并给负责人建一条待办' : '';
      return r.action === 'merge' ? `合并到已有${what}「${r.target_name}」${item.slots.length ? '（增加可用时段）' : ''}${extra}` : `新建${what}${extra}`;
    }
    case 'prop':
      return r.action === 'exists' ? `剧本里已有道具「${r.target_name}」${item.owner ? '；给负责人建一条待办' : ''}` : `新建道具条目${item.owner ? '，并给负责人建一条待办' : ''}`;
    case 'schedule': {
      const n = r.setup_ids.length + r.other_setup_ids.length;
      return n ? `加到 ${n} 个 setup 的排期约束` : null;
    }
    case 'take':
      return r.shot_ids.length ? '记一条条次' : '记一条条次（镜号未对上）';
    case 'todo':
      return r.assignee_id ? `待办，指派给 ${r.target_name}${r.assignee_roles.length ? `（${r.assignee_roles.join('、')}）` : ''}` : r.target_name ? `待办，负责人「${r.target_name}」` : '待办，暂无负责人';
    case 'other':
      return null;
  }
}

export interface KindGroup {
  kind: PasteKind;
  items: PasteItemView[];
}

/** Items grouped in review order (empty kinds left out). */
export function groupItems(items: readonly PasteItemView[]): KindGroup[] {
  return PASTE_KIND_ORDER.map((kind) => ({ kind, items: items.filter((i) => i.item.kind === kind) })).filter((g) => g.items.length > 0);
}

/** Ticked at first: what the server suggests (not applied, applicable, not a repeat). */
export function defaultSelection(items: readonly PasteItemView[]): Set<string> {
  return new Set(items.filter((i) => i.suggested).map((i) => i.key));
}

/** The selection, kept to keys still selectable after a refresh. */
export function pruneSelection(selected: ReadonlySet<string>, items: readonly PasteItemView[]): Set<string> {
  const ok = new Set(items.filter((i) => !i.applied && !i.blocked).map((i) => i.key));
  return new Set([...selected].filter((k) => ok.has(k)));
}

/** 「新建 5 个资源、3 条约束、2 条条次、5 条待办」 */
export function appliedLine(c: ApplyPasteResult['counts']): string {
  const parts = [
    c.resources_created ? `新建 ${c.resources_created} 个资源` : null,
    c.resources_updated ? `更新 ${c.resources_updated} 个资源` : null,
    c.constraints ? `${c.constraints} 条约束` : null,
    c.takes ? `${c.takes} 条条次` : null,
    c.entities ? `${c.entities} 个道具条目` : null,
    c.todos ? `${c.todos} 条待办` : null,
  ].filter(Boolean);
  return parts.length ? `已写入：${parts.join('、')}` : '没有需要写入的内容';
}

// ---------------------------------------------------------------- todos

/** Overdue when its date is before today (local); due today counts as not overdue. */
export function todoOverdue(t: Pick<Todo, 'due_date' | 'done'>, today: string): boolean {
  return !t.done && t.due_date !== null && t.due_date < today;
}

/** 「10月16日」「10月16日 18:00」「今天」「明天」 */
export function dueText(t: Pick<Todo, 'due_date' | 'due_time'>, today: string): string | null {
  if (!t.due_date) return null;
  const [, m, d] = t.due_date.split('-');
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const day = t.due_date === today ? '今天' : t.due_date === tomorrow ? '明天' : `${Number(m)}月${Number(d)}日`;
  return t.due_time ? `${day} ${t.due_time}` : day;
}

/** 「小林（摄影）」 or the typed name. */
export function assigneeText(t: Pick<Todo, 'assignee_name' | 'assignee_roles'>): string | null {
  if (!t.assignee_name) return null;
  return t.assignee_roles.length ? `${t.assignee_name}（${t.assignee_roles.join('、')}）` : t.assignee_name;
}
