import type { PasteItem, PasteKind, PasteOutput, PasteSlot, ScheduleRule, TakeRating } from '@storyscript/contracts';
import { snapQuote } from '../script/check.ts';
import { matchQuote, normalizeForMatch, quoteIsExact, substringEditDistance } from '../script/quote.ts';

/**
 * S5a 粘贴整理 — checking the model's items against the pasted segment:
 *
 * - normalizePasteJson: kinds and ratings in Chinese or other spellings,
 *   missing fields, 9:00 → 09:00, 2026-10-9 → 2026-10-09, 「第2场」 → "2"
 * - validatePaste: what a repair round should fix (a quote not in the text,
 *   a missing field the kind needs, an impossible date)
 * - finalizePaste: what is kept once the rounds are used up; a quote copied
 *   nearly right is stored in the text's own words
 * - uncoveredLines: lines of the text no item quotes, shown so nothing pasted
 *   silently disappears
 */

const KIND_WORDS: Record<string, PasteKind> = {
  人员: 'person', 演员: 'person', 人: 'person', 档期: 'person', people: 'person', actor: 'person', cast: 'person', performer: 'person',
  场地: 'location', 地点: 'location', place: 'location', venue: 'location',
  器材: 'equipment', 设备: 'equipment', gear: 'equipment',
  道具: 'prop', 服装: 'prop', 道具和服装: 'prop', 服化道: 'prop', costume: 'prop', props: 'prop',
  拍摄安排: 'schedule', 安排: 'schedule', 排期: 'schedule', plan: 'schedule', constraint: 'schedule',
  场记: 'take', 条次: 'take', log: 'take',
  待办: 'todo', 分工: 'todo', 任务: 'todo', task: 'todo',
  其他: 'other', 其它: 'other', misc: 'other',
};
const KINDS: readonly PasteKind[] = ['person', 'location', 'equipment', 'prop', 'schedule', 'take', 'todo', 'other'];

const RULE_WORDS: Record<string, ScheduleRule> = {
  在: 'within', 期间: 'within', on: 'within', during: 'within',
  不早于: 'not_before', 之后开始: 'not_before', from: 'not_before',
  不晚于: 'not_after', 之前完成: 'not_after', by: 'not_after', until: 'not_after',
  之前: 'before', 先于: 'before', 之后: 'after', 晚于: 'after',
};
const RULES: readonly ScheduleRule[] = ['within', 'not_before', 'not_after', 'before', 'after'];

const RATING_WORDS: Record<string, TakeRating> = {
  好: 'good', 可用: 'good', 保: 'good', 保留: 'good', ok: 'good', pass: 'good',
  备: 'alternate', 备用: 'alternate', 备选: 'alternate', alt: 'alternate',
  废: 'reject', 废弃: 'reject', 不可用: 'reject', ng: 'reject', bad: 'reject',
  未评: 'unrated', none: 'unrated',
};

const key = (v: string) => v.trim().toLowerCase().replace(/[\s-]+/g, '_');
const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : null;
  return s ? s : null;
};

function enumOf<T extends string>(v: unknown, list: readonly T[], words: Record<string, T>): unknown {
  if (typeof v !== 'string') return v;
  const k = key(v);
  return (list as readonly string[]).includes(k) ? k : (words[k] ?? words[v.trim()] ?? k);
}

function normDate(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(v.trim());
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : v.trim();
}

function normTime(v: unknown): unknown {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return v;
  const m = /^(\d{1,2})[:：](\d{2})$/.exec(v.trim());
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : v.trim();
}

const sceneNo = (v: unknown): string | null => {
  const s = str(v);
  return s ? s.replace(/^第\s*/, '').replace(/\s*场$/, '').trim() || null : null;
};

function normSlot(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  return {
    date: normDate(o.date),
    weekday: str(o.weekday),
    start: normTime(o.start),
    end: normTime(o.end),
    vague: o.vague === true || o.vague === 'true',
  };
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

export function normalizePasteJson(raw: unknown): unknown {
  let items: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) items = (raw as Record<string, unknown>).items;
  // another shape is not "nothing in it": zod rejects it and the repair round asks again
  if (!Array.isArray(items)) return raw;
  return {
    items: items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const it = item as Record<string, unknown>;
      const take = typeof it.take === 'string' && /^\d+$/.test(it.take.trim()) ? Number(it.take) : it.take ?? null;
      const quantity = typeof it.quantity === 'string' && /^\d+$/.test(it.quantity.trim()) ? Number(it.quantity) : it.quantity ?? null;
      return {
        kind: enumOf(it.kind ?? it.type, KINDS, KIND_WORDS),
        quote: typeof it.quote === 'string' ? it.quote.trim() : it.quote ?? '',
        name: str(it.name),
        detail: str(it.detail ?? it.note),
        character: str(it.character),
        owner: str(it.owner),
        quantity,
        slots: list(it.slots).map(normSlot),
        scenes: list(it.scenes ?? it.scene).map(sceneNo).filter((s) => s !== null),
        rule: it.rule == null || it.rule === '' ? null : enumOf(it.rule, RULES, RULE_WORDS),
        other_scenes: list(it.other_scenes).map(sceneNo).filter((s) => s !== null),
        shot: str(it.shot),
        take,
        rating: it.rating == null || it.rating === '' ? null : enumOf(it.rating, ['good', 'alternate', 'reject', 'unrated'], RATING_WORDS),
        clip: str(it.clip),
        assignee: str(it.assignee),
        task: str(it.task),
        unsure: str(it.unsure),
      };
    }),
  };
}

