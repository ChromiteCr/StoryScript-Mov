import type { JobKind, QuotaLane, UsageCurrency, UsagePrice, UsageSource, UsageTotals } from '@storyscript/contracts';

/**
 * S5 用量看板: labels, number formats and the cost estimate (tokens × the
 * unit prices the group typed in; the provider's bill is what counts). Pure.
 */

export const USAGE_SOURCE_LABEL: Record<UsageSource, string> = { local: '本机的模型', group: '本组的 key', own: '我的 key' };

export const USAGE_SOURCE_LEAD: Record<UsageSource, string> = {
  local: '这个项目里所有发给模型服务的请求。',
  group: '全组用组长配置的 key 发出的请求，所有组员都能看到。',
  own: '你用自己的 key 发出的请求，只有你看得到。',
};

/** Kinds that call a paid model, in the order the table lists them when tied. */
export const USAGE_KIND_LABEL: Partial<Record<JobKind, string>> = {
  breakdown_scene: 'AI 拆镜',
  polish_shots: 'AI 润色',
  check_script: '剧本体检',
  organize_paste: '粘贴整理',
  research_style: '风格研究',
  extract_entities: '抽取角色地点道具',
  suggest_order: '排序建议',
  image_redraw: 'AI 铅笔重绘',
};

export const CURRENCY_SIGN: Record<UsageCurrency, string> = { CNY: '¥', USD: '$' };
export const CURRENCY_LABEL: Record<UsageCurrency, string> = { CNY: '人民币', USD: '美元' };

/** 1234 → "1,234"; 123456 → "12.3 万"; 0 → "0" */
export function formatTokens(n: number): string {
  if (n >= 100_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')} 万`;
  return Math.round(n).toLocaleString('zh-CN');
}

/** Estimated spend, or null when no price that matters is set. */
export function estimateCost(t: Pick<UsageTotals, 'prompt_tokens' | 'completion_tokens' | 'images'>, price: UsagePrice): number | null {
  const parts: number[] = [];
  if (price.input_per_m !== null && t.prompt_tokens > 0) parts.push((t.prompt_tokens / 1_000_000) * price.input_per_m);
  if (price.output_per_m !== null && t.completion_tokens > 0) parts.push((t.completion_tokens / 1_000_000) * price.output_per_m);
  if (price.per_image !== null && t.images > 0) parts.push(t.images * price.per_image);
  const priced = price.input_per_m !== null || price.output_per_m !== null || price.per_image !== null;
  if (!priced) return null;
  return parts.reduce((a, b) => a + b, 0);
}

/** ¥0.42, ¥12.30, $0.0031 (tiny amounts keep two significant digits) */
export function formatMoney(n: number, currency: UsageCurrency): string {
  const sign = CURRENCY_SIGN[currency];
  if (n === 0) return `${sign}0`;
  if (n < 0.01) return `${sign}${n.toPrecision(2)}`;
  return `${sign}${n.toFixed(2)}`;
}

/** Whether the cost may be higher than estimated: requests without usage, or results unknown. */
export function costCaveat(t: Pick<UsageTotals, 'unknown_calls' | 'outcome_unknown'>): string | null {
  const parts: string[] = [];
  if (t.unknown_calls > 0) parts.push(`${t.unknown_calls} 次请求服务没有返回用量`);
  if (t.outcome_unknown > 0) parts.push(`${t.outcome_unknown} 个任务结果未知`);
  return parts.length ? `${parts.join('，')}，可能另有费用。` : null;
}

/** 「文本 37/200」 and how full the lane is (0–1). */
export function capLine(label: string, lane: QuotaLane): { text: string; ratio: number; full: boolean } {
  return { text: `${label} ${lane.used}/${lane.limit}`, ratio: lane.limit > 0 ? Math.min(1, lane.used / lane.limit) : 1, full: lane.remaining === 0 };
}

/** A price field: "" → null, otherwise a number in 0…10000 (else undefined: invalid). */
export function parsePrice(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : undefined;
}

/** 「10月7日」 from YYYY-MM-DD */
export function shortDate(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}月${Number(d)}日`;
}
