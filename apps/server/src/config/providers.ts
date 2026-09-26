import { readCredentials, type Credentials } from './paths.ts';

/**
 * Provider configuration flags. A provider counts as configured when base_url,
 * api_key and model are all present; each field comes from env
 * (STORYSCRIPT_LLM_* / STORYSCRIPT_IMAGE_*) first, then credentials.json.
 * Only booleans leave this module — keys never reach the frontend.
 */

type Kind = 'llm' | 'image';
const ENV_PREFIX: Record<Kind, string> = { llm: 'STORYSCRIPT_LLM_', image: 'STORYSCRIPT_IMAGE_' };
const FIELDS = ['base_url', 'api_key', 'model'] as const;

function isConfigured(kind: Kind, creds: Credentials, env: NodeJS.ProcessEnv): boolean {
  const stored = creds[kind] ?? {};
  return FIELDS.every((f) => {
    // an empty env var counts as unset
    const value = env[`${ENV_PREFIX[kind]}${f.toUpperCase()}`]?.trim() || stored[f]?.trim();
    return typeof value === 'string' && value.length > 0;
  });
}

export interface ProviderFlags {
  text_provider_configured: boolean;
  image_provider_configured: boolean;
}

export function providerFlags(stateDir: string, env: NodeJS.ProcessEnv = process.env): ProviderFlags {
  const creds = readCredentials(stateDir);
  return {
    text_provider_configured: isConfigured('llm', creds, env),
    image_provider_configured: isConfigured('image', creds, env),
  };
}
