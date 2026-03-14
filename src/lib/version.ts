/**
 * Version — reads from package.json at runtime so `genie update` reflects the new version.
 *
 * Resolution order:
 *   1. package.json relative to this file (dev / bun run)
 *   2. package.json in the project root (compiled dist)
 *   3. Hardcoded fallback
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FALLBACK_VERSION = '0.0.0-unknown';

function readVersionFromPackageJson(): string {
  // Try paths relative to this module
  const candidates = [
    // From src/lib/version.ts → ../../package.json
    resolve(dirname(import.meta.dir ?? __dirname), '..', '..', 'package.json'),
    // From dist/genie.js → ../package.json
    resolve(dirname(import.meta.dir ?? __dirname), '..', 'package.json'),
    // From dist/genie.js → ./package.json (if placed alongside)
    resolve(dirname(import.meta.dir ?? __dirname), 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        if (pkg.version) return pkg.version;
      }
    } catch {
      // Try next candidate
    }
  }

  return FALLBACK_VERSION;
}

export const VERSION = readVersionFromPackageJson();
