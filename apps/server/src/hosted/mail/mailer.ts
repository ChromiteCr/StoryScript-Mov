import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from '../../http/errors.ts';

/**
 * How the hosted server sends verification emails:
 * - resend: one POST to Resend's HTTP API; the key comes only from the
 *   environment (STORYSCRIPT_RESEND_API_KEY) and never reaches logs or pages
 * - outbox: each message written as JSON into a folder (tests, trying the
 *   server without an email account)
 * - none: nothing configured; sending fails with a message for the admin
 */

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  readonly kind: 'resend' | 'outbox' | 'none';
  send(message: MailMessage): Promise<void>;
}

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

const failed = (detail: string) => new AppError('MAIL_FAILED', '验证码邮件没有发出去，请过一会儿再试；一直不行请联系管理员。', 502, { detail }, true);

export function resendMailer(o: { apiKey: string; from: string; fetch?: typeof fetch; log?: (line: string) => void }): Mailer {
  const doFetch = o.fetch ?? fetch;
  const log = o.log ?? ((line: string) => console.error(line));
  return {
    kind: 'resend',
    async send(m) {
      let res: Response;
      try {
        res = await doFetch(RESEND_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: o.from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        const why = (err as Error).name === 'TimeoutError' ? 'timeout' : 'network';
        log(`发信失败（Resend，${why}）`);
        throw failed(why);
      }
      if (!res.ok) {
        // Resend explains in { name, message }; neither carries the key
        const body = (await res.json().catch(() => null)) as { name?: unknown; message?: unknown } | null;
        const name = typeof body?.name === 'string' ? body.name : '';
        const message = typeof body?.message === 'string' ? body.message.slice(0, 200) : '';
        log(`发信失败（Resend HTTP ${res.status}${name ? ` ${name}` : ''}）${message ? `：${message}` : ''}`);
        throw failed(`http ${res.status}`);
      }
    },
  };
}

export function outboxMailer(dir: string, from: string): Mailer {
  return {
    kind: 'outbox',
    async send(m) {
      mkdirSync(dir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`;
      writeFileSync(join(dir, name), JSON.stringify({ from, ...m }, null, 2));
    },
  };
}

export function noMailer(): Mailer {
  return {
    kind: 'none',
    async send() {
      throw new AppError('MAIL_FAILED', '服务器还没有配置发信，暂时不能注册或用验证码登录。请联系管理员。', 503);
    },
  };
}

/** STORYSCRIPT_MAIL_OUTBOX wins (tests); otherwise Resend when a key is set. */
export function mailerFromEnv(env: NodeJS.ProcessEnv, from: string, log?: (line: string) => void): Mailer {
  const outbox = env.STORYSCRIPT_MAIL_OUTBOX?.trim();
  if (outbox) return outboxMailer(outbox, from);
  const apiKey = env.STORYSCRIPT_RESEND_API_KEY?.trim();
  if (apiKey) return resendMailer({ apiKey, from, log });
  return noMailer();
}
