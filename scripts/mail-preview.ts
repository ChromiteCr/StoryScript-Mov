/**
 * Render the hosted server's verification emails (S2a) to .look/mail/:
 * the HTML as sent, and PNG screenshots at desktop and phone width in the
 * locally installed Chrome, so the template can be checked without sending.
 *
 *   npm run mail:preview
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { codeEmail, type MailPurpose } from '../apps/server/src/hosted/mail/templates.ts';

const OUT = resolve(import.meta.dirname, '..', '.look', 'mail');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const purpose of ['register', 'login', 'test'] as MailPurpose[]) {
    const m = codeEmail({ purpose, code: '482913', siteName: '学校短片节', origin: 'https://mov.nestudy.cn', minutes: 10 });
    writeFileSync(join(OUT, `${purpose}.html`), m.html);
    writeFileSync(join(OUT, `${purpose}.txt`), `${m.subject}\n\n${m.text}`);
    for (const [label, width] of [['desktop', 900], ['phone', 390]] as const) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: 'light' });
      await page.setContent(m.html);
      await page.screenshot({ path: join(OUT, `${purpose}-${label}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`写入 ${OUT}`);
