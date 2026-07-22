/**
 * Executed installer integration test — delivered-not-activated exit-2 propagation
 * (Group C, deliverable 10).
 *
 * This test actually RUNS install.sh's real post-install lifecycle end-to-end
 * inside an isolated fixture. `bash -n` is only a fast pre-check; this is the
 * proof. To keep the run hermetic and host-independent, the network/verify
 * surface (platform detection, manifest fetch, signed download, extraction,
 * final binary verification, lifecycle-lock primitives) is stubbed via bash
 * function override AFTER sourcing install.sh with GENIE_INSTALL_SOURCE_ONLY=1 —
 * but the code under test is the REAL, unmodified `handoff_to_subcommand` and
 * `main` exit-2 branch. The stub `genie` on `$LOCAL_BIN` is a genuine executable
 * whose post-install `install` yields the delivered/action-required state
 * (exit 2 + the stable A-owned result trailer with deliveryComplete:true).
 *
 * It asserts install.sh:
 *   - exits 2 (delivered-not-activated, NOT a failure die 1);
 *   - relays the stable result trailer (deliveryComplete:true) over stdout;
 *   - prints NO all-green "genie v<version> installed" footer;
 *   - releases the lifecycle lock on completion;
 *   - reruns idempotently with an identical exit code and state.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh');
const VERSION = '0.0.0-exit2-test';
const RESULT_TRAILER =
  '{"schemaVersion":1,"code":"activation-pending","deliveryComplete":true,"retry":false,' +
  '"nextAction":"retire tasks -> genie setup --codex -> /hooks -> new task"}';

let work: string;
let binDir: string;
let lockPath: string;
let harness: string;

/** A genuine executable genie whose `install` yields delivered/action-required (exit 2 + trailer). */
function writeStubGenie(): void {
  const script = [
    '#!/usr/bin/env bash',
    'case "${1:-}" in',
    `  --version|-v) echo "${VERSION} (stub)"; exit 0 ;;`,
    '  install)',
    `    printf '  ! Codex plugin: activation-pending (installed=5.260710.2, target=${VERSION})\\n'`,
    `    printf '%s\\n' '${RESULT_TRAILER}'`,
    '    exit 2 ;;',
    '  *) echo "stub-genie:${1:-}"; exit 0 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(join(binDir, 'genie'), script, { mode: 0o755 });
}

/**
 * A bash harness: source install.sh (source-only), stub the network/verify
 * surface, and run the REAL main() exit-2 lifecycle against the stub genie.
 */
function writeHarness(): void {
  const script = [
    '#!/usr/bin/env bash',
    'export GENIE_INSTALL_SOURCE_ONLY=1',
    `source ${JSON.stringify(INSTALL_SH)}`,
    '# Stub the network/verify/extraction surface — leave handoff_to_subcommand + main REAL.',
    'need() { :; }',
    'detect_platform() { echo "linux-x64-glibc"; }',
    'resolve_channel() { echo "stable"; }',
    'fetch_latest() { echo "{}"; }',
    `manifest_get() { case "$2" in version) echo "${VERSION}";; tarball_base) echo "file:///fixture";; *) echo "";; esac; }`,
    `acquire_lifecycle_lock() { LIFECYCLE_LOCK=${JSON.stringify(lockPath)}; LIFECYCLE_OWNER_RECORD="test-owner"; printf '%s\\n' "$LIFECYCLE_OWNER_RECORD" > "$LIFECYCLE_LOCK"; }`,
    'download_and_verify() { echo "/fixture/genie.tar.gz"; }',
    'extract_and_link() { :; }',
    'detect_legacy_install() { :; }',
    'ensure_path_wired() { :; }',
    'verify_installation() { :; }',
    'release_lifecycle_lock() { rm -f "$LIFECYCLE_LOCK"; LIFECYCLE_LOCK=""; }',
    `LOCAL_BIN=${JSON.stringify(binDir)}`,
    'main "$@"',
    '',
  ].join('\n');
  writeFileSync(harness, script, { mode: 0o755 });
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'genie-install-exit2-'));
  binDir = join(work, 'bin');
  lockPath = join(work, '.genie-lifecycle-test.lock');
  harness = join(work, 'harness.sh');
  mkdirSync(binDir, { recursive: true });
  writeStubGenie();
  writeHarness();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function runHarness(): { status: number | null; output: string } {
  const result = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: {
      HOME: work,
      GENIE_HOME: join(work, '.genie'),
      CODEX_HOME: join(work, 'codex'),
      TMPDIR: join(work, 'tmp'),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
  });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

describe('install.sh delivered-not-activated exit-2 propagation (executed)', () => {
  test('propagates exit 2 with the result trailer, no all-green footer, lock released, idempotent rerun', () => {
    // install.sh's validate_private_temp_root rejects a group-writable temp parent,
    // so pin the mode instead of inheriting the host umask (0002 hosts create 775).
    mkdirSync(join(work, 'tmp'), { recursive: true, mode: 0o700 });

    const first = runHarness();
    // Delivered-not-activated is exit 2, NOT the die-1 failure path.
    expect(first.status).toBe(2);
    // The stable A-owned result trailer with deliveryComplete:true is relayed.
    expect(first.output).toContain('"deliveryComplete":true');
    expect(first.output).toContain('"code":"activation-pending"');
    // Delivered-but-deferred message, and explicitly NO all-green footer.
    expect(first.output).toContain('Codex activation deferred');
    expect(first.output).not.toContain(`genie v${VERSION} installed`);
    // The lifecycle lock is released on completion (every terminal path).
    expect(existsSync(lockPath)).toBe(false);

    // Immediate rerun: identical exit and state (idempotent).
    const second = runHarness();
    expect(second.status).toBe(2);
    expect(second.output).toContain('"deliveryComplete":true');
    expect(second.output).not.toContain(`genie v${VERSION} installed`);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a genuine finisher failure (exit 1) still dies 1 — exit 2 is the ONLY action-required code', () => {
    // Swap the stub genie's install to a hard failure; the real handoff must die 1.
    writeFileSync(
      join(binDir, 'genie'),
      [
        '#!/usr/bin/env bash',
        'case "${1:-}" in',
        '  install) echo "boom" >&2; exit 1 ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    // install.sh's validate_private_temp_root rejects a group-writable temp parent,
    // so pin the mode instead of inheriting the host umask (0002 hosts create 775).
    mkdirSync(join(work, 'tmp'), { recursive: true, mode: 0o700 });
    const result = runHarness();
    expect(result.status).toBe(1);
    expect(result.output).toContain('installation remains incomplete and retryable');
    expect(existsSync(lockPath)).toBe(false);
  });
});
