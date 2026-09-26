import type { ImageDialect, ImagePreset } from '@storyscript/contracts';
import { GENERIC_PRESET, HOST_PRESETS } from './presets.ts';

/**
 * Dialect detection by host name (SPEC §1, FR-12):
 *   - a host matching a preset's host_patterns → generations-ref + that preset;
 *   - anything else → openai-edits (default);
 *   - dialect_override wins; forcing generations-ref on an unmatched host uses
 *     the generic preset.
 * Hosts known not to work for sketch redraw get a warning; `blocking`
 * warnings stop a redraw before anything is sent.
 */

export interface DialectInfo {
  dialect: ImageDialect;
  preset: ImagePreset | null;
  host: string;
  warning: string | null;
  /** the warning means redraw cannot work at all with this address */
  blocking: boolean;
}

export const GEMINI_WARNING = '该地址不接收参考图，不能用于草图重绘';
export const DASHSCOPE_COMPAT_WARNING = '百炼兼容模式不支持图像编辑，原生接口 v0.2 适配';
export const DASHSCOPE_NATIVE_WARNING = '百炼原生图像接口在 v0.2 适配，当前版本不能用于草图重绘';

/** Glob on host names: `*` matches one or more characters of [a-z0-9.-]. */
export function hostMatches(pattern: string, host: string): boolean {
  const re = new RegExp(
    `^${pattern
      .toLowerCase()
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[a-z0-9.-]+')}$`,
  );
  return re.test(host.toLowerCase());
}

function parseUrl(baseUrl: string): URL | null {
  try {
    return new URL(baseUrl);
  } catch {
    return null;
  }
}

export function matchPreset(host: string): ImagePreset | null {
  if (!host) return null;
  return HOST_PRESETS.find((p) => p.host_patterns.some((pat) => hostMatches(pat, host))) ?? null;
}

function hostWarning(url: URL | null): { warning: string | null; blocking: boolean } {
  if (!url) return { warning: null, blocking: false };
  const host = url.hostname.toLowerCase();
  if (host === 'generativelanguage.googleapis.com') return { warning: GEMINI_WARNING, blocking: true };
  if (/^dashscope(-intl)?\.aliyuncs\.com$/.test(host)) {
    return url.pathname.includes('compatible-mode')
      ? { warning: DASHSCOPE_COMPAT_WARNING, blocking: true }
      : { warning: DASHSCOPE_NATIVE_WARNING, blocking: true };
  }
  return { warning: null, blocking: false };
}

export function detectImageDialect(baseUrl: string, override: ImageDialect | null): DialectInfo {
  const url = parseUrl(baseUrl);
  const host = url?.hostname.toLowerCase() ?? '';
  const matched = matchPreset(host);
  const dialect: ImageDialect = override ?? (matched ? 'generations-ref' : 'openai-edits');
  const preset = dialect === 'generations-ref' ? (matched ?? GENERIC_PRESET) : null;
  return { dialect, preset, host, ...hostWarning(url) };
}
