import { useEffect, useId, useRef, useState } from 'react';
import { ListChecks, LoaderCircle } from 'lucide-react';
import { isApiClientError } from '../lib/api.ts';
import { isOtherActor } from '../lib/crew.ts';
import { formatProgress, isJobInFlight, JOB_KIND_LABEL, JOB_STATUS_LABEL } from '../lib/jobs.ts';
import { useActiveJobs } from '../lib/queries.ts';
import { useMyActorId } from './AccountMenu.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';
import { Spinner } from './ui.tsx';
import { EmptyState } from './workspace.tsx';

/**
 * Background jobs in the page bar: idle icon, or a spinner plus the number of
 * queued/running jobs. Click opens the list above the bar (disclosure).
 */
export function JobsIndicator({ enabled }: { enabled: boolean }) {
  const jobs = useActiveJobs(enabled);
  const myId = useMyActorId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const headingId = useId();

  const inFlight = enabled ? (jobs.data ?? []).filter(isJobInFlight) : [];
  const count = inFlight.length;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A server without the jobs route yet answers 404: that simply means no jobs.
  const unsupported = jobs.isError && isApiClientError(jobs.error) && jobs.error.code === 'NOT_FOUND';

  let body;
  if (!enabled) {
    body = <EmptyState quiet title="打开项目后，这里列出后台任务。" />;
  } else if (jobs.isPending) {
    body = (
      <div className="px-3 py-4">
        <Spinner label="正在读取…" />
      </div>
    );
  } else if (jobs.isError && !unsupported) {
    body = (
      <div className="p-2">
        <ErrorNotice error={jobs.error} />
      </div>
    );
  } else if (count === 0) {
    body = <EmptyState quiet title="没有进行中的任务。" description="拆镜、素材扫描这类耗时操作开始后会列在这里。" />;
  } else {
    body = (
      <ul className="max-h-[min(360px,50dvh)] divide-y divide-graphite-800 overflow-auto">
        {inFlight.map((job) => {
          const progress = formatProgress(job.progress);
          return (
            <li key={job.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-graphite-100">
                {JOB_KIND_LABEL[job.kind]}
                {job.actor && isOtherActor(job.actor, myId) ? <span className="text-xs text-graphite-300"> · {job.actor.name}</span> : null}
              </span>
              <span className="shrink-0 text-xs text-graphite-300 tabular-nums">
                {JOB_STATUS_LABEL[job.status]}
                {progress ? ` ${progress}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="后台任务"
        onClick={() => {
          setOpen((o) => !o);
          if (jobs.isError) void jobs.refetch();
        }}
        className={
          'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-control px-2 text-graphite-300 ' +
          'hover:bg-graphite-800 hover:text-graphite-100 aria-expanded:bg-graphite-800 aria-expanded:text-graphite-100'
        }
      >
        {count > 0 ? (
          <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <ListChecks aria-hidden className="size-4" />
        )}
        {count > 0 ? (
          <span aria-hidden className="text-xs text-graphite-100 tabular-nums">
            {count}
          </span>
        ) : null}
        <span className="sr-only">{count > 0 ? `后台任务：${count} 个进行中` : '后台任务'}</span>
      </button>

      {open ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          className="absolute right-0 bottom-full z-30 mb-2 w-[320px] max-w-[calc(100vw-16px)] overflow-hidden rounded-panel border border-graphite-700 bg-graphite-900"
        >
          <h2 id={headingId} className="flex h-7 items-center border-b border-graphite-950 bg-graphite-800 px-3 text-xs font-medium text-graphite-300">
            后台任务
          </h2>
          {body}
        </div>
      ) : null}
    </div>
  );
}
