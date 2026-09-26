import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, ApplyBreakdownInput, ApplyBreakdownResult, BreakdownRequest, DraftDetail, JobAccepted, ShotDraft } from '@storyscript/contracts';
import { startBreakdown } from '../ai/jobs.ts';
import type { AppDeps } from '../deps.ts';
import { listDrafts } from '../db/repos/draft.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { applyBreakdown, discardDraft, draftDetail } from '../services/drafts.ts';
import { ensuringBoards } from '../services/boards/boards.ts';

/** AI breakdown (FR-03): request → job → draft → review → apply / discard. */
export function registerDraftRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.post(Api.requestBreakdown.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, BreakdownRequest);
    const job = startBreakdown(deps, id, input);
    return respond(c, JobAccepted, { job_id: job.id }, 202);
  });

  app.get(Api.listDrafts.path, (c) => respond(c, z.array(ShotDraft), listDrafts(db())));

  app.get(Api.getDraft.path, (c) => respond(c, DraftDetail, draftDetail(db(), idParam(c))));

  app.post(Api.applyBreakdown.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, ApplyBreakdownInput);
    const d = db();
    return respond(c, ApplyBreakdownResult, d.tx(() => ensuringBoards(d, applyBreakdown(d, id, input))));
  });

  app.post(Api.discardDraft.path, (c) => respond(c, ShotDraft, discardDraft(db(), idParam(c))));
}
