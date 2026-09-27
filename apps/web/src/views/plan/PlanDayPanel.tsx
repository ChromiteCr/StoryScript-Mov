import { useEffect, useState } from 'react';
import { CalendarPlus, Check, Download, RefreshCw, Sparkles } from 'lucide-react';
import type { HealthInfo, PlanDetail } from '@storyscript/contracts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, Spinner } from '../../components/ui.tsx';
import { EmptyState, PaperCanvas, Panel } from '../../components/workspace.tsx';
import { isApiClientError } from '../../lib/api.ts';
import { JOB_STATUS_LABEL } from '../../lib/jobs.ts';
import { OUTCOME, PLAN_ERROR_COPY, UNPLACED_TEXT, approvalState, blockerLines, contradictionText } from '../../lib/labels-plan.ts';
import { callSheetCsv, exportFileName, takeLogCsv, type PlanLookup } from '../../lib/print-plan.ts';
import { useDraft, useJob, usePlanWrite, useProviders, useSuggestOrder, type PlanWrite } from '../../lib/queries-plan.ts';
import { CheckRow, MenuButton, MenuItem, Modal, StatusPill } from './controls.tsx';
import type { PlanData } from './data.ts';
import { CallSheetHeader, CallSheetTable, UnplacedList, type PrintMode } from './PrintViews.tsx';

/**
 * Main area: one shooting day. Status (outcome + approval), the stale
 * banner, AI order suggestion, reasons, and the call sheet on paper.
 * Approve is enabled only when the server says approval.ok (INV-05).
 */

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PlanDayPanel({
  data,
  detail,
  lookup,
  crew,
  health,
  onPrint,
  onNewPlan,
}: {
  data: PlanData;
  detail: PlanDetail | null;
  lookup: PlanLookup | null;
  crew: string;
  health: HealthInfo | undefined;
  onPrint: (mode: PrintMode) => void;
  onNewPlan: () => void;
}) {
  if (!detail || !lookup) {
    return (
      <Panel title="拍摄日">
        <EmptyState
          icon={CalendarPlus}
          title="还没有拍摄日计划。"
          description={
            data.setups.length === 0
              ? '先在左侧把镜头自动分组成 setup，再选日期和开工、收工时间。'
              : '选日期和开工、收工时间，按资源和约束排出当天的拍摄顺序。'
          }
          action={
            <Button onClick={onNewPlan}>
              <CalendarPlus aria-hidden className="size-3.5" />
              新建计划
            </Button>
          }
        />
      </Panel>
    );
  }
  return <DayBody data={data} detail={detail} lookup={lookup} crew={crew} health={health} onPrint={onPrint} />;
}

