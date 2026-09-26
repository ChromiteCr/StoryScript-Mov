import { z } from 'zod';

/**
 * zod 4 probes `new Function` for its JIT fast path; under our CSP (no
 * 'unsafe-eval') that probe is reported as a violation. Import before
 * anything that parses.
 */
z.config({ jitless: true });
