import type { TimeWindow } from '@storyscript/contracts';

/**
 * Time helpers for scheduling. Everything internal is UTC epoch milliseconds
 * on half-open intervals [start, end). Local wall-clock conversion goes
 * through Intl.DateTimeFormat so DST is handled by the platform tz database.
 */

export const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Half-open interval [start, end) in epoch milliseconds. */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

// ---------------------------------------------------------------------------
// ISO <-> ms
// ---------------------------------------------------------------------------

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/;

/** Parses a UTC ISO instant ("…Z"); NaN when malformed or not UTC. */
export function parseUtc(iso: string): number {
  if (typeof iso !== 'string' || !ISO_UTC.test(iso)) return Number.NaN;
  return Date.parse(iso);
}

export function toUtcIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Minutes → integer milliseconds (rounded, so 0.1 min is exactly 6000 ms). */
export function minutesToMs(min: number): number {
  return Math.round(min * MINUTE_MS);
}

export function windowToInterval(w: TimeWindow): Interval {
  return { start: parseUtc(w.start_utc), end: parseUtc(w.end_utc) };
}

export function intervalToWindow(iv: Interval): TimeWindow {
  return { start_utc: toUtcIso(iv.start), end_utc: toUtcIso(iv.end) };
}

// ---------------------------------------------------------------------------
// Single-interval tools
// ---------------------------------------------------------------------------

export function isEmpty(iv: Interval): boolean {
  return !(iv.start < iv.end);
}

/** True when both intervals are non-empty and share at least one instant. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < a.end && b.start < b.end && a.start < b.end && b.start < a.end;
}

/** True when `inner` lies entirely inside `outer` (an empty inner is contained anywhere). */
export function contains(outer: Interval, inner: Interval): boolean {
  if (isEmpty(inner)) return true;
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Length in minutes (0 for empty or inverted intervals). */
export function minutes(iv: Interval): number {
  return Math.max(0, iv.end - iv.start) / MINUTE_MS;
}

// ---------------------------------------------------------------------------
// Interval sets (sorted, disjoint, non-adjacent after `mergeIntervals`)
// ---------------------------------------------------------------------------

/**
 * Sorts, drops empty/NaN intervals and merges overlapping or touching ones.
 * ±Infinity bounds are allowed (used for open-ended not_before/not_after).
 */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const clean = list
    .filter((iv) => iv.start < iv.end)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of clean) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) out[out.length - 1] = { start: last.start, end: iv.end };
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/** Intersection of two interval sets. */
export function intersectSets(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const x = mergeIntervals(a);
  const y = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const p = x[i]!;
    const q = y[j]!;
    const start = Math.max(p.start, q.start);
    const end = Math.min(p.end, q.end);
    if (start < end) out.push({ start, end });
    if (p.end < q.end) i++;
    else j++;
  }
  return out;
}

/** True when a merged set covers `iv` completely (a contiguous iv needs one segment). */
export function setCovers(merged: readonly Interval[], iv: Interval): boolean {
  if (isEmpty(iv)) return true;
  return merged.some((w) => w.start <= iv.start && iv.end <= w.end);
}

/** Longest contiguous segment of a set, in ms. */
export function longestSegment(set: readonly Interval[]): number {
  let best = 0;
  for (const iv of mergeIntervals(set)) best = Math.max(best, iv.end - iv.start);
  return best;
}

// ---------------------------------------------------------------------------
// Local wall clock <-> UTC
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Date.UTC without the 0–99 → 1900s year quirk; day/hour overflow rolls over. */
function utcMs(year: number, month0: number, day: number, hour = 0, minute = 0, second = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month0, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

/** The wall-clock reading in `timeZone` at `instant`, expressed as if it were UTC. */
function wallClockMs(timeZone: string, instant: number): number {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const hour = get('hour') % 24;
  return utcMs(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
}

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** UTC offset of `timeZone` at `instant`, in ms (local = utc + offset). */
export function tzOffsetMs(timeZone: string, instant: number): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClockMs(timeZone, whole) - whole;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseLocalDate(date: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`invalid date "${date}", expected YYYY-MM-DD`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(utcMs(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new RangeError(`invalid calendar date "${date}"`);
  }
  return { y, m: mo, d };
}

/**
 * Local date + "HH:mm" in an IANA zone → UTC ISO instant.
 *
 * - `dayOffset` expands explicitly past midnight (e.g. 01:30 of the next day
 *   is `localToUtc(date, '01:30', tz, 1)`); nothing is inferred.
 * - Wall times inside a DST gap resolve forward using the pre-transition
 *   offset (02:30 on a spring-forward day becomes 03:30 local).
 * - Ambiguous wall times in a DST overlap resolve to the earlier instant.
 *
 * Throws RangeError on a malformed date/time or unknown zone.
 */
export function localToUtc(date: string, time: string, timeZone: string, dayOffset = 0): string {
  const { y, m, d } = parseLocalDate(date);
  const t = TIME_RE.exec(time);
  if (!t) throw new RangeError(`invalid time "${time}", expected HH:mm (00:00–23:59)`);
  if (!Number.isInteger(dayOffset)) throw new RangeError('dayOffset must be an integer');
  if (!isValidTimeZone(timeZone)) throw new RangeError(`unknown time zone "${timeZone}"`);

  const wall = utcMs(y, m - 1, d + dayOffset, Number(t[1]), Number(t[2]));
  const before = tzOffsetMs(timeZone, wall - DAY_MS);
  const after = tzOffsetMs(timeZone, wall + DAY_MS);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => wallClockMs(timeZone, instant) === wall)
    .sort((a, b) => a - b);
  const exact = candidates[0];
  return toUtcIso(exact ?? wall - before);
}

/**
 * Local "HH:mm"–"HH:mm" window on `date` → UTC TimeWindow. When the end is not
 * after the start (e.g. 22:00–02:00) the end is explicitly placed on the next
 * day, so the window crosses midnight instead of becoming empty.
 */
export function localWindowToUtc(date: string, start: string, end: string, timeZone: string): TimeWindow {
  const endsNextDay = end <= start;
  return {
    start_utc: localToUtc(date, start, timeZone),
    end_utc: localToUtc(date, end, timeZone, endsNextDay ? 1 : 0),
  };
}

/** UTC instant → local { date: YYYY-MM-DD, time: HH:mm } in `timeZone`. */
export function utcToLocal(instant: string | number, timeZone: string): { date: string; time: string } {
  const ms = typeof instant === 'number' ? instant : parseUtc(instant);
  const iso = toUtcIso(wallClockMs(timeZone, ms));
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}
