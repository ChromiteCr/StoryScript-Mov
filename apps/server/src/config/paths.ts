import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { RecentProject } from '@storyscript/contracts';

/**
 * Global state directory (SPEC §3): STORYSCRIPT_HOME || ~/.config/storyscript-mov
 *   config.json       preferences + recent projects
 *   credentials.json  provider keys (0600, never logged / never sent to the frontend)
 *   runtime.json      {port, token, pid, started_at} of the running server (0600)
 */

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STORYSCRIPT_HOME?.trim();
  return override ? resolve(override) : join(homedir(), '.config', 'storyscript-mov');
}

export function ensureStateDir(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

export const configPath = (stateDir: string) => join(stateDir, 'config.json');
export const credentialsPath = (stateDir: string) => join(stateDir, 'credentials.json');
export const runtimePath = (stateDir: string) => join(stateDir, 'runtime.json');

/** Read + validate a JSON file. Missing or unreadable → null; invalid → null (callers fall back to defaults). */
export function readJsonFile<T>(path: string, schema: z.ZodType<T>): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename). `mode` is enforced with chmod so a pre-existing file is tightened too. */
export function writeJsonFile(path: string, value: unknown, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

export const MAX_RECENT_PROJECTS = 20;

/** Loose: keys added by later versions survive a read-modify-write. */
export const AppConfig = z.looseObject({
  recent_projects: z.array(RecentProject).default([]),
});
export type AppConfig = z.infer<typeof AppConfig>;

export function readConfig(stateDir: string): AppConfig {
  return readJsonFile(configPath(stateDir), AppConfig) ?? { recent_projects: [] };
}

export function writeConfig(stateDir: string, config: AppConfig): void {
  writeJsonFile(configPath(stateDir), config);
}

/** Move `dir` to the top of the recent list (deduplicated, capped). */
export function touchRecentProject(stateDir: string, entry: RecentProject): void {
  const config = readConfig(stateDir);
  const rest = config.recent_projects.filter((p) => p.dir !== entry.dir);
  writeConfig(stateDir, { ...config, recent_projects: [entry, ...rest].slice(0, MAX_RECENT_PROJECTS) });
}

// ---------------------------------------------------------------------------
// credentials.json (0600)
// ---------------------------------------------------------------------------

const ProviderCredentials = z.object({
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  model: z.string().optional(),
});

export const Credentials = z.looseObject({
  llm: ProviderCredentials.optional(),
  image: ProviderCredentials.extend({ dialect_override: z.string().nullable().optional() }).optional(),
});
export type Credentials = z.infer<typeof Credentials>;

export function readCredentials(stateDir: string): Credentials {
  return readJsonFile(credentialsPath(stateDir), Credentials) ?? {};
}

export function writeCredentials(stateDir: string, creds: Credentials): void {
  writeJsonFile(credentialsPath(stateDir), creds, 0o600);
}

// ---------------------------------------------------------------------------
// runtime.json (0600)
// ---------------------------------------------------------------------------

export const RuntimeInfo = z.object({
  port: z.number().int().positive(),
  token: z.string().min(16),
  pid: z.number().int().positive(),
  started_at: z.string(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;

export function readRuntime(stateDir: string): RuntimeInfo | null {
  return readJsonFile(runtimePath(stateDir), RuntimeInfo);
}

export function writeRuntime(stateDir: string, info: RuntimeInfo): void {
  writeJsonFile(runtimePath(stateDir), info, 0o600);
}

/** Remove runtime.json only if it still belongs to `pid` (another server may have replaced it). */
export function clearRuntime(stateDir: string, pid = process.pid): void {
  const current = readRuntime(stateDir);
  if (current && current.pid !== pid) return;
  rmSync(runtimePath(stateDir), { force: true });
}
