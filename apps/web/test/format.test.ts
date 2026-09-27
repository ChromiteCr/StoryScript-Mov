import { describe, expect, it } from 'vitest';
import { basename, displayPath, formatDuration, isValidTimeZone, normalizePastedPath, parseDurationInput } from '../src/lib/format.ts';
import { parseView } from '../src/lib/route.ts';

describe('input helpers', () => {
  it('normalizes pasted paths', () => {
    expect(normalizePastedPath('  /Users/a/Films  ')).toBe('/Users/a/Films');
    expect(normalizePastedPath("'/Users/a/My Films'")).toBe('/Users/a/My Films');
    expect(normalizePastedPath('"/Users/a/My Films"')).toBe('/Users/a/My Films');
    expect(normalizePastedPath('/Users/a/My\\ Films\\ \\(2026\\)')).toBe('/Users/a/My Films (2026)');
    expect(normalizePastedPath('C:\\Films\\demo')).toBe('C:\\Films\\demo');
  });

  it('takes the last path segment', () => {
    expect(basename('/Users/a/周末短片/')).toBe('周末短片');
    expect(basename('C:\\Films\\demo')).toBe('demo');
    expect(basename('demo')).toBe('demo');
  });

  it('parses target duration in seconds', () => {
    expect(parseDurationInput('')).toBeNull();
    expect(parseDurationInput(' 600 ')).toBe(600);
    expect(parseDurationInput('0')).toBe('invalid');
    expect(parseDurationInput('1.5')).toBe('invalid');
    expect(parseDurationInput('-3')).toBe('invalid');
    expect(parseDurationInput('10:00')).toBe('invalid');
  });

  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 秒');
    expect(formatDuration(750)).toBe('12 分 30 秒');
    expect(formatDuration(3600)).toBe('1 小时');
    expect(formatDuration(3725)).toBe('1 小时 2 分 5 秒');
    expect(formatDuration(0)).toBe('0 秒');
  });

  it('checks IANA time zones', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('displayPath', () => {
  it('shows paths under home as ~/…', () => {
    expect(displayPath('/Users/someone/Footage/Day1', '/Users/someone')).toBe('~/Footage/Day1');
    expect(displayPath('/Users/someone', '/Users/someone/')).toBe('~');
    expect(displayPath('C:\\Users\\someone\\Footage', 'C:\\Users\\someone')).toBe('~\\Footage');
  });

  it('leaves everything else alone', () => {
    expect(displayPath('/Users/someone2/Footage', '/Users/someone')).toBe('/Users/someone2/Footage');
    expect(displayPath('/Volumes/Card A/DCIM', '/Users/someone')).toBe('/Volumes/Card A/DCIM');
    expect(displayPath('/Users/someone/x', undefined)).toBe('/Users/someone/x');
    expect(displayPath('/x', '/')).toBe('/x');
  });
});

describe('hash routes', () => {
  it('maps #/view to a known view only', () => {
    expect(parseView('#/script')).toBe('script');
    expect(parseView('#/settings/')).toBe('settings');
    expect(parseView('#/unknown')).toBeNull();
    expect(parseView('#t=abc')).toBeNull();
    expect(parseView('')).toBeNull();
  });
});
