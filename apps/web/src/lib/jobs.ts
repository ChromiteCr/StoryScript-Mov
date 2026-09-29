import { useSyncExternalStore } from 'react';
import type { Job, JobKind, JobStatus } from '@storyscript/contracts';

/**
 * Background jobs (FR-11: one status field, the frontend polls once a second).
 * Labels and pure helpers, plus a small module-level tracker for the job a
 * page is following. Remote jobs are never auto-resent; `interrupted` is only
 * transient for local jobs (the server re-runs them), so for remote jobs it is
 * terminal too.
 */

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  extract_entities: '实体抽取',
  breakdown_scene: '拆镜',
  suggest_order: '排序建议',
  scan_root: '扫描素材目录',
  probe_asset: '读取素材元数据',
  hash_asset: '计算校验值',
  poster_asset: '生成海报帧',
  image_redraw: 'AI 铅笔重绘',
  research_style: '风格研究',
  polish_shots: 'AI 润色',
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  outcome_unknown: '结果未知',
};

/** Per-step cap on outgoing model requests (AGENTS.md; server ai/jobs.ts MAX_ATTEMPTS). */
export const MAX_ATTEMPTS = 3;

export function isJobInFlight(job: Pick<Job, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running';
}

const ALWAYS_TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);

/** Polling stops here. */
export function isTerminalJob(job: Pick<Job, 'status' | 'remote'>): boolean {
  if (ALWAYS_TERMINAL.has(job.status)) return true;
  return job.status === 'interrupted' && job.remote;
}

/** 0.42 → "42%"; null → null */
export function formatProgress(progress: number | null): string | null {
  if (progress === null) return null;
  return `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

/** "已外发 2 次（每步上限 3 次）" */
export function attemptsText(attempts: number): string {
  return attempts === 0 ? '尚未外发' : `已外发 ${attempts} 次（每步上限 ${MAX_ATTEMPTS} 次）`;
}

/**
 * "输入 1,234 · 输出 567 tokens"; null when the provider reported nothing.
 * The server records { prompt_tokens, completion_tokens, total_tokens, unknown_calls }.
 */
export function usageText(usage: Record<string, number> | null): string | null {
  if (!usage) return null;
  const pick = (...keys: string[]) => keys.map((k) => usage[k]).find((v) => typeof v === 'number');
  const input = pick('prompt_tokens', 'input_tokens');
  const output = pick('completion_tokens', 'output_tokens');
  const total = pick('total_tokens');
  const unknown = pick('unknown_calls');
  const fmt = (n: number) => n.toLocaleString('zh-CN');
  const parts: string[] = [];
  // all-zero counters mean "nothing reported", not "free"
  const reported = (input ?? 0) > 0 || (output ?? 0) > 0 || (total ?? 0) > 0;
  if (reported) {
    if (input !== undefined) parts.push(`输入 ${fmt(input)}`);
    if (output !== undefined) parts.push(`输出 ${fmt(output)}`);
    if (parts.length === 0 && total !== undefined) parts.push(`共 ${fmt(total)}`);
  }
  const base = parts.length > 0 ? `${parts.join(' · ')} tokens` : null;
  if (unknown !== undefined && unknown > 0) return `${base ? `${base}；` : ''}${unknown} 次调用未报告用量`;
  return base;
}

// ------------------------------------------------------------ job tracker ---
// Which job the UI is following for a slot ("entities", "breakdown:<scene>").
// Module-level so switching pages does not lose it; the server remains the
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
/** the style library's research job (S3) */
export const STYLE_RESEARCH_SLOT = 'style-research';
/** the AI polish job of the shot table (S3a) */
export const POLISH_SLOT = 'polish';
