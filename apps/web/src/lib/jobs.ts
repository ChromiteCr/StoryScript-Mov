import { useSyncExternalStore } from 'react';
import type { Job, JobStatus } from '@storyscript/contracts';

/**
 * Job helpers (FR-11: one status field, frontend polls once a second).
 * Remote jobs never auto-resend; `interrupted` is only transient for local
 * jobs (the server re-runs them), so for remote jobs it is terminal too.
 */

export const MAX_ATTEMPTS = 3;

const ALWAYS_TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);

export function isTerminalJob(job: Pick<Job, 'status' | 'remote'>): boolean {
  if (ALWAYS_TERMINAL.has(job.status)) return true;
  return job.status === 'interrupted' && job.remote;
}

export function isActiveJob(job: Pick<Job, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/** "已外发 2 次（每步上限 3 次）" */
export function attemptsText(attempts: number): string {
  return attempts === 0 ? '尚未外发' : `已外发 ${attempts} 次（每步上限 ${MAX_ATTEMPTS} 次）`;
}

/** "输入 1,234 · 输出 567 tokens"; null when the provider reported nothing. */
export function usageText(usage: Record<string, number> | null): string | null {
  if (!usage) return null;
  const pick = (...keys: string[]) => keys.map((k) => usage[k]).find((v) => typeof v === 'number');
  const input = pick('prompt_tokens', 'input_tokens');
  const output = pick('completion_tokens', 'output_tokens');
  const total = pick('total_tokens');
  const fmt = (n: number) => n.toLocaleString('zh-CN');
  const parts: string[] = [];
  if (input !== undefined) parts.push(`输入 ${fmt(input)}`);
  if (output !== undefined) parts.push(`输出 ${fmt(output)}`);
  if (parts.length === 0 && total !== undefined) parts.push(`共 ${fmt(total)}`);
  return parts.length > 0 ? `${parts.join(' · ')} tokens` : null;
}

// ------------------------------------------------------------ job tracker ---
// Which job the UI is following for a slot ("entities", "breakdown:<scene>").
// Module-level so switching views does not lose it; the server remains the
// source of truth (pending drafts are listed from /drafts after a reload).

export interface TrackedJob {
  jobId: string;
  /** set once the success side effect (open the draft) has run */
  handled: boolean;
}

let tracked: ReadonlyMap<string, TrackedJob> = new Map();
const listeners = new Set<() => void>();

function emit(next: ReadonlyMap<string, TrackedJob>): void {
  tracked = next;
  for (const l of listeners) l();
}

export function trackJob(slot: string, jobId: string): void {
  const next = new Map(tracked);
  next.set(slot, { jobId, handled: false });
  emit(next);
}

export function markJobHandled(slot: string, jobId: string): void {
  const cur = tracked.get(slot);
  if (!cur || cur.jobId !== jobId || cur.handled) return;
  const next = new Map(tracked);
  next.set(slot, { jobId, handled: true });
  emit(next);
}

export function untrackJob(slot: string): void {
  if (!tracked.has(slot)) return;
  const next = new Map(tracked);
  next.delete(slot);
  emit(next);
}

export function resetTrackedJobs(): void {
  if (tracked.size > 0) emit(new Map());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTrackedJob(slot: string): TrackedJob | null {
  return useSyncExternalStore(subscribe, () => tracked.get(slot) ?? null);
}

export const breakdownSlot = (sceneId: string) => `breakdown:${sceneId}`;
export const ENTITIES_SLOT = 'entities';
