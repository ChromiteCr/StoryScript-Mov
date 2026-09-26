import type { Job, JobKind, JobStatus } from '@storyscript/contracts';

/** Chinese labels for background jobs (FR-11). Pure. */

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  extract_entities: '实体抽取',
  breakdown_scene: '拆镜',
  suggest_order: '排序建议',
  scan_root: '扫描素材目录',
  probe_asset: '读取素材元数据',
  hash_asset: '计算校验值',
  poster_asset: '生成海报帧',
  image_redraw: 'AI 铅笔重绘',
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

export function isJobInFlight(job: Pick<Job, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/** 0.42 → "42%"; null → null */
export function formatProgress(progress: number | null): string | null {
  if (progress === null) return null;
  return `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}
