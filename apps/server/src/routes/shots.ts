import type { Hono } from 'hono';
import { z } from 'zod';
import {
  Api,
  ArchiveShotInput,
  CreateShotInput,
  NarrativeOrderInput,
  SetRequirementInput,
  Shot,
  ShotRevision,
  UpdateShotInput,
} from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';
import { listActiveShots, listShotRevisions } from '../db/repos/shot.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { archiveShot, createShot, requireShot, setNarrativeOrder, setRequirement, updateShot } from '../services/shots.ts';
import { ensuringBoard } from '../services/boards/boards.ts';

/** Shots (FR-03 manual operations). All writes return only after the transaction committed. */
export function registerShotRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.get(Api.listShots.path, (c) => respond(c, z.array(Shot), listActiveShots(db())));

  app.post(Api.createShot.path, async (c) => {
    const input = await parseBody(c, CreateShotInput);
    const d = db();
    return respond(c, Shot, d.tx(() => ensuringBoard(d, createShot(d, input))), 201);
  });

  // static path before /shots/:id
  app.put(Api.setNarrativeOrder.path, async (c) => {
    const input = await parseBody(c, NarrativeOrderInput);
    return respond(c, z.array(Shot), setNarrativeOrder(db(), input));
  });

  app.patch(Api.updateShot.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, UpdateShotInput);
    return respond(c, Shot, updateShot(db(), id, input));
  });

  app.post(Api.archiveShot.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, ArchiveShotInput);
    return respond(c, Shot, archiveShot(db(), id, input));
  });

  app.post(Api.setRequirement.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, SetRequirementInput);
    return respond(c, Shot, setRequirement(db(), id, input));
  });

  app.get(Api.shotRevisions.path, (c) => {
    const id = idParam(c);
    const d = db();
    requireShot(d, id);
    return respond(c, z.array(ShotRevision), listShotRevisions(d, id));
  });
}
