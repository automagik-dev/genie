#!/usr/bin/env bun
/**
 * genie-wipe — fresh-start the local genie state to emulate new-user experience.
 *
 * Wipes:
 *   • pgserve data directory (~/.genie/data/pgserve) — full DB reset; migrations re-run on next connect
 *   • optional: worktrees, teams, state, spawn-scripts, logs, wishes, brainstorms (--full)
 *
 * Does NOT touch:
 *   • ~/.genie/config.json (user prefs — preserved by default, add --config to wipe)
 *   • ~/.genie/tmux.conf, scripts/, osc52-copy.sh (installer-owned files)
 *   • User's shell history, repos outside .genie/worktrees
 *
 * Modes:
 *   • default: --dry-run (prints size + path preview, no writes)
 *   • --apply: writes. Requires stdin interlock `I UNDERSTAND FRESH INSTALL`.
 *   • --full: also wipe .genie/{worktrees,teams,state,spawn-scripts,logs,wishes,brainstorms}
 *   • --config: also wipe .genie/config.json (returns to post-install defaults)
 *
 * Idempotent: a second run finds nothing to wipe (since dir already gone).
 *
 * On completion the next `genie <verb>` call re-creates pgserve fresh and runs
 * all migrations. No auto-start is performed by this script itself.
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const GENIE_HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');

const ALWAYS_WIPE = [join(GENIE_HOME, 'data', 'pgserve')];

const FULL_EXTRA = [
  join(GENIE_HOME, 'worktrees'),
  join(GENIE_HOME, 'teams'),
  join(GENIE_HOME, 'state'),
  join(GENIE_HOME, 'spawn-scripts'),
  join(GENIE_HOME, 'logs'),
  join(GENIE_HOME, 'wishes'),
  join(GENIE_HOME, 'brainstorms'),
];

const CONFIG_EXTRA = [
  join(GENIE_HOME, 'config.json'),
  join(GENIE_HOME, 'pgserve.port'),
  join(GENIE_HOME, 'serve.pid'),
  join(GENIE_HOME, 'brain-version-check.json'),
];

interface Flags {
  apply: boolean;
  full: boolean;
  config: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): Flags {
  return {
    apply: argv.includes('--apply'),
    full: argv.includes('--full'),
    config: argv.includes('--config'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function printHelp(): void {
  console.log(`genie-wipe — fresh-start local genie state.

USAGE
  bun scripts/genie-wipe.ts [--apply] [--full] [--config]

FLAGS
  (none)     --dry-run (default). Prints what would be wiped. No writes.
  --apply    Actually wipe. Prompts for 'I UNDERSTAND FRESH INSTALL' interlock.
  --full     Also wipe worktrees/teams/state/spawn-scripts/logs/wishes/brainstorms.
  --config   Also wipe config.json + pgserve.port + serve.pid.
  --help     Show this help.

EXAMPLES
  bun scripts/genie-wipe.ts                       # dry-run, DB-only
  bun scripts/genie-wipe.ts --full                # dry-run, everything except config
  bun scripts/genie-wipe.ts --apply               # wipe DB only
  bun scripts/genie-wipe.ts --apply --full --config   # nuke everything

AFTER
  Next 'genie' command auto-starts fresh pgserve and runs migrations.
  If --full was used, 'genie team ls' will show zero teams, 'genie task list' will be empty.
`);
}

function sizeOf(path: string): string {
  if (!existsSync(path)) return '—';
  try {
    if (statSync(path).isDirectory()) {
      const out = execSync(`du -sh "${path}" 2>/dev/null || echo '?'`, { encoding: 'utf8' });
      return out.split('\t')[0] ?? '?';
    }
    return `${statSync(path).size}B`;
  } catch {
    return '?';
  }
}

function stopRunningProcesses(): void {
  // Stop genie serve if running (which manages pgserve subprocess).
  try {
    execSync('genie daemon stop 2>/dev/null || true', { stdio: 'ignore' });
  } catch {
    // Non-fatal.
  }
  // Kill any stray pgserve / postgres processes under our data dir.
  try {
    execSync(`pgrep -f "${GENIE_HOME}/data/pgserve" 2>/dev/null | xargs -r kill -9 2>/dev/null || true`, {
      stdio: 'ignore',
    });
  } catch {
    // Non-fatal.
  }
}

async function confirmInterlock(targets: string[]): Promise<boolean> {
  console.log('\n━━━ WIPE MANIFEST ━━━');
  for (const t of targets) {
    const exists = existsSync(t);
    console.log(`  ${exists ? '✘' : '·'}  ${t}  (${exists ? sizeOf(t) : 'not present'})`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('This is destructive. Type exactly: I UNDERSTAND FRESH INSTALL');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('> ');
    return answer.trim() === 'I UNDERSTAND FRESH INSTALL';
  } finally {
    rl.close();
  }
}

function wipePath(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  const targets = [...ALWAYS_WIPE];
  if (flags.full) targets.push(...FULL_EXTRA);
  if (flags.config) targets.push(...CONFIG_EXTRA);

  // Always show the dry-run preview first.
  console.log(`GENIE_HOME = ${GENIE_HOME}\n`);
  console.log('Targets to wipe:');
  let anyPresent = false;
  for (const t of targets) {
    const exists = existsSync(t);
    if (exists) anyPresent = true;
    console.log(`  ${exists ? '✘' : '·'}  ${t}  (${exists ? sizeOf(t) : 'not present'})`);
  }

  if (!flags.apply) {
    console.log('\nDry-run only. Re-run with --apply to actually wipe.');
    return;
  }

  if (!anyPresent) {
    console.log('\nNothing to wipe — all targets absent. Exiting 0.');
    return;
  }

  const ok = await confirmInterlock(targets);
  if (!ok) {
    console.error('\n✖ Aborted — interlock phrase not matched.');
    process.exit(2);
  }

  console.log('\n▸ Stopping genie serve + pgserve…');
  stopRunningProcesses();

  console.log('▸ Wiping targets…');
  for (const t of targets) {
    if (existsSync(t)) {
      console.log(`    rm -rf ${t}`);
      wipePath(t);
    }
  }

  // Verify.
  const remaining = targets.filter((t) => existsSync(t));
  if (remaining.length > 0) {
    console.error(`\n✖ Wipe incomplete — still present: ${remaining.join(', ')}`);
    process.exit(1);
  }

  console.log('\n✓ Wipe complete.');
  console.log('  Next genie command will auto-start fresh pgserve and run all migrations.');
  if (flags.full) {
    console.log('  Worktrees/teams/state cleared. You are a new user.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
