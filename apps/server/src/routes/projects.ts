import type { Hono } from 'hono';
import { Api, CreateProjectInput, OpenProjectInput } from '@storyscript/contracts';
import { readConfig } from '../config/paths.ts';
import type { AppDeps } from '../deps.ts';
import { parseBody } from '../http/validate.ts';

/** Project lifecycle: recent list, create, open, close, current. */
export function registerProjectRoutes(app: Hono, deps: AppDeps): void {
  const session = deps.projectSession;

  app.get(Api.recentProjects.path, (c) => c.json({ data: readConfig(deps.stateDir).recent_projects }));

  app.post(Api.createProject.path, async (c) => {
    const input = await parseBody(c, CreateProjectInput);
    return c.json({ data: await session.create(input) }, 201);
  });

  app.post(Api.openProject.path, async (c) => {
    const { dir } = await parseBody(c, OpenProjectInput);
    return c.json({ data: await session.open(dir) });
  });

  app.post(Api.closeProject.path, async (c) => {
    await session.close();
    return c.body(null, 204);
  });

  app.get(Api.currentProject.path, (c) => c.json({ data: session.require().project() }));
}
