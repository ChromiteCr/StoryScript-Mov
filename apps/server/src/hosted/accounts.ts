import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../http/errors.ts';
import { hashInvite, type HostedConfig } from './config.ts';
import { LoginLimiter } from './limiter.ts';
import type { Mailer } from './mail/mailer.ts';
import { codeEmail } from './mail/templates.ts';
import { hashPassword, UNUSABLE_HASH, verifyPassword } from './passwords.ts';
import type { Account, CodePurpose, SiteDb } from './site-db.ts';

/**
 * Registering and signing in on a hosted server. Registration needs the
 * site's invite code and a code emailed to the address; signing in takes the
 * password or a fresh emailed code (which may also set a new password).
 * Every path that sends mail or checks a secret is rate limited.
 */

export const CODE_TTL_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const RESEND_AFTER_MS = 60_000;
const HOUR = 3600_000;
const PER_EMAIL_PER_HOUR = 5;
const PER_IP_PER_HOUR = 20;

export interface AccountDeps {
  site: SiteDb;
  mailer: Mailer;
  config: HostedConfig;
  now?: () => number;
}

export interface SignedIn {
  account: Account;
  /** cookie value */
  session: string;
}

const codeHash = (purpose: CodePurpose, email: string, code: string) =>
  createHash('sha256').update(`${purpose}:${email}:${code}`, 'utf8').digest('hex');

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

const tooMany = (seconds: number, message: string) =>
  new AppError('TOO_MANY_ATTEMPTS', message, 429, { retry_after_s: Math.max(1, Math.ceil(seconds)) }, true);

const minutes = (s: number) => Math.max(1, Math.ceil(s / 60));

export class Accounts {
  private readonly now: () => number;
  /** wrong passwords and codes, per client address and per email */
  readonly byAddress: LoginLimiter;
  readonly byEmail: LoginLimiter;

  constructor(private readonly d: AccountDeps) {
    this.now = d.now ?? Date.now;
    this.byAddress = new LoginLimiter(10, 200, 15 * 60_000, this.now);
    this.byEmail = new LoginLimiter(10, 10_000, 15 * 60_000, this.now);
  }

  // ---- mail ----

  private assertCanMail(email: string, ip: string): void {
    const { site, config } = this.d;
    const t = this.now();
    const last = site.lastMailAt(email);
    if (last !== null && t - last < RESEND_AFTER_MS) {
      const wait = (RESEND_AFTER_MS - (t - last)) / 1000;
      throw tooMany(wait, `验证码刚发过，请 ${Math.ceil(wait)} 秒后再重发。`);
    }
    if (site.mailsSince(t - HOUR, { email }) >= PER_EMAIL_PER_HOUR) throw tooMany(HOUR / 1000, '这个邮箱一小时内收到的验证码太多了，请一小时后再试。');
    if (site.mailsSince(t - HOUR, { ip }) >= PER_IP_PER_HOUR) throw tooMany(HOUR / 1000, '这台电脑一小时内请求的验证码太多了，请稍后再试。');
    if (site.mailsSince(t - 24 * HOUR) >= config.limits.emails_per_day) {
      throw new AppError('QUOTA_EXCEEDED', '今天网站的验证码邮件已经发完了，请明天再试，或联系管理员。', 429, { limit: config.limits.emails_per_day });
    }
  }

  private async sendCode(email: string, purpose: CodePurpose, ip: string): Promise<void> {
    this.assertCanMail(email, ip);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const { site, config, mailer } = this.d;
    const message = codeEmail({ purpose, code, siteName: config.site_name, origin: config.public_origin, minutes: CODE_TTL_MINUTES });
    // counted before sending, so a failing mail service cannot be hammered either
    site.logMail(email, ip, purpose);
    await mailer.send({ to: email, ...message });
    site.putCode(email, purpose, codeHash(purpose, email, code), CODE_TTL_MINUTES * 60_000);
  }

  private checkCode(email: string, purpose: CodePurpose, code: string, ip: string): void {
    this.assertNotLocked(email, ip);
    const r = this.d.site.checkCode(email, purpose, codeHash(purpose, email, code), CODE_MAX_ATTEMPTS);
    if (r === 'ok') return;
    this.byAddress.fail(ip);
    this.byEmail.fail(email);
    if (r === 'wrong') throw new AppError('UNAUTHORIZED', '验证码不对，请检查邮件里的 6 位数字。', 401);
    throw new AppError('UNAUTHORIZED', r === 'expired' ? '验证码已过期，请重新获取。' : '验证码已失效，请重新获取。', 401);
  }

