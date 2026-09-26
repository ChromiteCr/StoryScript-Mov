import { readFile } from 'node:fs/promises';
import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, JobAccepted, RasterView, RedrawInput } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { adoptRaster, listRasters, rasterImageFile, rejectRaster } from '../services/raster/rasters.ts';
import { requestRedraw } from '../services/raster/redraw.ts';

/**
 * M8 — AI pencil redraw (experimental, SPEC FR-12):
 *   POST /api/v1/boards/:id/redraw     202 { job_id }  (confirmation required)
 *   GET  /api/v1/boards/:id/rasters    candidates with stale flags
 *   POST /api/v1/rasters/:id/adopt     human adoption (never touches board/shot)
 *   POST /api/v1/rasters/:id/reject
 *   GET  /api/v1/rasters/:id/image     post-processed PNG (session cookie)
 * The board routes themselves live in routes/boards.ts (M4).
 */

export const rasterImagePath = '/api/v1/rasters/:id/image';

export function registerRasterRoutes(app: Hono, deps: AppDeps): void {
  const project = () => deps.projectSession.require();

  app.post(Api.requestRedraw.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, RedrawInput);
    const job = await requestRedraw(deps, id, input);
    return respond(c, JobAccepted, { job_id: job.id }, 202);
  });

  app.get(Api.listRasters.path, (c) => respond(c, z.array(RasterView), listRasters(project().db, idParam(c))));

  app.post(Api.adoptRaster.path, (c) => respond(c, RasterView, adoptRaster(project().db, idParam(c))));

  app.post(Api.rejectRaster.path, (c) => respond(c, RasterView, rejectRaster(project().db, idParam(c))));

  app.get(rasterImagePath, async (c) => {
    const id = idParam(c);
    const p = project();
    const file = await rasterImageFile(p.db, p.dir, id);
    const body = await readFile(file.path);
    return c.body(body, 200, {
      'Content-Type': 'image/png',
      'Content-Length': String(body.length),
      'Cache-Control': 'private, no-cache',
    });
  });
}
