import { describe, expect, it } from 'vitest';
import { ScriptInput } from '@storyscript/contracts';
import {
  formatFromFileName,
  isAcceptedFileName,
  isHeadingLine,
  pruneOverrides,
  splitLines,
  toggleHeadingOverride,
} from '../src/lib/scriptImport.ts';

// AT-02 (web side): the import page can mark a line as a scene heading or
// clear it; the overrides sent to previewScript/importScript stay minimal.

const TEXT = ['1. 内景 旧书店 夜', '店主整理书架。', '', '门铃响了。', '场2 日 外 河边', '两人并肩走。'].join('\n');
const DETECTED = [1, 5];

describe('heading overrides', () => {
  it('uses the rule result when there is no override', () => {
    expect(isHeadingLine(1, DETECTED, [])).toBe(true);
    expect(isHeadingLine(2, DETECTED, [])).toBe(false);
    expect(isHeadingLine(5, new Set(DETECTED), [])).toBe(true);
  });

  it('marks a plain line as heading with an is_heading=true override', () => {
    const o = toggleHeadingOverride([], DETECTED, 4);
    expect(o).toEqual([{ line: 4, is_heading: true }]);
    expect(isHeadingLine(4, DETECTED, o)).toBe(true);
  });

  it('clears a detected heading with an is_heading=false override', () => {
    const o = toggleHeadingOverride([], DETECTED, 5);
    expect(o).toEqual([{ line: 5, is_heading: false }]);
    expect(isHeadingLine(5, DETECTED, o)).toBe(false);
  });

  it('toggling twice removes the override instead of storing the rule result', () => {
    const once = toggleHeadingOverride([], DETECTED, 4);
    expect(toggleHeadingOverride(once, DETECTED, 4)).toEqual([]);
    const cleared = toggleHeadingOverride([], DETECTED, 1);
    expect(toggleHeadingOverride(cleared, DETECTED, 1)).toEqual([]);
  });

  it('keeps overrides sorted by line and one per line', () => {
    let o = toggleHeadingOverride([], DETECTED, 6);
    o = toggleHeadingOverride(o, DETECTED, 1);
    o = toggleHeadingOverride(o, DETECTED, 4);
    expect(o).toEqual([
      { line: 1, is_heading: false },
      { line: 4, is_heading: true },
      { line: 6, is_heading: true },
    ]);
    expect(new Set(o.map((x) => x.line)).size).toBe(o.length);
  });

  it('does not mutate the input list', () => {
    const input = [{ line: 4, is_heading: true }];
    const copy = structuredClone(input);
    toggleHeadingOverride(input, DETECTED, 2);
    expect(input).toEqual(copy);
  });

  it('produces a body the contract accepts', () => {
    const o = toggleHeadingOverride(toggleHeadingOverride([], DETECTED, 4), DETECTED, 5);
    const body = { text: TEXT, source_name: 'demo.txt', format: 'txt' as const, heading_overrides: o };
    expect(ScriptInput.safeParse(body).success).toBe(true);
  });

  it('prunes overrides that point at blank or missing lines', () => {
    const lines = splitLines(TEXT);
    expect(
      pruneOverrides(
        [
          { line: 3, is_heading: true },
          { line: 4, is_heading: true },
          { line: 99, is_heading: true },
        ],
        lines,
      ),
    ).toEqual([{ line: 4, is_heading: true }]);
  });
});

describe('file names', () => {
  it('maps extensions to ScriptFormat', () => {
    expect(formatFromFileName('a.fountain')).toBe('fountain');
    expect(formatFromFileName('a.MD')).toBe('md');
    expect(formatFromFileName('a.txt')).toBe('txt');
    expect(isAcceptedFileName('b.fountain')).toBe(true);
    expect(isAcceptedFileName('b.docx')).toBe(false);
  });

  it('splits CRLF, LF and CR line endings the same way', () => {
    expect(splitLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });
});
