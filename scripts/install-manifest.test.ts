import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// install.sh resolves the channel manifest from raw.githubusercontent.com, whose cache
// is independent of the repository (~5 min), so right after a release publishes a fresh
// install lands a version behind — issue #2950, the install-side twin of #2947.
// `fetch_latest` therefore reads the public contents API as well and keeps the newer
// answer.
//
// `install-swap.test.ts` already pins the happy paths of that resolution (the API copy
// winning while the CDN is stale, the CDN winning on a numeric comparison, a failed API
// read and a base64 envelope both degrading to the CDN). This file covers what is left:
// the TIE, a rate-limit body, each source alone, both sources gone, a channel mismatch —
// i.e. that neither pre-existing exit code was lost — and the request shapes themselves.
// Every case runs the real `fetch_latest` with `curl` shimmed onto PATH: no network, and
// the shim records its argv so the raw Accept header is asserted from what was sent.

const INSTALL_SH = join(import.meta.dir, '..', 'install.sh');

// Every case in the first describe reads the SECOND source, which fetch_latest consults
// only where jq can validate the answer (see the last describe for why). Inheriting the
// host's PATH therefore made each assertion conditional on this machine having jq: on a
// host without it these would quietly become no-second-source cases and fail for a
// reason that looks exactly like a broken gate. The PATH is built instead, from a farm
// that links the tools in by name, with or without jq, and the jq cases skip where the
// host has no jq to link.

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

/**
 * The jq-present cases cannot run where jq does not exist, and a host like that is
 * supported. They SKIP there rather than failing, so a red suite still means the gate
 * is broken rather than "this machine is minimal" — but the jq-FREE cases, which own
 * the defect, always run.
 */
const HAS_JQ = Bun.which('jq') !== null;

function toolBin(dir: string, name: string, withJq: boolean): string {
  const bin = join(dir, name);
  mkdirSync(bin, { recursive: true });
  for (const tool of withJq ? [...TOOLS, 'jq'] : TOOLS) {
    const real = Bun.which(tool);
    if (real) symlinkSync(real, join(bin, tool));
  }
  return bin;
}

/** The farm WITH jq linked in. */
const jqBin = (dir: string): string => toolBin(dir, 'jq-bin', true);
/** A PATH holding the tools and nothing else, so `command -v jq` genuinely fails. */
const noJqBin = (dir: string): string => toolBin(dir, 'nojq-bin', false);

const manifest = (version: string, channel = 'dev'): string =>
  JSON.stringify({
    schema_version: 1,
    channel,
    version,
    released_at: '2026-09-18T00:00:00Z',
    tarball_base: 'https://x/v',
  });

/** The contents API's answer WITHOUT the raw Accept header: an envelope, not the file. */
const envelope = (inner: string): string =>
  JSON.stringify({
    name: 'dev.json',
    path: '.well-known/dev.json',
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(inner).toString('base64'),
  });

const RATE_LIMITED = JSON.stringify({ message: 'API rate limit exceeded for 203.0.113.7.', status: '403' });

interface Answers {
  cdn?: string;
  api?: string;
}

