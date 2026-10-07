import { join } from 'node:path';
import {
  EMPTY_USAGE_PRICE,
  UsagePrice,
  type JobKind,
  type SaveUsagePriceInput,
  type UsageDay,
  type UsageReport,
  type UsageSource,
  type UsageSourceReport,
  type UsageTotals,
} from '@storyscript/contracts';
import { actorId, actorResolver } from '../collab/actor.ts';
import { canEditGroupModel, groupModelDir, ownModelDir, requireLeader } from '../collab/models.ts';
import { readJsonFile, writeJsonFile } from '../config/paths.ts';
import type { DbPort } from '../db/port.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { quotaUsage } from './quota.ts';

/**
 * S5 用量看板: totals of the project's paid model calls from its job rows
 * (remote jobs only, so --demo adds nothing), today (in the project's time
 * zone) and in all, per job kind, per day for two weeks and, for the group's
 * key, per member. On the hosted server the member's own key is reported
 * apart and to that member only. Unit prices for the estimate sit next to the
 * model settings they belong to (usage-price.json): the local settings
 * folder, the group's (the leader edits it) or the member's own.
 */

export const USAGE_DAYS = 14;
const PRICE_FILE = 'usage-price.json';

interface JobUsageRow {
  kind: JobKind;
  status: string;
  attempts: number;
  usage_json: string | null;
  created_at: string;
  actor_id: string | null;
  model_source: string | null;
}

const zero = (): UsageTotals => ({
  jobs: 0,
  requests: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  unknown_calls: 0,
  outcome_unknown: 0,
  images: 0,
});

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Add one job to the totals. Text jobs record prompt/completion tokens; image services report input/output. */
function add(t: UsageTotals, r: JobUsageRow): void {
  let usage: Record<string, unknown> | null = null;
  try {
    usage = r.usage_json ? (JSON.parse(r.usage_json) as Record<string, unknown>) : null;
  } catch {
    usage = null;
  }
  const attempts = Math.max(0, Math.trunc(r.attempts));
  t.jobs += 1;
  t.requests += attempts;
  if (usage) {
    const prompt = num(usage.prompt_tokens) || num(usage.input_tokens);
    const completion = num(usage.completion_tokens) || num(usage.output_tokens);
    t.prompt_tokens += prompt;
    t.completion_tokens += completion;
    t.total_tokens += num(usage.total_tokens) || prompt + completion;
    t.unknown_calls += num(usage.unknown_calls);
  } else if (attempts > 0 && r.kind !== 'image_redraw' && r.status === 'succeeded') {
    t.unknown_calls += attempts;
  }
  if (r.status === 'outcome_unknown') t.outcome_unknown += 1;
  if (r.kind === 'image_redraw' && r.status === 'succeeded') t.images += 1;
}

/** YYYY-MM-DD of an instant in a time zone (UTC if the zone is unknown). */
export function localDate(iso: string | number, timeZone: string): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The last `n` local dates up to `today`, oldest first. */
export function lastDates(today: string, n: number): string[] {
  const base = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(base - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

function sourceReport(
  db: DbPort,
  source: UsageSource,
  rows: readonly JobUsageRow[],
  o: { timeZone: string; today: string; perMember: boolean; price: UsagePrice; canEdit: boolean },
): UsageSourceReport {
  const today = zero();
  const total = zero();
  const byKind = new Map<JobKind, UsageTotals>();
  const byMember = new Map<string | null, UsageTotals>();
  const dates = lastDates(o.today, USAGE_DAYS);
  const days = new Map<string, UsageDay>(dates.map((date) => [date, { date, requests: 0, total_tokens: 0, images: 0 }]));
  for (const r of rows) {
    const date = localDate(r.created_at, o.timeZone);
    add(total, r);
    if (date === o.today) add(today, r);
    if (!byKind.has(r.kind)) byKind.set(r.kind, zero());
    add(byKind.get(r.kind)!, r);
    if (o.perMember) {
      if (!byMember.has(r.actor_id)) byMember.set(r.actor_id, zero());
      add(byMember.get(r.actor_id)!, r);
    }
    const day = days.get(date);
    if (day) {
      const one = zero();
      add(one, r);
      day.requests += one.requests;
      day.total_tokens += one.total_tokens;
      day.images += one.images;
    }
  }
  const heavier = (a: UsageTotals, b: UsageTotals) => b.total_tokens - a.total_tokens || b.requests - a.requests || b.images - a.images;
  const who = actorResolver(db);
  return {
    source,
    today,
    total,
    by_kind: [...byKind].map(([kind, totals]) => ({ kind, totals })).sort((a, b) => heavier(a.totals, b.totals)),
    by_member: o.perMember ? [...byMember].map(([id, totals]) => ({ actor: who(id), totals })).sort((a, b) => heavier(a.totals, b.totals)) : null,
    days: [...days.values()],
    price: o.price,
    can_edit_price: o.canEdit,
  };
}

function priceDir(deps: AppDeps, source: UsageSource): string | null {
  if (source === 'own') return deps.hosted ? (ownModelDir()?.dir ?? null) : null;
  if (source === 'group') return deps.hosted ? groupModelDir(deps).dir : null;
  return deps.hosted ? null : groupModelDir(deps).dir;
}

export function readUsagePrice(dir: string | null): UsagePrice {
  return (dir ? readJsonFile(join(dir, PRICE_FILE), UsagePrice) : null) ?? EMPTY_USAGE_PRICE;
}

export function usageReport(deps: AppDeps, now: number = Date.now()): UsageReport {
  const project = deps.projectSession.require();
  const db = project.db;
  const timeZone = project.project().timezone;
  const today = localDate(now, timeZone);
  const rows = db.all<JobUsageRow>('SELECT kind, status, attempts, usage_json, created_at, actor_id, model_source FROM job WHERE remote = 1 ORDER BY created_at');
  const base = { timeZone, today };
  const sources: UsageSourceReport[] = [];
  if (!deps.hosted) {
    sources.push(sourceReport(db, 'local', rows, { ...base, perMember: false, price: readUsagePrice(priceDir(deps, 'local')), canEdit: true }));
  } else {
    // jobs from before S4 carry no source: they used the group's key
    const groupRows = rows.filter((r) => r.model_source !== 'own');
    sources.push(sourceReport(db, 'group', groupRows, { ...base, perMember: true, price: readUsagePrice(priceDir(deps, 'group')), canEdit: canEditGroupModel(deps) }));
    const me = actorId();
    if (me) {
      const mine = rows.filter((r) => r.model_source === 'own' && r.actor_id === me);
      sources.push(sourceReport(db, 'own', mine, { ...base, perMember: false, price: readUsagePrice(priceDir(deps, 'own')), canEdit: true }));
    }
  }
  const llm = quotaUsage(deps, db, 'llm', now);
  const image = quotaUsage(deps, db, 'image', now);
  return {
    timezone: timeZone,
    today,
    generated_at: new Date(now).toISOString(),
    sources,
    caps: llm && image ? { llm, image } : null,
    demo: Boolean(deps.demo),
  };
}

export function saveUsagePrice(deps: AppDeps, input: SaveUsagePriceInput): UsagePrice {
  const dir = priceDir(deps, input.source);
  if (!dir) {
    const why = input.source === 'local' ? '服务器版按「组的 key / 我的 key」分别设置单价' : '本机版只有一份单价';
    throw new AppError('VALIDATION_ERROR', why, 400, { source: input.source });
  }
  if (input.source === 'group') requireLeader(deps);
  const price = UsagePrice.parse(input.price);
  writeJsonFile(join(dir, PRICE_FILE), price, 0o600);
  return price;
}
