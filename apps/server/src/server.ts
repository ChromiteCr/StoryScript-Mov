import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import type { ViteDevServer } from 'vite';
import { createApp } from './app.ts';
import { clearRuntime, ensureStateDir, resolveStateDir, writeRuntime } from './config/paths.ts';
import { errorBody } from './http/errors.ts';
import { ProjectSession } from './project/session.ts';
import { isAllowedHost, securityHeaders, type ServerMode } from './security/guards.ts';
import { generateToken } from './security/token.ts';

export const LISTEN_HOST = '127.0.0.1';

export interface StartServerOptions {
  mode: ServerMode;
  /** 0 (default) = random free port */
  port?: number;
  /** open the browser after start */
  open?: boolean;
  demo?: boolean;
  stateDir?: string;
  webDir?: string;
  /** development only: Vite root (default <repo>/apps/web) */
  devWebRoot?: string;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  /** launch link including the token fragment */
  url: string;
  token: string;
  stateDir: string;
  close(): Promise<void>;
}

/**
 * Built frontend: <pkg>/web when installed from npm, <repo>/apps/web/dist in a
 * checkout. A checkout can hold both (apps/server/web is the packaging copy
 * `npm run build` makes); the newer build wins, so rebuilding only the web app
 * is never shadowed by an old packaging copy.
 */
export function resolveWebDir(
  candidates = [fileURLToPath(new URL('../web', import.meta.url)), fileURLToPath(new URL('../../web/dist', import.meta.url))],
): string {
  const built = candidates
    .filter((d) => existsSync(join(d, 'index.html')))
    .map((d) => ({ d, t: statSync(join(d, 'index.html')).mtimeMs }));
  built.sort((a, b) => b.t - a.t);
  return built[0]?.d ?? candidates[0]!;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(err.code === 'EADDRINUSE' ? new Error(`端口 ${port} 已被占用，请换一个端口（--port）或省略以随机分配`) : err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: LISTEN_HOST });
  });
}

function sendForbiddenHost(res: ServerResponse): void {
  const body = JSON.stringify(errorBody('FORBIDDEN', '拒绝访问：只接受来自 127.0.0.1 或 localhost 的请求'));
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const isApiUrl = (url: string) => url === '/api' || url.startsWith('/api/') || url.startsWith('/api?');

/**
 * node:http server on 127.0.0.1 only. Host is checked before anything else;
 * /api/** goes to Hono; other requests go to Vite (development, GET/HEAD only)
 * or to Hono's static handler (production).
 */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const stateDir = ensureStateDir(opts.stateDir ?? resolveStateDir());
  const token = generateToken();

  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(503, { 'Retry-After': '1' });
    res.end();
  };
  const server = createServer((req, res) => handler(req, res));
  const port = await listen(server, opts.port ?? 0);

  const projectSession = new ProjectSession(stateDir);
  let vite: ViteDevServer | null = null;
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await vite?.close();
      projectSession.closeNow();
      clearRuntime(stateDir);
    })());

  let url: string;
  try {
    const { app, deps } = createApp({
      mode: opts.mode,
      port,
      token,
      webDir: opts.webDir ?? resolveWebDir(),
      stateDir,
      demo: opts.demo ?? false,
      projectSession,
    });
    // --demo: (re)build the demo project under the state dir and open it before the link is printed
    if (opts.demo) {
      const { openDemoProject } = await import('./demo/seed.ts');
      await openDemoProject(deps, { log });
    }
    const hono = getRequestListener(app.fetch);

    if (opts.mode === 'development') {
      const { createViteDev } = await import('./dev/vite.ts');
      vite = await createViteDev({ port, webRoot: opts.devWebRoot });
    }
    const devVite = vite;
    const devHeaders = Object.entries(securityHeaders(opts.mode));

    handler = (req, res) => {
      if (!isAllowedHost(req.headers.host, port)) return sendForbiddenHost(res);
      const reqUrl = req.url ?? '/';
      if (devVite && !isApiUrl(reqUrl) && (req.method === 'GET' || req.method === 'HEAD')) {
        for (const [k, v] of devHeaders) res.setHeader(k, v);
        devVite.middlewares(req, res, () => {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
        });
        return;
      }
      void hono(req, res);
    };

    writeRuntime(stateDir, { port, token, pid: process.pid, started_at: new Date().toISOString() });
    url = `http://127.0.0.1:${port}/#t=${token}`;
  } catch (err) {
    await close();
    throw err;
  }

  log(`StoryScript-Mov 已启动（${opts.mode === 'development' ? '开发模式' : '生产模式'}${opts.demo ? '，演示' : ''}）`);
  log(`在浏览器中打开：${url}`);
  log('按 Ctrl+C 退出。');

  if (opts.open) {
    try {
      const { default: open } = await import('open');
      await open(url);
    } catch {
      log('无法自动打开浏览器，请手动复制上面的链接。');
    }
  }

  return { port, url, token, stateDir, close };
}
