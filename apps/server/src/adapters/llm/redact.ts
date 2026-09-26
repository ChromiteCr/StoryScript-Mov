/**
 * Secret scrubbing for anything that may reach logs, API responses or job
 * rows. Providers sometimes echo (part of) the key in error messages, so the
 * configured key is removed verbatim and anything that looks like a bearer
 * token / sk- key is masked as well.
 */

const KEY_LIKE = /\b(sk|pk|rk|ak)-[A-Za-z0-9_\-*.]{6,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9_\-.~+/=*]{6,}/gi;

export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***');
  }
  return out.replace(BEARER, 'Bearer ***').replace(KEY_LIKE, '$1-***');
}