/** A real calendar day. */
export function isCalendarDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const NAMED: ReadonlySet<PasteKind> = new Set(['person', 'location', 'equipment', 'prop']);
/** A todo's text (contracts Todo.text) and a name's length. */
export const TODO_TEXT_MAX = 200;
const NAME_MAX = 80;

/** Missing pieces an item of its kind needs (for the repair round and the review). */
export function pasteItemProblems(item: PasteItem): string[] {
  const out: string[] = [];
  if (NAMED.has(item.kind) && !item.name) out.push('缺少 name');
  if (item.kind === 'todo' && !item.task?.trim()) out.push('缺少 task');
  if (item.task && Array.from(item.task.trim()).length > TODO_TEXT_MAX) out.push(`task 超过 ${TODO_TEXT_MAX} 字，请缩短`);
  if (item.name && Array.from(item.name.trim()).length > NAME_MAX) out.push(`name 超过 ${NAME_MAX} 字，请缩短`);
  if (item.kind === 'take' && !item.scenes[0] && !item.shot) out.push('场记缺少场号或镜号');
  if (item.kind === 'schedule') {
    if (!item.scenes.length) out.push('拍摄安排缺少 scenes');
    if (!item.rule) out.push('拍摄安排缺少 rule');
    else if ((item.rule === 'before' || item.rule === 'after') && !item.other_scenes.length) out.push(`rule 为 ${item.rule} 时要写 other_scenes`);
    else if ((item.rule === 'within' || item.rule === 'not_before' || item.rule === 'not_after') && !item.slots.length) out.push(`rule 为 ${item.rule} 时要写 slots`);
  }
  for (const s of item.slots) {
    if (!isCalendarDate(s.date)) out.push(`日期 ${s.date} 不存在`);
    // a todo's slot is only its due date and time; anything else is a span that must end after it starts
    else if (item.kind !== 'todo' && s.start && s.end && s.end <= s.start) out.push(`${s.date} 的结束时间 ${s.end} 要晚于开始时间 ${s.start}`);
  }
  return out;
}

/** Where the quote is: verbatim, nearly (then the closest stretch of the best line), or nowhere. */
export function placeQuote(quote: string, text: string): string | null {
  if (!quote.trim()) return null;
  if (quoteIsExact(quote, text)) return quote;
  const lines = text.split('\n').filter((l) => l.trim());
  const q = Array.from(normalizeForMatch(quote));
  let best: { line: string; d: number } | null = null;
  for (const line of lines) {
    const d = substringEditDistance(q, Array.from(normalizeForMatch(line)));
    if (!best || d < best.d) best = { line, d };
  }
  if (!best || matchQuote(quote, best.line).level !== 'fuzzy') return null;
  const snapped = snapQuote(quote, best.line);
  return quoteIsExact(snapped, text) ? snapped : null;
}

export function validatePaste(out: PasteOutput, text: string): { errors: string[] } {
  const errors: string[] = [];
  out.items.forEach((item, i) => {
    const n = `第 ${i + 1} 条`;
    if (!placeQuote(item.quote, text)) errors.push(`${n}：quote「${Array.from(item.quote).slice(0, 24).join('')}」在原文里找不到，请从原文逐字复制`);
    for (const p of pasteItemProblems(item)) errors.push(`${n}（${item.kind}）：${p}`);
  });
  return { errors };
}

export interface FinalizedPaste {
  items: PasteItem[];
  /** dropped: quote not found or a field the kind needs is missing */
  dropped: number;
}

export function finalizePaste(out: PasteOutput, text: string): FinalizedPaste {
  const items: PasteItem[] = [];
  let dropped = 0;
  for (const item of out.items) {
    const quote = placeQuote(item.quote, text);
    const slots = item.slots.filter((s) => isCalendarDate(s.date));
    const fixed: PasteItem = { ...item, quote: quote ?? item.quote, slots };
    if (!quote || pasteItemProblems(fixed).length) {
      dropped++;
      continue;
    }
    items.push(fixed);
  }
  return { items, dropped };
}

/** Non-empty lines no item quotes (so a message the model skipped still shows). */
export function uncoveredLines(text: string, quotes: readonly string[]): string[] {
  const qs = quotes.map(normalizeForMatch).filter(Boolean);
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      const n = normalizeForMatch(l);
      return n.length > 0 && !qs.some((q) => n.includes(q) || q.includes(n));
    });
}

/** Local window of a slot: its times, or the whole day when it gives none. */
export function slotTimes(s: Pick<PasteSlot, 'start' | 'end'>): { start: string; end: string } {
  return { start: s.start ?? '00:00', end: s.end ?? (s.start && s.start >= '23:00' ? '23:59' : s.start ? addHours(s.start, 4) : '23:59') };
}

function addHours(t: string, h: number): string {
  const [hh, mm] = t.split(':').map(Number);
  return `${String(Math.min(23, hh! + h)).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
