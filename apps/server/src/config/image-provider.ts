import { ImageDialect, type ImageProviderView, type SaveImageProviderInput } from '@storyscript/contracts';
import type { z } from 'zod';
import { detectImageDialect, type DialectInfo } from '../adapters/image/dialect.ts';
import { readCredentials, writeCredentials } from './paths.ts';
import { keyLast4 } from './text-provider.ts';

/**
 * Image provider settings (SPEC §6, FR-12). Fields come from the environment
 * (STORYSCRIPT_IMAGE_BASE_URL / _API_KEY / _MODEL) first, then
 * credentials.json → image (0600). dialect_override lives in the file only.
 * The key never leaves this module except to build a request.
 */

const ENV = { base_url: 'STORYSCRIPT_IMAGE_BASE_URL', api_key: 'STORYSCRIPT_IMAGE_API_KEY', model: 'STORYSCRIPT_IMAGE_MODEL' } as const;
type Field = keyof typeof ENV;

export interface ResolvedImageProvider {
  base_url: string | null;
  api_key: string | null;
  model: string | null;
  dialect_override: ImageDialect | null;
  /** 'env' when any field comes from the environment */
  source: 'env' | 'file';
  env_fields: Field[];
}

export interface ImageClientConfig extends DialectInfo {
  base_url: string;
  api_key: string;
  model: string;
}

const clean = (v: string | undefined | null) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function resolveImageProvider(stateDir: string, env: NodeJS.ProcessEnv): ResolvedImageProvider {
  const stored = readCredentials(stateDir).image ?? {};
  const override = ImageDialect.safeParse(stored.dialect_override);
  const out: ResolvedImageProvider = {
    base_url: null,
    api_key: null,
    model: null,
    dialect_override: override.success ? override.data : null,
    source: 'file',
    env_fields: [],
  };
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

/** Complete config with the detected dialect, or null when base_url / api_key / model is missing. */
export function imageClientConfig(stateDir: string, env: NodeJS.ProcessEnv): ImageClientConfig | null {
  const r = resolveImageProvider(stateDir, env);
  if (!r.base_url || !r.api_key || !r.model) return null;
  return { base_url: r.base_url, api_key: r.api_key, model: r.model, ...detectImageDialect(r.base_url, r.dialect_override) };
}

/** What the settings page may see: never the key, only its last 4 characters. */
export function imageProviderView(stateDir: string, env: NodeJS.ProcessEnv): ImageProviderView | null {
  const r = resolveImageProvider(stateDir, env);
  if (!r.base_url && !r.model && !r.api_key && !r.dialect_override) return null;
  const d = detectImageDialect(r.base_url ?? '', r.dialect_override);
  return {
    base_url: r.base_url ?? '',
    model: r.model ?? '',
    key_last4: keyLast4(r.api_key),
    source: r.source,
    dialect_override: r.dialect_override,
    dialect: d.dialect,
    preset_id: d.preset?.id ?? null,
    verified: d.preset ? d.preset.verified : false,
    warning: d.warning,
  };
}

/**
 * Save to credentials.json (0600). api_key: omitted/null keeps the stored key,
 * "" clears it. Environment values still win afterwards.
 */
export function saveImageProvider(stateDir: string, input: z.infer<typeof SaveImageProviderInput>): void {
  const creds = readCredentials(stateDir);
  const prev = creds.image ?? {};
  const next: { base_url: string; model: string; api_key?: string; dialect_override: ImageDialect | null } = {
    base_url: input.base_url.trim(),
    model: input.model.trim(),
    dialect_override: input.dialect_override,
  };
  if (input.api_key === undefined || input.api_key === null) {
    if (prev.api_key) next.api_key = prev.api_key;
  } else if (input.api_key.trim() !== '') {
    next.api_key = input.api_key.trim();
  }
  writeCredentials(stateDir, { ...creds, image: next });
}
