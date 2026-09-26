// Assembles the published server package (apps/server) before `tsdown` builds dist/:
//   - the built frontend apps/web/dist → apps/server/web
//   - README.md, LICENSE and THIRD_PARTY_NOTICES.md from the repo root → apps/server/
//     (npm always packs README* and LICENSE*; THIRD_PARTY_NOTICES.md is also copied
//     into dist/ by apps/server/tsdown.config.ts so it ships with the current `files`).
// The copies are build outputs and must not be committed (see .gitignore).
import { copyFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const src = root('apps/web/dist');
const dest = root('apps/server/web');
if (!existsSync(`${src}/index.html`)) {
  console.error('apps/web/dist 不存在，请先运行 npm run build -w @storyscript/web');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`copied ${src} -> ${dest}`);

const PACKAGE_DOCS = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
for (const name of PACKAGE_DOCS) {
  const from = root(name);
  if (!existsSync(from)) {
    console.error(`仓库根目录缺少 ${name}，发布包必须包含它`);
    process.exit(1);
  }
  copyFileSync(from, root(`apps/server/${name}`));
  console.log(`copied ${name} -> apps/server/${name}`);
}
