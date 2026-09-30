import { Job, type JobStatus, type ModelSource } from '@storyscript/contracts';
import { actorResolver } from '../../collab/actor.ts';
import type { DbPort } from '../port.ts';

/** job ↔ contracts Job. */

interface JobRow {
  id: string;
  kind: string;
  idempotency_key: string;
  remote: number;
  status: string;
  attempts: number;
  input_hash: string;
  progress: number | null;
  error_json: string | null;
  usage_json: string | null;
  result_ref: string | null;
  created_at: string;
  updated_at: string;
  actor_id: string | null;
  model_source: string | null;
}

const COLS =
  'id, kind, idempotency_key, remote, status, attempts, input_hash, progress, error_json, usage_json, result_ref, created_at, updated_at, actor_id, model_source';

export const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_unknown']);
export const isTerminal = (s: JobStatus) => TERMINAL.has(s);

function fromRow(r: JobRow, actor: ReturnType<typeof actorResolver>): Job {
  const { actor_id, ...rest } = r;
  return Job.parse({
    ...rest,
    actor: actor(actor_id),
    remote: r.remote === 1,
    error: r.error_json === null ? null : JSON.parse(r.error_json),
    usage: r.usage_json === null ? null : JSON.parse(r.usage_json),
  });
}

/** S4: who queued the job and whose model it calls come from the caller, never from the Job object. */
export function insertJob(db: DbPort, j: Job, by: { actor_id: string | null; model_source: ModelSource | null } = { actor_id: null, model_source: null }): void {
  const x = Job.parse(j);
  db.run(
    `INSERT INTO job (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.kind,
    x.idempotency_key,
    x.remote ? 1 : 0,
    x.status,
    x.attempts,
    x.input_hash,
    x.progress,
    x.error === null ? null : JSON.stringify(x.error),
    x.usage === null ? null : JSON.stringify(x.usage),
    x.result_ref,
    x.created_at,
    x.updated_at,
    by.actor_id,
    by.model_source,
  );
}

export function getJob(db: DbPort, id: string): Job | null {
  const r = db.get<JobRow>(`SELECT ${COLS} FROM job WHERE id = ?`, id);
  return r ? fromRow(r, actorResolver(db)) : null;
}

export function getJobByKey(db: DbPort, key: string): Job | null {
  const r = db.get<JobRow>(`SELECT ${COLS} FROM job WHERE idempotency_key = ?`, key);
  return r ? fromRow(r, actorResolver(db)) : null;
}

export function listJobsByStatus(db: DbPort, statuses: readonly JobStatus[]): Job[] {
  const marks = statuses.map(() => '?').join(', ');
  const actor = actorResolver(db);
  return db.all<JobRow>(`SELECT ${COLS} FROM job WHERE status IN (${marks}) ORDER BY created_at, rowid`, ...statuses).map((r) => fromRow(r, actor));
}

export interface JobPatch {
  status?: JobStatus;
  attempts?: number;
  progress?: number | null;
  error?: Job['error'];
  usage?: Job['usage'];
  result_ref?: string | null;
  idempotency_key?: string;
}

export function updateJobRow(db: DbPort, id: string, patch: JobPatch, now: string): void {
  const sets: string[] = ['updated_at = ?'];
  const vals: (string | number | null)[] = [now];
  const put = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.status !== undefined) put('status', patch.status);
  if (patch.attempts !== undefined) put('attempts', patch.attempts);
  if (patch.progress !== undefined) put('progress', patch.progress);
  if (patch.error !== undefined) put('error_json', patch.error === null ? null : JSON.stringify(patch.error));
  if (patch.usage !== undefined) put('usage_json', patch.usage === null ? null : JSON.stringify(patch.usage));
  if (patch.result_ref !== undefined) put('result_ref', patch.result_ref);
  if (patch.idempotency_key !== undefined) put('idempotency_key', patch.idempotency_key);
  db.run(`UPDATE job SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
}
