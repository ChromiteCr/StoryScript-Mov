import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { demoAssetsAt, readDemoMedia } from '../src/demo/assets.ts';

/**
 * Install paths under a temporary HOME (SPEC §7, PLAN M9) — slow: it builds
 * the app, packs it, installs the tarball with a fresh npm cache, clones the
 * repo and runs `npm ci` + `npm start`. Everything happens in
 * scripts/smoke-install.mjs; this test runs it and checks its report.
 *
 * Opt-in: it only runs with STORYSCRIPT_SMOKE=1, so a plain `npx vitest run`
 * (and `npm test`) skips it; CI runs it as a separate step with the variable
 * set. Note that the source path clones the committed HEAD, so uncommitted
 * changes are not part of it.
 *
 *   STORYSCRIPT_SMOKE=1 npx vitest run apps/server/test/smoke-install.test.ts
 *
 * The package-contents policy itself (packProblems) is checked by the fast
 * test at the bottom on every run.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'smoke-install.mjs');
const ENABLED = process.env.STORYSCRIPT_SMOKE === '1';

interface ServerReport {
  port: number;
  app_version: string;
  node: string;
  sqlite: string;
  runtime_cleaned: boolean;
}

interface SmokeReport {
  ok: boolean;
  error: string | null;
  fresh_cache: boolean;
  pack: { tarball: string; files: string[]; doctor_exit: number; doctor: string[]; server: ServerReport; demo: ServerReport } | null;
  source: { commit: string; server: ServerReport } | null;
}

const tmp = mkdtempSync(join(tmpdir(), 'ssm-smoke-report-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function runSmoke(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe.skipIf(!ENABLED)('install paths under a temporary HOME (slow)', () => {
  test('npm pack → npx <tgz> doctor/start/--demo; git clone → npm ci → npm start; runtime.json cleaned on SIGINT', async () => {
    const reportFile = join(tmp, 'report.json');
    const { code, out } = await runSmoke([`--report=${reportFile}`]);
    console.log(`[measure] smoke-install:\n${out.split('\n').filter((l) => l.startsWith('[smoke]')).join('\n')}`);
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as SmokeReport;
    expect(report.error, out).toBeNull();
    expect(code, out).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.fresh_cache).toBe(true);

    const pack = report.pack!;
    expect(pack.doctor_exit).toBe(0);
    expect(pack.doctor.some((l) => l.startsWith('[正常] 前端产物'))).toBe(true);
    for (const f of ['package.json', 'README.md', 'LICENSE', 'dist/cli.mjs', 'web/index.html']) expect(pack.files).toContain(f);
    expect(pack.files.some((f) => f === 'THIRD_PARTY_NOTICES.md' || f === 'dist/THIRD_PARTY_NOTICES.md')).toBe(true);
    for (const f of pack.files) {
      expect(f, f).toMatch(/^(dist\/|web\/|demo-data\/|package\.json$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/);
      // demo-data keeps the source layout (fixtures/…); its files are whitelisted by packProblems
      if (!f.startsWith('demo-data/')) expect(f, f).not.toMatch(/\.map$|(^|\/)\.env|(^|\/)(src|test|fixtures)\/|\.test\.|\.ts$/);
    }
    expect(pack.files).toContain('demo-data/fixtures/scripts/01-bookshop.txt');
    expect(pack.demo.runtime_cleaned).toBe(true);
    for (const s of [pack.server, report.source!.server]) {
      expect(s.runtime_cleaned).toBe(true);
      expect(s.node).toBe(process.versions.node);
      expect(s.sqlite).toMatch(/^3\.\d+\.\d+$/);
    }
    expect(report.source!.commit).toMatch(/^[0-9a-f]{40}$/);
  }, 40 * 60_000);
});

describe('npm pack file-list policy (fast, always on)', () => {
  // a variable specifier: the script is plain .mjs without type declarations
  const load = async () => (await import(pathToFileURL(SCRIPT).href)) as { packProblems: (files: string[]) => string[] };
  const DEMO = [
    'demo-data/fixtures/scripts/01-bookshop.txt',
    'demo-data/fixtures/replay/01-bookshop.entities-v1.json',
    'demo-data/samples/demo-media/media.json',
    'demo-data/samples/demo-media/posters/A001C003.jpg',
    'demo-data/samples/demo-media/clips/A001C003.mov',
    'demo-data/samples/demo-media/clips/notes.txt',
  ];
  const GOOD = ['package.json', 'README.md', 'LICENSE', 'dist/cli.mjs', 'dist/THIRD_PARTY_NOTICES.md', 'web/index.html', 'web/assets/index-abc.js', 'web/assets/index-abc.css', ...DEMO];

  test('the expected layout passes', async () => {
    const { packProblems } = await load();
    expect(packProblems(GOOD)).toEqual([]);
    expect(packProblems([...GOOD.filter((f) => f !== 'dist/THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md'])).toEqual([]);
  });

  test.each([
    ['source map', 'dist/cli.mjs.map'],
    ['.env', 'dist/.env'],
    ['TypeScript source', 'src/cli.ts'],
    ['test', 'dist/queue.test.mjs'],
    ['fixtures', 'web/fixtures/a.txt'],
    ['stray top-level file', 'tsdown.config.ts'],
    ['tarball', 'dist/old.tgz'],
    ['script source under demo-data', 'demo-data/fixtures/scripts/seed.ts'],
    ['database under demo-data', 'demo-data/samples/demo-media/project.sqlite'],
    ['other fixtures under demo-data', 'demo-data/fixtures/scripts/02-last-train.fountain'],
  ])('rejects a %s (%s)', async (_what, file) => {
    const { packProblems } = await load();
    expect(packProblems([...GOOD, file]).length).toBeGreaterThan(0);
  });

  test.each(['README.md', 'LICENSE', 'dist/cli.mjs', 'web/index.html', 'dist/THIRD_PARTY_NOTICES.md', 'demo-data/fixtures/scripts/01-bookshop.txt', 'demo-data/samples/demo-media/media.json'])('requires %s', async (missing) => {
    const { packProblems } = await load();
    expect(packProblems(GOOD.filter((f) => f !== missing))).not.toEqual([]);
  });
});

describe('packaged demo data (fast, always on)', () => {
  test('assembleDemoData yields what the --demo loader needs, and nothing the pack policy rejects', async () => {
    const { assembleDemoData } = (await import(pathToFileURL(fileURLToPath(new URL('../../../scripts/demo-data.mjs', import.meta.url))).href)) as {
      assembleDemoData: (root: string, dest: string) => string[];
    };
    const { packProblems } = (await import(pathToFileURL(SCRIPT).href)) as { packProblems: (files: string[]) => string[] };
    const dest = mkdtempSync(join(tmpdir(), 'ssm-demo-data-'));
    try {
      const copied = assembleDemoData(fileURLToPath(new URL('../../../', import.meta.url)), dest);
      const assets = demoAssetsAt(dest);
      expect(assets).not.toBeNull();
      expect(assets!.mediaDir).not.toBeNull();
      const manifest = readDemoMedia(assets!.mediaDir!);
      expect(manifest.clips.length).toBe(6);
      expect(manifest.clips_included).toBe(true);
      for (const c of manifest.clips) {
        expect(copied).toContain(`samples/demo-media/clips/${c.rel_path}`);
        if (c.poster) expect(copied).toContain(`samples/demo-media/${c.poster}`);
      }
      const packed = copied.map((f) => `demo-data/${f}`);
      const base = ['package.json', 'README.md', 'LICENSE', 'dist/cli.mjs', 'dist/THIRD_PARTY_NOTICES.md', 'web/index.html', 'web/assets/index-abc.js'];
      expect(packProblems([...base, ...packed])).toEqual([]);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
