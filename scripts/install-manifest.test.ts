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

// Every case here reads the SECOND source, which fetch_latest consults only where jq
// can validate the answer (see install-manifest-nojq.test.ts for why). Inheriting the
// host's PATH therefore made each assertion below conditional on this machine having
// jq: on a host without it these would quietly become no-second-source cases and fail
// for a reason that looks exactly like a broken gate. The PATH is built instead, from
// a farm that links jq in by name, and the cases skip where the host has no jq to link.
// (The two-sided proof that such a farm is what it claims lives in
// install-manifest-nojq.test.ts, against the same builder.)
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
  'jq',
];

/** See install-manifest-nojq.test.ts: without jq there is no second source to test. */
const HAS_JQ = Bun.which('jq') !== null;

function jqBin(dir: string): string {
  const bin = join(dir, 'jq-bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of TOOLS) {
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
      PATH: `${dir}:${jqBin(dir)}`,
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
