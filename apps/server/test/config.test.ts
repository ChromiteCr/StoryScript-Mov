import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  clearRuntime,
  configPath,
  credentialsPath,
  MAX_RECENT_PROJECTS,
  readConfig,
  readRuntime,
  resolveStateDir,
  runtimePath,
  touchRecentProject,
  writeCredentials,
  writeRuntime,
} from '../src/config/paths.ts';
import { providerFlags } from '../src/config/providers.ts';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ssm-config-'));
  process.env.STORYSCRIPT_HOME = dir;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe('global state directory', () => {
  test('STORYSCRIPT_HOME overrides ~/.config/storyscript-mov', () => {
    expect(resolveStateDir({ STORYSCRIPT_HOME: '/tmp/x' })).toBe('/tmp/x');
    expect(resolveStateDir({})).toBe(join(homedir(), '.config', 'storyscript-mov'));
    expect(resolveStateDir({ STORYSCRIPT_HOME: '  ' })).toBe(join(homedir(), '.config', 'storyscript-mov'));
  });

  test('credentials.json and runtime.json are written 0600 (tightening an existing file)', () => {
    writeFileSync(credentialsPath(dir), '{}', { mode: 0o644 });
    writeCredentials(dir, { llm: { base_url: 'https://llm.example/v1', api_key: 'sk-test', model: 'm' } });
    expect(mode(credentialsPath(dir))).toBe(0o600);
    writeRuntime(dir, { port: 4000, token: 't'.repeat(43), pid: process.pid, started_at: new Date().toISOString() });
    expect(mode(runtimePath(dir))).toBe(0o600);
    expect(readRuntime(dir)?.port).toBe(4000);
  });

  test('clearRuntime only removes the file of the given pid', () => {
    writeRuntime(dir, { port: 4001, token: 't'.repeat(43), pid: 999_999, started_at: new Date().toISOString() });
    clearRuntime(dir, process.pid);
    expect(existsSync(runtimePath(dir))).toBe(true);
    clearRuntime(dir, 999_999);
    expect(existsSync(runtimePath(dir))).toBe(false);
  });

  test('recent projects: most recent first, deduplicated, capped; unknown keys preserved', () => {
    writeFileSync(configPath(dir), JSON.stringify({ recent_projects: [], future_setting: 42 }));
    for (let i = 0; i < MAX_RECENT_PROJECTS + 5; i++) {
      touchRecentProject(dir, { dir: `/p/${i}`, name: `项目${i}`, opened_at: new Date(2026, 0, 1, 0, i).toISOString() });
    }
    touchRecentProject(dir, { dir: '/p/3', name: '项目3', opened_at: new Date().toISOString() });
    const cfg = readConfig(dir);
    expect(cfg.recent_projects).toHaveLength(MAX_RECENT_PROJECTS);
    expect(cfg.recent_projects[0]!.dir).toBe('/p/3');
    expect(cfg.recent_projects.filter((p) => p.dir === '/p/3')).toHaveLength(1);
    expect(JSON.parse(readFileSync(configPath(dir), 'utf8')).future_setting).toBe(42);
  });
});

describe('provider flags', () => {
  test('configured only when base_url, api_key and model are all present (env first, then credentials)', () => {
    const home = mkdtempSync(join(dir, 'p-'));
    expect(providerFlags(home, {})).toEqual({ text_provider_configured: false, image_provider_configured: false });
    writeCredentials(home, { llm: { base_url: 'https://llm.example/v1', model: 'm' } });
    expect(providerFlags(home, {}).text_provider_configured).toBe(false);
    expect(providerFlags(home, { STORYSCRIPT_LLM_API_KEY: 'sk-x' }).text_provider_configured).toBe(true);
    expect(
      providerFlags(home, {
        STORYSCRIPT_IMAGE_BASE_URL: 'https://img.example/v1',
        STORYSCRIPT_IMAGE_API_KEY: 'k',
        STORYSCRIPT_IMAGE_MODEL: 'i',
      }).image_provider_configured,
    ).toBe(true);
    expect(providerFlags(home, { STORYSCRIPT_LLM_API_KEY: '' }).text_provider_configured).toBe(false);
    // empty env var falls back to the stored value
    writeCredentials(home, { llm: { base_url: 'https://llm.example/v1', api_key: 'sk-stored', model: 'm' } });
    expect(providerFlags(home, { STORYSCRIPT_LLM_API_KEY: ' ' }).text_provider_configured).toBe(true);
  });
});
