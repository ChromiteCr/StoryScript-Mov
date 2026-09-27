import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  AddRootInput,
  Api,
  AssetFactsInput,
  BrowserFilesInput,
  BrowserFilesOutput,
  BuildCandidatesInput,
  BuildCandidatesOutput,
  CreateBrowserRootInput,
  JobAccepted,
  MediaAssetView,
  MediaSearchInput,
  RootCheckResult,
  SourceRoot,
} from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { listRoots } from '../db/repos/root.ts';
import { AppError } from '../http/errors.ts';
import { contentTypeFor, parseRange, rangeHeaders } from '../http/range.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { listAssetViews, posterFile, searchAssetViews, streamFile } from '../services/media/assets.ts';
import { createBrowserRoot, POSTER_MAX_BYTES, reportAssetFacts, reportBrowserFiles, saveBrowserPoster } from '../services/media/browser-ingest.ts';
import { buildLinkCandidates } from '../services/media/links.ts';
import { enqueueRootScan } from '../services/media/scan.ts';
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
    const r = await addRoot(p.db, p.folder, input);
    return respond(c, SourceRoot, r.root, r.created ? 201 : 200);
  });

  app.post(Api.scanRoot.path, async (c) => {
    const job = await enqueueRootScan(deps, idParam(c));
    return respond(c, JobAccepted, { job_id: job.id }, 202);
  });

  app.post(Api.checkRoot.path, async (c) => {
    const id = idParam(c);
    const p = project();
    const root = requireRoot(p.db, id);
    return respond(c, RootCheckResult, await checkRoot(p.db, root, p.folder));
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

  // ---- footage read by a browser on a team member's computer (S1b) ----
  app.post(Api.createBrowserRoot.path, async (c) => {
    const input = await parseBody(c, CreateBrowserRootInput);
    return respond(c, SourceRoot, createBrowserRoot(db(), input), 201);
  });

  app.post(Api.reportBrowserFiles.path, async (c) => {
    const input = await parseBody(c, BrowserFilesInput);
    return respond(c, BrowserFilesOutput, reportBrowserFiles(db(), idParam(c), input));
  });

  app.put(Api.reportAssetFacts.path, async (c) => {
    const input = await parseBody(c, AssetFactsInput);
    return respond(c, MediaAssetView, reportAssetFacts(db(), idParam(c), input));
  });

  /** Binary body (image/jpeg): the poster frame the browser grabbed. */
  app.put('/api/v1/media/assets/:id/poster', async (c) => {
    const id = idParam(c);
    const declared = Number(c.req.header('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > POSTER_MAX_BYTES) {
      throw new AppError('VALIDATION_ERROR', `海报图不能超过 ${POSTER_MAX_BYTES / 1024} KB`, 413);
    }
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('image/jpeg')) {
      throw new AppError('UNSUPPORTED_MEDIA', '海报图需要以 image/jpeg 上传', 415);
    }
    const p = project();
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return respond(c, MediaAssetView, await saveBrowserPoster(p.db, p.dir, id, bytes));
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
    const p = project();
    const file = await streamFile(p.db, id, p.folder);
    const range = parseRange(c.req.header('range'), file.size);
    const head = rangeHeaders(range, file.size);
    const headers = { ...head.headers, 'Content-Type': contentTypeFor(extOf(file.asset.rel_path)) };
    if (head.status === 416) return c.body(null, 416, headers);
    const bounds = range && range !== 'unsatisfiable' ? { start: range.start, end: range.end } : {};
    const stream = Readable.toWeb(createReadStream(file.path, bounds)) as ReadableStream<Uint8Array>;
    return c.body(stream, head.status, headers);
  });
}
