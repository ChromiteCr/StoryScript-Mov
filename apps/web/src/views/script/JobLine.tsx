import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DraftKind, Job, ShotDraft } from '@storyscript/contracts';
import { LoaderCircle, X } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { draftSceneId } from '../../lib/drafts.ts';
import { describeJobError } from '../../lib/errors.ts';
import {
  attemptsText,
  isJobInFlight,
  isTerminalJob,
  JOB_KIND_LABEL,
  JOB_STATUS_LABEL,
  markJobHandled,
  untrackJob,
  usageText,
  useTrackedJob,
} from '../../lib/jobs.ts';
import { keys, useCancelJob, useJob } from '../../lib/queries.ts';
import { isOtherActor } from '../../lib/crew.ts';
import { useMyActorId } from '../../components/AccountMenu.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, IconButton } from '../../components/ui.tsx';

/**
 * Resolve the draft a finished AI job produced: Job.result_ref (the server
 * sets it whenever a draft was written), else the newest pending draft of
 * that kind (and scene).
 */
export function useDraftFinder() {
  const qc = useQueryClient();
  return async (job: Job, kind: DraftKind, sceneId: string | null): Promise<string | null> => {
    const drafts = await qc.fetchQuery({
      queryKey: keys.drafts,
      queryFn: ({ signal }) => api.call('listDrafts', undefined, { signal }),
      staleTime: 0,
    });
    if (job.result_ref && drafts.some((d) => d.id === job.result_ref)) return job.result_ref;
    const match = (d: ShotDraft) => d.kind === kind && d.status === 'pending' && (sceneId === null || draftSceneId(d) === sceneId);
    const newest = drafts.filter(match).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return newest?.id ?? job.result_ref ?? null;
  };
}

const STATUS_DOT: Record<Job['status'], string> = {
  queued: 'bg-graphite-300',
  running: 'bg-graphite-100',
  succeeded: 'bg-ok',
  failed: 'bg-danger',
  cancelled: 'bg-graphite-500',
  interrupted: 'bg-warn',
  outcome_unknown: 'bg-warn',
};

export interface JobLineProps {
  slot: string;
  /** runs once when the job succeeds; the line then disappears */
  onSucceeded: (job: Job) => void | Promise<void>;
  /** a failed job may still have written a draft (e.g. the last attempt with errors): offer to open it */
  onOpenDraft?: (draftId: string) => void;
  /** what happens once the job succeeded (default: the draft opens) */
  successNote?: string;
}

/** Status of the AI job followed in `slot`: queued / running / failure reason / attempts / usage (FR-11). */
export function JobLine({ slot, onSucceeded, onOpenDraft, successNote = '正在打开草案…' }: JobLineProps) {
  const qc = useQueryClient();
  const tracked = useTrackedJob(slot);
  const job = useJob(tracked?.jobId ?? null);
  const cancel = useCancelJob();
  const myId = useMyActorId();
  const data = job.data;

  useEffect(() => {
    if (!tracked || tracked.handled || !data || data.id !== tracked.jobId) return;
    if (!isTerminalJob(data)) return;
    markJobHandled(slot, data.id);
    void qc.invalidateQueries({ queryKey: keys.drafts });
    if (data.status === 'succeeded') void Promise.resolve(onSucceeded(data)).finally(() => untrackJob(slot));
  }, [tracked, data, slot, onSucceeded, qc]);

  if (!tracked) return null;

  if (job.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <ErrorNotice error={job.error} />
        <Button variant="ghost" size="sm" onClick={() => untrackJob(slot)}>
          关闭
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-graphite-300" role="status">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
        已提交，正在查询任务状态…
      </p>
    );
  }

  const active = isJobInFlight(data);
  const terminal = isTerminalJob(data);
  const err = describeJobError(data.error);
  const usage = usageText(data.usage);
  const edge = data.status === 'failed' ? 'border-l-danger' : terminal && data.status !== 'succeeded' ? 'border-l-warn' : 'border-l-graphite-500';

  return (
    <div role="status" aria-live="polite" className={`rounded-panel border border-l-2 border-graphite-700 bg-graphite-800 px-2.5 py-2 text-sm ${edge}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {active ? (
          <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin text-graphite-300 motion-reduce:animate-none" />
        ) : (
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[data.status]}`} />
        )}
        <span className="font-medium text-graphite-100">
          {JOB_KIND_LABEL[data.kind]} {JOB_STATUS_LABEL[data.status]}
        </span>
        {data.actor && isOtherActor(data.actor, myId) ? <span className="text-xs text-graphite-300">{data.actor.name}的任务</span> : null}
        <span className="text-xs text-graphite-300 tabular-nums">{attemptsText(data.attempts)}</span>
        {usage ? <span className="text-xs text-graphite-300 tabular-nums">{usage}</span> : null}
        {data.status === 'succeeded' ? <span className="text-xs text-graphite-300">{successNote}</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {active ? (
            <Button variant="ghost" size="sm" busy={cancel.isPending} onClick={() => cancel.mutate(data.id)}>
              取消任务
            </Button>
          ) : null}
          {terminal && data.status !== 'succeeded' ? <IconButton icon={X} label="关闭任务状态" onClick={() => untrackJob(slot)} /> : null}
        </span>
      </div>
      {data.status === 'outcome_unknown' && !err ? (
        <p className="mt-1 text-xs text-graphite-300">请求已经发出，但无法确认结果。为避免重复计费，不会自动重发；需要时请重新发起。</p>
      ) : null}
      {/* the server marks a cancel after a request left the machine as outcome_unknown, so cancelled means nothing was sent */}
      {data.status === 'cancelled' ? (
        <p className="mt-1 text-xs text-graphite-300">{data.remote || data.attempts === 0 ? '任务已取消，没有向模型服务发出请求。' : '任务已取消。'}</p>
      ) : null}
      {err ? (
        <div className="mt-1 text-xs">
          <p className="font-medium text-graphite-100">{err.title}</p>
          {err.detail ? <p className="mt-0.5 text-graphite-300">{err.detail}</p> : null}
          {err.technical ? (
            <details className="mt-0.5 text-graphite-300">
              <summary className="cursor-pointer select-none hover:text-graphite-100">技术信息</summary>
              <p className="mt-0.5 font-mono break-all">{err.technical}</p>
            </details>
          ) : null}
        </div>
      ) : null}
      {terminal && data.status !== 'succeeded' && data.result_ref && onOpenDraft ? (
        <div className="mt-1.5 flex items-center gap-2">
          <Button size="sm" onClick={() => data.result_ref && onOpenDraft(data.result_ref)}>
            查看草案
          </Button>
          <span className="text-xs text-graphite-300">最后一次输出已存为草案，没有错误的条目仍可应用。</span>
        </div>
      ) : null}
      {cancel.isError ? <ErrorNotice className="mt-2" error={cancel.error} /> : null}
    </div>
  );
}
