import { useCallback, useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ScriptCheckView, ScriptEstimate, ScriptRisk, ScriptRiskSeverity } from '@storyscript/contracts';
import { ListChecks, X } from 'lucide-react';
import {
  clock,
  countsLine,
  INT_EXT_LABEL,
  RISK_CATEGORY_LABEL,
  RISK_SEVERITY_HINT,
  RISK_SEVERITY_LABEL,
  riskList,
  scriptChars,
  targetNote,
  type RiskGroup,
} from '../../lib/check.ts';
import { trackJob, useTrackedJob } from '../../lib/jobs.ts';
import { checkKeys, useScriptCheck, useSetRiskHandled, useStartScriptCheck } from '../../lib/queries-check.ts';
import { useHealth } from '../../lib/queries.ts';
import { ActorLabel } from '../../components/ActorLabel.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, IconButton, Notice, Spinner } from '../../components/ui.tsx';
import { Panel } from '../../components/workspace.tsx';
import { useWorkspace } from './context.ts';
import { JobLine } from './JobLine.tsx';

/**
 * S5 剧本体检 (script page): the rough length per scene, worked out from the
 * text, and the shooting difficulties the model found, as a checklist any
 * member ticks off. A quote jumps to the script; items whose quote is gone
 * after a new version wait at the end.
 */

export const CHECK_SLOT = 'script-check';

