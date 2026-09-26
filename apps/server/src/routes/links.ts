import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, CreateLinkInput, ReviewLinkInput, ShotMediaLink } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { createManualLink, listLinks, reviewLink } from '../services/media/links.ts';

/** Shot ↔ media links (FR-09): manual candidates, confirm / reject / unlink with revision checks. */
export function registerLinkRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.listLinks.path, (c) => respond(c, z.array(ShotMediaLink), listLinks(db())));

  app.post(Api.createLink.path, async (c) => {
    const input = await parseBody(c, CreateLinkInput);
    const r = createManualLink(db(), input);
    return respond(c, ShotMediaLink, r.link, r.created ? 201 : 200);
  });

  app.patch(Api.reviewLink.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, ReviewLinkInput);
    return respond(c, ShotMediaLink, reviewLink(db(), id, input));
  });
}
