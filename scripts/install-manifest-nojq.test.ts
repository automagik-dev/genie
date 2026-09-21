import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// install.sh reads a second manifest source (issue #2950). `manifest_get` has two
// parsers: jq, and — where jq is absent — a `sed` line match that reads "channel"
// and "version" from ANYWHERE in the body, including nested in an error object or
// in text that is not JSON. With one source that was harmless: there was nothing
// to out-rank. With two it decides which answer the installer believes, so the
// second source is read only where it can be validated strictly.
//
// This file exists because a suite that never controls which parser runs cannot
// see that difference — the property under test is parser-dependence itself.

const INSTALL_SH = join(import.meta.dir, '..', 'install.sh');
/**
 * The jq-present half cannot run where jq does not exist, and a host like that is
 * supported. It SKIPS there rather than failing, so a red suite still means the gate
 * is broken rather than "this machine is minimal" — but the jq-FREE half, which is the
 * half that owns the defect, always runs.
 */
const HAS_JQ = Bun.which('jq') !== null;

/** Everything install.sh reaches for, minus jq. */
const TOOLS = [
  'bash',
  'sh',
  'env',
  'sed',
  'tr',
  'head',
  'tail',
  'cat',
  'cut',
  'grep',
  'mktemp',
  'uname',
  'id',
  'mkdir',
  'rm',
  'chmod',
  'ln',
  'date',
  'dirname',
  'basename',
  'sort',
  'wc',
  'stat',
  'tar',
  'awk',
];

/** A PATH holding those tools and nothing else, so `command -v jq` genuinely fails. */
function noJqBin(dir: string): string {
  return toolBin(dir, 'nojq-bin', false);
}

/**
 * The same farm WITH jq linked in. Both halves are hermetic on purpose: taking the
 * host's PATH for the jq-present half would make every assertion there conditional
 * on this machine, and a jq-free host would turn those cases into silent duplicates
 * of the jq-free ones — the same shape as a broken gate.
 */
function jqBin(dir: string): string {
  return toolBin(dir, 'jq-bin', true);
}

function toolBin(dir: string, name: string, withJq: boolean): string {
  const bin = join(dir, name);
  mkdirSync(bin, { recursive: true });
  for (const tool of withJq ? [...TOOLS, 'jq'] : TOOLS) {
    const real = Bun.which(tool);
    if (real) symlinkSync(real, join(bin, tool));
  }
  return bin;
}

const REAL = JSON.stringify({
  schema_version: 1,
  channel: 'dev',
  version: '5.260918.2',
  released_at: '2026-09-18T00:00:00Z',
  tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v5.260918.2',
});