  private assertNotLocked(email: string, ip: string): void {
    const wait = Math.max(this.byAddress.retryAfter(ip), this.byEmail.retryAfter(email));
    if (wait > 0) throw tooMany(wait, `输错次数太多，请 ${minutes(wait)} 分钟后再试。`);
  }

  // ---- register ----

  async sendRegisterCode(email: string, invite: string, ip: string): Promise<void> {
    const wait = this.byAddress.retryAfter(ip);
    if (wait > 0) throw tooMany(wait, `输错次数太多，请 ${minutes(wait)} 分钟后再试。`);
    if (!sameHex(hashInvite(invite), this.d.config.invite_sha256)) {
      this.byAddress.fail(ip);
      throw new AppError('FORBIDDEN', '邀请码不对，请向活动负责人确认。', 403);
    }
    this.byAddress.succeed(ip);
    if (this.d.site.accountByEmail(email)) throw new AppError('ACCOUNT_EXISTS', '这个邮箱已经注册过了，请直接登录。', 409);
    await this.sendCode(email, 'register', ip);
  }

  async register(input: { email: string; code: string; name: string; password: string }, ip: string): Promise<SignedIn> {
    const { site } = this.d;
    if (site.accountByEmail(input.email)) throw new AppError('ACCOUNT_EXISTS', '这个邮箱已经注册过了，请直接登录。', 409);
    this.checkCode(input.email, 'register', input.code, ip);
    const password_hash = await hashPassword(input.password);
    // a second tab may have finished first while the password hashed
    if (site.accountByEmail(input.email)) throw new AppError('ACCOUNT_EXISTS', '这个邮箱已经注册过了，请直接登录。', 409);
    const account = site.createAccount({ email: input.email, name: input.name, password_hash });
    return { account, session: site.createSession(account.id) };
  }

  // ---- sign in ----

  async passwordLogin(email: string, password: string, ip: string): Promise<SignedIn> {
    this.assertNotLocked(email, ip);
    const account = this.d.site.accountByEmail(email);
    const ok = await verifyPassword(password, account?.password_hash ?? UNUSABLE_HASH);
    if (!account || !ok) {
      this.byAddress.fail(ip);
      this.byEmail.fail(email);
      throw new AppError('UNAUTHORIZED', account ? '密码不对。忘记密码可以改用验证码登录。' : '这个邮箱还没有注册。', 401);
    }
    this.byAddress.succeed(ip);
    this.byEmail.succeed(email);
    return { account, session: this.d.site.createSession(account.id) };
  }

  async sendLoginCode(email: string, ip: string): Promise<void> {
    // asking about unknown addresses counts like a wrong password, so the list of accounts cannot be harvested
    const wait = this.byAddress.retryAfter(ip);
    if (wait > 0) throw tooMany(wait, `尝试次数太多，请 ${minutes(wait)} 分钟后再试。`);
    if (!this.d.site.accountByEmail(email)) {
      this.byAddress.fail(ip);
      throw new AppError('NOT_FOUND', '这个邮箱还没有注册。', 404);
    }
    await this.sendCode(email, 'login', ip);
  }

  /** Emailed code; with `newPassword` the password is replaced and other browsers are signed out. */
  async codeLogin(input: { email: string; code: string; new_password?: string | undefined }, ip: string): Promise<SignedIn> {
    const { site } = this.d;
    this.assertNotLocked(input.email, ip);
    const account = site.accountByEmail(input.email);
    if (!account) {
      this.byAddress.fail(ip);
      throw new AppError('NOT_FOUND', '这个邮箱还没有注册。', 404);
    }
    this.checkCode(input.email, 'login', input.code, ip);
    this.byAddress.succeed(ip);
    this.byEmail.succeed(input.email);
    if (input.new_password) {
      site.setPassword(account.id, await hashPassword(input.new_password));
      site.revokeAccountSessions(account.id);
    }
    return { account, session: site.createSession(account.id) };
  }

  async changePassword(account: Account, current: string, next: string, keepSession: string): Promise<void> {
    const wait = this.byEmail.retryAfter(account.email);
    if (wait > 0) throw tooMany(wait, `输错次数太多，请 ${minutes(wait)} 分钟后再试。`);
    if (!(await verifyPassword(current, account.password_hash))) {
      this.byEmail.fail(account.email);
      // not 401: the page would take that as "signed out"
      throw new AppError('FORBIDDEN', '当前密码不对。', 403);
    }
    this.d.site.setPassword(account.id, await hashPassword(next));
    this.d.site.revokeAccountSessions(account.id, keepSession);
  }
}
