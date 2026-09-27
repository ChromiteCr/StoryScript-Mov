import { ArrowLeft, Printer } from 'lucide-react';
import type { PlanDetail } from '@storyscript/contracts';
import { Button } from '../../components/ui.tsx';
import { PaperCanvas } from '../../components/workspace.tsx';
import { OUTCOME, UNPLACED_TEXT, approvalState } from '../../lib/labels-plan.ts';
import { callSheetRows, isIdle, localTime, slateCards, type PlanLookup } from '../../lib/print-plan.ts';
import type { PlanData } from './data.ts';

/**
 * Paper content of the plan page: the call sheet (on screen and printed)
 * and the slate cards. Printing is the browser's (FR-10): paper turns white
 * with black ink; an unapproved or no-longer-valid plan is marked 草案.
 */

export type PrintMode = 'callsheet' | 'slates';

function DraftMark({ detail }: { detail: PlanDetail }) {
  const s = approvalState(detail.plan.status, detail.stale);
  const draft = s.label !== '已批准';
  return (
    <span
      className={
        'inline-flex h-7 shrink-0 items-center rounded-control border-2 px-2.5 text-sm font-medium tracking-widest ' +
        (draft ? 'border-ink text-ink' : 'border-ink/40 text-ink/75')
      }
    >
      {draft ? (s.label === '已失效' ? '草案 · 批准已失效' : '草案') : '已批准'}
    </span>
  );
}

export function CallSheetHeader({ data, detail, crew }: { data: PlanData; detail: PlanDetail; crew: string }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink/30 pb-3">
      <div className="min-w-0">
        <p className="text-xs text-ink/75">{data.project.name}</p>
        <h2 className="text-xl font-medium text-ink">拍摄单 · {detail.plan.date}</h2>
        <p className="text-sm text-ink/75 tabular-nums">
          开工 {crew} · {detail.plan.timezone}
        </p>
      </div>
      <DraftMark detail={detail} />
    </header>
  );
}