function fetchLatest(apiBody: string, opts: { withJq: boolean }): { code: number; out: string; argv: string } {
  const dir = mkdtempSync(join(tmpdir(), 'genie-nojq-'));
  const argvLog = join(dir, 'argv.log');
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> '${argvLog}'\nfor a in "$@"; do case "$a" in *api.github.com*) printf '%s' ${JSON.stringify(apiBody)}; exit 0 ;; esac; done\nprintf '%s' ${JSON.stringify(REAL)}\n`,
    { mode: 0o755 },
  );
  const run = Bun.spawnSync(['bash', '-c', 'source "$1"; fetch_latest dev', 'bash', INSTALL_SH], {
    env: {
      PATH: `${dir}:${opts.withJq ? jqBin(dir) : noJqBin(dir)}`,
      HOME: dir,
      GENIE_HOME: join(dir, 'genie-home'),
      GENIE_INSTALL_SOURCE_ONLY: '1',
      GENIE_CHANNEL: 'dev',
    },
  });
  return {
    code: run.exitCode,
    out: run.stdout.toString(),
    argv: Bun.file(argvLog).size > 0 ? require('node:fs').readFileSync(argvLog, 'utf-8') : '',
  };
}

describe('install.sh consults the second manifest source only where it can validate it', () => {
  test('both PATHs are what they claim, or nothing else in this file proves anything', () => {
    const probe = mkdtempSync(join(tmpdir(), 'genie-probe-'));
    const reachable = (path: string): boolean =>
      Bun.spawnSync(['bash', '-c', 'command -v jq'], { env: { PATH: path } }).exitCode === 0;
    // /usr/bin/jq exists on some hosts, so a system PATH is not enough: the jq-free
    // farm is built by name rather than by trimming the real PATH.
    expect(reachable(noJqBin(probe))).toBe(false);
    if (!HAS_JQ) return;
    // And the other half must PROVE it has jq. Asserting only the jq-free side left
    // "the gate is stuck closed" and "this host has no jq" indistinguishable, because
    // the jq-present cases inherited the host's PATH.
    expect(reachable(jqBin(probe))).toBe(true);
  });

  test('without jq a body that merely contains the words cannot displace the real manifest', () => {
    // Valid JSON, keys nested one level down: jq reads nothing, the line match reads
    // both. Without the gate this wins and the installer goes to tarball_base.
    const nested = JSON.stringify({
      error: { channel: 'dev', version: '9.9.9', tarball_base: 'https://not-the-release-host.example/v' },
    });
    const r = fetchLatest(nested, { withJq: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain('5.260918.2');
    expect(r.out).not.toContain('9.9.9');
    expect(r.out).not.toContain('not-the-release-host');
    // The read does not happen at all, which is the actual guarantee.
    expect(r.argv).not.toContain('api.github.com');
  });

  test('without jq a body that is not JSON at all cannot displace it either', () => {
    const prose = fetchLatest('failure: "channel": "dev" "version": "9.9.9"', { withJq: false });
    expect(prose.out).toContain('5.260918.2');
    expect(prose.out).not.toContain('9.9.9');
  });

  test.skipIf(!HAS_JQ)('with jq the same body is rejected on its own merits, and the source is still read', () => {
    const nested = JSON.stringify({ error: { channel: 'dev', version: '9.9.9' } });
    const r = fetchLatest(nested, { withJq: true });
    expect(r.out).toContain('5.260918.2');
    expect(r.out).not.toContain('9.9.9');
    expect(r.argv).toContain('api.github.com');
  });

  test('jq-free with no CDN answer fails rather than trusting the only body it cannot parse', () => {
    // The deliberate cost of the gate, pinned so it reads as a decision rather than a
    // regression: without jq there is no second source, so a CDN that cannot answer is
    // the end of the install — exit 5, the code it had before a second source existed.
    // The alternative is letting the sed matcher decide, with nothing to rank against.
    const dir = mkdtempSync(join(tmpdir(), 'genie-nocdn-'));
    writeFileSync(
      join(dir, 'curl'),
      '#!/bin/bash\nfor a in "$@"; do case "$a" in *api.github.com*) printf \'%s\' \'{"schema_version":1,"channel":"dev","version":"9.9.9","tarball_base":"https://x/v"}\'; exit 0 ;; esac; done\nexit 22\n',
      { mode: 0o755 },
    );
    const run = Bun.spawnSync(['bash', '-c', 'source "$1"; fetch_latest dev', 'bash', INSTALL_SH], {
      env: {
        PATH: `${dir}:${noJqBin(dir)}`,
        HOME: dir,
        GENIE_HOME: join(dir, 'genie-home'),
        GENIE_INSTALL_SOURCE_ONLY: '1',
        GENIE_CHANNEL: 'dev',
      },
    });
    expect(run.exitCode).toBe(5);
    expect(run.stdout.toString()).not.toContain('9.9.9');
  });

  test.skipIf(!HAS_JQ)('with jq a genuine newer answer still wins, so the gate costs nothing where it applies', () => {
    const fresher = JSON.stringify({
      schema_version: 1,
      channel: 'dev',
      version: '5.260918.4',
      released_at: '2026-09-18T01:00:00Z',
      tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v5.260918.4',
    });
    const r = fetchLatest(fresher, { withJq: true });
    expect(r.out).toContain('5.260918.4');
  });
});
