import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { UsageCurrency, UsageDay, UsagePrice, UsageReport, UsageSourceReport, UsageTotals } from '@storyscript/contracts';
import { actorPhrase } from '../../lib/crew.ts';
import { JOB_KIND_LABEL } from '../../lib/jobs.ts';
import { useSaveUsagePrice, useUsage } from '../../lib/queries-check.ts';
import {
  capLine,
  costCaveat,
  CURRENCY_LABEL,
  estimateCost,
  formatMoney,
  formatTokens,
  parsePrice,
  shortDate,
  USAGE_KIND_LABEL,
  USAGE_SOURCE_LABEL,
  USAGE_SOURCE_LEAD,
} from '../../lib/usage.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, Notice, SelectInput, Spinner, TextInput } from '../../components/ui.tsx';

/**
 * Settings → 用量 (S5): what this project's model calls used, from its job
 * records — today and in all, by day, by kind and (the group's key) by
 * member — with a cost estimate from the unit prices typed here, and on the
 * hosted server how much of the group key's daily cap is left.
 */

export function UsagePanel() {
  const usage = useUsage();
  if (usage.isPending) {
    return (
      <div className="p-3">
        <Spinner label="正在汇总用量…" />
      </div>
    );
  }
  if (usage.isError) {
    return (
      <div className="p-3">
        <ErrorNotice error={usage.error} />
      </div>
    );
  }
  const r = usage.data;
  return (
    <div className="flex flex-col">
      {r.demo ? (
        <div className="px-3 pt-3">
          <Notice tone="info" title="演示模式不计费">
            演示模式回放录好的输出，不外发请求，也不计入这里的用量。
          </Notice>
        </div>
      ) : null}
      {r.caps ? <Caps report={r} /> : null}
      {r.sources.map((s) => (
        <SourceSection key={s.source} report={s} single={r.sources.length === 1} />
      ))}
      <p className="px-3 pt-4 text-xs leading-5 text-graphite-300">
        按这个项目的任务记录汇总，「今天」按项目时区（{r.timezone}）计算。花费是按你填的单价估算的，以服务商的账单为准。
      </p>
    </div>
  );
}

// -------------------------------------------------------------------- caps

function Meter({ ratio, full }: { ratio: number; full: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 100 4" preserveAspectRatio="none" className="h-1 w-full rounded-full">
      <rect x={0} y={0} width={100} height={4} className="fill-graphite-800" />
      <rect x={0} y={0} width={Math.max(0, Math.min(100, ratio * 100))} height={4} className={full ? 'fill-danger' : ratio >= 0.8 ? 'fill-warn' : 'fill-graphite-300'} />
    </svg>
  );
}

