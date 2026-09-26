import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, CreateSetupInput, DeriveSetupsInput, Setup, UpdateSetupInput, Uuid } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { listSetups } from '../db/repos/setup.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { createSetup, deleteSetup, deriveSetups, updateSetup } from '../services/plan/setups.ts';

/** Setups (FR-06): auto grouping by location + camera bucket, manual edits, shot membership. */
export function registerSetupRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.listSetups.path, (c) => respond(c, z.array(Setup), listSetups(db())));

  // static path before /setups/:id
  app.post(Api.deriveSetups.path, async (c) => {
    const input = await parseBody(c, DeriveSetupsInput);
    return respond(c, z.array(Setup), deriveSetups(db(), input));
  });

  app.post(Api.createSetup.path, async (c) => {
    const input = await parseBody(c, CreateSetupInput);
    return respond(c, Setup, createSetup(db(), input), 201);
  });

  app.patch(Api.updateSetup.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, UpdateSetupInput);
    return respond(c, Setup, updateSetup(db(), id, input));
  });

  app.delete(Api.deleteSetup.path, (c) => respond(c, z.object({ id: Uuid }), deleteSetup(db(), idParam(c))));
}
