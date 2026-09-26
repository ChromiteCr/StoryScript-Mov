/** Order-independent JSON key for comparing plain data (no DOM, no deps). */
export function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
