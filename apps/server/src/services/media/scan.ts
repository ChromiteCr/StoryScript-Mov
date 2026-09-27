import type { Job } from '@storyscript/contracts';
import { projectContext } from '../../ai/runtime.ts';
import type { AppDeps } from '../../deps.ts';
import { listRoots } from '../../db/repos/root.ts';
import { AppError } from '../../http/errors.ts';
import { runScanJob } from '../../jobs/media-scan.ts';
import { requireRoot, requireServerReadable } from './roots.ts';

/** Queue the read-only scan of one root (idempotent per root while it runs). */
export async function enqueueRootScan(deps: AppDeps, rootId: string): Promise<Job> {
  const { project: p, jobs } = projectContext(deps);
  const root = requireRoot(p.db, rootId);
  requireServerReadable(root);
  const tools = await deps.tools();
  const ffprobe = tools.ffprobe.path;
  const ffmpeg = tools.ffmpeg.path;
  if (!ffprobe || !ffmpeg) {
    throw new AppError('FFMPEG_MISSING', '没有找到 ffmpeg / ffprobe：素材扫描需要它们。用 brew install ffmpeg 安装后重启 storyscript-mov', 409);
  }
  return jobs.enqueue({
    kind: 'scan_root',
    idempotency_key: `scan_root:${root.id}`,
    input_hash: root.id,
    remote: false,
    lane: 'local',
    run: (ctx) => runScanJob(ctx, { db: p.db, projectDir: p.dir, rootId: root.id, ffprobe, ffmpeg }),
  });
}

/**
 * Opening a project folder picks up what changed in it, like an editor
 * refreshing its file tree: the project root is re-scanned (unchanged files
 * are skipped by size + mtime; hashing continues in the background). Quietly
 * does nothing without ffmpeg, on a hosted server or in the demo.
 */
export async function autoScanProjectFolder(deps: AppDeps): Promise<Job | null> {
  if (deps.hosted || deps.demo) return null;
  const p = deps.projectSession.get();
  if (!p) return null;
  const root = listRoots(p.db).find((r) => r.kind === 'project');
  if (!root) return null;
  const tools = await deps.tools();
  if (!tools.ffprobe.path || !tools.ffmpeg.path) return null;
  return enqueueRootScan(deps, root.id);
}
