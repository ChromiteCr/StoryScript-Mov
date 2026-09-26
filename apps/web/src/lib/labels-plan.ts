import type {
  BlockKind,
  Constraint,
  ConstraintType,
  Contradiction,
  PlanOutcome,
  Resource,
  ResourceType,
  Setup,
  Shot,
  Unplaced,
  UnplacedCode,
  Violation,
} from '@storyscript/contracts';

/**
 * Chinese copy for the plan page (FR-06). Pure: no DOM, no React.
 * The scheduler's own messages are English and technical; the page shows
 * the sentences built here and keeps the raw text behind "技术信息".
 */

export const RESOURCE_TYPE_LABEL: Record<ResourceType, string> = {
  performer: '演员',
  location: '场地',
  equipment: '设备',
};

export const BLOCK_KIND_LABEL: Record<BlockKind, string> = {
  setup: '准备',
  shoot: '拍摄',
  reset: '复位',
  buffer: '锁定余量',
};

export const CONSTRAINT_TYPE_LABEL: Record<ConstraintType, string> = {
  before: '先于',
  not_before: '不早于',
  not_after: '不晚于',
  locked_block: '锁定时段',
};

export type OutcomeTone = 'ok' | 'warn' | 'danger' | 'neutral';

export const OUTCOME: Record<PlanOutcome, { label: string; tone: OutcomeTone; explain: string }> = {
  feasible: { label: '可行', tone: 'ok', explain: '所有必拍 setup 都已排入，独立校验没有发现问题。' },
  partial: {
    label: '部分可排',
    tone: 'warn',
    explain: '按当前顺序没能排下全部必拍项；这不等于无解，调整顺序或放宽时间后再算。',
  },
  search_incomplete: { label: '搜索未完成', tone: 'warn', explain: '排程搜索没有完成，结果不完整，请重新计算。' },
  proven_infeasible: {
    label: '已证明不可行',
    tone: 'danger',
    explain: '输入里有明确矛盾，任何顺序都排不下；依据列在下方。',
  },
  needs_input: { label: '缺少输入', tone: 'neutral', explain: '有必需的数据缺失或无效，补齐后重新计算。' },
};

/** Where names come from when turning ids into words. */
export interface NameLookup {
  setup(id: string | null): Setup | undefined;
  resource(id: string | null): Resource | undefined;
  shot(id: string | null): Shot | undefined;
  /** display number of a shot's scene, e.g. "1" */
  sceneNo(shot: Shot): string;
}

const q = (s: string) => `「${s}」`;

function setupName(n: NameLookup, id: string | null): string {
  const s = n.setup(id);
  return s ? q(s.label) : '某个 setup';
}

function resourceName(n: NameLookup, id: string | null): string {
  const r = n.resource(id);
  return r ? q(r.name) : '某项资源';
}

export function shotName(n: NameLookup, id: string | null): string {
  const s = n.shot(id);
  return s ? `${n.sceneNo(s)}-${s.code}` : '某个镜头';
}

/** MISSING_INPUT messages come from core in English; map the known shapes. */
function missingInput(v: Violation, n: NameLookup): string {
  const m = v.message;
  const setup = v.setup_id ? `${setupName(n, v.setup_id)}：` : '';
  if (/unconfirmed and has no time window/.test(m)) return `资源${resourceName(n, v.resource_id)}未确认，也没有填写可用时间`;
  if (/is not confirmed/.test(m)) return `资源${resourceName(n, v.resource_id)}还没有确认`;
  if (/malformed or empty time window/.test(m)) return `资源${resourceName(n, v.resource_id)}的可用时间段无效`;
  if (/no per-shot duration/.test(m)) return `${setup}每镜工时为 0，无法排期`;
  if (/invalid durations/.test(m)) return `${setup}工时无效`;
  if (/unknown shot/.test(m)) return `${setup}引用了不存在的镜头`;
  if (/unknown resource/.test(m)) return `${setup}需要的资源已不存在`;
  if (/unknown setup/.test(m)) return '有约束引用了已删除的 setup';
  if (/malformed time|malformed or empty span/.test(m)) return `${setup}约束的时间无效`;
  if (/crew window/.test(m)) return '剧组工作时间无效（开工和收工时间）';
  if (/time zone/.test(m)) return '项目时区无效';
  return `${setup}缺少必需的数据`;
}

/** One violation as a Chinese sentence. */
export function violationText(v: Violation, n: NameLookup): string {
  switch (v.code) {
    case 'RESOURCE_OVERLAP':
      return `${resourceName(n, v.resource_id)}在同一时间被两个块占用（${setupName(n, v.setup_id)}）`;
    case 'OUTSIDE_WINDOW':
      return v.resource_id
        ? `${setupName(n, v.setup_id)}落在${resourceName(n, v.resource_id)}的可用时间之外`
        : `${setupName(n, v.setup_id)}超出了剧组工作时间`;
    case 'PRECEDENCE':
      return `${setupName(n, v.setup_id)}开始时，必须先拍完的 setup 还没有拍完`;
    case 'NOT_BEFORE':
      return `${setupName(n, v.setup_id)}开始得早于“不早于”约束`;
    case 'NOT_AFTER':
      return `${setupName(n, v.setup_id)}结束得晚于“不晚于”约束`;
    case 'LOCKED_BLOCK_MOVED':
      return `${setupName(n, v.setup_id)}没有落在锁定时段内`;
    case 'UNPLACED_REQUIRED':
      return `必拍镜头 ${shotName(n, v.shot_id)}（${setupName(n, v.setup_id)}）没有排入`;
    case 'CREW_OVERLAP':
      return `两个块时间重叠（${setupName(n, v.setup_id)}）；只有一个摄制组，不能同时进行`;
    case 'ESTIMATE_UNCONFIRMED':
      return `${setupName(n, v.setup_id)}的工时还是估算，需要确认`;
    case 'MISSING_INPUT':
      return missingInput(v, n);
    case 'DURATION_MISMATCH':
      return `${setupName(n, v.setup_id)}的块时长与工时设置不一致`;
    case 'BLOCK_SEQUENCE':
      return `${setupName(n, v.setup_id)}的准备、拍摄、复位没有首尾相接`;
  }
}

