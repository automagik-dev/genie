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
import {
  CODEX_DELIVERY_INCOMPLETE_TRAILER,
  CODEX_DELIVERY_RESULT_TRAILER,
  CODEX_LIFECYCLE_BUSY_TRAILER,
} from '../../src/genie-commands/codex-delivery.js';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh');
const INSTALL_MODULE = join(REPO_ROOT, 'src', 'genie-commands', 'install.ts');
const LEASE_MODULE = join(REPO_ROOT, 'src', 'lib', 'codex-lifecycle-lease.ts');
const VERSION = '0.0.0-exit2-test';
const RESULT_TRAILER = CODEX_DELIVERY_RESULT_TRAILER;
const HUMAN_JSON_EXAMPLE = 'diagnostic example: {"schemaVersion":1,"code":"not-a-result"}';
const UNRELATED_JSON = '{"message":"schemaVersion and code remain human words"}';

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
    `    printf '%s\\n' '${HUMAN_JSON_EXAMPLE}'`,
    `    printf '%s\\n' '${UNRELATED_JSON}'`,
    `    printf '%s\\n' '${RESULT_TRAILER}'`,
    '    exit 2 ;;',
    '  *) echo "stub-genie:${1:-}"; exit 0 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(join(binDir, 'genie'), script, { mode: 0o755 });
}

/** An invalid exit-2 result stream containing both success and failure lifecycle trailers. */
function writeMixedTrailerStubGenie(contradictoryTrailer: string): void {
  const script = [
    '#!/usr/bin/env bash',
    'case "${1:-}" in',
    `  --version|-v) echo "${VERSION} (stub)"; exit 0 ;;`,
    '  install)',
    `    printf '%s\\n' '${RESULT_TRAILER}'`,
    `    printf '%s\\n' '${contradictoryTrailer}'`,
    '    exit 2 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n');
  writeFileSync(join(binDir, 'genie'), script, { mode: 0o755 });
}

/** A real install command whose inner lease loses to setup immediately before the shell finisher handoff. */
function writeSetupBusyStubGenie(): string {
  const finisher = join(work, 'setup-busy-finisher.ts');
  const mutationMarker = join(work, 'unexpected-finisher-mutation');
  writeFileSync(
    finisher,
    [
      "import { writeFileSync } from 'node:fs';",
      `import { acquireLifecycleLease } from ${JSON.stringify(LEASE_MODULE)};`,
      `import { installCommand } from ${JSON.stringify(INSTALL_MODULE)};`,
      'const genieHome = process.env.GENIE_HOME as string;',
      `const mutationMarker = ${JSON.stringify(mutationMarker)};`,
      "const mark = (phase: string) => writeFileSync(mutationMarker, phase + '\\n');",
      "const setup = acquireLifecycleLease('setup-activation', { genieHome });",
      "if (!setup.ok) throw new Error('fixture setup could not acquire Codex lifecycle lease');",
      'try {',
      '  await installCommand(',
      "    { integrations: 'codex' },",
      "    () => mark('cleanup'),",
      "    () => { mark('normalize'); return undefined; },",
      "    () => mark('sync'),",
      "    () => { mark('integrations'); return []; },",
      "    () => ({ path: '/fixture/borrowed-agent-sync.lock', release: () => undefined }),",
      '    undefined,',
      "    () => mark('consent'),",
      '    () => null,',
      '  );',
      '} finally {',
      '  setup.release();',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(binDir, 'genie'),
    [
      '#!/usr/bin/env bash',
      'case "${1:-}" in',
      `  --version|-v) echo "${VERSION} (stub)"; exit 0 ;;`,
      `  install) exec ${JSON.stringify(process.execPath)} run ${JSON.stringify(finisher)} ;;`,
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return mutationMarker;
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
    expect(first.output.split(RESULT_TRAILER)).toHaveLength(2);
    expect(first.output).toContain(HUMAN_JSON_EXAMPLE);
    expect(first.output).toContain(UNRELATED_JSON);
    // Delivered-but-deferred message, and explicitly NO all-green footer.
    expect(first.output).toContain('Codex activation deferred');
    expect(first.output).not.toContain(`genie v${VERSION} installed`);
    // The lifecycle lock is released on completion (every terminal path).
    expect(existsSync(lockPath)).toBe(false);

    // Immediate rerun: identical exit and state (idempotent).
    const second = runHarness();
    expect(second.status).toBe(2);
    expect(second.output).toContain('"deliveryComplete":true');
    expect(second.output.split(RESULT_TRAILER)).toHaveLength(2);
    expect(second.output).not.toContain(`genie v${VERSION} installed`);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a genuine finisher failure (exit 1) still dies 1', () => {
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

  test('setup winning before the real finisher keeps exit-2 busy delivery-incomplete and emits no false green footer', () => {
    const mutationMarker = writeSetupBusyStubGenie();
    mkdirSync(join(work, 'tmp'), { recursive: true, mode: 0o700 });

    const result = runHarness();

    expect(result.status).toBe(1);
    expect(result.output).toContain('"code":"codex-lifecycle-busy"');
    expect(result.output).toContain('"deliveryComplete":false');
    expect(result.output.split(CODEX_LIFECYCLE_BUSY_TRAILER)).toHaveLength(2);
    expect(result.output).not.toContain(RESULT_TRAILER);
    expect(result.output).not.toContain('Codex activation deferred');
    expect(result.output).not.toContain(`genie v${VERSION} installed`);
    expect(result.output).toContain('installation remains incomplete and retryable');
    expect(existsSync(mutationMarker)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(join(work, '.genie', '.codex-lifecycle.lock'))).toBe(false);
  });

  for (const [label, contradictoryTrailer] of [
    ['busy', CODEX_LIFECYCLE_BUSY_TRAILER],
    ['incomplete', CODEX_DELIVERY_INCOMPLETE_TRAILER],
    ['duplicate canonical action', RESULT_TRAILER],
    [
      'canonical-prefix unknown lifecycle result',
      '{"schemaVersion":1,"code":"future-lifecycle-result","deliveryComplete":true}',
    ],
    [
      'reordered-key unknown lifecycle result',
      '{"code":"future-lifecycle-result","deliveryComplete":true,"schemaVersion":1}',
    ],
    [
      'whitespace-padded schema-first lifecycle result',
      ' { "schemaVersion" : 2, "code" : "future-lifecycle-result", "deliveryComplete" : false } ',
    ],
    [
      'whitespace-padded reordered lifecycle result',
      '  {  "code" : "future-lifecycle-result" , "deliveryComplete" : false , "schemaVersion" : 2  }  ',
    ],
  ] as const) {
    test(`an action-required trailer mixed with ${label} fails closed with no deferred or green result`, () => {
      writeMixedTrailerStubGenie(contradictoryTrailer);
      mkdirSync(join(work, 'tmp'), { recursive: true, mode: 0o700 });

      const result = runHarness();

      expect(result.status).toBe(1);
      const outputLines = result.output.split(/\r?\n/);
      expect(outputLines.filter((line) => line === RESULT_TRAILER)).toHaveLength(
        contradictoryTrailer === RESULT_TRAILER ? 2 : 1,
      );
      expect(outputLines).toContain(contradictoryTrailer);
      expect(result.output).not.toContain('Codex activation deferred');
      expect(result.output).not.toContain(`genie v${VERSION} installed`);
      expect(result.output).toContain('installation remains incomplete and retryable');
      expect(existsSync(lockPath)).toBe(false);
    });
  }
});