function Caps({ report }: { report: UsageReport }) {
  const caps = report.caps!;
  const lanes = [capLine('文本', caps.llm), capLine('图像', caps.image)];
  return (
    <section aria-label="每日上限" className="px-3 pt-4">
      <h3 className="text-sm font-semibold text-graphite-100">本组 key 的每日上限</h3>
      <p className="mt-1 text-xs leading-5 text-graphite-300">滚动 24 小时内用本组的 key 发起的 AI 任务数，防止意外花费；用自己 key 的任务不计入。</p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {lanes.map((l, i) => {
          const lane = i === 0 ? caps.llm : caps.image;
          return (
            <div key={l.text}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-graphite-100 tabular-nums">{l.text}</span>
                <span className="text-xs text-graphite-300 tabular-nums">{l.full ? '已用完' : `还剩 ${lane.remaining} 次`}</span>
              </div>
              <div className="mt-1.5">
                <Meter ratio={l.ratio} full={l.full} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ source

function SourceSection({ report, single }: { report: UsageSourceReport; single: boolean }) {
  const headingId = useId();
  const empty = report.total.jobs === 0;
  return (
    <section aria-labelledby={headingId} className="mt-4 border-t border-graphite-800 pt-4">
      <div className="px-3">
        <h3 id={headingId} className="text-base font-semibold text-graphite-100">
          {single && report.source === 'local' ? '用量' : USAGE_SOURCE_LABEL[report.source]}
        </h3>
        <p className="mt-1 text-xs leading-5 text-graphite-300">{USAGE_SOURCE_LEAD[report.source]}</p>
      </div>
      {empty ? (
        <p className="px-3 pt-3 text-sm text-graphite-300">还没有调用记录。</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-graphite-800 bg-graphite-800 mx-3">
            <Figures label="今天" totals={report.today} price={report.price} />
            <Figures label="累计" totals={report.total} price={report.price} />
          </div>
          {costCaveat(report.total) ? <p className="px-3 pt-2 text-xs text-graphite-300">{costCaveat(report.total)}</p> : null}
          <DayChart days={report.days} />
          <BreakdownTable
            caption="按功能"
            rows={report.by_kind.map((k) => ({ key: k.kind, label: USAGE_KIND_LABEL[k.kind] ?? JOB_KIND_LABEL[k.kind], totals: k.totals }))}
            price={report.price}
          />
          {report.by_member ? (
            <BreakdownTable
              caption="按成员"
              rows={report.by_member.map((m, i) => ({ key: m.actor?.id ?? `none-${i}`, label: m.actor ? (actorPhrase(m.actor) ?? m.actor.name) : '早期记录（没有记下是谁）', totals: m.totals }))}
              price={report.price}
            />
          ) : null}
        </>
      )}
      <PriceForm report={report} />
    </section>
  );
}

function Figures({ label, totals, price }: { label: string; totals: UsageTotals; price: UsagePrice }) {
  const cost = estimateCost(totals, price);
  return (
    <div className="bg-graphite-900 px-3 py-2.5">
      <p className="text-xs text-graphite-300">{label}</p>
      <p className="mt-1 text-lg font-semibold text-graphite-100 tabular-nums">
        {totals.requests} <span className="text-xs font-normal text-graphite-300">次请求</span>
      </p>
      <p className="text-sm text-graphite-100 tabular-nums">
        {formatTokens(totals.total_tokens)} <span className="text-xs text-graphite-300">tokens</span>
        {totals.images > 0 ? <span className="ml-2 text-xs text-graphite-300">{totals.images} 张图</span> : null}
      </p>
      {cost !== null ? <p className="mt-0.5 text-sm text-graphite-100 tabular-nums">约 {formatMoney(cost, price.currency)}</p> : null}
    </div>
  );
}

function DayChart({ days }: { days: readonly UsageDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.total_tokens));
  const peak = days.reduce((a, b) => (b.total_tokens > a.total_tokens ? b : a), days[0]!);
  const requests = days.reduce((n, d) => n + d.requests, 0);
  const W = 14 * 10;
  const H = 40;
  const summary = `最近 14 天共 ${requests} 次请求${peak.total_tokens > 0 ? `，最多的一天是 ${shortDate(peak.date)}（${formatTokens(peak.total_tokens)} tokens）` : ''}`;
  return (
    <figure className="px-3 pt-4">
      <figcaption className="text-xs text-graphite-300">最近 14 天（tokens）</figcaption>
      <svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 block h-16 w-full">
        {days.map((d, i) => {
          const h = d.total_tokens > 0 ? Math.max(1.5, (d.total_tokens / max) * (H - 2)) : 0;
          return (
            <g key={d.date}>
              <title>{`${shortDate(d.date)}：${d.requests} 次请求，${formatTokens(d.total_tokens)} tokens${d.images ? `，${d.images} 张图` : ''}`}</title>
              <rect x={i * 10 + 1} y={0} width={8} height={H} className="fill-transparent" />
              <rect x={i * 10 + 1} y={H - 1} width={8} height={1} className="fill-graphite-800" />
              {h > 0 ? <rect x={i * 10 + 1} y={H - 1 - h} width={8} height={h} className={i === days.length - 1 ? 'fill-graphite-100' : 'fill-graphite-500'} /> : null}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-graphite-300 tabular-nums">
        <span>{shortDate(days[0]!.date)}</span>
        <span>今天</span>
      </div>
    </figure>
  );
}

function BreakdownTable({ caption, rows, price }: { caption: string; rows: { key: string; label: string; totals: UsageTotals }[]; price: UsagePrice }) {
  const priced = rows.some((r) => estimateCost(r.totals, price) !== null);
  if (rows.length === 0) return null;
  return (
    <div className="px-3 pt-4">
      <table className="w-full table-fixed text-sm">
        <caption className="pb-1.5 text-left text-xs text-graphite-300">{caption}</caption>
        <thead>
          <tr className="border-b border-graphite-800 text-xs text-graphite-300">
            <th scope="col" className="py-1 text-left font-normal">
              {caption === '按成员' ? '成员' : '功能'}
            </th>
            <th scope="col" className="w-16 py-1 text-right font-normal">
              请求
            </th>
            <th scope="col" className="w-20 py-1 text-right font-normal">
              tokens
            </th>
            {priced ? (
              <th scope="col" className="w-20 py-1 text-right font-normal">
                估算
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const cost = estimateCost(r.totals, price);
            return (
              <tr key={r.key} className="border-b border-graphite-800/60 last:border-0">
                <th scope="row" className="truncate py-1.5 text-left font-normal text-graphite-100">
                  {r.label}
                </th>
                <td className="py-1.5 text-right text-graphite-100 tabular-nums">{r.totals.requests}</td>
                <td className="py-1.5 text-right text-graphite-100 tabular-nums">
                  {r.totals.total_tokens > 0 ? formatTokens(r.totals.total_tokens) : r.totals.images > 0 ? `${r.totals.images} 张` : '—'}
                </td>
                {priced ? <td className="py-1.5 text-right text-graphite-100 tabular-nums">{cost !== null ? formatMoney(cost, price.currency) : '—'}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------- price

const CURRENCIES: readonly UsageCurrency[] = ['CNY', 'USD'];
const asText = (n: number | null) => (n === null ? '' : String(n));

function PriceForm({ report }: { report: UsageSourceReport }) {
  const save = useSaveUsagePrice();
  const formId = useId();
  const [currency, setCurrency] = useState<UsageCurrency>(report.price.currency);
  const [input, setInput] = useState(asText(report.price.input_per_m));
  const [output, setOutput] = useState(asText(report.price.output_per_m));
  const [image, setImage] = useState(asText(report.price.per_image));
  const [error, setError] = useState<string | null>(null);
  const readOnly = !report.can_edit_price;
  const sign = currency === 'CNY' ? '¥' : '$';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const values = [parsePrice(input), parsePrice(output), parsePrice(image)];
    if (values.some((v) => v === undefined)) {
      setError('单价要填 0 到 10000 之间的数字，不填表示不估算这一项。');
      return;
    }
    setError(null);
    const [input_per_m, output_per_m, per_image] = values as (number | null)[];
    save.mutate({ source: report.source, price: { currency, input_per_m: input_per_m!, output_per_m: output_per_m!, per_image: per_image! } });
  };

  const field = (label: string, value: string, set: (v: string) => void, hint: ReactNode) => (
    <Field label={label} hint={hint}>
      {({ id, describedBy }) => (
        <TextInput
          id={id}
          aria-describedby={describedBy}
          inputMode="decimal"
          value={value}
          onChange={(e) => set(e.target.value)}
          disabled={readOnly || save.isPending}
          placeholder="不估算"
          className="tabular-nums"
        />
      )}
    </Field>
  );

  return (
    <details className="mx-3 mt-4 rounded-panel border border-graphite-800 px-3 py-2" open={!readOnly && report.price.input_per_m === null && report.total.jobs > 0}>
      <summary className="cursor-pointer text-sm text-graphite-100 select-none">单价（用来估算花费）</summary>
      <form id={formId} onSubmit={submit} className="mt-3 grid grid-cols-1 gap-3 pb-2 sm:grid-cols-2" noValidate>
        {readOnly ? (
          <Notice tone="info" title="单价由组长填写" className="sm:col-span-2">
            和本组的模型设置一样，请组长修改。
          </Notice>
        ) : null}
        <Field label="币种">
          {({ id, describedBy }) => (
            <SelectInput id={id} aria-describedby={describedBy} value={currency} onChange={(e) => setCurrency(e.target.value as UsageCurrency)} disabled={readOnly || save.isPending}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {CURRENCY_LABEL[c]}
                </option>
              ))}
            </SelectInput>
          )}
        </Field>
        {field(`输入（${sign} / 百万 tokens）`, input, setInput, '见服务商的价格页')}
        {field(`输出（${sign} / 百万 tokens）`, output, setOutput, '通常比输入贵')}
        {field(`每张图（${sign}）`, image, setImage, 'AI 铅笔重绘用')}
        {error ? <Notice tone="danger" title="单价格式不对" className="sm:col-span-2">{error}</Notice> : null}
        {save.isError ? <ErrorNotice error={save.error} className="sm:col-span-2" /> : null}
        {readOnly ? null : (
          <div className="flex items-center gap-2 sm:col-span-2">
            <Button type="submit" variant="primary" size="sm" busy={save.isPending}>
              保存单价
            </Button>
            {save.isSuccess && !save.isPending ? <span className="text-xs text-graphite-300" role="status">已保存</span> : null}
          </div>
        )}
      </form>
    </details>
  );
}
