import type { SourceRange } from '@storyscript/contracts';

/**
 * CSV export (SPEC FR-10): RFC 4180 quoting, CRLF records, optional UTF-8
 * BOM, and formula-injection neutralisation — any string cell starting with
 * = + - @ TAB or CR gets a leading apostrophe so spreadsheets show it as text.
 * Numbers are written as-is (so negative PTS stay numeric), null/undefined
 * become empty cells.
 */

export interface CsvColumn {
  key: string;
  header: string;
}

export interface CsvOptions {
  /** prefix a UTF-8 byte order mark (helps Excel detect UTF-8 for Chinese text) */
  bom?: boolean;
}

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** Cell text for one value (before quoting). */
export function csvCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function quote(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: readonly Record<string, unknown>[], columns: readonly CsvColumn[], options: CsvOptions = {}): string {
  const lines = [columns.map((c) => quote(csvCellText(c.header)))];
  for (const row of rows) lines.push(columns.map((c) => quote(csvCellText(row[c.key]))));
  return (options.bom ? BOM : '') + lines.map((cells) => `${cells.join(',')}\r\n`).join('');
}

/**
 * Minimal RFC 4180 reader (for round-trip tests and template checks): quoted
 * fields, doubled quotes, CRLF / LF / CR line ends, optional BOM. A trailing
 * line break does not produce an empty record. Returns raw cell strings.
 */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
      fieldStarted = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      fieldStarted = false;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (fieldStarted || field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** The five integer source_range columns, in their frozen order. */
export const SOURCE_RANGE_COLUMNS = ['stream_index', 'in_pts', 'out_pts', 'time_base_num', 'time_base_den'] as const;

export function sourceRangeColumns(range: SourceRange): Record<(typeof SOURCE_RANGE_COLUMNS)[number], number> {
  return {
    stream_index: range.stream_index,
    in_pts: range.in_pts,
    out_pts: range.out_pts,
    time_base_num: range.time_base_num,
    time_base_den: range.time_base_den,
  };
}

/**
 * Reads the five columns back without rounding: each must be a plain decimal
 * integer inside the safe range. Returns null when any cell is not.
 */
export function sourceRangeFromColumns(cells: Record<string, string | undefined>): SourceRange | null {
  const out: Record<string, number> = {};
  for (const key of SOURCE_RANGE_COLUMNS) {
    const raw = cells[key];
    if (raw === undefined || !/^-?\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || String(n) !== raw.replace(/^(-?)0+(?=\d)/, '$1')) return null;
    out[key] = n;
  }
  return out as SourceRange;
}
