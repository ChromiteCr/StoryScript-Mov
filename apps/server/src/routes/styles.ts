import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, JobAccepted, StyleCard, StyleCardInput, StyleDefaults, StyleLibrary, StyleResearchInput } from '@storyscript/contracts';
import { startStyleResearch } from '../ai/style-jobs.ts';
import type { AppDeps } from '../deps.ts';
import { respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { createStyle, deleteStyle, saveResearchedStyle, saveStyleDefaults, styleLibrary, updateStyle } from '../services/styles.ts';

/** S3 style library: built-in and group cards, the group's defaults, and style research (→ draft → saved card). */
export function registerStyleRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;
  const param = (c: { req: { param: (k: string) => string | undefined } }) => c.req.param('id') ?? '';

  app.get(Api.getStyles.path, (c) => respond(c, StyleLibrary, styleLibrary(db())));

  app.post(Api.createStyle.path, async (c) => {
    const input = await parseBody(c, StyleCardInput);
    const d = db();
    return respond(c, StyleCard, d.tx(() => createStyle(d, input)), 201);
  });

  // before /styles/:id so "defaults" and "research" are not taken for an id
  app.put(Api.saveStyleDefaults.path, async (c) => {
    const input = await parseBody(c, StyleDefaults);
    return respond(c, StyleLibrary, saveStyleDefaults(db(), input));
  });

  app.post(Api.researchStyle.path, async (c) => {
    const input = await parseBody(c, StyleResearchInput);
    const job = startStyleResearch(deps, input);
    return respond(c, JobAccepted, { job_id: job.id }, 202);
  });

  app.put(Api.updateStyle.path, async (c) => {
    const input = await parseBody(c, StyleCardInput);
    return respond(c, StyleCard, updateStyle(db(), param(c), input));
  });

  app.delete(Api.deleteStyle.path, (c) => respond(c, z.object({ id: z.string() }), deleteStyle(db(), param(c))));

  app.post(Api.saveResearchedStyle.path, async (c) => {
    const input = await parseBody(c, StyleCardInput);
    return respond(c, StyleCard, saveResearchedStyle(db(), param(c), input), 201);
  });
}
