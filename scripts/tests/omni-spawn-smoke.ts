#!/usr/bin/env bun
/**
 * Smoke test for issue #2486 — Omni-Bridge spawn command corruption.
 *
 * Validates that the NEW script-based path (writeTmuxLaunchScript + source)
 * works reliably with long commands containing backticks, emojis, parentheses,
 * and nested quotes.
 *
 * Run with:
 *   bun run scripts/tests/omni-spawn-smoke.ts
 */

import { execSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { writeTmuxLaunchScript } from '../../src/lib/tmux-launch-script.js';

const MARKER = 'OMNI_SPAWN_SUCCESS_2486';
const RESULT_FILE = `/tmp/${MARKER}`;

// Build a deliberately nasty payload with all the problematic chars.
// We wrap everything in a single 'sh -c' so writeTmuxLaunchScript's
// leading 'exec' works correctly (the real Genie launches 'claude',
// a long-running process; here we use 'sleep' to keep the pane alive
// long enough for capture).
const nastyPayload = '👍 `backticks` (instance: alpha) (ALWAYS your last action)';
const innerCommand = [
  `echo '${MARKER}'`,
  `export TEST_VAR='${nastyPayload}'`,
  `export JSON='{"emoji":"👍","nested":"(instance: alpha)"}'`,
  `export LONG='${'A'.repeat(1800)}'`,
  `touch ${RESULT_FILE}`,
  'sleep 1',
].join(' && ');

// The full command that Genie would pass to writeTmuxLaunchScript
const nastyCommand = `sh -c '${innerCommand.replace(/'/g, "'\\''")}'`;

function killServer(socket: string) {
  try {
    execSync(`tmux -L ${socket} kill-server 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

function cleanup(socket: string, scriptPath?: string) {
  killServer(socket);
  try {
    unlinkSync(RESULT_FILE);
  } catch {
    // ignore
  }
  if (scriptPath) {
    try {
      unlinkSync(scriptPath);
    } catch {
      // ignore
    }
  }
}

function createPane(socket: string): string {
  execSync(`tmux -L ${socket} new-session -d -e LC_ALL=C.UTF-8 -e LANG=C.UTF-8`, { stdio: 'ignore' });
  execSync('sleep 0.3');
  const paneId = execSync(`tmux -L ${socket} list-panes -F '#{pane_id}'`, { encoding: 'utf-8' }).trim();
  return paneId;
}

function capturePane(socket: string, paneId: string): string {
  try {
    return execSync(`tmux -L ${socket} capture-pane -p -t '${paneId}' -S -10`, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function waitForResult(socket: string, paneId: string, timeoutMs = 5000): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = capturePane(socket, paneId);
    if (content.includes(MARKER)) return true;
    if (content.includes('parse error')) return false;
    execSync('sleep 0.2');
  }
  return false;
}

console.log('=== Omni-Bridge Spawn Smoke Test (#2486) ===\n');

// ---------------------------------------------------------------------------
// TEST 1: OLD inline path (replicates executeTmux -> send-keys without -l)
// ---------------------------------------------------------------------------
const socket1 = 'genie-smoke-old';
console.log('TEST 1: Inline send-keys (old path)');
cleanup(socket1);
const pane1 = createPane(socket1);

// Replicate the OLD Genie path exactly:
// executeTmux(`send-keys -t '${paneId}' ${shellQuote(cmd)} Enter`)
const quotedOld = `'${nastyCommand.replace(/'/g, "'\\''")}'`;
try {
  execSync(`tmux -L ${socket1} send-keys -t '${pane1}' ${quotedOld} Enter`);
} catch (e) {
  console.log(`  tmux send-keys itself failed: ${e instanceof Error ? e.message : e}`);
}

const oldOk = waitForResult(socket1, pane1);
const oldContent = capturePane(socket1, pane1);
const oldHasParseError = oldContent.includes('parse error');
console.log(`  Parse error visible: ${oldHasParseError}`);
console.log(`  Marker detected: ${oldOk}`);
console.log(`  Result: ${oldOk ? 'PASS' : 'FAIL / FLAKY'}\n`);

killServer(socket1);

// ---------------------------------------------------------------------------
// TEST 2: NEW script-based path
// ---------------------------------------------------------------------------
const socket2 = 'genie-smoke-new';
console.log('TEST 2: Script-based send-keys (writeTmuxLaunchScript + source)');
cleanup(socket2);
const pane2 = createPane(socket2);

const scriptPath = writeTmuxLaunchScript('smoke-2486', nastyCommand);
// Replicate the NEW Genie path:
// executeTmux(`send-keys -t '${paneId}' "source ${scriptPath}" Enter`)
execSync(`tmux -L ${socket2} send-keys -t '${pane2}' "source ${scriptPath}" Enter`);

const newOk = waitForResult(socket2, pane2);
const newContent = capturePane(socket2, pane2);
const newHasParseError = newContent.includes('parse error');
let markerOnDisk = false;
try {
  markerOnDisk = readFileSync(RESULT_FILE).toString().trim() === '';
} catch {
  markerOnDisk = false;
}
console.log(`  Parse error visible: ${newHasParseError}`);
console.log(`  Marker in pane: ${newContent.includes(MARKER)}`);
console.log(`  Marker file created: ${markerOnDisk}`);
console.log(`  Result: ${newOk ? 'PASS' : 'FAIL'}\n`);

cleanup(socket2, scriptPath);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('=== Summary ===');
if (!oldOk && newOk) {
  console.log('✅ Fix validated: inline path fails, script path is stable.');
  process.exit(0);
} else if (oldOk && newOk) {
  console.log('⚠️  Both paths passed on this machine (tmux/zsh may be tolerant for this payload).');
  console.log('   The script path is still the safer architectural choice for 1968+ char payloads.');
  process.exit(0);
} else if (!newOk) {
  console.log('❌ New script path failed — investigate.');
  process.exit(1);
} else {
  console.log('❓ Unexpected state — review output above.');
  process.exit(1);
}
