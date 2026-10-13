import type { Hono } from 'hono';
import { Api, JobAccepted, ShotTipsView } from '@storyscript/contracts';
import { startShotTips } from '../ai/tips-jobs.ts';
import type { AppDeps } from '../deps.ts';
import { respond } from '../http/respond.ts';
import { shotTipsView } from '../services/tips.ts';

/** S5c: shot tips (a first guess for every shot, the model's per scene). */
export function registerTipRoutes(app: Hono, deps: AppDeps): void {
  app.get(Api.getShotTips.path, (c) => respond(c, ShotTipsView, shotTipsView(deps.projectSession.require().db)));
  app.post(Api.startShotTips.path, (c) => respond(c, JobAccepted, { job_id: startShotTips(deps, c.req.param('id') ?? '').id }, 202));
}
