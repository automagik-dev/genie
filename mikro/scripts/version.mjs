#!/usr/bin/env node

/**
 * Version bump script for mikro.
 *
 * Format: 1.YYMMDD.N
 *   - 1       fixed major prefix (bumped from 0 on 2026-08-17 — v1 declares
 *             the public surface production-ready; versions remain calendar
 *             cuts and CHANGELOG.md remains the compatibility source. Old
 *             v0.* tags stay in history; npm orders every 1.* above them.)
 *   - YYMMDD  today's date (UTC)
 *   - N       1-based daily build counter (highest existing v1.YYMMDD.* tag + 1)
 *
 * Env override: MIKRO_BUILD_NUMBER — forces N to the given value.
 *
 * Syncs the computed version into every committed version location, so a tag
 * cut on the bump commit cannot lie about package contents (see the coherence
 * invariants in docs/release-contract.md):
 *   - package.json         ("version" field)
 *   - package-lock.json    (".version" and '.packages[""].version')
 *   - src/version.ts       (VERSION export)
 *   - dist/src/version.js  (dist/ is committed for git-URL consumers)
 *   - dist/src/version.d.ts
 *
 * Invoked by `npm run bump-version` and by the Release Metadata workflow, which
 * runs it on a bare runner — so this script must stay dependency-free.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Highest N already tagged for this UTC day, or 0 when the day is untagged.
// Deliberately max(N) rather than a tag count: a single deleted or skipped tag
// would make a count-based N collide with an existing tag forever after, and a
// collision means `gh release create` fails and main ships without a release.
function getHighestBuildNumber(datePrefix) {
  const tagPrefix = `v1.${datePrefix}.`;
  try {
    const output = execSync(`git tag --list "${tagPrefix}*"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output
      .split('\n')
      .map((tag) => Number(tag.trim().slice(tagPrefix.length)))
      .filter((n) => Number.isInteger(n) && n > 0)
      .reduce((max, n) => Math.max(max, n), 0);
  } catch {
    return 0;
  }
}

function generateVersion() {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const datePrefix = `${yy}${mm}${dd}`;

  const envBuild = process.env.MIKRO_BUILD_NUMBER;
  const n = envBuild ? Number(envBuild) : getHighestBuildNumber(datePrefix) + 1;

  return `1.${datePrefix}.${n}`;
}

// ---------------------------------------------------------------------------
// Sync files
// ---------------------------------------------------------------------------

function syncPackageJson(version) {
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`  package.json -> ${version}`);
}

function syncPackageLock(version) {
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) return;
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
  console.log(`  package-lock.json -> ${version}`);
}

function syncVersionTs(version) {
  const versionPath = join(root, 'src', 'version.ts');
  const content = `export const VERSION = '${version}';\n`;
  writeFileSync(versionPath, content, 'utf-8');
  console.log(`  src/version.ts -> ${version}`);
}

// dist/ is committed (see .gitignore), so a bump that touches only src/ ships a
// stale VERSION to `bun add git+...` consumers. Rewrite just the version
// literal instead of regenerating the file, so the result stays byte-identical
// to `tsc` output (which emits no trailing newline after the sourceMap
// comment) and `npm run build` produces no follow-up diff.
function syncDistVersion(version) {
  for (const relPath of ['dist/src/version.js', 'dist/src/version.d.ts']) {
    const distPath = join(root, relPath);
    if (!existsSync(distPath)) continue;
    const before = readFileSync(distPath, 'utf-8');
    const after = before.replace(
      /(VERSION\s*=\s*)(['"])[^'"]*\2/,
      (_match, assign, quote) => `${assign}${quote}${version}${quote}`,
    );
    if (after === before && !before.includes(version)) {
      throw new Error(
        `Could not find a VERSION literal to rewrite in ${relPath}. ` +
          'Run `npm run build` and re-run the bump.',
      );
    }
    writeFileSync(distPath, after, 'utf-8');
    console.log(`  ${relPath} -> ${version}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const version = generateVersion();
console.log(`Bumping to ${version}`);
syncPackageJson(version);
syncPackageLock(version);
syncVersionTs(version);
syncDistVersion(version);
console.log('Done.');