export const UNPLACED_TEXT: Record<UnplacedCode, string> = {
  NO_SLOT: '当天找不到足够长的空档：所需演员、场地和剧组同时空闲的时间不够',
  ORDER: '按当前顺序排到它时，剩下的时间已经放不下；换个顺序可能排得下',
  OCCUPIED: '它能用的时间段已被前面的 setup 占用',
  PRECEDENCE: '必须先拍的 setup 没有排入，所以它也排不进去',
  LOCKED: '锁定时段无法使用',
  MISSING_INPUT: '缺少必需的数据',
};

export function unplacedText(u: Unplaced, n: NameLookup): string {
  return `${setupName(n, u.setup_id)}没有排入：${UNPLACED_TEXT[u.code]}`;
}

const names = (list: string[]) => list.join('、');

/** Evidence for proven_infeasible, in Chinese; numbers are lifted from the core message. */
export function contradictionText(c: Contradiction, n: NameLookup): string {
  const setups = names(c.setup_ids.map((id) => setupName(n, id)));
  const resources = names(c.resource_ids.map((id) => resourceName(n, id)));
  switch (c.code) {
    case 'NO_WINDOW':
      return `${resources}已确认，但在剧组工作时间内当天没有任何可用时间；需要它的：${setups}`;
    case 'BLOCK_EXCEEDS_WINDOWS': {
      const m = /needs ([\d.]+) min.* is ([\d.]+) min/.exec(c.message);
      const nums = m ? `需要连续 ${m[1]} 分钟，但最长的共同空闲只有 ${m[2]} 分钟` : '需要的连续时长超过了共同空闲的最长时段';
      return `${setups}${nums}${resources ? `（${resources}）` : ''}`;
    }
    case 'PRECEDENCE_CYCLE':
      return `已确认的“先于”约束形成了环：${setups}`;
    case 'LOCKED_CONFLICT':
      return `锁定时段与其他条件冲突：${setups}${resources ? `（涉及${resources}）` : ''}`;
  }
}

/**
 * Approval blockers as display lines: UNPLACED_REQUIRED is folded per setup
 * ("「X」有 3 个必拍镜头没有排入：1-001、1-002、1-003") so a plan with nothing
 * placed does not print one line per shot; everything else stays one line each.
 */
export function blockerLines(list: readonly Violation[], n: NameLookup): { key: string; text: string; raw: string }[] {
  const out: { key: string; text: string; raw: string }[] = [];
  const unplaced = new Map<string, Violation[]>();
  for (const v of list) {
    if (v.code === 'UNPLACED_REQUIRED') {
      const k = v.setup_id ?? '';
      if (!unplaced.has(k)) out.push({ key: `u:${k}`, text: '', raw: '' });
      unplaced.set(k, [...(unplaced.get(k) ?? []), v]);
    } else {
      out.push({ key: `${out.length}`, text: violationText(v, n), raw: v.message });
    }
  }
  for (const line of out) {
    if (!line.key.startsWith('u:')) continue;
    const group = unplaced.get(line.key.slice(2))!;
    if (group.length === 1) {
      line.text = violationText(group[0]!, n);
    } else {
      const shots = group.map((v) => shotName(n, v.shot_id)).join('、');
      line.text = `${setupName(n, group[0]!.setup_id)}有 ${group.length} 个必拍镜头没有排入：${shots}`;
    }
    line.raw = group.map((v) => v.message).join('\n');
  }
  return out;
}

/** A constraint as a sentence, e.g. 「A」须在「B」之前拍完. `time` renders an instant locally. */
export function constraintText(c: Constraint, n: NameLookup, time: (iso: string) => string): string {
  switch (c.type) {
    case 'before':
      return `${setupName(n, c.a_setup_id)}须在${setupName(n, c.b_setup_id)}开始前拍完`;
    case 'not_before':
      return `${setupName(n, c.setup_id)}不早于 ${time(c.at_utc)} 开始`;
    case 'not_after':
      return `${setupName(n, c.setup_id)}须在 ${time(c.at_utc)} 前结束`;
    case 'locked_block':
      return `${setupName(n, c.setup_id)}锁定在 ${time(c.start_utc)}–${time(c.end_utc)}`;
  }
}

/** Approval state shown next to the outcome. */
export function approvalState(status: 'draft' | 'approved', stale: boolean): { label: string; tone: OutcomeTone } {
  if (status === 'approved') return stale ? { label: '已失效', tone: 'warn' } : { label: '已批准', tone: 'ok' };
  return { label: '草案', tone: 'neutral' };
}

/** Error copy this page needs beyond lib/errors (proposed for the shared table). */
export const PLAN_ERROR_COPY = {
  approveBlocked: '计划还不能批准',
  resourceInUse: '这项资源还在被 setup 使用',
  aiNotConfigured: 'AI 排序建议需要文本模型，尚未配置：在“设置 → 模型”里填写后可用。手动上移/下移不受影响。',
} as const;
