import { homedir } from 'node:os';
import type { Hono } from 'hono';
import { Api, type HealthInfo, type SiteInfo } from '@storyscript/contracts';
import { providerFlags } from '../config/providers.ts';
import { sqliteVersion } from '../db/port.ts';
import type { AppDeps } from '../deps.ts';
import { APP_VERSION } from '../version.ts';

/** GET /api/v1/health — environment + capability flags (never secrets). */
export function registerHealthRoutes(app: Hono, deps: AppDeps): void {
  // public: the sign-in screen needs to know whether this is a hosted server
  app.get(Api.site.path, (c) => c.json({ data: { hosted: false, name: 'StoryScript-Mov' } satisfies SiteInfo }));

  app.get(Api.health.path, async (c) => {
    // a hosted server never touches footage: no tool probing, no server paths
    const none = { path: null, version: null };
    const tools = deps.hosted ? { ffmpeg: none, ffprobe: none, h264_encoders: [] } : await deps.tools();
    const data: HealthInfo = {
      app_version: APP_VERSION,
      node: process.versions.node,
      sqlite: sqliteVersion(),
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      encoders: tools.h264_encoders,
      project_open: deps.projectSession.isOpen,
      ...providerFlags(deps.stateDir, deps.env),
      demo: deps.demo,
      home_dir: deps.hosted ? '' : homedir(),
      hosted: deps.hosted !== null,
      team_name: deps.hosted?.name ?? null,
    };
    return c.json({ data });
  });
}
