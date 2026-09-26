import type { CoverageResult } from '@storyscript/contracts';
import { PaperCanvas } from '../../components/workspace.tsx';
import { FLAG_LABEL, MISSING_ORDER, MISSING_REASON_HINT, MISSING_REASON_LABEL, REQUIRED_LABEL } from '../../lib/labels-media.ts';
import type { ShotRef } from '../set/model.ts';
import { missingReport } from './model.ts';

/**
 * 漏拍报告 for the browser's print dialog (FR-10: PDF via print CSS). Hidden on
 * screen; in print only the main area remains, so this sheet is the page.
 */
export function MissingReportPrint({ project, coverage, refs }: { project: string; coverage: readonly CoverageResult[]; refs: readonly ShotRef[] }) {
  const report = missingReport(coverage, refs);
  const printed = new Date().toLocaleString('zh-CN', { hour12: false });
  return (
    <div className="hidden print:block">
      <PaperCanvas variant="fill" label="漏拍报告">
        <h1 className="text-xl font-medium">{project} · 漏拍报告</h1>
        <p className="mt-1 text-sm">
          打印时间 {printed}。必拍镜头中尚未判定可用的共 {report.total} 个；可选与免拍镜头不计入。
        </p>
        {MISSING_ORDER.map((reason) => (
          <section key={reason} className="mt-5 break-inside-avoid-page">
            <h2 className="border-b border-ink/40 pb-1 text-base font-medium">
              {MISSING_REASON_LABEL[reason]}（{report.byReason[reason].length}）
            </h2>
            <p className="mt-1 text-xs">{MISSING_REASON_HINT[reason]}</p>
            {report.byReason[reason].length === 0 ? (
              <p className="mt-1 text-sm">无</p>
            ) : (
              <table className="mt-2 w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs">
                    <th className="w-20 py-1 font-medium">镜号</th>
                    <th className="py-1 font-medium">内容</th>
                    <th className="w-28 py-1 font-medium">条次 / 关联</th>
                    <th className="w-8 py-1 font-medium">✓</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byReason[reason].map(({ ref, result }) => (
                    <tr key={ref.shot.id} className="border-t border-ink/20 align-top">
                      <td className="py-1 tabular-nums">{ref.label}</td>
                      <td className="py-1">
                        {ref.shot.fields.action}
                        {result.flags.length > 0 ? <span className="ml-1 text-xs">（{result.flags.map((f) => FLAG_LABEL[f]).join('、')}）</span> : null}
                        {result.status === 'needs_pickup' ? <span className="ml-1 text-xs">（已决定补拍）</span> : null}
                      </td>
                      <td className="py-1 tabular-nums">
                        {result.facts.take_count} / {result.facts.link_count}
                      </td>
                      <td className="py-1">
                        <span aria-hidden className="inline-block size-3 border border-ink/60" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
        {report.notCounted.length > 0 ? (
          <section className="mt-5 break-inside-avoid-page">
            <h2 className="border-b border-ink/40 pb-1 text-base font-medium">可选与免拍（不计入漏拍）</h2>
            <p className="mt-1 text-sm">{report.notCounted.map(({ ref, result }) => `${ref.label}（${REQUIRED_LABEL[result.required_status]}）`).join('、')}</p>
          </section>
        ) : null}
      </PaperCanvas>
    </div>
  );
}