export function CheckPanel({ onClose }: { onClose?: () => void }) {
  const view = useScriptCheck();
  return (
    <Panel
      title="剧本体检"
      padded={false}
      tools={onClose ? <IconButton icon={X} label="关闭体检，回到镜头表" onClick={onClose} /> : undefined}
    >
      {view.isPending ? (
        <div className="p-3">
          <Spinner label="正在读取体检结果…" />
        </div>
      ) : view.isError ? (
        <div className="p-3">
          <ErrorNotice error={view.error} />
        </div>
      ) : (
        <div className="flex flex-col gap-5 px-3 pt-3 pb-6">
          {view.data.estimate ? <Estimate estimate={view.data.estimate} /> : null}
          <Risks view={view.data} />
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ estimate

function Estimate({ estimate }: { estimate: ScriptEstimate }) {
  const ws = useWorkspace();
  const headingId = useId();
  const note = targetNote(estimate);
  const scenes = useMemo(() => new Map(ws.script.scenes.map((s) => [s.id, s] as const)), [ws.script.scenes]);
  const total = Math.max(1, estimate.seconds);
  const longest = Math.max(1, ...estimate.scenes.map((s) => s.seconds));
  let x = 0;

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="text-xs text-graphite-300">
        预估片长
      </h3>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-xl font-semibold text-graphite-100 tabular-nums">{clock(estimate.seconds)}</span>
        <span className="text-xs text-graphite-300 tabular-nums">
          {clock(estimate.low_seconds)}–{clock(estimate.high_seconds)}，按字数粗估
        </span>
      </p>
      {note ? (
        <p className={`mt-0.5 inline-flex items-center gap-1.5 text-xs ${note.over ? 'text-graphite-100' : 'text-graphite-300'}`}>
          {note.over ? <span aria-hidden className="size-1.5 rounded-full bg-warn" /> : null}
          {note.text}
        </p>
      ) : null}
      {/* the film as a strip: one segment per scene, as long as its share */}
      {estimate.seconds > 0 ? (
        <svg aria-hidden viewBox={`0 0 ${total} 6`} preserveAspectRatio="none" className="mt-2 block h-1.5 w-full rounded-full">
          {estimate.scenes.map((s, i) => {
            const rect = <rect key={s.scene_id} x={x} y={0} width={Math.max(0, s.seconds - (i < estimate.scenes.length - 1 ? total * 0.004 : 0))} height={6} className={i % 2 ? 'fill-graphite-500' : 'fill-graphite-300'} />;
            x += s.seconds;
            return rect;
          })}
        </svg>
      ) : null}
      <ol className="mt-3 flex flex-col">
        {estimate.scenes.map((s) => {
          const scene = scenes.get(s.scene_id);
          return (
            <li key={s.scene_id}>
              <button
                type="button"
                onClick={() => scene && ws.selectScene(scene, { reveal: true })}
                disabled={!scene}
                className="grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-control px-1 py-1 text-left hover:enabled:bg-graphite-800/60 focus-visible:outline-offset-[-2px]"
              >
                <span className="text-xs text-graphite-300 tabular-nums">{s.display_no}</span>
                <span className="min-w-0 truncate text-sm text-graphite-100">{s.heading}</span>
                <span className="flex items-center gap-2">
                  <svg aria-hidden viewBox={`0 0 ${longest} 4`} preserveAspectRatio="none" className="hidden h-1 w-12 xl:block">
                    <rect x={0} y={0} width={longest} height={4} className="fill-graphite-800" />
                    <rect x={0} y={0} width={s.seconds} height={4} className="fill-graphite-300" />
                  </svg>
                  <span className="w-10 text-right text-sm text-graphite-100 tabular-nums">{clock(s.seconds)}</span>
                </span>
                <span className="col-start-2 col-end-4 text-xs text-graphite-300 tabular-nums">
                  {[s.int_ext ? INT_EXT_LABEL[s.int_ext] : null, s.time_label, s.shots_seconds !== null ? `镜头时长合计 ${clock(s.shots_seconds)}` : null].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs leading-5 text-graphite-300">
        对白按每秒 4 个字、动作描写按每秒 2.5 个字估算，每场另加 3 秒。实际长度取决于表演和剪辑，只作排期参考。
      </p>
    </section>
  );
}

// --------------------------------------------------------------------- risks

function Risks({ view }: { view: ScriptCheckView }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const headingId = useId();
  const start = useStartScriptCheck();
  const tracked = useTrackedJob(CHECK_SLOT);
  const [confirming, setConfirming] = useState(false);
  const [hideHandled, setHideHandled] = useState(false);
  const list = useMemo(() => riskList(view.risks, ws.script.scenes, hideHandled), [view.risks, ws.script.scenes, hideHandled]);
  const check = view.check;
  const busy = tracked !== null || start.isPending;
  const cannot = ws.ai.reason ?? (busy ? '体检进行中' : null);

  const onSucceeded = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: checkKeys.view });
  }, [qc]);

  const launch = () => {
    start.mutate(undefined, {
      onSuccess: ({ job_id }) => {
        trackJob(CHECK_SLOT, job_id);
        setConfirming(false);
      },
    });
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 id={headingId} className="text-xs text-graphite-300">
          拍摄难点
        </h3>
        {check ? <span className="text-xs text-graphite-100 tabular-nums">{countsLine(list.counts)}</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {check && list.counts.handled > 0 ? (
            <Button variant="ghost" size="sm" aria-pressed={hideHandled} onClick={() => setHideHandled((h) => !h)}>
              {hideHandled ? `显示已处理（${list.counts.handled}）` : '隐藏已处理'}
            </Button>
          ) : null}
          {check ? (
            <Button size="sm" onClick={() => setConfirming(true)} disabled={cannot !== null} title={cannot ?? '把当前剧本重新体检一次'}>
              重新体检
            </Button>
          ) : null}
        </span>
      </div>

      {!check && !tracked ? (
        <div className="rounded-panel border border-dashed border-graphite-700 px-3 py-3">
          <p className="text-sm leading-6 text-graphite-100">
            让模型通读剧本，找出夜外景、雨水、车辆、人群、动物、危险动作、需审批场地、特效、年代服化这几类难拍的地方，每条附一个学生能做到的替代拍法。
          </p>
          <p className="mt-1 text-xs text-graphite-300">结果只是提示，不会改动剧本和镜头。</p>
          <Button className="mt-3" variant="primary" onClick={() => setConfirming(true)} disabled={cannot !== null} title={cannot ?? undefined}>
            <ListChecks aria-hidden className="size-3.5" />
            找出拍摄难点
          </Button>
          {ws.ai.reason ? <p className="mt-2 text-xs text-graphite-300">{ws.ai.reason}</p> : null}
        </div>
      ) : null}

      {start.isError && !confirming ? <ErrorNotice error={start.error} context="ai-request" /> : null}
      <JobLine slot={CHECK_SLOT} onSucceeded={onSucceeded} successNote="正在载入结果…" />

      {check ? (
        <>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-graphite-300">
            <span className="tabular-nums">{new Date(check.created_at).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })}</span>
            <ActorLabel actor={check.actor} after="发起" />
            {check.model ? <span className="break-all">{check.model}</span> : null}
          </p>
          {!check.current ? (
            <Notice tone="warn" title="剧本已改版，这是对旧版本的体检">
              还能在新版本里找到的条目照常显示；找不到的放在最后。建议重新体检。
            </Notice>
          ) : null}
          {check.issues.length > 0 ? (
            <Notice tone="info" title={check.status === 'partial' ? '这次结果不完整' : '附注'}>
              <ul className="list-disc pl-4">
                {check.issues.map((i) => (
                  <li key={`${i.code}:${i.message}`}>{i.message}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {list.counts.total === 0 && list.counts.stale === 0 ? <p className="text-sm text-graphite-300">没有找到明显的拍摄难点。</p> : null}
          {list.counts.total > 0 && list.groups.length === 0 ? <p className="text-sm text-graphite-300">都处理完了。</p> : null}
          {list.groups.map((g) => (
            <RiskSceneGroup key={g.scene?.id ?? 'other'} group={g} />
          ))}
          {list.stale.length > 0 ? (
            <details className="rounded-panel border border-graphite-700 px-3 py-2">
              <summary className="cursor-pointer text-sm text-graphite-300 select-none hover:text-graphite-100">剧本已改，对不上的条目（{list.stale.length}）</summary>
              <ul className="mt-2 flex flex-col gap-2">
                {list.stale.map((r) => (
                  <RiskItem key={r.id} risk={r} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      {confirming ? <ConfirmCheck again={check !== null} busy={start.isPending} error={start.error} onConfirm={launch} onClose={() => setConfirming(false)} /> : null}
    </section>
  );
}

function RiskSceneGroup({ group }: { group: RiskGroup }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId}>
      <h4 id={titleId} className="mb-1.5 flex min-w-0 items-baseline gap-2 text-sm font-medium text-graphite-100">
        {group.scene ? (
          <>
            <span className="shrink-0 text-xs text-graphite-300 tabular-nums">第 {group.scene.display_no} 场</span>
            <span className="min-w-0 truncate">{group.scene.heading}</span>
          </>
        ) : (
          '场次之外'
        )}
      </h4>
      <ul className="flex flex-col gap-2">
        {group.risks.map((r) => (
          <RiskItem key={r.id} risk={r} />
        ))}
      </ul>
    </section>
  );
}

/** Severity as a shape as well as a word: an open ring, a half-filled ring, a full disc. */
function SeverityMark({ severity }: { severity: ScriptRiskSeverity }) {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="size-3 shrink-0">
      <circle cx={6} cy={6} r={5} className={severity === 'low' ? 'fill-none stroke-graphite-300' : severity === 'medium' ? 'fill-none stroke-warn' : 'fill-danger stroke-danger'} strokeWidth={1.5} />
      {severity === 'medium' ? <path d="M6 1 A5 5 0 0 0 6 11 Z" className="fill-warn" /> : null}
    </svg>
  );
}

function RiskItem({ risk }: { risk: ScriptRisk }) {
  const ws = useWorkspace();
  const set = useSetRiskHandled();
  const checkboxId = useId();
  // the tick shows at once; the server's answer replaces it
  const [ticked, setTicked] = useState<boolean | null>(null);
  const pending = ticked !== null;
  const handled = ticked ?? risk.handled !== null;
  const category = RISK_CATEGORY_LABEL[risk.category];

  return (
    <li className={`rounded-panel border border-graphite-700 px-3 py-2.5 ${handled ? 'bg-transparent' : 'bg-graphite-800/50'}`}>
      <div className="flex items-start gap-2.5">
        <input
          id={checkboxId}
          type="checkbox"
          checked={handled}
          aria-busy={pending || undefined}
          onChange={(e) => {
            // stays enabled (and focused) while saving; a second click waits for the first
            if (pending) return;
            const on = e.target.checked;
            setTicked(on);
            set.mutate({ id: risk.id, handled: on }, { onSettled: () => setTicked(null) });
          }}
          className="mt-0.5 size-4 shrink-0 accent-graphite-100"
        />
        <div className="min-w-0 flex-1">
          <label htmlFor={checkboxId} className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="inline-flex items-center gap-1.5" title={RISK_SEVERITY_HINT[risk.severity]}>
              <SeverityMark severity={risk.severity} />
              <span className={`text-sm font-medium ${handled ? 'text-graphite-300' : 'text-graphite-100'}`}>{category}</span>
            </span>
            <span className="text-xs text-graphite-300">{RISK_SEVERITY_LABEL[risk.severity]}</span>
            {handled ? <span className="text-xs text-graphite-300">已处理</span> : null}
          </label>
          <p className={`mt-1 text-sm leading-6 ${handled ? 'text-graphite-300' : 'text-graphite-100'}`}>{risk.problem}</p>
          <p className="mt-0.5 text-sm leading-6 text-graphite-300">
            <span className="text-graphite-100">替代拍法：</span>
            {risk.alternative}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {risk.paragraph_id ? (
              <button
                type="button"
                onClick={() => ws.locate({ paragraph_id: risk.paragraph_id!, quote: risk.quote })}
                className="min-w-0 text-left text-xs break-words text-graphite-300 underline decoration-graphite-700 underline-offset-2 hover:text-graphite-100 hover:decoration-graphite-300"
                title="在剧本原文里找到这一句"
              >
                「{risk.quote}」
              </button>
            ) : (
              <span className="min-w-0 text-xs break-words text-graphite-500">「{risk.quote}」</span>
            )}
            {risk.handled ? <ActorLabel actor={risk.handled.actor} after="已处理" className="text-xs text-graphite-300" /> : null}
          </div>
          {set.isError && set.variables?.id === risk.id ? <ErrorNotice className="mt-2" error={set.error} /> : null}
        </div>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------- confirm

function ConfirmCheck({ again, busy, error, onConfirm, onClose }: { again: boolean; busy: boolean; error: unknown; onConfirm: () => void; onClose: () => void }) {
  const ws = useWorkspace();
  const health = useHealth().data;
  const chars = scriptChars(ws.script.version.paragraphs);
  const scenes = ws.script.scenes.length;
  const ownKey = health?.hosted && health.text_model_source === 'own';
  const groupKey = health?.hosted && health.text_model_source !== 'own';

  return (
    <Dialog
      onClose={onClose}
      busy={busy}
      title={again ? '重新体检' : '剧本体检'}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={onConfirm} busy={busy} disabled={!ws.ai.enabled}>
            {busy ? null : <ListChecks aria-hidden className="size-3.5" />}
            开始体检
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2 text-sm leading-6 text-graphite-300">
        <p>
          {ws.ai.demo ? '演示模式回放录好的样例结果，不外发。' : (
            <>
              会把剧本全文（{scenes} 场，约 {chars.toLocaleString('zh-CN')} 字）发送到 <span className="text-graphite-100">{ws.providerHost ?? '你配置的地址'}</span>，请模型找出拍摄难点并给出替代拍法。
            </>
          )}
        </p>
        {ws.ai.demo ? null : <p>1 次调用；输出格式不对时最多再试 2 次（每步最多外发 3 次）。</p>}
        {groupKey ? <p>用的是本组的 key，计入本组 24 小时内的调用上限。</p> : null}
        {ownKey ? <p>用的是你自己的 key，不计入本组的上限。</p> : null}
        {again ? <p>新结果会替换现在的清单；同一个难点已经勾选的，会保留勾选。</p> : <p>结果只是提示，不会改动剧本和镜头。</p>}
        {error ? <ErrorNotice error={error} context="ai-request" /> : null}
      </div>
    </Dialog>
  );
}

