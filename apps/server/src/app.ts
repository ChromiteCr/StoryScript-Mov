import { Hono } from 'hono';
import { chooseFolder } from './adapters/platform/choose-folder.ts';
import { Api } from '@storyscript/contracts';
import type { AppDeps, HostedTeam } from './deps.ts';
import { detectTools, type ToolsInfo } from './diagnostics.ts';
import { errorBody, onError } from './http/errors.ts';
import { ProjectSession } from './project/session.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerPlatformRoutes } from './routes/platform.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerSessionRoutes } from './routes/session.ts';
import { registerStaticRoutes } from './routes/static.ts';
import { publicOnlyFetch } from './security/egress.ts';
import { authGuard, headersMiddleware, hostGuard, originGuard, type ServerMode } from './security/guards.ts';
import { SessionStore } from './security/sessions.ts';
import { registerDraftRoutes } from './routes/drafts.ts';
import { registerEntityRoutes } from './routes/entities.ts';
import { registerJobRoutes } from './routes/jobs.ts';
import { registerScriptRoutes } from './routes/scripts.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerShotRoutes } from './routes/shots.ts';
import { registerResourceRoutes } from './routes/resources.ts';
import { registerSetupRoutes } from './routes/setups.ts';
import { registerConstraintRoutes } from './routes/constraints.ts';
import { registerPlanRoutes } from './routes/plans.ts';
import { registerTakeRoutes } from './routes/takes.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerLinkRoutes } from './routes/links.ts';
import { registerCoverageRoutes } from './routes/coverage.ts';
import { registerBoardRoutes } from './routes/boards.ts';
import { registerRasterRoutes } from './routes/rasters.ts';
import { registerExportRoutes } from './routes/export.ts';

export interface CreateAppOptions {
  mode: ServerMode;
  /** the port the server listens on (Host/Origin allow-list) */
  port: number;
  /** launch token printed as /#t=<token> */
  token: string;
  /** Vite build output served in production */
  webDir: string;
  stateDir: string;
  demo?: boolean;
  env?: NodeJS.ProcessEnv;
  projectSession?: ProjectSession;
  tools?: () => Promise<ToolsInfo>;
  chooseFolder?: () => Promise<string | null>;
  /**
   * Hosted server mode: this instance serves one team behind the hosted
   * gateway (hosted/gateway.ts), which already checked Host, Origin and the
   * team session; the static frontend is served by the gateway too.
   */
  hosted?: HostedTeam;
  /** tests: the transport to model services (default: global fetch; hosted: public https only) */
  fetch?: typeof fetch;
}

export interface AppHandle {
  app: Hono;
  sessions: SessionStore;
  projectSession: ProjectSession;
  deps: AppDeps;
}

const isApiPath = (path: string) => path === '/api' || path.startsWith('/api/');

/** What a team on a shared server must not do; registered before the real routes, so they never run. */
const HOSTED_DENIED: { routes: (keyof typeof Api)[]; message: string }[] = [
  {
    routes: ['createProject', 'openProject', 'closeProject'],
    message: '服务器版中每个队伍固定使用一个项目，不能新建、打开或关闭其他项目。',
  },
  { routes: ['chooseFolder'], message: '服务器版不能在服务器上弹出文件夹选择框。' },
  {
    routes: ['addRoot', 'scanRoot', 'checkRoot'],
    message: '服务器版不读取服务器上的目录。素材请在浏览器里从本机添加。',
  },
];

function registerHostedLimits(app: Hono): void {
  for (const { routes, message } of HOSTED_DENIED) {
    for (const r of routes) app.on(Api[r].method, Api[r].path, (c) => c.json(errorBody('FORBIDDEN', message), 403));
  }
  app.get(Api.recentProjects.path, (c) => c.json({ data: [] }));
}

/**
 * The Hono application: security middleware first (headers → Host → Origin →
 * cookie), then /api/v1 routes, then (production only) the static frontend.
 */
export function createApp(opts: CreateAppOptions): AppHandle {
  const sessions = new SessionStore(opts.token);
  const projectSession = opts.projectSession ?? new ProjectSession(opts.stateDir);
  const deps: AppDeps = {
    mode: opts.mode,
    port: opts.port,
    stateDir: opts.stateDir,
    demo: opts.demo ?? false,
    env: opts.env ?? process.env,
    sessions,
    projectSession,
    tools: opts.tools ?? (() => detectTools()),
    chooseFolder: opts.chooseFolder ?? (() => chooseFolder()),
    hosted: opts.hosted ?? null,
    fetch: opts.fetch ?? (opts.hosted ? publicOnlyFetch : globalThis.fetch),
  };

  const app = new Hono();
  app.onError(onError);
  app.notFound((c) =>
    isApiPath(c.req.path) ? c.json(errorBody('NOT_FOUND', '接口不存在'), 404) : c.text('Not Found', 404),
  );

  app.use('*', headersMiddleware(opts.mode));
  if (opts.hosted) {
    registerHostedLimits(app);
  } else {
    app.use('*', hostGuard(opts.port));
    app.use('*', originGuard(opts.port));
    app.use('*', authGuard(sessions));
  }

  registerSessionRoutes(app, deps);
  registerHealthRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerPlatformRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerScriptRoutes(app, deps);
  registerEntityRoutes(app, deps);
  registerShotRoutes(app, deps);
  registerDraftRoutes(app, deps);
  registerJobRoutes(app, deps);
  registerResourceRoutes(app, deps);
  registerSetupRoutes(app, deps);
  registerConstraintRoutes(app, deps);
  registerPlanRoutes(app, deps);
  registerTakeRoutes(app, deps);
  registerMediaRoutes(app, deps);
  registerLinkRoutes(app, deps);
  registerCoverageRoutes(app, deps);
  registerBoardRoutes(app, deps);
  registerRasterRoutes(app, deps);
  registerExportRoutes(app, deps);

  if (opts.mode === 'production' && !opts.hosted) registerStaticRoutes(app, opts.webDir);

  return { app, sessions, projectSession, deps };
}
