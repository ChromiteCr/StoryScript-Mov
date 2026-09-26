import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';

/**
 * Development mode: Vite runs in middleware mode on the same port as the API
 * (same origin, so the Origin/cookie checks hold). HMR uses its own websocket
 * on port+1, bound to 127.0.0.1. Only available from a source checkout.
 */

/** <repo>/apps/web, resolved from this file (apps/server/src/dev/vite.ts). */
export function defaultWebRoot(): string {
  return fileURLToPath(new URL('../../../web', import.meta.url));
}

export interface ViteDevOptions {
  /** port of the main server; HMR listens on port + 1 unless hmrPort is given */
  port: number;
  hmrPort?: number;
  webRoot?: string;
}

export async function createViteDev(opts: ViteDevOptions): Promise<ViteDevServer> {
  const root = opts.webRoot ?? defaultWebRoot();
  const configFile = join(root, 'vite.config.ts');
  if (!existsSync(configFile)) {
    throw new Error(
      `开发模式需要前端的 Vite 配置文件，但没有找到：${configFile}\n` +
        '请确认在源码仓库中运行（npm run dev），且 apps/web 已包含 vite.config.ts；已安装的发布包不支持 --dev。',
    );
  }
  let vite: typeof import('vite');
  try {
    vite = await import('vite');
  } catch {
    throw new Error('开发模式需要 vite（devDependency），请在仓库根目录运行 npm ci 后重试。');
  }
  return vite.createServer({
    root,
    configFile,
    appType: 'spa',
    server: {
      middlewareMode: true,
      ws: { host: '127.0.0.1', port: opts.hmrPort ?? opts.port + 1 },
    },
  });
}
