import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// install.sh resolves the channel manifest from raw.githubusercontent.com, whose cache
// is independent of the repository (~5 min), so right after a release publishes a fresh
// install lands a version behind — issue #2950, the install-side twin of #2947. It now
// reads the public contents API as well and keeps the newer answer. Every case below
// runs the real `fetch_latest` with `curl` shimmed onto PATH: no network, and the shim
// records its argv so the raw Accept header is asserted from what was actually sent.

const INSTALL_SH = join(import.meta.dir, '..', 'install.sh');
/** Tools install.sh reaches for; jq is deliberately absent from this list. */
const NO_JQ_TOOLS = [
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
  const bin = join(dir, 'nojq-bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of NO_JQ_TOOLS) {
    const real = Bun.which(tool);
    if (real) symlinkSync(real, join(bin, tool));
  }
  return bin;
}

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
  /** Hide `jq`, the config on which manifest_get falls back to a line match. */
  withoutJq?: boolean;
}

function fetchLatest(answers: Answers): { code: number; out: string; err: string; argv: string } {
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
      // A jq-free host is supported and manifest_get behaves differently there, so
      // that case runs with a PATH holding the system tools install.sh needs but
      // not the directory jq lives in. SYSTEM_PATH is asserted jq-free below, so
      // this can never quietly become the jq case again.
      PATH: answers.withoutJq ? `${dir}:${noJqBin(dir)}` : `${dir}:${process.env.PATH ?? ''}`,
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

describe('install.sh fetch_latest reads both manifest sources (#2950)', () => {
  test('the API answer wins while the CDN copy is still stale', () => {
    const r = fetchLatest({ cdn: manifest('5.260918.2'), api: manifest('5.260918.4') });
    expect(r.code).toBe(0);
    expect(r.out).toContain('5.260918.4');
    expect(r.out).not.toContain('5.260918.2');
  });

  test('the CDN answer is kept when it leads, and on a tie', () => {
    expect(fetchLatest({ cdn: manifest('5.260918.9'), api: manifest('5.260918.4') }).out).toContain('5.260918.9');
    const tie = fetchLatest({ cdn: manifest('5.260918.4'), api: manifest('5.260918.4') });
    expect(tie.out).toContain('5.260918.4');
  });

  test('neither an envelope nor an error body can displace the CDN answer', () => {
    // Both carry no `channel`, so a stale-but-valid CDN answer survives junk that
    // happens to be newer-looking inside.
    const enveloped = fetchLatest({ cdn: manifest('5.260918.2'), api: envelope(manifest('9.260918.9')) });
    expect(enveloped.code).toBe(0);
    expect(enveloped.out).toContain('5.260918.2');
    const limited = fetchLatest({ cdn: manifest('5.260918.2'), api: RATE_LIMITED });
    expect(limited.code).toBe(0);
    expect(limited.out).toContain('5.260918.2');
  });

  test('either source alone still installs; neither is a hard failure with the original exit code', () => {
    expect(fetchLatest({ cdn: manifest('5.260918.2') }).out).toContain('5.260918.2');
    const apiOnly = fetchLatest({ api: manifest('5.260918.4') });
    expect(apiOnly.code).toBe(0);
    expect(apiOnly.out).toContain('5.260918.4');
    // Both unreachable keeps the pre-existing contract: exit 5, naming the CDN url.
    const neither = fetchLatest({});
    expect(neither.code).toBe(5);
    expect(neither.err).toContain('could not fetch');
    // Both answered but for another channel keeps the other pre-existing contract.
    const wrongChannel = fetchLatest({ cdn: manifest('5.260918.2', 'stable'), api: manifest('5.260918.4', 'stable') });
    expect(wrongChannel.code).toBe(1);
    expect(wrongChannel.err).toContain('not usable for channel dev');
  });

  test('without jq the second source is not read at all, so a line-matched body cannot win', () => {
    // Guard the guard: if jq ever ships inside SYSTEM_PATH this test would silently
    // become a second copy of the jq case, so it fails loudly instead.
    const probe = mkdtempSync(join(tmpdir(), 'genie-nojq-'));
    const jqReachable =
      Bun.spawnSync(['bash', '-c', 'command -v jq'], { env: { PATH: noJqBin(probe) } }).exitCode === 0;
    expect(jqReachable).toBe(false);
    // manifest_get's no-jq fallback reads "channel"/"version" from ANYWHERE in the
    // body — an error object, or text that is not JSON. One source was never exposed
    // to that (nothing to out-rank); two would be. So without jq the API is skipped
    // and the host keeps exactly its pre-#2950 behaviour.
    const nested = JSON.stringify({
      error: { channel: 'dev', version: '9.9.9', tarball_base: 'https://attacker.example/v' },
    });
    const r = fetchLatest({ cdn: manifest('5.260918.2'), api: nested, withoutJq: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('5.260918.2');
    expect(r.out).not.toContain('9.9.9');
    expect(r.argv).not.toContain('api.github.com');
    // Not JSON at all is the same story.
    const prose = fetchLatest({
      cdn: manifest('5.260918.2'),
      api: '"channel": "dev" "version": "9.9.9"',
      withoutJq: true,
    });
    expect(prose.out).toContain('5.260918.2');
    // With jq present the same nested body is rejected on its own merits.
    const withJq = fetchLatest({ cdn: manifest('5.260918.2'), api: nested });
    expect(withJq.out).toContain('5.260918.2');
    expect(withJq.out).not.toContain('9.9.9');
  });

  test('an answer missing a field the installer will read cannot displace a complete one', () => {
    const noTarball = JSON.stringify({ schema_version: 1, channel: 'dev', version: '9.260918.9' });
    const r = fetchLatest({ cdn: manifest('5.260918.2'), api: noTarball });
    expect(r.out).toContain('5.260918.2');
    expect(r.out).not.toContain('9.260918.9');
  });

  test('an empty 200 from the CDN is still a usability failure, not a fetch failure', () => {
    // curl exits 0 with no body: the manifest is unusable (exit 1), which is what
    // this said before a second source existed. Only a genuine fetch failure is 5.
    const empty = fetchLatest({ cdn: '' });
    expect(empty.code).toBe(1);
    const unreachable = fetchLatest({});
    expect(unreachable.code).toBe(5);
  });

  test('the API is asked for the file its own bytes, on main, and the CDN is asked without that header', () => {
    const r = fetchLatest({ cdn: manifest('5.260918.2'), api: manifest('5.260918.4') });
    const lines = r.argv.trim().split('\n');
    const apiCall = lines.find((l) => l.includes('api.github.com')) ?? '';
    const cdnCall = lines.find((l) => l.includes('raw.githubusercontent.com')) ?? '';
    expect(apiCall).toContain('Accept: application/vnd.github.raw');
    expect(apiCall).toContain('/contents/.well-known/dev.json?ref=main');
    // The second source must not add an unbounded stall to an install the CDN could
    // already serve. curl enforces the bound; this pins that we ask for it.
    expect(apiCall).toContain('-m 5');
    // Without the header the API answers with the envelope the test above rejects.
    expect(cdnCall).not.toContain('Accept:');
    expect(cdnCall).toContain('/main/.well-known/dev.json');
  });
});
