import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { isPidAlive } from '../project/lock.ts';
import { resolveWebDir } from '../server.ts';
import { Accounts } from './accounts.ts';
import { hostedConfigExists, readHostedConfig, serverConfigPath, type HostedConfig } from './config.ts';
import { createGateway } from './gateway.ts';
import { Groups } from './groups.ts';
import { mailerFromEnv, type Mailer } from './mail/mailer.ts';
import { SiteDb } from './site-db.ts';
import { TeamRuntime } from './teams.ts';

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
 * Start the hosted server from <data>/server.json and <data>/site.db: open
 * every group's project (one app instance each) and one gateway in front.
 */
export async function startHostedServer(opts: {
  dataDir: string;
  webDir?: string;
  /** tests: override the configured port (0 = random) */
  port?: number;
  log?: (line: string) => void;
  /** tests: a fake mail service; otherwise from the environment */
  mailer?: Mailer;
  now?: () => number;
}): Promise<HostedServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const loaded = readHostedConfig(opts.dataDir);
  if (!loaded) {
    throw new Error(
      hostedConfigExists(opts.dataDir)
        ? `无法读取 ${serverConfigPath(opts.dataDir)}：格式不对，或是旧版（队伍口令）配置。请删除后重新运行 storyscript-mov server init`
        : `找不到 ${serverConfigPath(opts.dataDir)}：先运行 storyscript-mov server init`,
    );
  }
  const other = runningServerPid(opts.dataDir);
  if (other) throw new Error(`这个数据目录已经有服务在运行（进程 ${other}）`);

  const config: HostedConfig = { ...loaded, port: opts.port ?? loaded.port };
  const webDir = opts.webDir ?? resolveWebDir();
  const site = SiteDb.open(opts.dataDir, opts.now);
  const runtime = new TeamRuntime({ dataDir: opts.dataDir, webDir, config });
  const mailer = opts.mailer ?? mailerFromEnv(process.env, config.mail.from);
  const httpServer = createServer();
  const closeAll = () => {
    runtime.closeAll();
    site.close();
  };

  try {
    for (const t of site.listTeams()) await runtime.open(t);
  } catch (err) {
    closeAll();
    throw err;
  }

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
    closeAll();
    throw err;
  });
  // loopback Host/Origin entries use the real port (tests listen on port 0)
  const running: HostedConfig = { ...config, port };
  const accounts = new Accounts({ site, mailer, config: running, now: opts.now });
  const groups = new Groups({ site, runtime, config: running, now: opts.now });
  const gateway = createGateway({ config: running, site, accounts, groups, runtime, webDir });
  handler = getRequestListener(gateway.fetch);
  writeFileSync(pidPath(opts.dataDir), `${process.pid}\n`);

  log(`StoryScript-Mov 服务器版已启动：${running.site_name}`);
  log(`监听 ${running.listen_host}:${port}，对外地址 ${running.public_origin}`);
  log(`账号 ${site.listAccounts().length} 个，小组 ${runtime.size} 个`);
  const mailNote = { resend: `发信：Resend，发件人 ${running.mail.from}`, outbox: '发信：写入发件箱目录（STORYSCRIPT_MAIL_OUTBOX）', none: '发信：未配置（设置环境变量 STORYSCRIPT_RESEND_API_KEY 后重启），暂时不能注册' };
  log(mailNote[mailer.kind]);

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      closeAll();
      rmSync(pidPath(opts.dataDir), { force: true });
    })());
  return { port, config: running, close };
}
