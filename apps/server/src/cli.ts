#!/usr/bin/env node
/**
 * CLI entry. Version shim first: on an unsupported Node we print how to
 * upgrade instead of crashing on node:sqlite or newer syntax. Everything
 * else is loaded lazily from main.ts only after the check passes.
 */
import { nodeUpgradeHelp, nodeVersionOk } from './node-version.ts';

if (!nodeVersionOk(process.versions.node)) {
  console.error(nodeUpgradeHelp(process.versions.node));
  process.exit(1);
}

const { main } = await import('./main.ts');
const code = await main(process.argv.slice(2));
if (code !== undefined) process.exitCode = code;
