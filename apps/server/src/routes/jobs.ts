import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, Job } from '@storyscript/contracts';
import { projectContext } from '../ai/runtime.ts';
import type { AppDeps } from '../deps.ts';
import { idParam, respond } from '../http/respond.ts';

/** Jobs (FR-11): status polling, active list, cancel. */
export function registerJobRoutes(app: Hono, deps: AppDeps): void {
  app.get(Api.listActiveJobs.path, (c) => respond(c, z.array(Job), projectContext(deps).jobs.listActive()));

  app.get(Api.getJob.path, (c) => respond(c, Job, projectContext(deps).jobs.require(idParam(c))));

  app.post(Api.cancelJob.path, (c) => respond(c, Job, projectContext(deps).jobs.cancel(idParam(c))));
}
