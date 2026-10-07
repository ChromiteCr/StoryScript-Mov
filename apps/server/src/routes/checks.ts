import type { Hono } from 'hono';
import { Api, JobAccepted, SaveUsagePriceInput, ScriptCheckView, ScriptRisk, SetRiskHandledInput, UsagePrice, UsageReport } from '@storyscript/contracts';
import { startScriptCheck } from '../ai/check-jobs.ts';
import type { AppDeps } from '../deps.ts';
import { respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { scriptCheckView, setRiskHandled } from '../services/check.ts';
import { saveUsagePrice, usageReport } from '../services/usage.ts';

/** S5: the script check (length estimate, shooting difficulties to tick off) and the usage dashboard. */
export function registerCheckRoutes(app: Hono, deps: AppDeps): void {
  const project = () => deps.projectSession.require();

  app.get(Api.getScriptCheck.path, (c) => {
    const p = project();
    return respond(c, ScriptCheckView, scriptCheckView(p.db, p.project()));
  });

  app.post(Api.startScriptCheck.path, (c) => respond(c, JobAccepted, { job_id: startScriptCheck(deps).id }, 202));

  app.put(Api.setRiskHandled.path, async (c) => {
    const input = await parseBody(c, SetRiskHandledInput);
    const db = project().db;
    return respond(c, ScriptRisk, db.tx(() => setRiskHandled(db, c.req.param('id') ?? '', input.handled)));
  });

  app.get(Api.getUsage.path, (c) => respond(c, UsageReport, usageReport(deps)));

  app.put(Api.saveUsagePrice.path, async (c) => {
    const input = await parseBody(c, SaveUsagePriceInput);
    return respond(c, UsagePrice, saveUsagePrice(deps, input));
  });
}
