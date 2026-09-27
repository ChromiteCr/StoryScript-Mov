import { createHash, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonFile } from '../config/paths.ts';

/**
 * Hosted server mode: one server, several teams, each with one fixed project.
 * Everything lives under a data directory the admin chooses:
 *
 *   <data>/server.json            this file's schema (no secrets: team codes are stored hashed)
 *   <data>/sessions.json          signed-in browsers (hashed ids, 0600)
 *   <data>/teams/<slug>/project/  the team's project (SQLite + posters + rasters)
 *   <data>/teams/<slug>/state/    the team instance's state dir (model keys come from the environment)
 */

export const TEAM_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const HostedTeamConfig = z.object({
  slug: z.string().regex(TEAM_SLUG),
  name: z.string().min(1).max(40),
  /** sha256 hex of the normalised team code */
  code_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: z.string(),
});
export type HostedTeamConfig = z.infer<typeof HostedTeamConfig>;

export const HostedConfig = z.object({
  format: z.literal('storyscript-mov-server'),
  version: z.literal(1),
  site_name: z.string().min(1).max(60),
  /** where browsers reach the site, e.g. https://story.example.com (no path) */
  public_origin: z.string().url(),
  /** 127.0.0.1 behind a reverse proxy (recommended) */
  listen_host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** IANA zone for new team projects */
  timezone: z.string().min(1),
  /** per team, per rolling 24 h: paid model jobs (all teams share the admin's keys) */
  limits: z
    .object({ llm_jobs_per_day: z.number().int().min(0), image_jobs_per_day: z.number().int().min(0) })
    .default({ llm_jobs_per_day: 200, image_jobs_per_day: 20 }),
  teams: z.array(HostedTeamConfig),
});
export type HostedConfig = z.infer<typeof HostedConfig>;

export const serverConfigPath = (dataDir: string) => join(dataDir, 'server.json');
export const teamDir = (dataDir: string, slug: string) => join(dataDir, 'teams', slug);

export function readHostedConfig(dataDir: string): HostedConfig | null {
  return readJsonFile(serverConfigPath(dataDir), HostedConfig);
}

export function hostedConfigExists(dataDir: string): boolean {
  return existsSync(serverConfigPath(dataDir));
}

export function writeHostedConfig(dataDir: string, config: HostedConfig): void {
  writeJsonFile(serverConfigPath(dataDir), HostedConfig.parse(config), 0o600);
}

/** "https://Story.Example.com/" → "https://story.example.com"; rejects paths, queries and non-http(s). */
export function normalizeOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`不是有效的网址：${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('公开地址必须以 https:// 或 http:// 开头');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('公开地址只写协议和域名（可带端口），不支持子路径，例如 https://story.example.com');
  }
  return url.origin;
}

// ---- team codes -----------------------------------------------------------

/** No 0/O, 1/I/L: codes are read aloud and typed from paper. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 4;
const CODE_GROUP_LEN = 4;

/** 16 characters from 31 symbols (~79 bits), shown as XXXX-XXXX-XXXX-XXXX. */
export function generateTeamCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let s = '';
    for (let i = 0; i < CODE_GROUP_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/** Case, spaces and dashes do not matter when a code is typed. */
export function normalizeTeamCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, '');
}

export function hashTeamCode(code: string): string {
  return createHash('sha256').update(normalizeTeamCode(code), 'utf8').digest('hex');
}

export function inviteLink(config: Pick<HostedConfig, 'public_origin'>, code: string): string {
  return `${config.public_origin}/#t=${encodeURIComponent(code)}`;
}
