import { defineConfig } from 'tsdown';

/**
 * Published package `storyscript-mov`: one ESM bundle for Node ≥24.15.
 * Workspace packages (contracts, core) are inlined; runtime dependencies stay
 * external (installed by npm); vite is dev-only and never bundled.
 * @resvg/resvg-wasm (MPL-2.0) stays an external dependency, unmodified.
 */
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  dts: false,
  fixedExtension: true,
  sourcemap: false,
  deps: {
    alwaysBundle: [/^@storyscript\//],
    neverBundle: ['vite', /^node:/],
  },
});
