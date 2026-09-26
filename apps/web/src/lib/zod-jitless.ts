/**
 * zod 4 probes `new Function` for its JIT fast path. Under our CSP (no
 * 'unsafe-eval') the probe fails safely but is still reported as a CSP
 * violation. zod keeps its config on this global (created with `??=`), so
 * setting `jitless` before the first parse turns the probe off.
 * Import before anything that parses. Replace with `z.config({ jitless: true })`
 * once apps/web lists zod as a direct dependency.
 */
const g = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
(g.__zod_globalConfig ??= {}).jitless = true;

export {};
