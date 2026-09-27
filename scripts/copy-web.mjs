// Assembles the published server package (apps/server) before `tsdown` builds dist/:
//   - the built frontend apps/web/dist → apps/server/web
//   - the `--demo` inputs (sample script, replay recordings, demo footage) → apps/server/demo-data
//   - README.md (relative links made absolute), LICENSE and THIRD_PARTY_NOTICES.md
//     from the repo root → apps/server/
//     (npm always packs README* and LICENSE*; THIRD_PARTY_NOTICES.md is also copied
//     into dist/ by apps/server/tsdown.config.ts so it ships with the current `files`).
// The copies are build outputs and must not be committed (see .gitignore).
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleDemoData } from './demo-data.mjs';
import { packageReadme } from './package-readme.mjs';

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

const demo = assembleDemoData(root(''), root('apps/server/demo-data'));
console.log(`copied ${demo.length} demo files -> apps/server/demo-data`);

const PACKAGE_DOCS = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
for (const name of PACKAGE_DOCS) {
  const from = root(name);
  if (!existsSync(from)) {
    console.error(`仓库根目录缺少 ${name}，发布包必须包含它`);
    process.exit(1);
  }
  if (name === 'README.md') {
    // relative images and links → GitHub URLs, so they also work on the npm page
    const { repository } = JSON.parse(readFileSync(root('apps/server/package.json'), 'utf8'));
    writeFileSync(root(`apps/server/${name}`), packageReadme(readFileSync(from, 'utf8'), repository.url));
  } else {
    copyFileSync(from, root(`apps/server/${name}`));
  }
  console.log(`copied ${name} -> apps/server/${name}`);
}
