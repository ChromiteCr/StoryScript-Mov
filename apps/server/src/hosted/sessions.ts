import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonFile } from '../config/paths.ts';

/**
 * Signed-in browsers on a hosted server. A session id (random, in an HttpOnly
 * cookie) maps to one team. Only sha256(id) is kept, in memory and in
 * <data>/sessions.json (0600), so a server restart does not sign everyone out
 * and a leaked file does not leak usable cookies.
 */

export const HOSTED_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_PER_TEAM = 200;

const Stored = z.object({
  team: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
});
const StoredFile = z.object({ sessions: z.record(z.string(), Stored) });

const hashId = (id: string) => createHash('sha256').update(id, 'utf8').digest('hex');

export class HostedSessions {
  private readonly byHash = new Map<string, z.infer<typeof Stored>>();

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    const saved = file ? readJsonFile(file, StoredFile) : null;
    const t = this.now();
    for (const [h, s] of Object.entries(saved?.sessions ?? {})) if (s.expires_at > t) this.byHash.set(h, s);
  }

  static inDataDir(dataDir: string): HostedSessions {
    return new HostedSessions(join(dataDir, 'sessions.json'));
  }

  /** New session for a team; returns the cookie value. */
  create(team: string): string {
    const id = randomBytes(32).toString('base64url');
    const t = this.now();
    this.byHash.set(hashId(id), { team, created_at: t, expires_at: t + HOSTED_SESSION_TTL_MS });
    this.trim(team);
    this.save();
    return id;
  }

  /** The team this cookie belongs to, or null (unknown or expired). */
  team(id: string | undefined): string | null {
    if (typeof id !== 'string' || id.length === 0) return null;
    const s = this.byHash.get(hashId(id));
    if (!s) return null;
    if (s.expires_at <= this.now()) {
      this.byHash.delete(hashId(id));
      this.save();
      return null;
    }
    return s.team;
  }

  revoke(id: string | undefined): void {
    if (typeof id === 'string' && this.byHash.delete(hashId(id))) this.save();
  }

  /** Sign out every browser of a team (its code was reset or the team removed). */
  revokeTeam(team: string): void {
    let changed = false;
    for (const [h, s] of this.byHash) {
      if (s.team === team) {
        this.byHash.delete(h);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  count(team?: string): number {
    let n = 0;
    for (const s of this.byHash.values()) if (!team || s.team === team) n++;
    return n;
  }

  /** Oldest sessions of a team go first once it has too many. */
  private trim(team: string): void {
    const mine = [...this.byHash.entries()].filter(([, s]) => s.team === team).sort((a, b) => a[1].created_at - b[1].created_at);
    for (const [h] of mine.slice(0, Math.max(0, mine.length - MAX_PER_TEAM))) this.byHash.delete(h);
  }

  private save(): void {
    if (!this.file) return;
    writeJsonFile(this.file, { sessions: Object.fromEntries(this.byHash) }, 0o600);
  }
}

/**
 * Failed sign-ins per client address: 10 per 15 minutes, plus a site-wide cap
 * against guessing from many addresses. Codes carry ~79 bits, so this is about
 * noise and abuse, not about making guessing feasible.
 */
export class LoginLimiter {
  private readonly perKey = new Map<string, number[]>();
  private global: number[] = [];

  constructor(
    private readonly perKeyMax = 10,
    private readonly globalMax = 200,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until this address may try again, or 0. */
  retryAfter(key: string): number {
    const t = this.now();
    const recent = (this.perKey.get(key) ?? []).filter((x) => x > t - this.windowMs);
    this.global = this.global.filter((x) => x > t - this.windowMs);
    const blockedBy = [recent.length >= this.perKeyMax ? recent : null, this.global.length >= this.globalMax ? this.global : null].filter(
      (l): l is number[] => l !== null,
    );
    if (blockedBy.length === 0) return 0;
    const until = Math.max(...blockedBy.map((l) => l[0]! + this.windowMs));
    return Math.max(1, Math.ceil((until - t) / 1000));
  }

  fail(key: string): void {
    const t = this.now();
    const recent = (this.perKey.get(key) ?? []).filter((x) => x > t - this.windowMs);
    recent.push(t);
    this.perKey.set(key, recent);
    this.global.push(t);
    if (this.perKey.size > 10_000) this.perKey.clear();
  }

  succeed(key: string): void {
    this.perKey.delete(key);
  }
}
