import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DraftKind, Job, ShotDraft } from '@storyscript/contracts';
import { LoaderCircle, X } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { draftSceneId } from '../../lib/drafts.ts';
import { describeJobError } from '../../lib/errors.ts';
import { attemptsText, isActiveJob, isTerminalJob, markJobHandled, untrackJob, usageText, useTrackedJob } from '../../lib/jobs.ts';
import { JOB_STATUS_LABEL } from '../../lib/labels.ts';
import { keys, useCancelJob, useJob } from '../../lib/queries.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Tag, type TagTone } from '../../components/ui.tsx';

const TONE: Record<Job['status'], TagTone> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
  interrupted: 'warn',
  outcome_unknown: 'warn',
};

/**
 * Resolve the draft a finished AI job produced: Job.result_ref when the
 * server sets it, else the newest pending draft of that kind (and scene).
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

export interface JobLineProps {
  slot: string;
  /** runs once when the job succeeds; the line then disappears */
  onSucceeded: (job: Job) => void | Promise<void>;
}

/** Status of the AI job followed in `slot`: queued/running/failure reason/attempts (FR-11). */
export function JobLine({ slot, onSucceeded }: JobLineProps) {
  const tracked = useTrackedJob(slot);
  const job = useJob(tracked?.jobId ?? null);
  const cancel = useCancelJob();
  const data = job.data;

  useEffect(() => {
    if (!tracked || tracked.handled || !data || data.id !== tracked.jobId) return;
    if (data.status !== 'succeeded') return;
    markJobHandled(slot, data.id);
    void Promise.resolve(onSucceeded(data)).finally(() => untrackJob(slot));
  }, [tracked, data, slot, onSucceeded]);

  if (!tracked) return null;

  if (job.isError) {
    return (
      <div className="flex flex-col gap-2">
        <ErrorNotice error={job.error} />
        <div>
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => untrackJob(slot)}>
            关闭
          </Button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-ink-3" role="status">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
        已提交，正在查询任务状态…
      </p>
    );
  }

  const active = isActiveJob(data);
  const terminal = isTerminalJob(data);
  const err = describeJobError(data.error);
  const usage = usageText(data.usage);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-sheet border px-3 py-2 text-[13px] ${data.status === 'failed' ? 'border-danger-rule bg-danger-bg' : terminal && data.status !== 'succeeded' ? 'border-warn-rule bg-warn-bg' : 'border-rule bg-sheet-sunk'}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tag tone={TONE[data.status]}>
          {active ? <LoaderCircle aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : null}
          {JOB_STATUS_LABEL[data.status]}
        </Tag>
        <span className="text-xs text-ink-2">{attemptsText(data.attempts)}</span>
        {usage ? <span className="text-xs text-ink-3">{usage}</span> : null}
        {data.status === 'succeeded' ? <span className="text-xs text-ink-2">正在打开草案…</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {active ? (
            <Button variant="ghost" className="h-7 px-2 text-xs" busy={cancel.isPending} onClick={() => cancel.mutate(data.id)}>
              取消任务
            </Button>
          ) : null}
          {terminal && data.status !== 'succeeded' ? (
            <button
              type="button"
              onClick={() => untrackJob(slot)}
              className="inline-flex size-6 items-center justify-center rounded-control text-ink-3 hover:bg-sheet hover:text-ink"
              aria-label="关闭任务状态"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </span>
      </div>
      {data.status === 'outcome_unknown' ? (
        <p className="mt-1 text-xs text-ink-2">服务重启时请求已发出，无法确认结果。为避免重复计费，不会自动重发；需要时请重新发起。</p>
      ) : null}
      {data.status === 'cancelled' ? <p className="mt-1 text-xs text-ink-2">任务已取消。已经发出的请求仍可能计费。</p> : null}
      {err ? (
        <div className="mt-1 text-xs">
          <p className="font-medium text-danger">{err.title}</p>
          {err.detail ? <p className="mt-0.5 text-ink-2">{err.detail}</p> : null}
          {err.technical ? <p className="mt-0.5 font-mono break-all text-ink-3">{err.technical}</p> : null}
        </div>
      ) : null}
      {cancel.isError ? <ErrorNotice className="mt-2" error={cancel.error} /> : null}
    </div>
  );
}
