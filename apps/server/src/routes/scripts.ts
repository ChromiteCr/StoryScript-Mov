import type { Hono } from 'hono';
import { z } from 'zod';
import {
  Api,
  CurrentScript,
  Scene,
  ScriptImportResult,
  ScriptInput,
  ScriptPreview,
  ScriptVersionSummary,
  UpdateSceneInput,
} from '@storyscript/contracts';
import { parseScript } from '@storyscript/core';
import type { AppDeps } from '../deps.ts';
import { getEntity } from '../db/repos/entity.ts';
import { latestScriptVersion, listScenes, listVersionSummaries, stripSort, updateSceneRow } from '../db/repos/script.ts';
import { AppError } from '../http/errors.ts';
import { idParam, respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { importScript } from '../services/scripts.ts';
import { requireScene } from '../services/shots.ts';

/** Script import (FR-02): preview (pure), import (new immutable version + relink), current, versions, scene edits. */
export function registerScriptRoutes(app: Hono, deps: AppDeps): void {
  const db = () => deps.projectSession.require().db;

  app.post(Api.previewScript.path, async (c) => {
    const input = await parseBody(c, ScriptInput);
    return respond(
      c,
      ScriptPreview,
      parseScript(input.text, input.format, input.heading_overrides, { shotOverrides: input.shot_overrides, untitledScene: input.source_name }),
    );
  });

  app.post(Api.importScript.path, async (c) => {
    const input = await parseBody(c, ScriptInput);
    return respond(c, ScriptImportResult, importScript(db(), input), 201);
  });

  app.get(Api.currentScript.path, (c) => {
    const d = db();
    const version = latestScriptVersion(d);
    return respond(c, CurrentScript.nullable(), version ? { version, scenes: listScenes(d, version.id).map(stripSort) } : null);
  });

  app.get(Api.scriptVersions.path, (c) => respond(c, z.array(ScriptVersionSummary), listVersionSummaries(db())));

  app.patch(Api.updateScene.path, async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, UpdateSceneInput);
    const d = db();
    const scene = d.tx(() => {
      requireScene(d, id);
      if (input.location_entity_id) {
        const e = getEntity(d, input.location_entity_id);
        if (!e || e.type !== 'location') throw new AppError('VALIDATION_ERROR', 'location_entity_id 必须是一个地点实体', 400);
      }
      updateSceneRow(d, id, input);
      return stripSort(requireScene(d, id));
    });
    return respond(c, Scene, scene);
  });
}
