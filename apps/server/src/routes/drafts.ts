import type { Hono } from 'hono';
import { z } from 'zod';
import {
  Api,
  ApplyBreakdownInput,
  ApplyBreakdownResult,
  ApplyPolishInput,
  ApplyPolishResult,
  BreakdownRequest,
  DraftDetail,
  JobAccepted,
  PolishRequest,
  ShotDraft,
} from '@storyscript/contracts';
import { startPolish } from '../ai/polish-jobs.ts';
import { startBreakdown } from '../ai/jobs.ts';
import type { AppDeps } from '../deps.ts';
import { listDrafts } from '../db/repos/draft.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { applyBreakdown, discardDraft, draftDetail } from '../services/drafts.ts';
import { applyPolish } from '../services/polish.ts';
import { ensuringBoards } from '../services/boards/boards.ts';

/** AI breakdown (FR-03) and S3a polish: request → job → draft → review → apply / discard. */
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

  // S3a polish: shots → job → draft → review → apply in place
  app.post(Api.requestPolish.path, async (c) => {
    const input = await parseBody(c, PolishRequest);
    const job = startPolish(deps, input);
    return respond(c, JobAccepted, { job_id: job.id }, 202);
  });

  app.post(Api.applyPolish.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, ApplyPolishInput);
    // like a manual edit: boards are not redrawn here (the board page shows they are out of date)
    return respond(c, ApplyPolishResult, applyPolish(db(), id, input));
  });
}
