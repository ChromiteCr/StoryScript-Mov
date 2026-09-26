import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, CreateTakeInput, Take, UpdateTakeInput } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { listTakes } from '../db/repos/take.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { createTake, updateTake } from '../services/media/takes.ts';

/** Set log (FR-07). Writes return only after their transaction committed. */
export function registerTakeRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.listTakes.path, (c) => respond(c, z.array(Take), listTakes(db())));

  app.post(Api.createTake.path, async (c) => {
    const input = await parseBody(c, CreateTakeInput);
    return respond(c, Take, createTake(db(), input), 201);
  });

  app.patch(Api.updateTake.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, UpdateTakeInput);
    return respond(c, Take, updateTake(db(), id, input));
  });
}
