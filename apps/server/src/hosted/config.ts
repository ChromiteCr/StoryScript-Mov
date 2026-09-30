import { createHash, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonFile } from '../config/paths.ts';

/**
 * Hosted server mode: one server, many groups, each with one project.
 * Everything lives under a data directory the admin chooses:
 *
 *   <data>/server.json            this file's schema (no secrets: the invite code is stored hashed)
 *   <data>/site.db                accounts, groups, sessions, emailed codes (site-db.ts)
 *   <data>/teams/<slug>/project/  a group's project (SQLite + posters + rasters)
 *   <data>/teams/<slug>/state/    the group instance's state dir (model keys come from the environment)
 */

export const TEAM_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const HostedLimits = z.object({
  /** per group, per rolling 24 h: paid model jobs (all groups share the admin's keys) */
  llm_jobs_per_day: z.number().int().min(0).default(200),
  image_jobs_per_day: z.number().int().min(0).default(20),
  /** whole site, per rolling 24 h: verification emails (Resend's free plan sends 100 a day) */
  emails_per_day: z.number().int().min(0).default(100),
  max_teams: z.number().int().min(1).default(60),
  max_team_members: z.number().int().min(1).default(12),
  /** groups one account may be in at the same time (its own included) */
  max_groups_per_account: z.number().int().min(1).default(2),
});
export type HostedLimits = z.infer<typeof HostedLimits>;

export const HostedConfig = z.object({
  format: z.literal('storyscript-mov-server'),
  version: z.literal(2),
  site_name: z.string().min(1).max(60),
  /** where browsers reach the site, e.g. https://story.example.com (no path) */
  public_origin: z.string().url(),
  /** 127.0.0.1 behind a reverse proxy (recommended) */
  listen_host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** IANA zone for new group projects */
  timezone: z.string().min(1),
  /** sha256 hex of the normalised invite code everyone types to register */
  invite_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** sender of verification emails, e.g. "StoryScript-Mov <noreply@mov.example.com>" */
  mail: z.object({ from: z.string().min(3).max(200) }),
  limits: HostedLimits.prefault({}),
});
export type HostedConfig = z.infer<typeof HostedConfig>;

export const serverConfigPath = (dataDir: string) => join(dataDir, 'server.json');
export const teamDir = (dataDir: string, slug: string) => join(dataDir, 'teams', slug);
/** S4: an account's own settings (its own model); created 0700 on first save */
export const accountDir = (dataDir: string, accountId: string) => join(dataDir, 'accounts', accountId);

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

// ---- invite code (site) and join codes (groups) ---------------------------

/** Case and spaces do not matter when the invite code is typed. */
export function normalizeInvite(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, '');
}

export function hashInvite(code: string): string {
  return createHash('sha256').update(normalizeInvite(code), 'utf8').digest('hex');
}

/** No 0/O, 1/I/L: codes are read aloud and typed from paper. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 8 characters from 31 symbols (~40 bits), stored as ABCD2345, shown as ABCD-2345. */
export function generateJoinCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Case, spaces and dashes do not matter; a pasted join link works too. */
export function normalizeJoinCode(input: string): string {
  const link = /[#&]join=([^&\s]+)/.exec(input);
  const raw = link ? decodeURIComponent(link[1]!) : input;
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

export const showJoinCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export function joinLink(config: Pick<HostedConfig, 'public_origin'>, code: string): string {
  return `${config.public_origin}/#join=${showJoinCode(code)}`;
}

/** "noreply@x.com" → "StoryScript-Mov <noreply@x.com>"; a full "Name <addr>" is kept. */
export function normalizeSender(input: string): string {
  const s = input.trim();
  const addr = /<([^<>\s]+@[^<>\s]+)>$/.exec(s)?.[1] ?? s;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) throw new Error(`不是有效的发件地址：${input}`);
  return s.includes('<') ? s : `StoryScript-Mov <${addr}>`;
}