function fetchLatest(
  answers: Answers,
  { withJq = true }: { withJq?: boolean } = {},
): { code: number; out: string; err: string; argv: string } {
  const dir = mkdtempSync(join(tmpdir(), 'genie-manifest-'));
  const argvLog = join(dir, 'argv.log');
  // `curl -fsSL` exits non-zero on an HTTP error and prints nothing; an absent answer
  // here is that case, which is what an offline host or a spent API budget looks like.
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> '${argvLog}'\nfor a in "$@"; do case "$a" in *api.github.com*) ${
      answers.api === undefined ? 'exit 22' : `printf '%s' ${JSON.stringify(answers.api)}; exit 0`
    } ;; esac; done\n${answers.cdn === undefined ? 'exit 22' : `printf '%s' ${JSON.stringify(answers.cdn)}; exit 0`}\n`,
    { mode: 0o755 },
  );
  const run = Bun.spawnSync(['bash', '-c', 'source "$1"; fetch_latest dev', 'bash', INSTALL_SH], {
    env: {
      PATH: `${dir}:${withJq ? jqBin(dir) : noJqBin(dir)}`,
      HOME: dir,
      GENIE_HOME: join(dir, 'genie-home'),
      GENIE_INSTALL_SOURCE_ONLY: '1',
      GENIE_CHANNEL: 'dev',
    },
  });
  return {
    code: run.exitCode,
    out: run.stdout.toString(),
    err: run.stderr.toString(),
    argv: readFileSync(argvLog, 'utf-8'),
  };
}

describe('install.sh fetch_latest dual-source manifest edges (#2950)', () => {
  test.skipIf(!HAS_JQ)('the CDN answer is kept when it leads, and on a tie', () => {
    expect(fetchLatest({ cdn: manifest('5.260918.9'), api: manifest('5.260918.4') }).out).toContain('5.260918.9');
    const tie = fetchLatest({ cdn: manifest('5.260918.4'), api: manifest('5.260918.4') });
    expect(tie.out).toContain('5.260918.4');
  });

  test.skipIf(!HAS_JQ)('neither an envelope nor an error body can displace the CDN answer', () => {
    // Both carry no `channel`, so a stale-but-valid CDN answer survives junk that
    // happens to be newer-looking inside.
    const enveloped = fetchLatest({ cdn: manifest('5.260918.2'), api: envelope(manifest('9.260918.9')) });
    expect(enveloped.code).toBe(0);
    expect(enveloped.out).toContain('5.260918.2');
    const limited = fetchLatest({ cdn: manifest('5.260918.2'), api: RATE_LIMITED });
    expect(limited.code).toBe(0);
    expect(limited.out).toContain('5.260918.2');
  });

  test.skipIf(!HAS_JQ)(
    'either source alone still installs; neither is a hard failure with the original exit code',
    () => {
      expect(fetchLatest({ cdn: manifest('5.260918.2') }).out).toContain('5.260918.2');
      const apiOnly = fetchLatest({ api: manifest('5.260918.4') });
      expect(apiOnly.code).toBe(0);
      expect(apiOnly.out).toContain('5.260918.4');
      // Both unreachable keeps the pre-existing contract: exit 5, naming the CDN url.
      const neither = fetchLatest({});
      expect(neither.code).toBe(5);
      expect(neither.err).toContain('could not fetch');
      // Both answered but for another channel keeps the other pre-existing contract.
      const wrongChannel = fetchLatest({
        cdn: manifest('5.260918.2', 'stable'),
        api: manifest('5.260918.4', 'stable'),
      });
      expect(wrongChannel.code).toBe(1);
      expect(wrongChannel.err).toContain('manifest channel mismatch');
    },
  );

  test.skipIf(!HAS_JQ)(
    'the API is asked for the file its own bytes, on main, and the CDN is asked without that header',
    () => {
      const r = fetchLatest({ cdn: manifest('5.260918.2'), api: manifest('5.260918.4') });
      const lines = r.argv.trim().split('\n');
      const apiCall = lines.find((l) => l.includes('api.github.com')) ?? '';
      const cdnCall = lines.find((l) => l.includes('raw.githubusercontent.com')) ?? '';
      expect(apiCall).toContain('Accept: application/vnd.github.raw');
      expect(apiCall).toContain('/contents/.well-known/dev.json?ref=main');
      // Without the header the API answers with the envelope the test above rejects.
      expect(cdnCall).not.toContain('Accept:');
      expect(cdnCall).toContain('/main/.well-known/dev.json');
    },
  );
});

// `manifest_get` has two parsers: jq, and — where jq is absent — a `sed` line match that
// reads "channel" and "version" from ANYWHERE in the body, including nested in an error
// object or in text that is not JSON. With one source that was harmless; with two it
// decides which answer the installer believes, so the second source is read only where
// it can be validated strictly. The property under test is parser-dependence itself, so
// these cases control which parser runs.
describe('install.sh consults the second manifest source only where it can validate it', () => {
  const REAL = manifest('5.260918.2');

  test('both PATHs are what they claim, or nothing else here proves anything', () => {
    const probe = mkdtempSync(join(tmpdir(), 'genie-probe-'));
    const reachable = (path: string): boolean =>
      Bun.spawnSync(['bash', '-c', 'command -v jq'], { env: { PATH: path } }).exitCode === 0;
    // /usr/bin/jq exists on some hosts, so a system PATH is not enough: the jq-free
    // farm is built by name rather than by trimming the real PATH.
    expect(reachable(noJqBin(probe))).toBe(false);
    if (!HAS_JQ) return;
    // And the other half must PROVE it has jq, or "the gate is stuck closed" and "this
    // host has no jq" stay indistinguishable.
    expect(reachable(jqBin(probe))).toBe(true);
  });

  test('without jq a body that merely contains the words, or is not JSON at all, cannot displace the real manifest', () => {
    // Valid JSON, keys nested one level down: jq reads nothing, the line match reads
    // both. Without the gate this wins and the installer goes to tarball_base.
    const nested = JSON.stringify({
      error: { channel: 'dev', version: '9.9.9', tarball_base: 'https://not-the-release-host.example/v' },
    });
    for (const api of [nested, 'failure: "channel": "dev" "version": "9.9.9"']) {
      const r = fetchLatest({ cdn: REAL, api }, { withJq: false });
      expect(r.code).toBe(0);
      expect(r.out).toContain('5.260918.2');
      expect(r.out).not.toContain('9.9.9');
      expect(r.out).not.toContain('not-the-release-host');
      // The read does not happen at all, which is the actual guarantee.
      expect(r.argv).not.toContain('api.github.com');
    }
  });

  test.skipIf(!HAS_JQ)('with jq the same body is rejected on its own merits, and the source is still read', () => {
    const nested = JSON.stringify({ error: { channel: 'dev', version: '9.9.9' } });
    const r = fetchLatest({ cdn: REAL, api: nested });
    expect(r.out).toContain('5.260918.2');
    expect(r.out).not.toContain('9.9.9');
    expect(r.argv).toContain('api.github.com');
  });

  test('jq-free with no CDN answer fails rather than trusting the only body it cannot parse', () => {
    // The deliberate cost of the gate, pinned so it reads as a decision rather than a
    // regression: without jq there is no second source, so a CDN that cannot answer is
    // the end of the install — exit 5, the code it had before a second source existed.
    const r = fetchLatest({ api: manifest('9.9.9') }, { withJq: false });
    expect(r.code).toBe(5);
    expect(r.out).not.toContain('9.9.9');
  });

  test.skipIf(!HAS_JQ)('with jq a genuine newer answer still wins, so the gate costs nothing where it applies', () => {
    expect(fetchLatest({ cdn: REAL, api: manifest('5.260918.4') }).out).toContain('5.260918.4');
  });
});
