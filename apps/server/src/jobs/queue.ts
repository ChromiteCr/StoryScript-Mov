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
 * - lanes: 'llm' (text model) and 'image' (paid image model) run one job at a
 *   time each and never wait on each other; 'local' (scan/probe/hash/poster)
 *   runs two at a time.
 * - outcome_unknown: a remote job whose paid request left the machine but
 *   whose result cannot be known (timeout, 5xx, dropped connection) reports
 *   status 'outcome_unknown' itself; it is never re-sent.
 * - cancel: queued → cancelled; running → abort; if a remote request already
 *   left the process the job becomes outcome_unknown (the call may still
 *   complete and be billed), otherwise cancelled. A cancelled job's late
 *   result is discarded.
 * - recovery (queue construction = project opened by a fresh server): leftover
 *   queued/running rows become interrupted (local, or remote with no request
 *   sent) or outcome_unknown (remote with attempts > 0). Remote jobs are never
 *   re-sent automatically. Local jobs whose kind has a re-run factory
 *   (registerRerun: scan_root / probe_asset / hash_asset / poster_asset) are
 *   then re-queued under the same id and idempotency key, so a page polling
 *   that job id sees it finish; kinds without a factory stay interrupted.
 */

export type JobLane = 'llm' | 'image' | 'local';

export interface JobRunContext {
  job_id: string;
  signal: AbortSignal;
  /** call right before every outbound request */
  markSent(attempt: number): void;
}

export interface JobRunResult {
  /**
   * 'outcome_unknown' is for remote jobs only (a paid request left and its
   * result is unknowable); a local job reporting it is recorded as failed.
   */
  status: 'succeeded' | 'failed' | 'outcome_unknown';
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

// ---------------------------------------------------------------------------
// FR-11 restart re-run registry (local jobs only)
// ---------------------------------------------------------------------------

/** Local, idempotent job kinds that may be re-run after a restart. */
export const RERUNNABLE_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['scan_root', 'probe_asset', 'hash_asset', 'poster_asset']);

export interface RerunContext {
  /** the interrupted row: id, kind, idempotency_key and input_hash identify the work */
  job: Job;
  db: DbPort;
  /** folder of the project that owns the queue (null when unknown) */
  projectDir: string | null;
}

/**
 * Rebuilds the spec of an interrupted local job from its row. Returning null
 * (e.g. the source root is gone, ffmpeg is missing) leaves the job interrupted.
 * Only `run` and `lane` of the returned spec are used; id and key stay.
 */
export type RerunFactory = (ctx: RerunContext) => JobSpec | null | Promise<JobSpec | null>;

const registry = new Map<JobKind, RerunFactory>();

export function registerRerun(kind: JobKind, factory: RerunFactory): void {
  if (!RERUNNABLE_KINDS.has(kind)) throw new Error(`job kind ${kind} is not a local re-runnable kind`);
  registry.set(kind, factory);
}

/** Registered factories (read-only view, e.g. for tests). */
export function registeredReruns(): ReadonlyMap<JobKind, RerunFactory> {
  return registry;
}

