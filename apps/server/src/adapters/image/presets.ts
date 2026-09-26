import { ImagePreset } from '@storyscript/contracts';
import genericJson from './presets/generic-generations.json' with { type: 'json' };
import openrouterJson from './presets/openrouter.json' with { type: 'json' };
import seedreamJson from './presets/volcengine-seedream.json' with { type: 'json' };

/**
 * generations-ref presets (SPEC FR-12): one JSON file per service in
 * ./presets, validated with contracts ImagePreset at load. Adding a service =
 * adding a JSON file and one import line here. `verified` stays false until a
 * real end-to-end run is recorded in docs/providers.md.
 */

export const PRESET_FILES = {
  'volcengine-seedream.json': seedreamJson,
  'openrouter.json': openrouterJson,
  'generic-generations.json': genericJson,
} as const;

function load(name: string, raw: unknown): ImagePreset {
  const parsed = ImagePreset.safeParse(raw);
  if (!parsed.success) throw new Error(`image preset ${name} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** Host-matched presets, in match priority order. */
export const HOST_PRESETS: readonly ImagePreset[] = [load('volcengine-seedream.json', seedreamJson), load('openrouter.json', openrouterJson)];

/** Used when generations-ref is forced for a host no preset matches. */
export const GENERIC_PRESET: ImagePreset = load('generic-generations.json', genericJson);

export const ALL_PRESETS: readonly ImagePreset[] = [...HOST_PRESETS, GENERIC_PRESET];

export function presetById(id: string): ImagePreset | null {
  return ALL_PRESETS.find((p) => p.id === id) ?? null;
}
