import { randomUUID } from 'node:crypto';
import type { Job, JobKind, JobStatus } from '@storyscript/contracts';
import { redactSecrets } from '../adapters/llm/redact.ts';
import type { DbPort } from '../db/port.ts';
import { getJob, getJobByKey, insertJob, isTerminal, listJobsByStatus, updateJobRow } from '../db/repos/job.ts';
import { AppError } from '../http/errors.ts';

/**
 * In-process, persisted job queue (SPEC FR-11).
 *
 *   queued → running → succeeded | failed | cancelled | outcome_unknown
 *
 * - idempotency: enqueueing a key whose job is still queued/running returns
 *   that job (double clicks); a finished job with the same key is retired
 *   (its key gets a "~<id>" suffix) so a new run can start.
 * - lanes: 'llm' runs one job at a time.
 * - cancel: queued → cancelled; running → abort; if a remote request already
 *   left the process the job becomes outcome_unknown (the call may still
 *   complete and be billed), otherwise cancelled. A cancelled job's late
 *   result is discarded.
 * - recovery (queue construction = project opened by a fresh server): leftover
 *   queued/running rows become interrupted (local, or remote with no request
 *   sent) or outcome_unknown (remote with attempts > 0). Remote jobs are never
 *   re-sent automatically.
 */

export type JobLane = 'llm' | 'local';

export interface JobRunContext {
  job_id: string;
  signal: AbortSignal;
  /** call right before every outbound request */
  markSent(attempt: number): void;
}

export interface JobRunResult {
  status: 'succeeded' | 'failed';
  attempts: number;
  usage: Record<string, number> | null;
  error?: { code: string; message: string } | null;
  /**
   * Writes the job's output (e.g. a draft) and returns result_ref. Runs in the
   * same transaction as the terminal status update, and only if the job was
   * not cancelled meanwhile.
   */
  commit?: () => string | null;
}

export interface JobSpec {
  kind: JobKind;
  idempotency_key: string;
  input_hash: string;
  remote: boolean;
  lane?: JobLane;
  run: (ctx: JobRunContext) => Promise<JobRunResult>;
}

interface Entry {
  id: string;
  spec: JobSpec;
  lane: JobLane;
  controller: AbortController;
  started: boolean;
  sent: number;
  cancelled: boolean;
  done: Promise<void>;
  resolveDone: () => void;
}

export const OUTCOME_UNKNOWN_MESSAGE = '已取消：请求已经发出，远端调用仍可能完成并计费；结果不会被使用';
const RECOVERED_UNKNOWN = '服务重启时该任务仍在进行：已发出的调用可能已完成并计费，系统不会自动重发';
const RECOVERED_INTERRUPTED = '服务重启时该任务被中断（尚未发出请求）';

const LIMITS: Record<JobLane, number> = { llm: 1, local: 2 };

