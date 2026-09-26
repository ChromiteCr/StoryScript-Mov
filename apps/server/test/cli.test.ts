import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { nodeUpgradeHelp, nodeVersionOk } from '../src/node-version.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
// run tsx through this Node binary so a test can blank out PATH
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = join(repoRoot, 'apps', 'server', 'src', 'cli.ts');

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ssm-cli-'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsxCli, cli, ...args],
      { cwd: repoRoot, env: { ...process.env, STORYSCRIPT_HOME: join(home, 'state'), ...env }, timeout: 30_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('CLI', () => {
  test('doctor exits 0 under a temporary STORYSCRIPT_HOME', async () => {
    const r = await run(['doctor']);
    console.log(`[measure] doctor output:\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[正常\] Node\.js \d+\.\d+\.\d+/);
    expect(r.stdout).toMatch(/\[正常\] SQLite 3\.\d+\.\d+/);
    expect(r.stdout).toContain('状态目录可写');
    expect(existsSync(join(home, 'state'))).toBe(true);
    expect(r.stderr).not.toContain('ExperimentalWarning');
  });

  test('doctor still exits 0 when ffmpeg cannot be found (warning only)', async () => {
    const r = await run(['doctor'], {
      PATH: '/nonexistent',
      STORYSCRIPT_FFMPEG: '/nonexistent/ffmpeg',
      STORYSCRIPT_FFPROBE: '/nonexistent/ffprobe',
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('[警告] 未找到 ffmpeg');
  });

  test('open without a running server exits 1 with a hint', async () => {
    const r = await run(['open', '--no-open']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('服务未运行');
  });

  test('--help exits 0; unknown command / bad flag exit 2', async () => {
    expect((await run(['--help'])).code).toBe(0);
    expect((await run(['frobnicate'])).code).toBe(2);
    expect((await run(['start', '--bogus'])).code).toBe(2);
    expect((await run(['start', '--port', 'abc'])).code).toBe(2);
  });
});

describe('Node version shim', () => {
  test.each([
    ['24.15.0', true],
    ['24.16.1', true],
    ['26.10.0', true],
    ['v24.15.0', true],
    ['24.14.9', false],
    ['22.20.0', false],
    ['18.0.0', false],
  ])('%s → %s', (v, ok) => {
    expect(nodeVersionOk(v)).toBe(ok);
  });

  test('upgrade help mentions brew, fnm, volta and keg-only PATH', () => {
    const text = nodeUpgradeHelp('22.0.0');
    for (const s of ['brew install node', 'fnm', 'volta', 'keg-only', 'PATH', '24.15']) expect(text).toContain(s);
  });
});