function DayBody({
  data,
  detail,
  lookup,
  crew,
  health,
  onPrint,
}: {
  data: PlanData;
  detail: PlanDetail;
  lookup: PlanLookup;
  crew: string;
  health: HealthInfo | undefined;
  onPrint: (mode: PrintMode) => void;
}) {
  const write = usePlanWrite();
  const [bom, setBom] = useState(true);
  const { plan, stale, approval } = detail;
  const outcome = OUTCOME[plan.result.outcome];
  const state = approvalState(plan.status, stale);
  const aiReady = Boolean(health && (health.text_provider_configured || health.demo));
  const suggestion = useSuggestionState(plan.id);

  const recompute = () => write.mutate({ kind: 'recompute', id: plan.id, revision: plan.revision });

  return (
    <Panel title={`拍摄日 · ${plan.date}`} padded={false}>
      <div className="flex flex-col print:block">
        <div className="flex flex-wrap items-center gap-2 border-b border-graphite-800 px-3 py-2 print:hidden">
          <Button size="sm" onClick={recompute} busy={write.isPending && write.variables?.kind === 'recompute'}>
            <RefreshCw aria-hidden className="size-3.5" />
            重新计算
          </Button>
          <Button
            size="sm"
            disabled={!aiReady || suggestion.busy}
            busy={suggestion.busy}
            title={aiReady ? '由文本模型给出 setup 顺序和理由，采纳前可以先看' : PLAN_ERROR_COPY.aiNotConfigured}
            onClick={() => suggestion.setConfirming(true)}
          >
            <Sparkles aria-hidden className="size-3.5" />
            AI 排序建议
          </Button>
          {!aiReady && health ? <span className="text-xs text-graphite-300">需要先在设置里配置文本模型</span> : null}
          <div className="ml-auto">
            <MenuButton label="导出" icon={Download}>
              {(close) => (
                <>
                  <MenuItem
                    onClick={() => {
                      close();
                      onPrint('callsheet');
                    }}
                    hint="浏览器打印，未批准时标“草案”"
                  >
                    打印拍摄单
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close();
                      download(exportFileName('拍摄单', plan.date), callSheetCsv(plan, lookup, bom));
                    }}
                  >
                    下载拍摄单 CSV
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close();
                      onPrint('slates');
                    }}
                    hint="每镜一张，条次留空"
                  >
                    打印打板卡
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close();
                      download(exportFileName('场记模板', plan.date), takeLogCsv(plan, lookup, bom));
                    }}
                    hint="预填场次和镜号"
                  >
                    下载场记 CSV 模板
                  </MenuItem>
                  <div className="mt-1 border-t border-graphite-700 px-3 pt-2 pb-1">
                    <CheckRow checked={bom} onChange={setBom} hint="Excel 打开中文不乱码">
                      CSV 带 BOM
                    </CheckRow>
                  </div>
                </>
              )}
            </MenuButton>
          </div>
        </div>

        <div className="flex flex-col gap-3 p-3 print:hidden">
          <section aria-label="计划状态" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={outcome.tone}>{outcome.label}</StatusPill>
              <StatusPill tone={state.tone}>{state.label}</StatusPill>
              <span className="text-xs text-graphite-300 tabular-nums">
                开工 {crew} · 修订 r{plan.revision}
              </span>
              {plan.status === 'approved' && !stale ? null : (
                <Button
                  variant="primary"
                  size="sm"
                  className="ml-auto"
                  disabled={!approval.ok || stale}
                  busy={write.isPending && write.variables?.kind === 'approve'}
                  onClick={() => write.mutate({ kind: 'approve', id: plan.id, revision: plan.revision })}
                >
                  <Check aria-hidden className="size-3.5" />
                  批准计划
                </Button>
              )}
            </div>
            <p className="text-sm text-graphite-300">{outcome.explain}</p>
            {write.isError ? <WriteError error={write.error} kind={write.variables?.kind} /> : null}
          </section>

          {stale ? (
            <Notice tone="warn" title="输入已变化，计划需要重新计算" role="status">
              <div className="flex flex-wrap items-center gap-2">
                <span>资源、setup、镜头或约束在计算之后有改动{plan.status === 'approved' ? '，原来的批准已失效' : ''}。</span>
                <Button size="sm" onClick={recompute} busy={write.isPending && write.variables?.kind === 'recompute'}>
                  <RefreshCw aria-hidden className="size-3.5" />
                  重新计算
                </Button>
              </div>
            </Notice>
          ) : null}

          <OrderSuggestion data={data} detail={detail} state={suggestion} demo={health?.demo ?? false} />

          {plan.result.contradictions.length > 0 ? (
            <section aria-label="不可行的依据" className="rounded-panel border border-l-2 border-graphite-700 border-l-danger bg-graphite-800 px-3 py-2.5">
              <h3 className="text-sm font-medium text-graphite-100">依据（{plan.result.contradictions.length}）</h3>
              <ul className="mt-1 flex flex-col gap-1 text-sm text-graphite-300">
                {plan.result.contradictions.map((c, i) => (
                  <li key={i} title={c.message}>
                    {contradictionText(c, data.names)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {plan.result.unplaced.length > 0 ? (
            <section aria-label="未排入" className="rounded-panel border border-l-2 border-graphite-700 border-l-warn bg-graphite-800 px-3 py-2.5">
              <h3 className="text-sm font-medium text-graphite-100">未排入（{plan.result.unplaced.length}）</h3>
              <ul className="mt-1 flex flex-col gap-1 text-sm text-graphite-300">
                {plan.result.unplaced.map((u) => (
                  <li key={u.setup_id} title={u.reason}>
                    <span className="text-graphite-100">「{data.setupById.get(u.setup_id)?.label ?? '已删除的 setup'}」</span>
                    ：{UNPLACED_TEXT[u.code]}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {!approval.ok && approval.blockers.length > 0 ? (
            <section aria-label="批准前需要解决" className="rounded-panel border border-graphite-700 bg-graphite-900 px-3 py-2.5">
              <h3 className="text-sm font-medium text-graphite-100">批准前需要解决（{approval.blockers.length}）</h3>
              <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-sm text-graphite-300">
                {blockerLines(approval.blockers, data.names).map((line) => (
                  <li key={line.key} title={line.raw}>
                    {line.text}
                  </li>
                ))}
              </ul>
            </section>
          ) : approval.ok && !stale && plan.status !== 'approved' ? (
            <p className="text-sm text-graphite-300">校验通过，工时和资源都已确认，可以批准。</p>
          ) : null}
        </div>

        <div className="px-3 pb-3 print:p-0">
          <PaperCanvas variant="fill" label="拍摄单">
            <CallSheetHeader data={data} detail={detail} crew={crew} />
            <div className="mt-3">
              <CallSheetTable detail={detail} lookup={lookup} />
            </div>
            <UnplacedList detail={detail} lookup={lookup} />
          </PaperCanvas>
        </div>
      </div>
    </Panel>
  );
}

const WRITE_BLOCKED_TITLE: Record<PlanWrite['kind'], string> = {
  approve: PLAN_ERROR_COPY.approveBlocked,
  recompute: PLAN_ERROR_COPY.recomputeBlocked,
  reorder: PLAN_ERROR_COPY.reorderBlocked,
  adopt: PLAN_ERROR_COPY.adoptBlocked,
};

/** A 409 state error names the action that was refused (approve, recompute, reorder, adopt). */
function WriteError({ error, kind }: { error: unknown; kind: PlanWrite['kind'] | undefined }) {
  if (isApiClientError(error) && error.status === 409 && error.code === 'VALIDATION_ERROR' && kind) {
    return <Notice tone="danger" title={WRITE_BLOCKED_TITLE[kind]}>{error.message}</Notice>;
  }
  return <ErrorNotice error={error} />;
}

// ------------------------------------------------------- AI order suggestion ---

interface SuggestionState {
  planId: string;
  jobId: string | null;
  setJobId: (id: string | null) => void;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  busy: boolean;
}

function useSuggestionState(planId: string): SuggestionState {
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const job = useJob(jobId);
  useEffect(() => {
    setJobId(null);
    setConfirming(false);
  }, [planId]);
  const busy = jobId !== null && (!job.data || job.data.status === 'queued' || job.data.status === 'running');
  return { planId, jobId, setJobId, confirming, setConfirming, busy };
}

function OrderSuggestion({ data, detail, state, demo }: { data: PlanData; detail: PlanDetail; state: SuggestionState; demo: boolean }) {
  const suggest = useSuggestOrder();
  const write = usePlanWrite();
  const job = useJob(state.jobId);
  const done = job.data?.status === 'succeeded' ? job.data.result_ref : null;
  const draft = useDraft(done);
  const [adopted, setAdopted] = useState<string | null>(null);

  const send = () =>
    suggest.mutate(state.planId, {
      onSuccess: (r) => {
        setAdopted(null);
        state.setJobId(r.job_id);
        state.setConfirming(false);
      },
    });

  let body = null;
  if (state.jobId && job.data && (job.data.status === 'queued' || job.data.status === 'running')) {
    body = <Spinner label={`正在请求排序建议（${JOB_STATUS_LABEL[job.data.status]}）…`} />;
  } else if (job.data && job.data.status !== 'succeeded') {
    body = (
      <Notice tone="danger" title={`排序建议${JOB_STATUS_LABEL[job.data.status]}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span>{job.data.error?.message ?? '没有拿到可用的结果。'}</span>
          <Button size="sm" variant="ghost" onClick={() => state.setJobId(null)}>
            关闭
          </Button>
        </div>
      </Notice>
    );
  } else if (draft.data) {
    const parsed = draft.data.draft.parsed as { setup_order?: string[]; rationale?: string } | null;
    const order = parsed?.setup_order ?? [];
    const isAdopted = adopted === draft.data.draft.id || draft.data.draft.status === 'applied';
    body = (
      <section aria-label="AI 排序建议" className="rounded-panel border border-graphite-700 bg-graphite-800 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-graphite-100">AI 建议的拍摄顺序</h3>
          <span className="text-xs text-graphite-300">未经验证的草案；采纳后仍由校验器判定可行性</span>
          <div className="ml-auto flex gap-1">
            {isAdopted ? (
              <span className="inline-flex h-6 items-center gap-1 text-xs text-graphite-100">
                <Check aria-hidden className="size-3.5 text-ok" />
                已采纳，结果见上方
              </span>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => state.setJobId(null)}>
                  忽略
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  busy={write.isPending}
                  onClick={() =>
                    write.mutate(
                      { kind: 'adopt', id: detail.plan.id, revision: detail.plan.revision, draft_id: draft.data.draft.id },
                      { onSuccess: () => setAdopted(draft.data.draft.id) },
                    )
                  }
                >
                  采纳
                </Button>
              </>
            )}
          </div>
        </div>
        <ol className="mt-2 flex list-decimal flex-col gap-0.5 pl-5 text-sm text-graphite-100">
          {order.map((id) => (
            <li key={id}>{data.setupById.get(id)?.label ?? '（已删除的 setup）'}</li>
          ))}
        </ol>
        {parsed?.rationale ? <p className="mt-2 text-sm whitespace-pre-line text-graphite-300">{parsed.rationale}</p> : null}
        {write.isError ? <ErrorNotice error={write.error} className="mt-2" /> : null}
      </section>
    );
  }

  return (
    <>
      {suggest.isError ? <ErrorNotice error={suggest.error} /> : null}
      {body}
      {state.confirming ? <SendConfirm onCancel={() => state.setConfirming(false)} onSend={send} busy={suggest.isPending} demo={demo} /> : null}
    </>
  );
}

function SendConfirm({ onCancel, onSend, busy, demo }: { onCancel: () => void; onSend: () => void; busy: boolean; demo: boolean }) {
  const providers = useProviders(!demo);
  const base = providers.data?.text?.base_url ?? null;
  let host: string | null = null;
  try {
    host = base ? new URL(base).host : null;
  } catch {
    host = base;
  }
  return (
    <Modal
      title="发送排序请求"
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" busy={busy} onClick={onSend}>
            发送
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-graphite-100">
          {!demo && host ? (
            <>
              将发往 <span className="font-mono">{host}</span>
              {providers.data?.text?.model ? `（模型 ${providers.data.text.model}）` : ''}：
            </>
          ) : (
            '演示模式：使用本地录制的回放，不会外发请求。将使用：'
          )}
        </p>
        <ul className="list-disc pl-5 text-graphite-300">
          <li>setup 名称、场地名、每个 setup 的总时长</li>
          <li>镜头编号、景别和动作摘要（前 40 字）</li>
          <li>演员名和演员、场地的可用时间</li>
          <li>已确认的约束</li>
        </ul>
        <p className="text-xs text-graphite-300">每次最多外发 3 次（含重试），费用按你的服务商计费。模型只返回 setup 顺序和理由，不会改动计划，采纳前你可以先看。</p>
      </div>
    </Modal>
  );
}
