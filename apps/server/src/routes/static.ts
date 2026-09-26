import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/**
 * Production frontend: files from `webDir` (the Vite build), SPA fallback to
 * index.html for extension-less paths. No cookie needed; the Host guard still applies.
 */
export function registerStaticRoutes(app: Hono, webDir: string): void {
  const hasBuild = existsSync(join(webDir, 'index.html'));
  const isApi = (path: string) => path === '/api' || path.startsWith('/api/');

  if (!hasBuild) {
    app.get('*', (c) => {
      if (isApi(c.req.path)) return c.notFound();
      return c.html(
        '<!doctype html><meta charset="utf-8"><title>StoryScript-Mov</title>' +
          '<p>前端尚未构建。源码运行请先执行 <code>npm run build</code>，开发时请使用 <code>npm run dev</code>。</p>',
        503,
      );
    });
    return;
  }

  const files = serveStatic({ root: webDir });
  const index = serveStatic({ root: webDir, path: 'index.html' });
  // Vite puts content-hashed files under /assets/
  const cacheControl = (path: string) =>
    path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';

  app.use('*', async (c, next) => {
    if (isApi(c.req.path) || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return next();
    const res = await files(c, next);
    if (res instanceof Response && res.ok) res.headers.set('Cache-Control', cacheControl(c.req.path));
    return res;
  });

  // SPA fallback: only for "page" paths, never for missing assets
  app.get('*', async (c, next) => {
    const last = c.req.path.split('/').pop() ?? '';
    if (isApi(c.req.path) || last.includes('.')) return next();
    const res = await index(c, next);
    if (res instanceof Response && res.ok) res.headers.set('Cache-Control', 'no-cache');
    return res;
  });
}
