// Copies the built frontend (apps/web/dist) into the published server package (apps/server/web).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const dest = fileURLToPath(new URL('../apps/server/web', import.meta.url));
if (!existsSync(`${src}/index.html`)) {
  console.error('apps/web/dist 不存在，请先运行 npm run build -w @storyscript/web');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`copied ${src} -> ${dest}`);
