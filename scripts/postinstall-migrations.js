#!/usr/bin/env node
/**
 * genie host-migrations postinstall hook.
 *
 * Runs `genie migrate --quiet` after `bun add -g @automagik/genie@<latest>`
 * so users get host-state self-heal transparently.
 *
 * Behavior:
 *   - GENIE_SKIP_MIGRATIONS=1 → exit 0 immediately (CI / containers)
 *   - No ~/.genie/ directory → fresh install, exit 0 silently
 *   - genie binary not callable yet → exit 0 (other postinstalls may run first)
 *   - Otherwise: invoke `genie migrate --quiet` with timeout
 *   - Soft-fail: any error logs warning, exits 0 (never breaks bun install)
 *
 * The escape hatch for forced re-runs is `genie migrate` (manual).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function main() {
  if (process.env.GENIE_SKIP_MIGRATIONS === '1') return;

  const genieRoot = path.join(os.homedir(), '.genie');
  if (!fs.existsSync(genieRoot)) return; // fresh install

  // Try locating the genie binary in this package
  const candidate = path.join(__dirname, '..', 'dist', 'genie.js');
  if (!fs.existsSync(candidate)) {
    process.stderr.write(`[genie-postinstall-migrations] dist not built yet at ${candidate}, skipping\n`);
    return;
  }

  const result = spawnSync(process.execPath, [candidate, 'migrate', '--quiet'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 60_000,
  });

  if (result.error) {
    process.stderr.write(`[genie-postinstall-migrations] WARNING: invocation failed: ${result.error.message}\n`);
    process.stderr.write('[genie-postinstall-migrations] Run `genie migrate` manually to retry.\n');
    return;
  }
  if (result.status !== 0) {
    process.stderr.write(`[genie-postinstall-migrations] WARNING: \`genie migrate\` exited ${result.status}\n`);
    process.stderr.write('[genie-postinstall-migrations] Run `genie migrate` manually to investigate.\n');
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[genie-postinstall-migrations] WARNING: unexpected error: ${err.message}\n`);
}
process.exit(0);
