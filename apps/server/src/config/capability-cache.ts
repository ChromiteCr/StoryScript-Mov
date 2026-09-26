import { z } from 'zod';
import { StructuredMode } from '@storyscript/contracts';
import { readConfig, writeConfig } from './paths.ts';

/**
 * Structured-output capability per endpoint (base_url + model), persisted in
 * config.json → capability_cache. Only the base URL and model id are stored,
 * never keys.
 */

export interface CapabilityCache {
  get(base_url: string, model: string): StructuredMode | null;
  set(base_url: string, model: string, mode: StructuredMode): void;
}

const Entry = z.object({ mode: StructuredMode, probed_at: z.string() });
const CacheShape = z.record(z.string(), Entry);

export const capabilityKey = (base_url: string, model: string) => `${base_url.replace(/\/+$/, '')}|${model}`;

export class FileCapabilityCache implements CapabilityCache {
  constructor(private readonly stateDir: string) {}

  private read(): z.infer<typeof CacheShape> {
    const parsed = CacheShape.safeParse(readConfig(this.stateDir).capability_cache);
    return parsed.success ? parsed.data : {};
  }

  get(base_url: string, model: string): StructuredMode | null {
    return this.read()[capabilityKey(base_url, model)]?.mode ?? null;
  }

  set(base_url: string, model: string, mode: StructuredMode): void {
    const config = readConfig(this.stateDir);
    const current = this.read();
    const key = capabilityKey(base_url, model);
    if (current[key]?.mode === mode) return;
    current[key] = { mode, probed_at: new Date().toISOString() };
    writeConfig(this.stateDir, { ...config, capability_cache: current });
  }
}

export class MemoryCapabilityCache implements CapabilityCache {
  private readonly map = new Map<string, StructuredMode>();

  get(base_url: string, model: string): StructuredMode | null {
    return this.map.get(capabilityKey(base_url, model)) ?? null;
  }

  set(base_url: string, model: string, mode: StructuredMode): void {
    this.map.set(capabilityKey(base_url, model), mode);
  }
}
