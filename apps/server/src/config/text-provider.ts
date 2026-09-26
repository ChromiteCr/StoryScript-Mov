import type { SaveTextProviderInput, TextProviderView } from '@storyscript/contracts';
import type { TextClientConfig } from '../adapters/llm/chat.ts';
import { readCredentials, writeCredentials } from './paths.ts';

/**
 * Text provider settings (SPEC §6). Each field comes from the environment
 * (STORYSCRIPT_LLM_BASE_URL / _API_KEY / _MODEL) first, then credentials.json
 * → llm. Same precedence as config/providers.ts. The key itself never leaves
 * this module except to build the SDK client.
 */

const ENV = { base_url: 'STORYSCRIPT_LLM_BASE_URL', api_key: 'STORYSCRIPT_LLM_API_KEY', model: 'STORYSCRIPT_LLM_MODEL' } as const;
type Field = keyof typeof ENV;

export interface ResolvedTextProvider {
  base_url: string | null;
  api_key: string | null;
  model: string | null;
  /** 'env' when any field comes from the environment */
  source: 'env' | 'file';
  env_fields: Field[];
}

const clean = (v: string | undefined | null) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function resolveTextProvider(stateDir: string, env: NodeJS.ProcessEnv): ResolvedTextProvider {
  const stored = readCredentials(stateDir).llm ?? {};
  const out: ResolvedTextProvider = { base_url: null, api_key: null, model: null, source: 'file', env_fields: [] };
  for (const f of Object.keys(ENV) as Field[]) {
    const fromEnv = clean(env[ENV[f]]);
    if (fromEnv) {
      out[f] = fromEnv;
      out.env_fields.push(f);
    } else {
      out[f] = clean(stored[f]);
    }
  }
  if (out.env_fields.length) out.source = 'env';
  return out;
}

/** Complete client config, or null when base_url / api_key / model is missing. */
export function textClientConfig(stateDir: string, env: NodeJS.ProcessEnv): TextClientConfig | null {
  const r = resolveTextProvider(stateDir, env);
  if (!r.base_url || !r.api_key || !r.model) return null;
  return { base_url: r.base_url, api_key: r.api_key, model: r.model };
}

export function keyLast4(key: string | null): string | null {
  if (!key) return null;
  return key.length >= 8 ? key.slice(-4) : '****';
}

/** What the settings page may see: never the key, only its last 4 characters. */
export function textProviderView(stateDir: string, env: NodeJS.ProcessEnv): TextProviderView | null {
  const r = resolveTextProvider(stateDir, env);
  if (!r.base_url && !r.model && !r.api_key) return null;
  return { base_url: r.base_url ?? '', model: r.model ?? '', key_last4: keyLast4(r.api_key), source: r.source };
}

/**
 * Save to credentials.json (0600). api_key: omitted/null keeps the stored key,
 * "" clears it. Environment values still win afterwards.
 */
export function saveTextProvider(stateDir: string, input: SaveTextProviderInput): void {
  const creds = readCredentials(stateDir);
  const prev = creds.llm ?? {};
  const next: { base_url: string; model: string; api_key?: string } = {
    base_url: input.base_url.trim(),
    model: input.model.trim(),
  };
  if (input.api_key === undefined || input.api_key === null) {
    if (prev.api_key) next.api_key = prev.api_key;
  } else if (input.api_key.trim() !== '') {
    next.api_key = input.api_key.trim();
  }
  writeCredentials(stateDir, { ...creds, llm: next });
}
