import { chmodSync, existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { GroupRole } from '@storyscript/contracts';
import { openDb, type DbPort } from '../db/port.ts';

/**
 * The hosted server's own records, in <data>/site.db: accounts, groups,
 * signed-in browsers, emailed codes and a log of sent mail (for limits).
 * Group projects stay in teams/<slug>/ as before. Session ids and codes are
 * stored hashed; passwords as scrypt hashes (passwords.ts).
 */

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_SESSIONS_PER_ACCOUNT = 20;
const MAIL_LOG_KEEP_MS = 7 * 24 * 3600 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  team_slug TEXT REFERENCES teams(slug) ON DELETE SET NULL,
  team_role TEXT CHECK (team_role IN ('leader', 'member')),
  joined_at TEXT,
  /** increasing join order: who joined first leads next, even within one millisecond */
  joined_seq INTEGER
);
CREATE INDEX IF NOT EXISTS accounts_team ON accounts(team_slug);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, purpose)
);
CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  purpose TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_log_sent ON mail_log(sent_at);
PRAGMA user_version = 1;
`;

export interface Account {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
  team_slug: string | null;
  team_role: GroupRole | null;
  joined_at: string | null;
}

export interface Team {
  slug: string;
  name: string;
  /** normalised (no dash), e.g. ABCD2345 */
  join_code: string;
  created_at: string;
}

export type CodePurpose = 'register' | 'login';
export type CodeCheck = 'ok' | 'wrong' | 'expired' | 'missing';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export const siteDbPath = (dataDir: string) => join(dataDir, 'site.db');

export class SiteDb {
  constructor(
    readonly db: DbPort,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
  }

  static open(dataDir: string, now?: () => number): SiteDb {
    const path = siteDbPath(dataDir);
    const fresh = !existsSync(path);
    const site = new SiteDb(openDb(path), now);
    if (fresh) chmodSync(path, 0o600);
    return site;
  }

  close(): void {
    this.db.close();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ---- accounts ----

  createAccount(a: { email: string; name: string; password_hash: string }): Account {
    const row: Account = { id: randomUUID(), ...a, created_at: this.iso(), team_slug: null, team_role: null, joined_at: null };
    this.db.run(
      'INSERT INTO accounts (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      row.id,
      row.email,
      row.name,
      row.password_hash,
      row.created_at,
    );
    return row;
  }

  accountByEmail(email: string): Account | null {
    return this.db.get<Account>('SELECT * FROM accounts WHERE email = ?', email) ?? null;
  }

  accountById(id: string): Account | null {
    return this.db.get<Account>('SELECT * FROM accounts WHERE id = ?', id) ?? null;
  }

  listAccounts(): Account[] {
    return this.db.all<Account>('SELECT * FROM accounts ORDER BY created_at, email');
  }

  deleteAccount(id: string): void {
    this.db.run('DELETE FROM accounts WHERE id = ?', id);
  }

  setPassword(id: string, passwordHash: string): void {
    this.db.run('UPDATE accounts SET password_hash = ? WHERE id = ?', passwordHash, id);
  }

  setMembership(id: string, slug: string | null, role: GroupRole | null): void {
    this.db.run(
      `UPDATE accounts SET team_slug = ?, team_role = ?, joined_at = ?,
         joined_seq = CASE WHEN ? IS NULL THEN NULL ELSE (SELECT COALESCE(MAX(joined_seq), 0) + 1 FROM accounts) END
       WHERE id = ?`,
      slug,
      role,
      slug ? this.iso() : null,
      slug,
      id,
    );
  }

  setRole(id: string, role: GroupRole): void {
    this.db.run('UPDATE accounts SET team_role = ? WHERE id = ?', role, id);
  }

  // ---- groups ----

  createTeam(t: { slug: string; name: string; join_code: string }): Team {
    const row: Team = { ...t, created_at: this.iso() };
    this.db.run('INSERT INTO teams (slug, name, join_code, created_at) VALUES (?, ?, ?, ?)', row.slug, row.name, row.join_code, row.created_at);
    return row;
  }

  team(slug: string): Team | null {
    return this.db.get<Team>('SELECT * FROM teams WHERE slug = ?', slug) ?? null;
  }

  teamByJoinCode(code: string): Team | null {
    return this.db.get<Team>('SELECT * FROM teams WHERE join_code = ?', code) ?? null;
  }

  listTeams(): Team[] {
    return this.db.all<Team>('SELECT * FROM teams ORDER BY created_at, slug');
  }

  setJoinCode(slug: string, code: string): void {
    this.db.run('UPDATE teams SET join_code = ? WHERE slug = ?', code, slug);
  }

  /** Removes the group; its members are left without one. */
  deleteTeam(slug: string): void {
    this.db.tx(() => {
      this.db.run('UPDATE accounts SET team_slug = NULL, team_role = NULL, joined_at = NULL, joined_seq = NULL WHERE team_slug = ?', slug);
      this.db.run('DELETE FROM teams WHERE slug = ?', slug);
    });
  }

  /** Earliest joined first (that order also decides who leads next). */
  members(slug: string): Account[] {
    return this.db.all<Account>('SELECT * FROM accounts WHERE team_slug = ? ORDER BY joined_seq', slug);
  }

  // ---- sessions ----

  /** New signed-in browser for an account; returns the cookie value (only its hash is stored). */
  createSession(accountId: string): string {
    const id = randomBytes(32).toString('base64url');
    const t = this.now();
    this.db.tx(() => {
      this.db.run('DELETE FROM sessions WHERE expires_at <= ?', t);
      this.db.run('INSERT INTO sessions (id_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(id), accountId, t, t + SESSION_TTL_MS);
      this.db.run(
        `DELETE FROM sessions WHERE account_id = ? AND id_hash NOT IN
           (SELECT id_hash FROM sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT ${MAX_SESSIONS_PER_ACCOUNT})`,
        accountId,
        accountId,
      );
    });
    return id;
  }

  /** The account behind a cookie value, or null (unknown, expired or account gone). */
  sessionAccount(id: string | undefined): Account | null {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
    const row = this.db.get<Account & { expires_at: number }>(
      'SELECT a.*, s.expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id_hash = ?',
      sha256(id),
    );
    if (!row) return null;
    if (row.expires_at <= this.now()) {
      this.db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(id));
      return null;
    }
    const { expires_at: _, ...account } = row;
    return account;
  }

  revokeSession(id: string | undefined): void {
    if (typeof id === 'string' && id.length > 0) this.db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(id));
  }

  /** Sign an account out everywhere, except (optionally) the browser that asked. */
  revokeAccountSessions(accountId: string, keep?: string): void {
    this.db.run('DELETE FROM sessions WHERE account_id = ? AND id_hash != ?', accountId, keep ? sha256(keep) : '');
  }

  sessionCount(accountId?: string): number {
    const t = this.now();
    const row = accountId
      ? this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND expires_at > ?', accountId, t)
      : this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', t);
    return row?.n ?? 0;
  }

  // ---- emailed codes ----

  /** Replaces any earlier code for this email and purpose. */
  putCode(email: string, purpose: CodePurpose, codeHash: string, ttlMs: number): void {
    this.db.run(
      `INSERT INTO email_codes (email, purpose, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (email, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      email,
      purpose,
      codeHash,
      this.now() + ttlMs,
    );
  }

  /**
   * One try at a code. A right code is used up; a wrong one counts, and the
   * code is dropped after `maxAttempts` wrong tries.
   */
  checkCode(email: string, purpose: CodePurpose, codeHash: string, maxAttempts: number): CodeCheck {
    return this.db.tx(() => {
      const row = this.db.get<{ code_hash: string; expires_at: number; attempts: number }>(
        'SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ? AND purpose = ?',
        email,
        purpose,
      );
      if (!row) return 'missing';
      if (row.expires_at <= this.now()) {
        this.db.run('DELETE FROM email_codes WHERE email = ? AND purpose = ?', email, purpose);
        return 'expired';
      }
      if (row.code_hash === codeHash) {
        this.db.run('DELETE FROM email_codes WHERE email = ? AND purpose = ?', email, purpose);
        return 'ok';
      }
      if (row.attempts + 1 >= maxAttempts) this.db.run('DELETE FROM email_codes WHERE email = ? AND purpose = ?', email, purpose);
      else this.db.run('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?', email, purpose);
      return 'wrong';
    });
  }

  // ---- sent mail (limits) ----

  logMail(email: string, ip: string, purpose: string): void {
    const t = this.now();
    this.db.run('DELETE FROM mail_log WHERE sent_at < ?', t - MAIL_LOG_KEEP_MS);
    this.db.run('INSERT INTO mail_log (email, ip, purpose, sent_at) VALUES (?, ?, ?, ?)', email, ip, purpose, t);
  }

  /** Mail sent since `since` (ms), to one email, from one address, or in total. */
  mailsSince(since: number, by: { email?: string; ip?: string } = {}): number {
    if (by.email) return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mail_log WHERE email = ? AND sent_at > ?', by.email, since)?.n ?? 0;
    if (by.ip) return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mail_log WHERE ip = ? AND sent_at > ?', by.ip, since)?.n ?? 0;
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mail_log WHERE sent_at > ?', since)?.n ?? 0;
  }

  lastMailAt(email: string): number | null {
    return this.db.get<{ t: number | null }>('SELECT MAX(sent_at) AS t FROM mail_log WHERE email = ?', email)?.t ?? null;
  }
}
