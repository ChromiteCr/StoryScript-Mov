import type { Hono } from 'hono';
import { z } from 'zod';
import { AdoptSuggestionInput, Api, CreatePlanInput, JobAccepted, Plan, PlanDetail, PlanRevisionInput, ReorderPlanInput } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { listPlans } from '../db/repos/plan.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { adoptSuggestion, approvePlan, createPlan, getPlanDetail, recomputePlan, reorderPlan } from '../services/plan/plans.ts';
import { startOrderSuggestion } from '../services/plan/suggest.ts';

/** Shooting-day plans (FR-06): compute, reorder, approve (INV-05), LLM order suggestion. */
export function registerPlanRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.listPlans.path, (c) => respond(c, z.array(Plan), listPlans(db())));

  app.post(Api.createPlan.path, async (c) => {
    const input = await parseBody(c, CreatePlanInput);
    return respond(c, PlanDetail, createPlan(db(), input), 201);
  });

  app.get(Api.getPlan.path, (c) => respond(c, PlanDetail, getPlanDetail(db(), idParam(c))));

  app.post(Api.recomputePlan.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, PlanRevisionInput);
    return respond(c, PlanDetail, recomputePlan(db(), id, input));
  });

  app.post(Api.reorderPlan.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, ReorderPlanInput);
    return respond(c, PlanDetail, reorderPlan(db(), id, input));
  });

  app.post(Api.approvePlan.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, PlanRevisionInput);
    return respond(c, PlanDetail, approvePlan(db(), id, input));
  });

  app.post(Api.suggestOrder.path, (c) => {
    const job = startOrderSuggestion(deps, idParam(c));
    return respond(c, JobAccepted, { job_id: job.id }, 202);
  });

  app.post(Api.adoptSuggestion.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, AdoptSuggestionInput);
    return respond(c, PlanDetail, adoptSuggestion(db(), id, input));
  });
}
