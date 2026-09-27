import { homedir } from 'node:os';
import type { Hono } from 'hono';
import { Api, type HealthInfo } from '@storyscript/contracts';
import { providerFlags } from '../config/providers.ts';
import { sqliteVersion } from '../db/port.ts';
import type { AppDeps } from '../deps.ts';
import { APP_VERSION } from '../version.ts';

/** GET /api/v1/health — environment + capability flags (never secrets). */
export function registerHealthRoutes(app: Hono, deps: AppDeps): void {
  app.get(Api.health.path, async (c) => {
    const tools = await deps.tools();
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
      home_dir: homedir(),
    };
    return c.json({ data });
  });
}
