import { chmodSync, existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { GroupRole, ModelSource } from '@storyscript/contracts';
import { openDb, type DbPort } from '../db/port.ts';

/**
 * The hosted server's own records, in <data>/site.db: accounts, groups and
 * who is in which (an account may be in a few groups, S2d), signed-in
 * browsers (each remembers the group it is working in), emailed codes and a
 * log of sent mail (for limits). Group projects stay in teams/<slug>/.
 * Session ids and codes are stored hashed; passwords as scrypt hashes.
 *
 * Schema versions (PRAGMA user_version): 1 = one group per account (columns
 * on accounts, S2a); 2 = memberships table + sessions.current_team. The old
 * account columns stay, unused (SQLite cannot drop a foreign-key column);
 * 3 = crew roles and each member's model choice on memberships (S4). An
 * existing file is copied to site.db.v<N>.bak before it is migrated.
 */

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_SESSIONS_PER_ACCOUNT = 20;
const MAIL_LOG_KEEP_MS = 7 * 24 * 3600 * 1000;

/** version-1 tables (kept as the base: CREATE IF NOT EXISTS, then migrated) */
const BASE_SCHEMA = `
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
`;

/** v1 → v2: memberships (several groups per account) and the group each browser works in */
const MIGRATE_2 = `
CREATE TABLE memberships (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  team_slug TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
  joined_at TEXT NOT NULL,
  /* increasing join order: who joined first leads next, even within one millisecond */
  joined_seq INTEGER NOT NULL,
  PRIMARY KEY (account_id, team_slug)
);
CREATE INDEX memberships_team ON memberships(team_slug, joined_seq);
INSERT INTO memberships (account_id, team_slug, role, joined_at, joined_seq)
  SELECT id, team_slug, COALESCE(team_role, 'member'), COALESCE(joined_at, created_at), COALESCE(joined_seq, rowid)
  FROM accounts WHERE team_slug IS NOT NULL AND team_slug IN (SELECT slug FROM teams);
UPDATE accounts SET team_slug = NULL, team_role = NULL, joined_at = NULL, joined_seq = NULL;
ALTER TABLE sessions ADD COLUMN current_team TEXT;
UPDATE sessions SET current_team =
  (SELECT m.team_slug FROM memberships m WHERE m.account_id = sessions.account_id ORDER BY m.joined_seq LIMIT 1);
PRAGMA user_version = 2;
`;

/** v2 → v3 (S4): crew roles, and whose model each member uses in each group */
const MIGRATE_3 = `
ALTER TABLE memberships ADD COLUMN crew_roles_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memberships ADD COLUMN text_source TEXT NOT NULL DEFAULT 'group' CHECK (text_source IN ('group', 'own'));
ALTER TABLE memberships ADD COLUMN image_source TEXT NOT NULL DEFAULT 'group' CHECK (image_source IN ('group', 'own'));
PRAGMA user_version = 3;
`;
export const SITE_SCHEMA_VERSION = 3;

export interface Account {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
}

export interface Membership {
  account_id: string;
  team_slug: string;
  role: GroupRole;
  joined_at: string;
  joined_seq: number;
  crew_roles_json: string;
  text_source: ModelSource;
  image_source: ModelSource;
}

/** A group member: the account plus its role and crew roles there. */
export interface Member extends Account {
  role: GroupRole;
  joined_at: string;
  crew_roles_json: string;
}

/** crew_roles_json → string[] (never throws on a bad row) */
export function crewRolesOf(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** A signed-in browser: its account and the group it is working in (may be stale; the gateway checks). */
export interface SessionInfo {
  account: Account;
  current_team: string | null;
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

const ACCOUNT_COLS = 'id, email, name, password_hash, created_at';
const ACCOUNT_COLS_A = 'a.id, a.email, a.name, a.password_hash, a.created_at';

export class SiteDb {
  constructor(
    readonly db: DbPort,
    private readonly now: () => number = Date.now,
    /** the file, when there is one: an existing site.db is copied aside before it is migrated */
    file?: string,
  ) {
    const version = db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    if (version > SITE_SCHEMA_VERSION) throw new Error(`site.db 的版本 ${version} 比这个程序新，请升级 storyscript-mov`);
    if (file && version > 0 && version < SITE_SCHEMA_VERSION) {
      const bak = `${file}.v${version}.bak`;
      if (!existsSync(bak)) {
        db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
        chmodSync(bak, 0o600);
      }
    }
    db.exec(BASE_SCHEMA);
    if (version < 2) db.tx(() => db.exec(MIGRATE_2));
    if (version < 3) db.tx(() => db.exec(MIGRATE_3));
  }

  static open(dataDir: string, now?: () => number): SiteDb {
    const path = siteDbPath(dataDir);
    const fresh = !existsSync(path);
    const site = new SiteDb(openDb(path), now, path);
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
    const row: Account = { id: randomUUID(), ...a, created_at: this.iso() };
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
    return this.db.get<Account>(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE email = ?`, email) ?? null;
  }

  accountById(id: string): Account | null {
    return this.db.get<Account>(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`, id) ?? null;
  }

  listAccounts(): Account[] {
    return this.db.all<Account>(`SELECT ${ACCOUNT_COLS} FROM accounts ORDER BY created_at, email`);
  }

  deleteAccount(id: string): void {
    this.db.run('DELETE FROM accounts WHERE id = ?', id);
  }

  setPassword(id: string, passwordHash: string): void {
    this.db.run('UPDATE accounts SET password_hash = ? WHERE id = ?', passwordHash, id);
  }

  // ---- memberships ----

  /** The groups an account is in, earliest joined first. */
  memberships(accountId: string): Membership[] {
    return this.db.all<Membership>('SELECT * FROM memberships WHERE account_id = ? ORDER BY joined_seq', accountId);
  }

  membership(accountId: string, slug: string): Membership | null {
    return this.db.get<Membership>('SELECT * FROM memberships WHERE account_id = ? AND team_slug = ?', accountId, slug) ?? null;
  }

  addMembership(accountId: string, slug: string, role: GroupRole): void {
    this.db.run(
      `INSERT INTO memberships (account_id, team_slug, role, joined_at, joined_seq)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(joined_seq), 0) + 1 FROM memberships))`,
      accountId,
      slug,
      role,
      this.iso(),
    );
  }

  removeMembership(accountId: string, slug: string): void {
    this.db.run('DELETE FROM memberships WHERE account_id = ? AND team_slug = ?', accountId, slug);
  }

  setRole(accountId: string, slug: string, role: GroupRole): void {
    this.db.run('UPDATE memberships SET role = ? WHERE account_id = ? AND team_slug = ?', role, accountId, slug);
  }

  setCrewRoles(accountId: string, slug: string, roles: readonly string[]): void {
    this.db.run('UPDATE memberships SET crew_roles_json = ? WHERE account_id = ? AND team_slug = ?', JSON.stringify(roles), accountId, slug);
  }

  setModelChoice(accountId: string, slug: string, choice: { text?: ModelSource; image?: ModelSource }): void {
    if (choice.text) this.db.run('UPDATE memberships SET text_source = ? WHERE account_id = ? AND team_slug = ?', choice.text, accountId, slug);
    if (choice.image) this.db.run('UPDATE memberships SET image_source = ? WHERE account_id = ? AND team_slug = ?', choice.image, accountId, slug);
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

  /** Removes the group and everyone's membership of it; browsers working in it fall back to another group. */
  deleteTeam(slug: string): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM memberships WHERE team_slug = ?', slug);
      this.db.run('UPDATE sessions SET current_team = NULL WHERE current_team = ?', slug);
      this.db.run('DELETE FROM teams WHERE slug = ?', slug);
    });
  }

  /** Earliest joined first (that order also decides who leads next). */
  members(slug: string): Member[] {
    return this.db.all<Member>(
      `SELECT ${ACCOUNT_COLS_A}, m.role, m.joined_at, m.crew_roles_json FROM memberships m JOIN accounts a ON a.id = m.account_id
       WHERE m.team_slug = ? ORDER BY m.joined_seq`,
      slug,
    );
  }

  // ---- sessions ----

  /** New signed-in browser for an account; returns the cookie value (only its hash is stored). */
  createSession(accountId: string, currentTeam: string | null = null): string {
    const id = randomBytes(32).toString('base64url');
    const t = this.now();
    this.db.tx(() => {
      this.db.run('DELETE FROM sessions WHERE expires_at <= ?', t);
      this.db.run(
        'INSERT INTO sessions (id_hash, account_id, created_at, expires_at, current_team) VALUES (?, ?, ?, ?, ?)',
        sha256(id),
        accountId,
        t,
        t + SESSION_TTL_MS,
        currentTeam,
      );
      this.db.run(
        `DELETE FROM sessions WHERE account_id = ? AND id_hash NOT IN
           (SELECT id_hash FROM sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT ${MAX_SESSIONS_PER_ACCOUNT})`,
        accountId,
        accountId,
      );
    });
    return id;
  }

  /** The account behind a cookie value and the group that browser works in, or null (unknown, expired or account gone). */
  session(id: string | undefined): SessionInfo | null {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
    const row = this.db.get<Account & { expires_at: number; current_team: string | null }>(
      `SELECT ${ACCOUNT_COLS_A}, s.expires_at, s.current_team FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id_hash = ?`,
      sha256(id),
    );
    if (!row) return null;
    if (row.expires_at <= this.now()) {
      this.db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(id));
      return null;
    }
    const { expires_at: _, current_team, ...account } = row;
    return { account, current_team };
  }

  sessionAccount(id: string | undefined): Account | null {
    return this.session(id)?.account ?? null;
  }

  setSessionTeam(id: string, slug: string | null): void {
    this.db.run('UPDATE sessions SET current_team = ? WHERE id_hash = ?', slug, sha256(id));
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