export function CallSheetTable({ detail, lookup }: { detail: PlanDetail; lookup: PlanLookup }) {
  const rows = callSheetRows(detail.plan, lookup);
  if (rows.length === 0) {
    return <p className="py-6 text-sm text-ink/75">这个计划没有排入任何块。</p>;
  }
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[560px] border-collapse text-sm text-ink">
        <thead>
          <tr className="border-b border-ink/40 text-left text-xs text-ink/75">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              时间
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              类型
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              setup
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              镜头
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              演员
            </th>
            <th scope="col" className="py-1.5 font-medium">
              场地
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) =>
            isIdle(r) ? (
              <tr key={`idle-${i}`} className="border-b border-ink/10 text-xs text-ink/60">
                <td className="py-1 pr-3 whitespace-nowrap tabular-nums">
                  {r.start}–{r.end}
                </td>
                <td colSpan={5} className="py-1">
                  空闲 {r.minutes} 分钟
                </td>
              </tr>
            ) : (
              <tr key={r.block_id} className={`border-b border-ink/15 align-top ${r.kind === 'shoot' ? '' : 'text-ink/75'}`}>
                <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">
                  {r.start}–{r.end}
                  <span className="ml-1 text-xs text-ink/60">{r.minutes}′</span>
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{r.kind_label}</td>
                <td className="py-1.5 pr-3">{r.setup}</td>
                <td className="py-1.5 pr-3 tabular-nums">{r.shots || '—'}</td>
                <td className="py-1.5 pr-3">{r.performers || '—'}</td>
                <td className="py-1.5">{[r.location, r.equipment].filter(Boolean).join('；') || '—'}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

export function UnplacedList({ detail, lookup }: { detail: PlanDetail; lookup: PlanLookup }) {
  const list = detail.plan.result.unplaced;
  if (list.length === 0) return null;
  return (
    <section className="mt-4">
      <h3 className="text-sm font-medium text-ink">未排入（{list.length}）</h3>
      <ul className="mt-1 list-disc pl-5 text-sm text-ink">
        {list.map((u) => (
          <li key={u.setup_id}>
            {lookup.setups.get(u.setup_id)?.label ?? '（已删除的 setup）'}：{UNPLACED_TEXT[u.code]}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SlateCardsSheet({ data, detail, lookup }: { data: PlanData; detail: PlanDetail; lookup: PlanLookup }) {
  const cards = slateCards(detail.plan, lookup, data.project.code_format);
  if (cards.length === 0) return <p className="text-sm text-ink/75">计划里没有排入的镜头，没有可打印的打板卡。</p>;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 print:grid-cols-2">
      {cards.map((c) => (
        <article key={c.shot_id} className="flex break-inside-avoid flex-col gap-2 rounded-paper border-2 border-ink p-3 text-ink">
          <div className="flex items-baseline justify-between gap-2 text-xs text-ink/75">
            <span className="truncate">{data.project.name}</span>
            <span className="tabular-nums">{detail.plan.date}</span>
          </div>
          <dl className="grid grid-cols-3 border-y border-ink/40 text-center">
            {[
              ['场', c.scene],
              ['镜', c.shot],
              ['条', ''],
            ].map(([k, v], i) => (
              <div key={k} className={`py-1.5 ${i > 0 ? 'border-l border-ink/40' : ''}`}>
                <dt className="text-xs text-ink/75">{k}</dt>
                <dd className="h-9 text-2xl leading-9 font-medium tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="font-mono text-lg tracking-wide">{c.code ?? `${c.scene}-${c.shot}`}</p>
          <p className="truncate text-xs text-ink/75">
            {c.setup}
            {c.description ? ` · ${c.description}` : ''}
          </p>
          <div className="grid grid-cols-2 gap-3 text-xs text-ink/75">
            <span className="border-b border-ink/40 pb-0.5">机位</span>
            <span className="border-b border-ink/40 pb-0.5">卷号</span>
          </div>
        </article>
      ))}
    </div>
  );
}

export function PrintPreview({
  mode,
  data,
  detail,
  lookup,
  crew,
  onBack,
  backLabel = '返回计划',
}: {
  mode: PrintMode;
  data: PlanData;
  detail: PlanDetail;
  lookup: PlanLookup;
  crew: string;
  onBack: () => void;
  /** where the back button goes (the deliver page opens the same preview) */
  backLabel?: string;
}) {
  const title = mode === 'callsheet' ? '拍摄单' : '打板卡';
  return (
    <div className="flex min-h-full flex-col gap-1 p-1 print:block print:p-0">
      <div className="flex flex-wrap items-center gap-2 rounded-panel bg-graphite-900 px-2 py-1.5 print:hidden">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-3.5" />
          {backLabel}
        </Button>
        <h1 className="text-sm font-medium text-graphite-100">
          {title}打印预览 · {detail.plan.date}
        </h1>
        <p className="min-w-0 text-xs text-graphite-300">用浏览器打印；需要 PDF 时在打印对话框里选"存储为 PDF"。</p>
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => window.print()}>
          <Printer aria-hidden className="size-3.5" />
          打印
        </Button>
      </div>
      <div className="mx-auto w-full max-w-[860px] print:max-w-none">
        <PaperCanvas variant="fill" label={`${title}（打印预览）`}>
          {mode === 'callsheet' ? (
            <>
              <CallSheetHeader data={data} detail={detail} crew={crew} />
              <div className="mt-3">
                <CallSheetTable detail={detail} lookup={lookup} />
              </div>
              <UnplacedList detail={detail} lookup={lookup} />
              <p className="mt-6 text-xs text-ink/60">
                修订 r{detail.plan.revision} · 结果：{OUTCOME[detail.plan.result.outcome].label} · 生成于 {localTime(detail.plan.updated_at, detail.plan.timezone, detail.plan.date)}
              </p>
            </>
          ) : (
            <>
              <header className="mb-3 flex items-start justify-between gap-3 border-b border-ink/30 pb-2">
                <div>
                  <p className="text-xs text-ink/75">{data.project.name}</p>
                  <h2 className="text-xl font-medium text-ink">打板卡 · {detail.plan.date}</h2>
                  <p className="text-xs text-ink/75">按拍摄顺序，每镜一张；条次现场手填。编号格式：{data.project.code_format}</p>
                </div>
                <DraftMark detail={detail} />
              </header>
              <SlateCardsSheet data={data} detail={detail} lookup={lookup} />
            </>
          )}
        </PaperCanvas>
      </div>
    </div>
  );
}
