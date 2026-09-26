import type { Hono } from 'hono';
import { z } from 'zod';
import { Api, Constraint, ConstraintInput, Uuid } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { listConstraints } from '../db/repos/constraint.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { createConstraint, deleteConstraint } from '../services/plan/constraints.ts';

/** Schedule constraints (FR-06). Only confirmed ones take part in planning. */
export function registerConstraintRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.listConstraints.path, (c) => respond(c, z.array(Constraint), listConstraints(db())));

  app.post(Api.createConstraint.path, async (c) => {
    const input = await parseBody(c, ConstraintInput);
    return respond(c, Constraint, createConstraint(db(), input), 201);
  });

  app.delete(Api.deleteConstraint.path, (c) => respond(c, z.object({ id: Uuid }), deleteConstraint(db(), idParam(c))));
}
