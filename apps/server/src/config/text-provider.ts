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

// ------------------------------------------------------------ S3 research --

export type SearchSupport = 'dashscope' | 'openai';

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** The web-search flag a service takes, from its address (null: none we know). */
export function searchSupport(baseUrl: string): SearchSupport | null {
  const host = hostOf(baseUrl);
  if (host === 'dashscope.aliyuncs.com' || host.endsWith('.dashscope.aliyuncs.com') || host === 'dashscope-intl.aliyuncs.com') return 'dashscope';
  if (host === 'api.openai.com') return 'openai';
  return null;
}

/** Body fields that turn web search on for this service and model, or null. */
export function searchBody(baseUrl: string, model: string): Record<string, unknown> | null {
  const support = searchSupport(baseUrl);
  if (support === 'dashscope') return { enable_search: true };
  // OpenAI searches only with its search models (…-search-preview and the like)
  if (support === 'openai' && /search/i.test(model)) return { web_search_options: {} };
  return null;
}

export interface ResearchSettings {
  /** null: the main model */
  model: string | null;
  search: boolean;
}

export function researchSettings(stateDir: string): ResearchSettings {
  const stored = readCredentials(stateDir).llm ?? {};
  return { model: clean(stored.research_model), search: stored.research_search === true };
}

/** Client and body for a style research call: the main service and key, maybe another model, maybe web search. */
export function researchClientConfig(
  stateDir: string,
  main: TextClientConfig,
): { cfg: TextClientConfig; extraBody: Record<string, unknown> | null } {
  const r = researchSettings(stateDir);
  const cfg = { ...main, model: r.model ?? main.model };
  return { cfg, extraBody: r.search ? searchBody(cfg.base_url, cfg.model) : null };
}

/** What the settings page may see: never the key, only its last 4 characters. */
export function textProviderView(stateDir: string, env: NodeJS.ProcessEnv): TextProviderView | null {
  const r = resolveTextProvider(stateDir, env);
  if (!r.base_url && !r.model && !r.api_key) return null;
  const research = researchSettings(stateDir);
  return {
    base_url: r.base_url ?? '',
    model: r.model ?? '',
    key_last4: keyLast4(r.api_key),
    source: r.source,
    research_model: research.model,
    research_search: research.search,
    search_support: r.base_url ? searchSupport(r.base_url) : null,
  };
}

/**
 * Save to credentials.json (0600). api_key: omitted/null keeps the stored key,
 * "" clears it. Environment values still win afterwards.
 */
export function saveTextProvider(stateDir: string, input: SaveTextProviderInput): void {
  const creds = readCredentials(stateDir);
  const prev = creds.llm ?? {};
  const next: { base_url: string; model: string; api_key?: string; research_model?: string; research_search?: boolean } = {
    base_url: input.base_url.trim(),
    model: input.model.trim(),
  };
  // S3 research settings: omitted keeps what is stored; null or "" = the main model
  const researchModel = input.research_model === undefined ? prev.research_model : (input.research_model ?? '').trim();
  if (researchModel) next.research_model = researchModel;
  const search = input.research_search ?? prev.research_search;
  if (search) next.research_search = true;
  if (input.api_key === undefined || input.api_key === null) {
    if (prev.api_key) next.api_key = prev.api_key;
  } else if (input.api_key.trim() !== '') {
    next.api_key = input.api_key.trim();
  }
  writeCredentials(stateDir, { ...creds, llm: next });
}
