import type { MailMessage } from './mailer.ts';

/**
 * Verification emails of the hosted server. Email clients only understand
 * tables and inline styles, so that is all this uses. The code sits in a
 * letterboxed 2.39 frame with the dashed 1.43 centre-safe guides the app's
 * mark and storyboards use, on the app's paper colour. Every piece of text
 * is escaped; each message has a plain-text twin.
 */

export type MailPurpose = 'register' | 'login' | 'test';

export interface CodeEmailInput {
  purpose: MailPurpose;
  /** six digits (ignored for 'test') */
  code: string;
  siteName: string;
  /** https://mov.example.com */
  origin: string;
  minutes: number;
}

const PAPER = '#efebe2';
const SHEET = '#ffffff';
const RULE = '#d9d4c7';
const INK = '#25262a';
const INK_2 = '#55565c';
const INK_3 = '#7a7b80';
const FRAME = '#faf8f3';
const GUIDE = '#7fc4e2';
const SANS = "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif";
const MONO = "'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

interface Copy {
  subject: string;
  preheader: string;
  heading: string;
  lead: string;
  caption: string;
  after: string;
}

function copyFor(i: CodeEmailInput, host: string): Copy {
  const valid = `${i.minutes} 分钟内有效，用过即失效`;
  switch (i.purpose) {
    case 'register':
      return {
        subject: `${i.siteName} 注册验证码：${i.code}`,
        preheader: `${i.code} 是你的注册验证码，${i.minutes} 分钟内有效。`,
        heading: '确认你的邮箱',
        lead: `在注册页面输入下面的验证码，完成${i.siteName}的账号注册。`,
        caption: valid,
        after: `如果你没有在 ${host} 注册，忽略这封邮件即可。没有这个验证码，别人无法用你的邮箱注册。`,
      };
    case 'login':
      return {
        subject: `${i.siteName} 登录验证码：${i.code}`,
        preheader: `${i.code} 是你的登录验证码，${i.minutes} 分钟内有效。`,
        heading: '登录验证码',
        lead: '在登录页面输入下面的验证码。忘记了密码的话，输入验证码时可以一并设置新密码。',
        caption: valid,
        after: '如果不是你本人在登录，忽略这封邮件即可，你的密码不会被改动。',
      };
    case 'test':
      return {
        subject: `${i.siteName} 发信测试`,
        preheader: '服务器可以正常发出验证码邮件。',
        heading: '发信设置正常',
        lead: '这是管理员发出的测试邮件：服务器可以正常发出注册和登录验证码。',
        caption: '测试邮件',
        after: '不需要做任何操作。',
      };
  }
}

function frame(content: string): string {
  const bar = (radius: string) =>
    `<tr><td height="12" style="height:12px;background:${INK};border-radius:${radius};font-size:0;line-height:0;">&nbsp;</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
${bar('4px 4px 0 0')}
<tr><td style="background:${FRAME};padding:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="20%" style="border-right:1px dashed ${GUIDE};font-size:0;line-height:0;">&nbsp;</td>
<td align="center" style="padding:40px 0;font-family:${MONO};font-size:34px;line-height:1;font-weight:600;letter-spacing:10px;color:${INK};">${content}</td>
<td width="20%" style="border-left:1px dashed ${GUIDE};font-size:0;line-height:0;">&nbsp;</td>
</tr></table>
</td></tr>
${bar('0 0 4px 4px')}
</table>`;
}

export function codeEmail(i: CodeEmailInput): Omit<MailMessage, 'to'> {
  const host = new URL(i.origin).host;
  const c = copyFor(i, host);
  const e = escapeHtml;
  const shown = i.purpose === 'test' ? 'OK' : i.code;
  const p = (text: string, style: string) => `<p style="margin:0;font-family:${SANS};${style}">${e(text)}</p>`;

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${e(c.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${e(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
<tr><td align="center" style="padding:32px 16px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
<tr><td style="padding:0 2px 16px;font-family:${SANS};font-size:13px;line-height:1.4;font-weight:600;color:${INK};">
<span style="display:inline-block;width:22px;height:8px;border:1px solid ${INK};border-radius:1px;vertical-align:-1px;margin-right:8px;"></span>StoryScript-Mov
</td></tr>
<tr><td style="background:${SHEET};border:1px solid ${RULE};border-radius:6px;padding:32px 28px 28px;">
${p(c.heading, `font-size:20px;line-height:1.4;font-weight:600;color:${INK};`)}
${p(c.lead, `padding-top:8px;padding-bottom:24px;font-size:15px;line-height:1.75;color:${INK_2};`)}
${frame(e(shown))}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-top:8px;font-family:${SANS};font-size:12px;line-height:1.5;color:${INK_3};">${e(c.caption)}</td>
<td align="right" style="padding-top:8px;font-family:${MONO};font-size:11px;line-height:1.5;color:${INK_3};">2.39 : 1</td>
</tr></table>
${p(c.after, `padding-top:24px;font-size:13px;line-height:1.7;color:${INK_2};`)}
</td></tr>
<tr><td style="padding:16px 2px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${INK_3};">
这封邮件由${e(i.siteName)}（<a href="${e(i.origin)}" style="color:${INK_3};text-decoration:underline;">${e(host)}</a>）自动发送，请不要直接回复。
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  const text = [
    c.heading,
    '',
    c.lead,
    '',
    i.purpose === 'test' ? '    OK' : `    验证码：${i.code}`,
    '',
    `${c.caption}。`,
    c.after,
    '',
    '--',
    `这封邮件由${i.siteName}（${i.origin}）自动发送，请不要直接回复。`,
    '',
  ].join('\n');

  return { subject: c.subject, html, text };
}
