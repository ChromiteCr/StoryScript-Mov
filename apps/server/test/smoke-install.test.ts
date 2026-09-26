import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

/**
 * Install paths under a temporary HOME (SPEC §7, PLAN M9) — slow: it builds
 * the app, packs it, installs the tarball with a fresh npm cache, clones the
 * repo and runs `npm ci` + `npm start`. Everything happens in
 * scripts/smoke-install.mjs; this test runs it and checks its report.
 *
 * Runs by default on CI (env CI set), otherwise only with STORYSCRIPT_SMOKE=1;
 * STORYSCRIPT_SMOKE=0 turns it off everywhere. Note that the source path
 * clones the committed HEAD, so uncommitted changes are not part of it.
 *
 *   STORYSCRIPT_SMOKE=1 npx vitest run apps/server/test/smoke-install.test.ts
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'smoke-install.mjs');
const flag = process.env.STORYSCRIPT_SMOKE;
const ENABLED = flag === '1' || (flag !== '0' && Boolean(process.env.CI));

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
  pack: { tarball: string; files: string[]; doctor_exit: number; doctor: string[]; server: ServerReport } | null;
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
  test('npm pack → npx <tgz> doctor/start; git clone → npm ci → npm start; runtime.json cleaned on SIGINT', async () => {
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
      expect(f, f).toMatch(/^(dist\/|web\/|package\.json$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/);
      expect(f, f).not.toMatch(/\.map$|(^|\/)\.env|(^|\/)(src|test|fixtures)\/|\.test\.|\.ts$/);
    }
    for (const s of [pack.server, report.source!.server]) {
      expect(s.runtime_cleaned).toBe(true);
      expect(s.node).toBe(process.versions.node);
      expect(s.sqlite).toMatch(/^3\.\d+\.\d+$/);
    }
    expect(report.source!.commit).toMatch(/^[0-9a-f]{40}$/);
  }, 40 * 60_000);
});
