import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isAppError } from '../src/http/errors.ts';
import { mailerFromEnv, outboxMailer, resendMailer } from '../src/hosted/mail/mailer.ts';
import { codeEmail } from '../src/hosted/mail/templates.ts';
import { hashPassword, UNUSABLE_HASH, verifyPassword } from '../src/hosted/passwords.ts';

/** S2a: verification emails (Resend, outbox) and their templates; account passwords. */

const KEY = 're_test_0123456789abcdef';
const message = { to: 'a@school.test', subject: 's', html: '<p>h</p>', text: 't' };

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('did not throw');
}

describe('Resend mailer', () => {
  test('one POST with the key as a bearer token and the message as JSON', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }) as unknown as typeof fetch;
    await resendMailer({ apiKey: KEY, from: 'StoryScript-Mov <noreply@mov.example.test>', fetch: fake }).send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: 'StoryScript-Mov <noreply@mov.example.test>',
      to: ['a@school.test'],
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });
  });

  test('a refusal or a network failure is MAIL_FAILED, and neither the error nor the log carries the key', async () => {
    const logs: string[] = [];
    const refuse = (async () =>
      new Response(JSON.stringify({ name: 'validation_error', message: 'The mov.example.test domain is not verified' }), { status: 403 })) as unknown as typeof fetch;
    const e1 = await thrown(resendMailer({ apiKey: KEY, from: 'x <a@b.test>', fetch: refuse, log: (l) => logs.push(l) }).send(message));
    expect(isAppError(e1) && e1.code).toBe('MAIL_FAILED');
    expect(logs.join('\n')).toContain('not verified');
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const e2 = await thrown(resendMailer({ apiKey: KEY, from: 'x <a@b.test>', fetch: down, log: (l) => logs.push(l) }).send(message));
    expect(isAppError(e2) && e2.code).toBe('MAIL_FAILED');
    expect(JSON.stringify([e1, e2, (e1 as Error).message, logs])).not.toContain(KEY);
  });

  test('the environment picks the mailer: outbox first, then Resend, else none', () => {
    expect(mailerFromEnv({ STORYSCRIPT_MAIL_OUTBOX: '/tmp/x', STORYSCRIPT_RESEND_API_KEY: KEY }, 'a@b.test').kind).toBe('outbox');
    expect(mailerFromEnv({ STORYSCRIPT_RESEND_API_KEY: KEY }, 'a@b.test').kind).toBe('resend');
    expect(mailerFromEnv({ STORYSCRIPT_RESEND_API_KEY: '  ' }, 'a@b.test').kind).toBe('none');
  });

  test('the outbox writes each message as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssm-outbox-'));
    try {
      await outboxMailer(dir, 'x <a@b.test>').send(message);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'))).toEqual({ from: 'x <a@b.test>', ...message });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verification email templates', () => {
  const base = { code: '482913', siteName: '学校短片节', origin: 'https://mov.example.test', minutes: 10 };

  test('register and login: subject, code in the letterboxed frame, plain-text twin', () => {
    const r = codeEmail({ ...base, purpose: 'register' });
    expect(r.subject).toBe('学校短片节 注册验证码：482913');
    expect(r.html).toContain('482913');
    expect(r.html).toContain('2.39 : 1');
    expect(r.html).toContain('border-right:1px dashed #7fc4e2');
    expect(r.text).toContain('验证码：482913');
    expect(r.text).toContain('10 分钟内有效');
    expect(r.text).toContain('https://mov.example.test');
    const l = codeEmail({ ...base, purpose: 'login' });
    expect(l.subject).toBe('学校短片节 登录验证码：482913');
    expect(l.text).toContain('新密码');
    const t = codeEmail({ ...base, code: '', purpose: 'test' });
    expect(t.subject).toBe('学校短片节 发信测试');
  });

  test('email-safe: tables and inline styles only, every text escaped', () => {
    const r = codeEmail({ ...base, siteName: '<script>alert(1)</script>&"', purpose: 'register' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;');
    expect(r.html).not.toMatch(/<style|<link|<img|<svg|class=/);
  });
});

describe('account passwords', () => {
  test('scrypt hash round-trips; wrong passwords, other hashes and the unusable hash never match', async () => {
    const h1 = await hashPassword('correct horse');
    const h2 = await hashPassword('correct horse');
    expect(h1).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(h1).not.toBe(h2);
    expect(await verifyPassword('correct horse', h1)).toBe(true);
    expect(await verifyPassword('correct horse ', h1)).toBe(false);
    expect(await verifyPassword('', UNUSABLE_HASH)).toBe(false);
    expect(await verifyPassword('x', 'plain')).toBe(false);
  });
});