export interface JobQueueOptions {
  now?: () => string;
  projectDir?: string | null;
  /** re-run factories by kind; default: the process-wide registry (registerRerun) */
  reruns?: ReadonlyMap<JobKind, RerunFactory>;
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
export const RERUN_QUEUED_MESSAGE = '服务重启时该任务被中断，已按原参数自动重新排队';
export const RERUN_UNAVAILABLE_MESSAGE = '服务重启时该任务被中断，无法自动重跑';

const LIMITS: Record<JobLane, number> = { llm: 1, image: 1, local: 2 };
const LANES = Object.keys(LIMITS) as JobLane[];

export class JobQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = Object.fromEntries(LANES.map((l) => [l, [] as string[]])) as Record<JobLane, string[]>;
  private readonly running = Object.fromEntries(LANES.map((l) => [l, 0])) as Record<JobLane, number>;
  private readonly now: () => string;
  private readonly projectDir: string | null;
  private readonly reruns: ReadonlyMap<JobKind, RerunFactory>;
  private recovering: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DbPort,
    opts: JobQueueOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.projectDir = opts.projectDir ?? null;
    this.reruns = opts.reruns ?? registry;
    this.recover();
  }

  /**
   * Mark leftovers of a previous process (never re-sends remote work), then
   * re-queue the local ones that have a re-run factory.
   */
  private recover(): void {
    const stale = listJobsByStatus(this.db, ['queued', 'running']);
    if (stale.length === 0) return;
    const now = this.now();
    const rerun: Job[] = [];
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
        if (!j.remote && RERUNNABLE_KINDS.has(j.kind) && this.reruns.has(j.kind)) rerun.push(j);
      }
    });
    if (rerun.length === 0) return;
    // queued again synchronously: a click on the same key meanwhile joins this job instead of starting a second run
    this.db.tx(() => {
      for (const j of rerun) {
        updateJobRow(this.db, j.id, { status: 'queued', progress: null, error: { code: 'INTERRUPTED', message: RERUN_QUEUED_MESSAGE } }, now);
      }
    });
    this.recovering = Promise.all(rerun.map((j) => this.resume(j))).then(() => undefined);
  }

  private async resume(job: Job): Promise<void> {
    let spec: JobSpec | null = null;
    let reason: string | null = null;
    try {
      spec = await this.reruns.get(job.kind)!({ job, db: this.db, projectDir: this.projectDir });
      if (spec && (spec.remote || spec.kind !== job.kind)) {
        spec = null;
        reason = '重跑函数返回了不同类型或远端任务';
      }
    } catch (err) {
      reason = redactSecrets(err instanceof Error ? err.message : String(err));
    }
    try {
      const current = getJob(this.db, job.id);
      // cancelled (or otherwise settled) while the factory ran
      if (!current || current.status !== 'queued' || this.entries.has(job.id)) return;
      if (!spec) {
        const message = reason ? `${RERUN_UNAVAILABLE_MESSAGE}：${reason}` : RERUN_UNAVAILABLE_MESSAGE;
        updateJobRow(this.db, job.id, { status: 'interrupted', error: { code: 'INTERRUPTED', message } }, this.now());
        return;
      }
      this.admit(job.id, { ...spec, idempotency_key: job.idempotency_key, input_hash: job.input_hash, remote: false });
    } catch (err) {
      // project closed underneath the recovery; the next open recovers again
      console.error('[storyscript-mov] 任务重跑失败：', redactSecrets(err instanceof Error ? err.message : String(err)));
    }
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
    this.admit(job.job.id, spec);
    return job.job;
  }

  /** Track a queued row in memory and schedule it on its lane. */
  private admit(id: string, spec: JobSpec): void {
    const lane = spec.lane ?? 'llm';
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.entries.set(id, {
      id,
      spec,
      lane,
      controller: new AbortController(),
      started: false,
      sent: 0,
      cancelled: false,
      done,
      resolveDone,
    });
    this.pending[lane].push(id);
    queueMicrotask(() => this.pump(lane));
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

  /** Resolves when restart re-runs were scheduled and every job known to this queue has settled (tests, shutdown). */
  async idle(): Promise<void> {
    await this.recovering;
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
    const status: JobStatus = result.status === 'outcome_unknown' && !entry.spec.remote ? 'failed' : result.status;
    try {
      if (!entry.cancelled) {
        this.db.tx(() => {
          const ref = result.commit ? result.commit() : null;
          updateJobRow(
            this.db,
            entry.id,
            {
              status,
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

/** `dir` of an OpenedProject-like owner. */
function ownerDir(owner: object): string | null {
  const dir = (owner as { dir?: unknown }).dir;
  return typeof dir === 'string' ? dir : null;
}

/**
 * The queue of an open project (created — leftovers recovered and local ones
 * re-run — on first use). `owner` is the OpenedProject; its `dir` is handed to
 * re-run factories.
 */
export function jobQueueFor(owner: object, db: DbPort, opts: Omit<JobQueueOptions, 'now'> = {}): JobQueue {
  let q = queues.get(owner);
  if (!q) {
    q = new JobQueue(db, { ...opts, projectDir: opts.projectDir ?? ownerDir(owner) });
    queues.set(owner, q);
  }
  return q;
}
