import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { createApp } from '../app.ts';
import { ensureStateDir } from '../config/paths.ts';
import { isPidAlive } from '../project/lock.ts';
import { ProjectSession } from '../project/session.ts';
import { generateToken } from '../security/token.ts';
import { resolveWebDir } from '../server.ts';
import { readHostedConfig, serverConfigPath, teamDir, type HostedConfig } from './config.ts';
import { createGateway, type GatewayTeam } from './gateway.ts';
import { HostedSessions, LoginLimiter } from './sessions.ts';

export interface HostedServer {
  port: number;
  config: HostedConfig;
  close(): Promise<void>;
}

const pidPath = (dataDir: string) => join(dataDir, 'server.pid');

/** pid of a hosted server still running on this data dir, or null. */
export function runningServerPid(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath(dataDir), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Start the hosted server from <data>/server.json: open (or create) every
 * team's project, one app instance per team, and one gateway in front.
 */
export async function startHostedServer(opts: {
  dataDir: string;
  webDir?: string;
  /** tests: override the configured port (0 = random) */
  port?: number;
  log?: (line: string) => void;
}): Promise<HostedServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const loaded = readHostedConfig(opts.dataDir);
  if (!loaded) throw new Error(`找不到或无法读取 ${serverConfigPath(opts.dataDir)}：先运行 storyscript-mov server init`);
  if (loaded.teams.length === 0) throw new Error('还没有队伍：先运行 storyscript-mov server team add <代号> --name <队名>');
  const other = runningServerPid(opts.dataDir);
  if (other) throw new Error(`这个数据目录已经有服务在运行（进程 ${other}）`);

  const webDir = opts.webDir ?? resolveWebDir();
  const sessionsByTeam: ProjectSession[] = [];
  const teams = new Map<string, GatewayTeam>();
  const httpServer = createServer();
  const closeTeams = () => {
    for (const s of sessionsByTeam) s.closeNow();
  };

  try {
    for (const t of loaded.teams) {
      const dir = teamDir(opts.dataDir, t.slug);
      const projectDir = join(dir, 'project');
      const stateDir = ensureStateDir(join(dir, 'state'));
      const projectSession = new ProjectSession(stateDir);
      sessionsByTeam.push(projectSession);
      if (existsSync(join(projectDir, 'project.json'))) await projectSession.open(projectDir);
      else {
        await projectSession.create({ dir: projectDir, name: t.name, timezone: loaded.timezone, default_aspect: '2.39', target_duration_s: null });
      }
      const { app } = createApp({
        mode: 'production',
        port: loaded.port,
        token: generateToken(),
        webDir,
        stateDir,
        projectSession,
        hosted: { slug: t.slug, name: t.name },
      });
      teams.set(t.slug, { name: t.name, fetch: (req, env) => app.fetch(req, env) });
    }
  } catch (err) {
    closeTeams();
    throw err;
  }

  const config: HostedConfig = { ...loaded, port: opts.port ?? loaded.port };
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(503, { 'Retry-After': '1' });
    res.end();
  };
  httpServer.on('request', (req, res) => handler(req, res));
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new Error(`端口 ${config.port} 已被占用`) : err),
    );
    httpServer.listen({ port: config.port, host: config.listen_host }, () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : config.port);
    });
  }).catch((err: unknown) => {
    closeTeams();
    throw err;
  });
  // loopback Host/Origin entries use the real port (tests listen on port 0)
  const running: HostedConfig = { ...config, port };
  const gateway = createGateway({ config: running, teams, sessions: HostedSessions.inDataDir(opts.dataDir), limiter: new LoginLimiter(), webDir });
  handler = getRequestListener(gateway.fetch);
  writeFileSync(pidPath(opts.dataDir), `${process.pid}\n`);

  log(`StoryScript-Mov 服务器版已启动：${running.site_name}`);
  log(`监听 ${running.listen_host}:${port}，对外地址 ${running.public_origin}`);
  log(`队伍 ${running.teams.length} 个：${running.teams.map((t) => `${t.name}（${t.slug}）`).join('、')}`);

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      closeTeams();
      rmSync(pidPath(opts.dataDir), { force: true });
    })());
  return { port, config: running, close };
}
