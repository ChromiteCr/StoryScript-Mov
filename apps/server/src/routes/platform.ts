import type { Hono } from 'hono';
import { Api, type ChooseFolderResult } from '@storyscript/contracts';
import type { AppDeps } from '../deps.ts';

/** POST /api/v1/platform/choose-folder — native picker (macOS); {path:null} on cancel or elsewhere. */
export function registerPlatformRoutes(app: Hono, deps: AppDeps): void {
  app.post(Api.chooseFolder.path, async (c) => {
    const data: ChooseFolderResult = { path: await deps.chooseFolder() };
    return c.json({ data });
  });
}
