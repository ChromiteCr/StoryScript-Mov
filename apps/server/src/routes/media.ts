import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  AddRootInput,
  Api,
  BuildCandidatesInput,
  BuildCandidatesOutput,
  JobAccepted,
  MediaAssetView,
  MediaSearchInput,
  RootCheckResult,
  SourceRoot,
} from '@storyscript/contracts';
import { projectContext } from '../ai/runtime.ts';
import type { AppDeps } from '../deps.ts';
import { listRoots } from '../db/repos/root.ts';
import { AppError } from '../http/errors.ts';
import { contentTypeFor, parseRange, rangeHeaders } from '../http/range.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { runScanJob } from '../jobs/media-scan.ts';
import { listAssetViews, posterFile, searchAssetViews, streamFile } from '../services/media/assets.ts';
import { buildLinkCandidates } from '../services/media/links.ts';
import { extOf } from '../services/media/paths.ts';
import { addRoot, checkRoot, requireRoot } from '../services/media/roots.ts';

/**
 * Media library (FR-08/09): source roots, read-only scan job, availability
 * check, library listing and LIKE search, link candidates, and the two binary
 * endpoints referenced by MediaAssetView (poster_url, stream_url). The binary
 * endpoints sit under /api/ so authGuard requires the session cookie.
 */
export function registerMediaRoutes(app: Hono, deps: AppDeps): void {
  const project = () => deps.projectSession.require();
  const db = () => project().db;

  app.get(Api.listRoots.path, (c) => respond(c, z.array(SourceRoot), listRoots(db())));

  app.post(Api.addRoot.path, async (c) => {
    const input = await parseBody(c, AddRootInput);
    const p = project();
    const r = await addRoot(p.db, p.dir, input);
    return respond(c, SourceRoot, r.root, r.created ? 201 : 200);
  });

  app.post(Api.scanRoot.path, async (c) => {
    const id = idParam(c);
    const { project: p, jobs } = projectContext(deps);
    const root = requireRoot(p.db, id);
    const tools = await deps.tools();
    const ffprobe = tools.ffprobe.path;
    const ffmpeg = tools.ffmpeg.path;
    if (!ffprobe || !ffmpeg) {
      throw new AppError('FFMPEG_MISSING', '没有找到 ffmpeg / ffprobe：素材扫描需要它们。用 brew install ffmpeg 安装后重启 storyscript-mov', 409);
    }
    const job = jobs.enqueue({
      kind: 'scan_root',
      idempotency_key: `scan_root:${root.id}`,
      input_hash: root.id,
      remote: false,
      lane: 'local',
      run: (ctx) => runScanJob(ctx, { db: p.db, projectDir: p.dir, rootId: root.id, ffprobe, ffmpeg }),
    });
    return respond(c, JobAccepted, { job_id: job.id }, 202);
  });

  app.post(Api.checkRoot.path, async (c) => {
    const id = idParam(c);
    const d = db();
    const root = requireRoot(d, id);
    return respond(c, RootCheckResult, await checkRoot(d, root));
  });

  app.get(Api.listAssets.path, (c) => respond(c, z.array(MediaAssetView), listAssetViews(db())));

  app.post(Api.searchAssets.path, async (c) => {
    const input = await parseBody(c, MediaSearchInput);
    return respond(c, z.array(MediaAssetView), searchAssetViews(db(), input));
  });

  app.post(Api.buildCandidates.path, async (c) => {
    const input = await parseBody(c, BuildCandidatesInput);
    return respond(c, BuildCandidatesOutput, buildLinkCandidates(db(), input));
  });

  app.get('/api/v1/media/assets/:id/poster', async (c) => {
    const id = idParam(c);
    const p = project();
    const file = await posterFile(p.db, p.dir, id);
    const body = await readFile(file.path);
    return c.body(body, 200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.length) });
  });

  app.get('/api/v1/media/assets/:id/stream', async (c) => {
    const id = idParam(c);
    const file = await streamFile(db(), id);
    const range = parseRange(c.req.header('range'), file.size);
    const head = rangeHeaders(range, file.size);
    const headers = { ...head.headers, 'Content-Type': contentTypeFor(extOf(file.asset.rel_path)) };
    if (head.status === 416) return c.body(null, 416, headers);
    const bounds = range && range !== 'unsatisfiable' ? { start: range.start, end: range.end } : {};
    const stream = Readable.toWeb(createReadStream(file.path, bounds)) as ReadableStream<Uint8Array>;
    return c.body(stream, head.status, headers);
  });
}
