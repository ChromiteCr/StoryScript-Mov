import { Fragment, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { CoverageDecisionKind, CoverageResult, MediaAssetView, ShotMediaLink, Take } from '@storyscript/contracts';
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { Button, TextInput } from '../../components/ui.tsx';
import { EmptyState } from '../../components/workspace.tsx';
import { FLAG_LABEL, MISSING_ORDER, MISSING_REASON_HINT, MISSING_REASON_LABEL, REQUIRED_LABEL } from '../../lib/labels-media.ts';
import { useAddCoverageDecision } from '../../lib/queries-media.ts';
import type { ShotRef } from '../set/model.ts';
import { fileName, missingReport, usableChoices } from './model.ts';
import { CoverageBadge, MediaErrorNotice, MiniTag } from './shared.tsx';

/**
 * 覆盖与漏拍 (FR-09): coverage per scene as computed by the server (core
 * computeCoverage, never here), the missing list by its four reasons, and the
 * append-only decisions: usable (pick confirmed, online clips), needs pickup,
 * or revoke — each with a reason.
 */

export interface CoveragePanelProps {
  coverage: readonly CoverageResult[];
  refs: readonly ShotRef[];
  links: readonly ShotMediaLink[];
  assets: ReadonlyMap<string, MediaAssetView>;
  takes: readonly Take[];
}

export function CoveragePanel({ coverage, refs, links, assets, takes }: CoveragePanelProps) {
  const [open, setOpen] = useState<string | null>(null);
  const byShot = useMemo(() => new Map(coverage.map((c) => [c.shot_id, c] as const)), [coverage]);
  const scenes = useMemo(() => {
    const out: { key: string; title: string; heading: string; refs: ShotRef[] }[] = [];
    for (const r of refs) {
      const last = out[out.length - 1];
      if (last && last.key === r.shot.scene_id) last.refs.push(r);
      else out.push({ key: r.shot.scene_id, title: `第 ${r.scene_no} 场`, heading: r.scene_heading, refs: [r] });
    }
    return out;
  }, [refs]);
  const report = useMemo(() => missingReport(coverage, refs), [coverage, refs]);

  if (refs.length === 0) {
    return <EmptyState title="还没有镜头，覆盖状态从镜头表开始。" />;
  }

  return (
    <div className="grid min-h-full grid-cols-1 gap-px bg-graphite-800 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
      <div className="min-w-0 bg-graphite-900">
        <table aria-label="按场的覆盖状态" className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-9" />
            <col className="w-16" />
            <col className="w-24" />
            <col />
          </colgroup>
          {scenes.map((sc) => {
            const usable = sc.refs.filter((r) => byShot.get(r.shot.id)?.status === 'usable').length;
            const required = sc.refs.filter((r) => r.shot.required_status === 'required').length;
            return (
              <tbody key={sc.key}>
                <tr>
                  <th colSpan={4} scope="colgroup" className="sticky top-0 z-10 bg-graphite-900 px-3 pt-2 pb-1 text-left font-normal">
                    <span className="text-xs font-medium text-graphite-100">{sc.title}</span>
                    <span className="ml-2 text-xs text-graphite-300">{sc.heading}</span>
                    <span className="ml-2 text-xs text-graphite-300 tabular-nums">
                      可用 {usable} / 必拍 {required}
                    </span>
                  </th>
                </tr>
                {sc.refs.map((r) => {
                  const c = byShot.get(r.shot.id);
                  const expanded = open === r.shot.id;
                  return (
                    <Fragment key={r.shot.id}>
                      <tr className={`border-t border-graphite-800 ${expanded ? 'bg-graphite-800' : 'hover:bg-graphite-800/50'}`}>
                        <td className="py-1.5 pl-2">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={`${r.label} 覆盖决定`}
                            onClick={() => setOpen(expanded ? null : r.shot.id)}
                            className="inline-flex size-6 items-center justify-center rounded-control text-graphite-300 hover:bg-graphite-700 hover:text-graphite-100"
                          >
                            {expanded ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
                          </button>
                        </td>
                        <td className="py-1.5 text-graphite-100 tabular-nums">{r.label}</td>
                        <td className="py-1.5 pr-2">{c ? <CoverageBadge status={c.status} /> : null}</td>
                        <td className="py-1.5 pr-2">
                          <span className="block truncate text-graphite-100" title={r.shot.fields.action}>
                            {r.shot.required_status !== 'required' ? <span className="mr-1.5 text-xs text-graphite-300">[{REQUIRED_LABEL[r.shot.required_status]}]</span> : null}
                            {r.shot.fields.action}
                          </span>
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-graphite-300 tabular-nums">
                            {c ? `${c.facts.take_count} 条 · ${c.facts.link_count} 关联 · ${c.facts.confirmed_link_count} 确认` : ''}
                            {c?.flags.map((f) => (
                              <MiniTag key={f} icon={TriangleAlert} tone="warn">
                                {FLAG_LABEL[f]}
                              </MiniTag>
                            ))}
                          </span>
                        </td>
                      </tr>
                      {expanded ? (
                        <tr className="bg-graphite-800">
                          <td colSpan={4} className="px-3 pt-1 pb-3">
                            <DecisionForm key={r.shot.id} shotRef={r} result={c ?? null} links={links} assets={assets} takes={takes} onDone={() => setOpen(null)} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </div>

      <div className="min-w-0 bg-graphite-900 p-3">
        <h3 className="text-xs font-medium text-graphite-100">
          漏拍清单 <span className="text-graphite-300 tabular-nums">（{report.total}）</span>
        </h3>
        {report.total === 0 ? <p className="mt-2 text-sm text-graphite-300">必拍镜头都已判定可用或免拍。</p> : null}
        <div className="mt-2 flex flex-col gap-3">
          {MISSING_ORDER.map((reason) =>
            report.byReason[reason].length > 0 ? (
              <section key={reason} aria-label={MISSING_REASON_LABEL[reason]}>
                <h4 className="text-xs text-graphite-100">
                  {MISSING_REASON_LABEL[reason]} <span className="text-graphite-300 tabular-nums">{report.byReason[reason].length}</span>
                </h4>
                <p className="text-xs text-graphite-300">{MISSING_REASON_HINT[reason]}</p>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {report.byReason[reason].map(({ ref, result }) => (
                    <li key={ref.shot.id}>
                      <button
                        type="button"
                        onClick={() => setOpen(ref.shot.id)}
                        title={ref.shot.fields.action}
                        className="inline-flex h-6 items-center gap-1 rounded-control border border-graphite-700 px-1.5 text-xs text-graphite-100 tabular-nums hover:border-graphite-500"
                      >
                        {ref.label}
                        {result.status === 'needs_pickup' ? <span className="text-graphite-300">补拍</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}
          {report.notCounted.length > 0 ? (
            <section aria-label="可选与免拍">
              <h4 className="text-xs text-graphite-100">
                可选与免拍（不算漏拍） <span className="text-graphite-300 tabular-nums">{report.notCounted.length}</span>
              </h4>
              <ul className="mt-1 flex flex-wrap gap-1">
                {report.notCounted.map(({ ref, result }) => (
                  <li key={ref.shot.id} className="inline-flex h-6 items-center gap-1 rounded-control border border-dashed border-graphite-700 px-1.5 text-xs text-graphite-300 tabular-nums">
                    {ref.label}
                    <span>{REQUIRED_LABEL[result.required_status]}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const DECISIONS: readonly { id: CoverageDecisionKind; label: string; hint: string }[] = [
  { id: 'usable', label: '设为可用', hint: '选定已确认、原片在线的片段' },
  { id: 'needs_pickup', label: '需要补拍', hint: '记入漏拍清单' },
  { id: 'clear', label: '撤销决定', hint: '回到按事实计算的状态' },
];

function DecisionForm({
  shotRef,
  result,
  links,
  assets,
  takes,
  onDone,
}: {
  shotRef: ShotRef;
  result: CoverageResult | null;
  links: readonly ShotMediaLink[];
  assets: ReadonlyMap<string, MediaAssetView>;
  takes: readonly Take[];
  onDone: () => void;
}) {
  const add = useAddCoverageDecision();
  const id = useId();
  const [kind, setKind] = useState<CoverageDecisionKind>('usable');
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const choices = usableChoices(shotRef.shot.id, links, assets);
  const formRef = useRef<HTMLFormElement>(null);
  // bring the form into view with its shot row (scroll-mt covers the row and the sticky scene header)
  useEffect(() => {
    formRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (kind === 'usable' && picked.length === 0) return setError('至少选一个片段');
    if (reason.trim() === '') return setError('请写明原因：决定只追加、不修改，原因会一直留着');
    setError(null);
    add.mutate(
      { shotId: shotRef.shot.id, input: { decision: kind, selected_link_ids: kind === 'usable' ? picked : [], reason: reason.trim() } },
      { onSuccess: onDone },
    );
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="flex scroll-mt-20 scroll-mb-2 flex-col gap-2.5" aria-label={`${shotRef.label} 覆盖决定`}>
      <div role="radiogroup" aria-label="决定" className="flex flex-wrap gap-1">
        {DECISIONS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={kind === d.id}
            title={d.hint}
            onClick={() => setKind(d.id)}
            className={
              'h-7 rounded-control border px-2.5 text-sm ' +
              (kind === d.id ? 'border-graphite-100 bg-graphite-100 font-medium text-graphite-950' : 'border-graphite-700 bg-graphite-900 text-graphite-100 hover:border-graphite-500')
            }
          >
            {d.label}
          </button>
        ))}
      </div>
      {kind === 'usable' ? (
        choices.length === 0 ? (
          <p className="text-sm text-graphite-300">
            还没有可选的片段：先在候选审核或检查器里确认关联；原片要在线，片段区间要精确。
            {result?.facts.link_count ? `（现有 ${result.facts.link_count} 条关联，${result.facts.confirmed_link_count} 条已确认）` : ''}
          </p>
        ) : (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs text-graphite-300">可用片段</legend>
            {choices.map((l) => {
              const take = takes.find((t) => t.id === l.take_id);
              const a = assets.get(l.media_asset_id);
              return (
                <label key={l.id} className="flex items-center gap-2 text-sm text-graphite-100">
                  <input
                    type="checkbox"
                    className="size-3.5"
                    checked={picked.includes(l.id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id)))}
                  />
                  <span className="truncate">{a ? fileName(a.rel_path) : l.media_asset_id}</span>
                  {take ? <span className="text-xs text-graphite-300 tabular-nums">T{String(take.take_no).padStart(2, '0')}</span> : null}
                </label>
              );
            })}
          </fieldset>
        )
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-reason`} className="text-xs font-medium text-graphite-100">
          原因（必填）
        </label>
        <TextInput id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'needs_pickup' ? '如：穿帮，需要补拍' : '如：焦点准，表演可用'} />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-graphite-100">
          {error}
        </p>
      ) : null}
      {add.isError ? <MediaErrorNotice error={add.error} /> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" busy={add.isPending} disabled={kind === 'usable' && choices.length === 0}>
          记录决定
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
    </form>
  );
}