export class JobQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly pending: Record<JobLane, string[]> = { llm: [], local: [] };
  private readonly running: Record<JobLane, number> = { llm: 0, local: 0 };

  constructor(
    private readonly db: DbPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.recover();
  }

  /** Mark leftovers of a previous process (never re-sends remote work). */
  private recover(): void {
    const stale = listJobsByStatus(this.db, ['queued', 'running']);
    if (stale.length === 0) return;
    const now = this.now();
    this.db.tx(() => {
      for (const j of stale) {
        const unknown = j.remote && j.attempts > 0;
        updateJobRow(
          this.db,
          j.id,
          {
            status: unknown ? 'outcome_unknown' : 'interrupted',
            error: unknown
              ? { code: 'PROVIDER_OUTCOME_UNKNOWN', message: RECOVERED_UNKNOWN }
              : { code: 'INTERRUPTED', message: RECOVERED_INTERRUPTED },
          },
          now,
        );
      }
    });
  }

  get(id: string): Job | null {
    return getJob(this.db, id);
  }

  require(id: string): Job {
    const j = this.get(id);
    if (!j) throw new AppError('NOT_FOUND', '任务不存在', 404);
    return j;
  }

  listActive(): Job[] {
    return listJobsByStatus(this.db, ['queued', 'running']);
  }

  enqueue(spec: JobSpec): Job {
    const lane = spec.lane ?? 'llm';
    const now = this.now();
    const job = this.db.tx(() => {
      const existing = getJobByKey(this.db, spec.idempotency_key);
      if (existing && !isTerminal(existing.status)) return { job: existing, fresh: false };
      if (existing) updateJobRow(this.db, existing.id, { idempotency_key: `${existing.idempotency_key}~${existing.id}` }, existing.updated_at);
      const fresh: Job = {
        id: randomUUID(),
        kind: spec.kind,
        idempotency_key: spec.idempotency_key,
        remote: spec.remote,
        status: 'queued',
        attempts: 0,
        input_hash: spec.input_hash,
        progress: null,
        error: null,
        usage: null,
        result_ref: null,
        created_at: now,
        updated_at: now,
      };
      insertJob(this.db, fresh);
      return { job: fresh, fresh: true };
    });
    if (!job.fresh) return job.job;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.entries.set(job.job.id, {
      id: job.job.id,
      spec,
      lane,
      controller: new AbortController(),
      started: false,
      sent: 0,
      cancelled: false,
      done,
      resolveDone,
    });
    this.pending[lane].push(job.job.id);
    queueMicrotask(() => this.pump(lane));
    return job.job;
  }

  cancel(id: string): Job {
    const job = this.require(id);
    if (isTerminal(job.status)) return job;
    const entry = this.entries.get(id);
    const now = this.now();
    if (!entry || !entry.started) {
      if (entry) {
        entry.cancelled = true;
        this.pending[entry.lane] = this.pending[entry.lane].filter((x) => x !== id);
        this.finish(entry);
      }
      updateJobRow(this.db, id, { status: 'cancelled', error: null }, now);
      return this.require(id);
    }
    entry.cancelled = true;
    entry.controller.abort();
    const unknown = entry.spec.remote && entry.sent > 0;
    updateJobRow(
      this.db,
      id,
      unknown
        ? { status: 'outcome_unknown', attempts: entry.sent, error: { code: 'PROVIDER_OUTCOME_UNKNOWN', message: OUTCOME_UNKNOWN_MESSAGE } }
        : { status: 'cancelled', attempts: entry.sent, error: null },
      now,
    );
    return this.require(id);
  }

  /** Resolves when every job known to this queue has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.entries.size > 0) await Promise.all([...this.entries.values()].map((e) => e.done));
  }

  private finish(entry: Entry): void {
    this.entries.delete(entry.id);
    entry.resolveDone();
  }

  private pump(lane: JobLane): void {
    while (this.running[lane] < LIMITS[lane] && this.pending[lane].length > 0) {
      const id = this.pending[lane].shift()!;
      const entry = this.entries.get(id);
      if (!entry || entry.cancelled) continue;
      void this.start(entry);
    }
  }

  private async start(entry: Entry): Promise<void> {
    entry.started = true;
    this.running[entry.lane]++;
    let result: JobRunResult;
    try {
      updateJobRow(this.db, entry.id, { status: 'running' as JobStatus }, this.now());
      result = await entry.spec.run({
        job_id: entry.id,
        signal: entry.controller.signal,
        markSent: (attempt) => {
          entry.sent = Math.max(entry.sent, attempt);
          if (!entry.cancelled) {
            try {
              updateJobRow(this.db, entry.id, { attempts: entry.sent }, this.now());
            } catch {
              // project closed underneath the job; recovery handles the row
            }
          }
        },
      });
    } catch (err) {
      result = {
        status: 'failed',
        attempts: entry.sent,
        usage: null,
        error: { code: 'INTERNAL', message: redactSecrets(err instanceof Error ? err.message : String(err)) },
      };
    } finally {
      this.running[entry.lane]--;
    }
    try {
      if (!entry.cancelled) {
        this.db.tx(() => {
          const ref = result.commit ? result.commit() : null;
          updateJobRow(
            this.db,
            entry.id,
            {
              status: result.status,
              attempts: Math.max(result.attempts, entry.sent),
              usage: result.usage,
              error: result.error ?? null,
              result_ref: ref,
              progress: 1,
            },
            this.now(),
          );
        });
      }
    } catch (err) {
      console.error('[storyscript-mov] 任务结果写入失败：', redactSecrets(err instanceof Error ? err.message : String(err)));
    } finally {
      this.finish(entry);
      this.pump(entry.lane);
    }
  }
}

// ---------------------------------------------------------------------------
// one queue per open project database
// ---------------------------------------------------------------------------

const queues = new WeakMap<object, JobQueue>();

/** The queue of an open project (created — and leftovers recovered — on first use). */
export function jobQueueFor(owner: object, db: DbPort): JobQueue {
  let q = queues.get(owner);
  if (!q) {
    q = new JobQueue(db);
    queues.set(owner, q);
  }
  return q;
}
