import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The README in the npm package (scripts/package-readme.mjs): relative images
 * and links become GitHub URLs so they also resolve on the npm page.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const load = async () =>
  (await import(pathToFileURL(`${ROOT}scripts/package-readme.mjs`).href)) as {
    packageReadme: (md: string, repositoryUrl: string) => string;
    githubBases: (repositoryUrl: string) => { blob: string; raw: string };
  };
const REPO = 'git+https://github.com/owner/repo.git';

describe('package README', () => {
  test('relative images → raw files, relative links → GitHub pages; the rest unchanged', async () => {
    const { packageReadme } = await load();
    const md = [
      '![demo](docs/media/hero.gif)',
      'See [the spec](docs/SPEC-v0.1.md) and [English](README.en.md).',
      '![version](https://img.shields.io/badge/version-S1-blue)',
      '[site](https://example.com/x) [top](#quick-start) [mail](mailto:a@b.c)',
    ].join('\n');
    expect(packageReadme(md, REPO).split('\n')).toEqual([
      '![demo](https://raw.githubusercontent.com/owner/repo/main/docs/media/hero.gif)',
      'See [the spec](https://github.com/owner/repo/blob/main/docs/SPEC-v0.1.md) and [English](https://github.com/owner/repo/blob/main/README.en.md).',
      '![version](https://img.shields.io/badge/version-S1-blue)',
      '[site](https://example.com/x) [top](#quick-start) [mail](mailto:a@b.c)',
    ]);
  });

  test('the real README keeps no relative link, with the package repository URL', async () => {
    const { packageReadme, githubBases } = await load();
    const pkg = JSON.parse(readFileSync(`${ROOT}apps/server/package.json`, 'utf8')) as { repository: { url: string } };
    expect(githubBases(pkg.repository.url).raw).toMatch(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main$/);
    const out = packageReadme(readFileSync(`${ROOT}README.md`, 'utf8'), pkg.repository.url);
    expect(out).not.toMatch(/\]\((?!https?:|mailto:|#)[^)]+\)/);
    expect(out).toContain('/docs/media/hero.gif)');
  });
});
