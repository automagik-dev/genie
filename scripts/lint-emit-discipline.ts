#!/usr/bin/env bun
/**
 * CI lint rule — emit discipline guard.
 *
 * Fails the build if any of these show up in `src/`:
 *   1. A direct `INSERT INTO genie_runtime_events*` outside the allowlist.
 *   2. A Zod schema under `src/lib/events/schemas/` that uses
 *      `.passthrough()` or `z.any()`.
 *   3. A schema file under `src/lib/events/schemas/` that does not mention
 *      a tier marker anywhere (`tier:A`, `tier:B`, `tier:C`, or `tagTier(`).
 *
 * Wired into `bun run check` via package.json.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const SRC_ROOT = join(REPO_ROOT, 'src');
const SCHEMAS_ROOT = join(SRC_ROOT, 'lib', 'events', 'schemas');

/**
 * Files that historically wrote to `genie_runtime_events` before emit.ts
 * existed. Group 3 migrates them into `emit.ts`; until then they are
 * grandfathered so the lint doesn't churn on a half-migrated tree.
 */
const INSERT_ALLOWLIST = new Set<string>([
  'src/lib/emit.ts',
  'src/lib/runtime-events.ts',
  // `events migrate --audit` is an authorized one-shot legacy-replay path:
  // it backfills historical audit_events into the enriched schema with a
  // sentinel source='audit-migrate' tag so consumer queries see the legacy
  // history through the new surface. Not used by normal emission.
  'src/term-commands/events-migrate.ts',
]);

type Finding = { path: string; line: number; message: string };
const findings: Finding[] = [];

function walk(dir: string, visit: (absPath: string) => void): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      walk(abs, visit);
    } else if (st.isFile()) {
      visit(abs);
    }
  }
}

function isCodeFile(path: string): boolean {
  return /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path);
}

function checkNoRawInsert(): void {
  const INSERT = /INSERT\s+INTO\s+genie_runtime_events\w*/i;
  walk(SRC_ROOT, (abs) => {
    if (!isCodeFile(abs)) return;
    const rel = relative(REPO_ROOT, abs);
    if (INSERT_ALLOWLIST.has(rel)) return;
    const src = readFileSync(abs, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      if (INSERT.test(line)) {
        findings.push({
          path: rel,
          line: idx + 1,
          message: 'direct INSERT INTO genie_runtime_events — route through src/lib/emit.ts',
        });
      }
    });
  });
}

function checkSchemaDiscipline(): void {
  let exists = true;
  try {
    statSync(SCHEMAS_ROOT);
  } catch {
    exists = false;
  }
  if (!exists) return;

  walk(SCHEMAS_ROOT, (abs) => {
    if (!isCodeFile(abs)) return;
    const rel = relative(REPO_ROOT, abs);
    const src = readFileSync(abs, 'utf8');
    const lines = src.split('\n');

    let sawTierMarker = false;
    lines.forEach((line, idx) => {
      if (/\.passthrough\s*\(/.test(line)) {
        findings.push({ path: rel, line: idx + 1, message: '.passthrough() forbidden in event schemas' });
      }
      if (/\bz\.any\s*\(/.test(line)) {
        findings.push({ path: rel, line: idx + 1, message: 'z.any() forbidden in event schemas' });
      }
      if (/tier:[ABC]/.test(line) || /tagTier\s*\(/.test(line) || /from\s+['"]\.\/_scaffold/.test(line)) {
        sawTierMarker = true;
      }
    });

    // Scaffolds shared helper file re-exports tier-tagged schemas; skip the
    // barrel / helper files that don't define a concrete type.
    const isScaffoldHelper = /_scaffold\.ts$/.test(rel);
    if (!sawTierMarker && !isScaffoldHelper) {
      findings.push({ path: rel, line: 1, message: 'schema file missing any tier tag (tagTier / tier:A/B/C)' });
    }
  });
}

checkNoRawInsert();
checkSchemaDiscipline();

if (findings.length > 0) {
  process.stderr.write(`\nemit-discipline lint: ${findings.length} violation(s)\n\n`);
  for (const f of findings) {
    process.stderr.write(`  ${f.path}:${f.line}: ${f.message}\n`);
  }
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write('emit-discipline lint: ok\n');
