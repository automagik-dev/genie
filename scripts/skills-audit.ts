#!/usr/bin/env bun
/**
 * skills-audit: enforce the "mechanical reference fix only" scope fence
 * for the unify-bridge-revamp-skills wish.
 *
 * For every skill file under skills/, compare the current working tree
 * against its baseline (default: HEAD) using `git diff --numstat`.
 * If any single file has > 30% of its lines changed (added+deleted
 * relative to the baseline's line count), fail.
 *
 * Override the baseline with SKILLS_AUDIT_BASE=<ref>.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKILLS_DIR = 'skills';
const THRESHOLD = 0.3;
function sh(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' });
}

/**
 * Resolve the diff baseline. HEAD is the wrong default for CI: on a clean
 * checkout the working tree matches HEAD, numstat is empty, and the audit
 * passes vacuously. Default to origin/dev, fall back to its merge-base, and
 * only fall back to HEAD as a last resort (and log why).
 */
function resolveBase(): string {
  const override = process.env.SKILLS_AUDIT_BASE;
  if (override) return override;
  const candidates = [
    { ref: 'origin/dev', kind: 'origin/dev' },
    {
      ref: (() => {
        try {
          return execSync('git merge-base HEAD origin/dev', { cwd: ROOT, encoding: 'utf8' }).trim();
        } catch {
          return '';
        }
      })(),
      kind: 'merge-base HEAD origin/dev',
    },
  ];
  for (const c of candidates) {
    if (!c.ref) continue;
    try {
      execSync(`git rev-parse --verify ${c.ref}`, { cwd: ROOT, stdio: 'pipe' });
      return c.ref;
    } catch {
      // try next
    }
  }
  console.warn('[skills-audit] origin/dev unavailable — falling back to HEAD (enforcement will be vacuous)');
  return 'HEAD';
}

const BASE = resolveBase();
console.log(`[skills-audit] baseline ref: ${BASE}`);

interface Row {
  file: string;
  added: number;
  deleted: number;
  baselineLines: number;
  ratio: number;
}

function baselineLineCount(file: string): number {
  try {
    const out = sh(`git show ${BASE}:${file} 2>/dev/null | wc -l`).trim();
    return Number.parseInt(out, 10) || 0;
  } catch {
    // New file — use current line count to avoid div-by-zero.
    if (existsSync(join(ROOT, file))) {
      return readFileSync(join(ROOT, file), 'utf8').split('\n').length;
    }
    return 0;
  }
}

function main() {
  let numstat: string;
  try {
    numstat = sh(`git diff --numstat ${BASE} -- ${SKILLS_DIR}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`skills-audit: failed to diff against ${BASE}: ${msg}`);
    process.exit(2);
  }

  const rows: Row[] = [];
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [addedStr, deletedStr, file] = line.split('\t');
    const added = Number.parseInt(addedStr, 10) || 0;
    const deleted = Number.parseInt(deletedStr, 10) || 0;
    const baseline = baselineLineCount(file) || Math.max(added + deleted, 1);
    const ratio = (added + deleted) / baseline;
    rows.push({ file, added, deleted, baselineLines: baseline, ratio });
  }

  const violations = rows.filter((r) => r.ratio > THRESHOLD);

  console.log(JSON.stringify({ base: BASE, threshold: THRESHOLD, files: rows, violations }, null, 2));

  if (violations.length > 0) {
    console.error(`\nskills-audit: ${violations.length} file(s) exceeded ${THRESHOLD * 100}% change threshold`);
    process.exit(1);
  }
  console.error(`skills-audit: OK (${rows.length} changed file(s); all within ${THRESHOLD * 100}% threshold)`);
}

main();
