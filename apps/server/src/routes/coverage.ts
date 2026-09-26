import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, CoverageDecision, CoverageDecisionInput, CoverageResult } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { addCoverageDecision, projectCoverage } from '../services/coverage/coverage.ts';

/** Coverage (FR-09, COV): computed on every request by core, decisions append-only. */
export function registerCoverageRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.coverage.path, (c) => respond(c, z.array(CoverageResult), projectCoverage(db())));

  app.post(Api.addCoverageDecision.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, CoverageDecisionInput);
    return respond(c, CoverageDecision, addCoverageDecision(db(), id, input), 201);
  });
}
