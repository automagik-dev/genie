/**
 * doctor — minimal diagnostic checks for a genie install.
 *
 * v5 is zero-daemon: no PostgreSQL, no pm2, no tmux supervision. The doctor
 * therefore only checks the handful of things genie actually depends on:
 *   1. the genie binary + its version (and whether it is on PATH)
 *   2. git present + repo detection
 *   3. the shared .genie/genie.db is openable at the expected schema version
 *   4. the skills prompts are present
 *   5. bun present (genie runs under bun)
 *
 * Human-readable by default; `--json` emits the raw check results. Exits
 * non-zero if any check is a hard failure.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION, GenieDbError, openDb, resolveDbPath, resolveRepoRoot } from '../lib/v5/genie-db.js';
import { VERSION } from '../lib/version.js';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  suggestion?: string;
}

// ============================================================================
// Output helpers (process.stdout/stderr — no console.* in v5 source)
// ============================================================================

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

const GLYPH: Record<CheckStatus, string> = {
  pass: '\x1b[32m✔\x1b[0m',
  warn: '\x1b[33m!\x1b[0m',
  fail: '\x1b[31m✖\x1b[0m',
};

function whichBinary(name: string): string | null {
  try {
    const bunWhich = (Bun as unknown as { which?: (n: string) => string | null }).which;
    if (typeof bunWhich === 'function') return bunWhich(name);
  } catch {
    /* fall through to execFileSync */
  }
  try {
    return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Individual checks
// ============================================================================

function checkGenieBinary(): CheckResult[] {
  const results: CheckResult[] = [{ name: `genie version ${VERSION}`, status: 'pass' }];
  const onPath = whichBinary('genie');
  if (onPath) {
    results.push({ name: 'genie on PATH', status: 'pass', detail: onPath });
  } else {
    results.push({
      name: 'genie on PATH',
      status: 'warn',
      detail: 'not found on PATH',
      suggestion: 'Run `genie setup` (or add the install dir to PATH) to invoke genie without an explicit path.',
    });
  }
  return results;
}

function checkGit(): CheckResult[] {
  const gitPath = whichBinary('git');
  if (!gitPath) {
    return [
      {
        name: 'git present',
        status: 'fail',
        detail: 'git not found on PATH',
        suggestion: 'Install git — genie resolves the repo root and shared genie.db via git.',
      },
    ];
  }
  const results: CheckResult[] = [{ name: 'git present', status: 'pass', detail: gitPath }];
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside === 'true') {
      results.push({ name: 'inside a git repository', status: 'pass', detail: resolveRepoRoot() });
    } else {
      results.push({ name: 'inside a git repository', status: 'warn', detail: 'not a work tree' });
    }
  } catch {
    results.push({
      name: 'inside a git repository',
      status: 'warn',
      detail: 'not inside a git repository',
      suggestion: 'Run genie from within a git repo — per-repo state lives under <repo>/.genie/.',
    });
  }
  return results;
}

function checkDatabase(): CheckResult[] {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    return [
      {
        name: 'genie.db',
        status: 'pass',
        detail: `absent at ${dbPath} (created on first task/board use)`,
      },
    ];
  }
  try {
    const db = openDb({ path: dbPath });
    try {
      const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
      const version = row?.user_version ?? 0;
      if (version === CURRENT_SCHEMA_VERSION) {
        return [{ name: 'genie.db', status: 'pass', detail: `${dbPath} (schema v${version})` }];
      }
      return [
        {
          name: 'genie.db',
          status: 'fail',
          detail: `${dbPath} reports schema v${version}, expected v${CURRENT_SCHEMA_VERSION}`,
        },
      ];
    } finally {
      db.close();
    }
  } catch (err) {
    const detail = err instanceof GenieDbError ? err.message : err instanceof Error ? err.message : String(err);
    return [{ name: 'genie.db', status: 'fail', detail }];
  }
}

function checkSkills(): CheckResult[] {
  // skills/ ships alongside the source tree; resolve it relative to the repo
  // root (dev) — an installed plugin bundle exposes the same directory.
  const candidates = [join(resolveRepoRoot(), 'skills'), join(import.meta.dir, '..', '..', 'skills')];
  const found = candidates.find((p) => existsSync(join(p, 'wish', 'SKILL.md')) || existsSync(join(p, 'wish.md')));
  if (found) {
    return [{ name: 'skills present', status: 'pass', detail: found }];
  }
  return [
    {
      name: 'skills present',
      status: 'warn',
      detail: 'skills/ directory not found',
      suggestion: 'Reinstall genie or run from the repo root so skill prompts resolve.',
    },
  ];
}

function checkBun(): CheckResult[] {
  const bunVersion = typeof Bun !== 'undefined' ? Bun.version : null;
  const onPath = whichBinary('bun');
  if (bunVersion) {
    return [
      {
        name: `bun ${bunVersion}`,
        status: 'pass',
        detail: onPath ?? 'running under bun',
      },
    ];
  }
  return [
    {
      name: 'bun present',
      status: 'fail',
      detail: 'bun runtime not detected',
      suggestion: 'Install bun (https://bun.sh) — genie is a bun single-file binary.',
    },
  ];
}

// ============================================================================
// Entry point
// ============================================================================

export async function doctorCommand(options?: { json?: boolean }): Promise<void> {
  const results: CheckResult[] = [
    ...checkGenieBinary(),
    ...checkGit(),
    ...checkDatabase(),
    ...checkSkills(),
    ...checkBun(),
  ];

  const failed = results.filter((r) => r.status === 'fail');

  if (options?.json) {
    out(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2));
  } else {
    out('genie doctor');
    out('');
    for (const r of results) {
      const suffix = r.detail ? ` — ${r.detail}` : '';
      out(`  ${GLYPH[r.status]} ${r.name}${suffix}`);
      if (r.suggestion) out(`      ↳ ${r.suggestion}`);
    }
    out('');
    out(failed.length === 0 ? '\x1b[32mAll checks passed.\x1b[0m' : `\x1b[31m${failed.length} check(s) failed.\x1b[0m`);
  }

  if (failed.length > 0) process.exitCode = 1;
}
