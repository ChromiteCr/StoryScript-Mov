import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, CreateEntityInput, Entity, EntityDraftSelection, JobAccepted, UpdateEntityInput } from '@storyscript/contracts';
import { startEntityExtraction } from '../ai/jobs.ts';
import type { AppDeps } from '../deps.ts';
import { listEntities } from '../db/repos/entity.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { applyEntityDraft, createEntity, updateEntity } from '../services/entities.ts';

/** Entities (FR-02): manual CRUD without a key; LLM extraction → draft → apply with edits. */
export function registerEntityRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.listEntities.path, (c) => respond(c, z.array(Entity), listEntities(db())));

  app.post(Api.createEntity.path, async (c) => {
    const input = await parseBody(c, CreateEntityInput);
    return respond(c, Entity, createEntity(db(), input), 201);
  });

  app.patch(Api.updateEntity.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, UpdateEntityInput);
    return respond(c, Entity, updateEntity(db(), id, input));
  });

  app.post(Api.extractEntities.path, (c) => {
    const job = startEntityExtraction(deps);
    return respond(c, JobAccepted, { job_id: job.id }, 202);
  });

  app.post(Api.applyEntityDraft.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, EntityDraftSelection);
    return respond(c, z.array(Entity), applyEntityDraft(db(), id, input));
  });
}
