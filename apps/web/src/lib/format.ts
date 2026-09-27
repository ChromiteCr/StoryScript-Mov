/** Small display/input helpers. Pure, no DOM. */

/** 750 → "12 分 30 秒"; 3725 → "1 小时 2 分 5 秒" */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} 小时`);
  if (m > 0) parts.push(`${m} 分`);
  if (sec > 0 || parts.length === 0) parts.push(`${sec} 秒`);
  return parts.join(' ');
}

/** Last path segment, tolerant of trailing slashes and Windows separators. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/**
 * Clean up a pasted path: trim, drop wrapping quotes, and undo the `\ `
 * escaping a terminal adds when a folder is dragged into it.
 */
export function normalizePastedPath(raw: string): string {
  let p = raw.trim();
  if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
    p = p.slice(1, -1);
  } else if (p.includes('\\ ')) {
    p = p.replace(/\\(.)/g, '$1');
  }
  return p;
}

/**
 * A path under the user's home shown as ~/… : shorter, and a shared
 * screenshot does not carry the account name. Anything else is unchanged.
 */
export function displayPath(path: string, home: string | null | undefined): string {
  const h = (home ?? '').replace(/[\\/]+$/, '');
  if (!h) return path;
  if (path === h) return '~';
  const sep = path.charAt(h.length);
  return path.startsWith(h) && (sep === '/' || sep === '\\') ? `~${path.slice(h.length)}` : path;
}

export function isValidTimeZone(tz: string): boolean {
  if (tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "9月26日 14:05", with the year when it is not the current one. */
export function formatOpenedAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString('zh-CN', {
    year: sameYear ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "" → null; "90" → 90; anything else → "invalid" */
export function parseDurationInput(raw: string): number | null | 'invalid' {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return 'invalid';
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : 'invalid';
}
