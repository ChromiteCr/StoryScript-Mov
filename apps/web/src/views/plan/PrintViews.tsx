import { useId, useMemo, useState } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import type { PlanDetail } from '@storyscript/contracts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button } from '../../components/ui.tsx';
import { PaperCanvas } from '../../components/workspace.tsx';
import { OUTCOME, UNPLACED_TEXT, approvalState } from '../../lib/labels-plan.ts';
import { callSheetRows, isIdle, localTime, shotsInShootingOrder, slateCards, type PlanLookup } from '../../lib/print-plan.ts';
import { useShotTips } from '../../lib/queries-tips.ts';
import { tipsAppendix, tipsByShot } from '../../lib/tips.ts';
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

/**
 * S5c 附拍摄提示: after the call sheet, the model's tips for the plan's shots
 * in the order the call sheet shoots them. Shots with only the first guess
 * (no model tips) are left out and counted under the table.
 */
export function TipsAppendixSheet({ detail, lookup }: { detail: PlanDetail; lookup: PlanLookup }) {
  const view = useShotTips();
  const titleId = useId();
  const appendix = useMemo(() => tipsAppendix(shotsInShootingOrder(detail.plan), lookup, tipsByShot(view.data)), [detail.plan, lookup, view.data]);
  const { rows, without } = appendix;
  return (
    <section aria-labelledby={titleId} className="mt-8 border-t border-ink/30 pt-3">
      <h3 id={titleId} className="text-base font-medium text-ink break-after-avoid">
        附：拍摄提示
      </h3>
      <p className="text-xs text-ink/75 break-after-avoid">按拍摄顺序；提示由 AI 按镜头字段生成，只作参考。</p>
      {view.isPending ? (
        <p className="py-3 text-sm text-ink/75 print:hidden">正在读取拍摄提示…</p>
      ) : view.isError ? (
        <div className="py-3 print:hidden">
          <ErrorNotice error={view.error} />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-3 text-sm text-ink/75">计划里的镜头还没有 AI 拍摄提示。可以在剧本页的镜头编辑器里按场生成。</p>
      ) : (
        <div className="-mx-1 mt-2 overflow-x-auto px-1 print:overflow-visible">
          <table className="w-full min-w-[560px] border-collapse text-sm text-ink print:min-w-0">
            <thead>
              <tr className="border-b border-ink/40 text-left text-xs text-ink/75">
                <th scope="col" className="py-1.5 pr-3 font-medium whitespace-nowrap">
                  镜号
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium whitespace-nowrap">
                  难度
                </th>
                <th scope="col" className="w-[7.5rem] py-1.5 pr-3 font-medium">
                  器材
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  提示
                </th>
                <th scope="col" className="w-[26%] py-1.5 font-medium">
                  常见失误
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.shot_id} className="break-inside-avoid border-b border-ink/15 align-top">
                  <td className="py-1.5 pr-3 tabular-nums">
                    <span className="whitespace-nowrap">{r.ref}</span>
                    {r.stale ? (
                      <span className="block text-xs whitespace-nowrap text-ink/60" title="镜头改过，提示可能过时">
                        可能过时
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{r.difficulty}</td>
                  <td className="py-1.5 pr-3">{r.gear}</td>
                  <td className="py-1.5 pr-3">
                    <ol className="list-decimal pl-4">
                      {r.tips.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ol>
                  </td>
                  <td className="py-1.5">{r.mistake}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {without > 0 && rows.length > 0 ? <p className="mt-2 text-xs text-ink/60">另有 {without} 个镜头还没有 AI 拍摄提示，未列出。</p> : null}
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
  // S5c: off by default; the appendix prints after the call sheet
  const [withTips, setWithTips] = useState(false);
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
        <span className="ml-auto flex items-center gap-3">
          {mode === 'callsheet' ? (
            <label className="flex items-center gap-1.5 text-xs text-graphite-100" title="在拍摄单后面按拍摄顺序附上每个镜头的难度、器材、实拍提示和常见失误">
              <input type="checkbox" checked={withTips} onChange={(e) => setWithTips(e.target.checked)} className="size-3.5 accent-graphite-100" />
              附拍摄提示
            </label>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => window.print()}>
            <Printer aria-hidden className="size-3.5" />
            打印
          </Button>
        </span>
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
              {withTips ? <TipsAppendixSheet detail={detail} lookup={lookup} /> : null}
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
