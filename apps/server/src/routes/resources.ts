import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, CreateResourceInput, Resource, UpdateResourceInput, Uuid } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { listResources } from '../db/repos/resource.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { createResource, deleteResource, updateResource } from '../services/plan/resources.ts';

/** Resources (FR-06): performers, locations, equipment with UTC availability windows. */
export function registerResourceRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.listResources.path, (c) => respond(c, z.array(Resource), listResources(db())));

  app.post(Api.createResource.path, async (c) => {
    const input = await parseBody(c, CreateResourceInput);
    return respond(c, Resource, createResource(db(), input), 201);
  });

  app.patch(Api.updateResource.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, UpdateResourceInput);
    return respond(c, Resource, updateResource(db(), id, input));
  });

  app.delete(Api.deleteResource.path, (c) => respond(c, z.object({ id: Uuid }), deleteResource(db(), idParam(c))));
}
