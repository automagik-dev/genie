import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A release is installed only when the certificate that signed it carries GitHub's
// numeric ids for this repository (1030039430) and for its owner (245047546). The
// in-process verifier owns that rule for `genie update`
// (src/lib/delivery-evidence-verify.test.ts); this file owns it for the shell side:
// scripts/release-certificate-ids.sh, and the byte-identical block install.sh embeds
// because the installer is fetched as one file.
//
// The two `.bundle` fixtures are REAL release bundles, unmodified: one signed before
// the 2026-11 repository rename and one after. Every refusal case is one of those
// with a few certificate bytes changed. The id reader runs only after cosign has
// verified the bundle, so the cases here drive it directly and put a recording
// stand-in where cosign and gh would be: no network, no signing.

const ROOT = join(import.meta.dir, '..');
const INSTALL_SH = join(ROOT, 'install.sh');
const HELPER = join(ROOT, 'scripts', 'release-certificate-ids.sh');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'release-certificates');
const POST_RENAME = join(FIXTURES, 'genie-6.261111.1-linux-x64-glibc.tar.gz.bundle');
const PRE_RENAME = join(FIXTURES, 'genie-6.261108.1-linux-x64-glibc.tar.gz.bundle');
const GH_RESULT = join(FIXTURES, 'gh-attestation-verify.6.261108.1.json');

const REPOSITORY_ID = '1030039430';
const OWNER_ID = '245047546';
const REPOSITORY_ID_OID = Buffer.from('2B0601040183BF30010F', 'hex');
const OWNER_ID_OID = Buffer.from('2B0601040183BF300111', 'hex');
const CURRENT_IDENTITY =
  '^https://github\\.com/automagik-si/genie/\\.github/workflows/sign-attest\\.yml@refs/heads/main$';
const PRE_RENAME_IDENTITY =
  '^https://github\\.com/automagik-dev/genie/\\.github/workflows/sign-attest\\.yml@refs/heads/main$';
const ISSUER = 'https://token.actions.githubusercontent.com';

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
  'cp',
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
  'base64',
  'od',
  'sha256sum',
  'shasum',
  'ldd',
];
const HAS_JQ = Bun.which('jq') !== null;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genie-certificate-ids-'));
  dirs.push(dir);
  return dir;
}

/** A PATH holding the named tools and nothing else: no host gh, no host cosign. */
function toolBin(dir: string, extra: string[] = []): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of [...TOOLS, ...extra]) {
    const real = Bun.which(tool);
    if (real && !existsSync(join(bin, tool))) symlinkSync(real, join(bin, tool));
  }
  return bin;
}

function script(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`);
  chmodSync(path, 0o755);
}

// ── Bundle surgery ───────────────────────────────────────────────────────────

function certificateBase64(bundleText: string): string {
  const match = /"cert":"([A-Za-z0-9+/=]+)"/.exec(bundleText);
  if (!match) throw new Error('fixture has no cert member');
  return match[1];
}

function certificateDer(bundlePath: string): Buffer {
  const pem = Buffer.from(certificateBase64(readFileSync(bundlePath, 'utf8')), 'base64').toString('utf8');
  return Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

function pemOf(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** The fixture's exact bytes with only the certificate replaced. */
function bundleWithCertificate(bundlePath: string, der: Buffer, dir: string, name: string): string {
  const text = readFileSync(bundlePath, 'utf8');
  const out = join(dir, name);
  writeFileSync(out, text.replace(certificateBase64(text), Buffer.from(pemOf(der)).toString('base64')));
  return out;
}

/** Replace the one occurrence of `from` in `der`; the fixture must hold exactly one. */
function replaceOnce(der: Buffer, from: Buffer, to: Buffer): Buffer {
  const at = der.indexOf(from);
  if (at < 0 || der.indexOf(from, at + 1) >= 0) throw new Error('fixture does not hold exactly one match');
  if (from.length !== to.length) throw new Error('replacement must keep the length');
  const out = Buffer.from(der);
  to.copy(out, at);
  return out;
}

const utf8String = (value: string): Buffer => Buffer.concat([Buffer.from([0x0c, value.length]), Buffer.from(value)]);

type Mutation = { name: string; mutate: (der: Buffer) => Buffer; says: string };

const MUTATIONS: Mutation[] = [
  {
    name: 'another repository id',
    mutate: (der) => replaceOnce(der, utf8String(REPOSITORY_ID), utf8String('1030039431')),
    says: `Source Repository Identifier is not ${REPOSITORY_ID}`,
  },
  {
    name: 'another owner id',
    mutate: (der) => replaceOnce(der, utf8String(OWNER_ID), utf8String('245047547')),
    says: `Source Repository Owner Identifier is not ${OWNER_ID}`,
  },
  {
    name: 'no repository id extension',
    mutate: (der) => replaceOnce(der, REPOSITORY_ID_OID, Buffer.from('2B0601040183BF300163', 'hex')),
    says: 'no single Source Repository Identifier',
  },
  {
    name: 'no owner id extension',
    mutate: (der) => replaceOnce(der, OWNER_ID_OID, Buffer.from('2B0601040183BF300163', 'hex')),
    says: 'no single Source Repository Owner Identifier',
  },
  {
    name: 'the repository id extension twice',
    mutate: (der) => replaceOnce(der, OWNER_ID_OID, REPOSITORY_ID_OID),
    says: 'no single Source Repository Identifier',
  },
  {
    name: 'the repository id in another string type',
    mutate: (der) =>
      replaceOnce(
        der,
        utf8String(REPOSITORY_ID),
        Buffer.concat([Buffer.from([0x13, REPOSITORY_ID.length]), Buffer.from(REPOSITORY_ID)]),
      ),
    says: `Source Repository Identifier is not ${REPOSITORY_ID}`,
  },
  {
    name: 'a truncated certificate',
    mutate: (der) => der.subarray(0, der.length - 12),
    says: 'no single Source Repository Identifier',
  },
];

// ── Runners ──────────────────────────────────────────────────────────────────

type Run = { exitCode: number; stdout: string; stderr: string };

function run(argv: string[], env: Record<string, string>): Run {
  const proc = Bun.spawnSync(argv, { env, stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function baseEnv(dir: string, bin: string): Record<string, string> {
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return { PATH: bin, HOME: home, GENIE_HOME: join(home, '.genie'), TMPDIR: dir, GENIE_INSTALL_SOURCE_ONLY: '1' };
}

/** The shared helper, run the way a release script runs it. */
function helperCheck(bundle: string, dir: string): Run {
  return run(['bash', HELPER, bundle], baseEnv(dir, toolBin(dir)));
}

/** The copy inside install.sh, reached by sourcing the installer. */
function installerCheck(bundle: string, dir: string): Run {
  const body = 'source "$1"; if release_certificate_carries_pinned_ids "$2"; then exit 0; else exit 1; fi';
  return run(['bash', '-c', body, 'bash', INSTALL_SH, bundle], baseEnv(dir, toolBin(dir)));
}

function markedBlock(path: string): string {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('# >>> release-certificate-ids');
  const end = text.indexOf('# <<< release-certificate-ids');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(text.indexOf('# >>> release-certificate-ids', start + 1)).toBe(-1);
  return text.slice(start, end);
}

// ── The reader ───────────────────────────────────────────────────────────────

describe('the repository-id block', () => {
  test('install.sh carries the helper block byte for byte', () => {
    const helper = markedBlock(HELPER);
    expect(helper.length).toBeGreaterThan(1000);
    expect(markedBlock(INSTALL_SH)).toBe(helper);
  });

  test('pins the two ids GitHub assigned to this repository and its owner', () => {
    const block = markedBlock(HELPER);
    expect(block).toContain(`EXPECTED_REPOSITORY_ID="${REPOSITORY_ID}"`);
    expect(block).toContain(`EXPECTED_REPOSITORY_OWNER_ID="${OWNER_ID}"`);
  });
});

for (const [label, check] of [
  ['scripts/release-certificate-ids.sh', helperCheck],
  ['install.sh', installerCheck],
] as const) {
  describe(`release certificate ids — ${label}`, () => {
    test('accepts the real release signed after the rename', () => {
      const result = check(POST_RENAME, workDir());
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    test('accepts the real release signed before the rename', () => {
      const result = check(PRE_RENAME, workDir());
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    });

    test('an unchanged certificate re-wrapped by the test still passes', () => {
      // Proves the refusals below come from the changed bytes, not from the re-wrapping.
      const dir = workDir();
      const bundle = bundleWithCertificate(POST_RENAME, certificateDer(POST_RENAME), dir, 'same.bundle');
      expect(check(bundle, dir).exitCode).toBe(0);
    });

    for (const mutation of MUTATIONS) {
      test(`refuses a certificate with ${mutation.name}`, () => {
        const dir = workDir();
        const bundle = bundleWithCertificate(
          POST_RENAME,
          mutation.mutate(certificateDer(POST_RENAME)),
          dir,
          'x.bundle',
        );
        const result = check(bundle, dir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(mutation.says);
        expect(result.stderr).toContain('refusing');
      });
    }

    test('refuses a bundle that names the certificate member twice', () => {
      const dir = workDir();
      const text = readFileSync(POST_RENAME, 'utf8');
      const bundle = join(dir, 'twice.bundle');
      writeFileSync(bundle, text.replace('"rekorBundle"', `"Cert":"${certificateBase64(text)}","rekorBundle"`));
      const result = check(bundle, dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('could not read the certificate');
    });

    test('refuses a bundle carrying an escape sequence', () => {
      const dir = workDir();
      const text = readFileSync(POST_RENAME, 'utf8');
      const bundle = join(dir, 'escaped.bundle');
      writeFileSync(bundle, text.replace('"rekorBundle"', '"note":"\\u0063","rekorBundle"'));
      const result = check(bundle, dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('could not read the certificate');
    });

    test('refuses an empty bundle and a missing one', () => {
      const dir = workDir();
      const empty = join(dir, 'empty.bundle');
      writeFileSync(empty, '');
      expect(check(empty, dir).exitCode).toBe(1);
      expect(check(join(dir, 'absent.bundle'), dir).exitCode).toBe(1);
    });
  });
}

test('the helper refuses to guess when called without exactly one bundle', () => {
  const dir = workDir();
  const result = run(['bash', HELPER], baseEnv(dir, toolBin(dir)));
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain('usage:');
});

test('install.sh fetches a pre-rename manifest base under the current name and leaves any other base alone', () => {
  const dir = workDir();
  const body = 'source "$1"; shift; for base in "$@"; do current_name_tarball_base "$base"; done';
  const result = run(
    [
      'bash',
      '-c',
      body,
      'bash',
      INSTALL_SH,
      'https://github.com/automagik-dev/genie/releases/download/v6.261108.1',
      'https://github.com/automagik-si/genie/releases/download/v6.261111.2',
      'https://github.com/automagik-dev/genie-other/releases/download/v1',
      'https://mirror.invalid/automagik-dev/genie/releases/download/v1',
    ],
    baseEnv(dir, toolBin(dir)),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual([
    'https://github.com/automagik-si/genie/releases/download/v6.261108.1',
    'https://github.com/automagik-si/genie/releases/download/v6.261111.2',
    'https://github.com/automagik-dev/genie-other/releases/download/v1',
    'https://mirror.invalid/automagik-dev/genie/releases/download/v1',
  ]);
});

// ── install.sh: cosign path ──────────────────────────────────────────────────

/**
 * A cosign stand-in. It records its argv and reports success only for the
 * certificate identity named in SHIM_COSIGN_ACCEPTS — what the real cosign does
 * for a bundle signed under that identity.
 */
function cosignShim(bin: string, log: string): void {
  script(join(bin, 'cosign'), [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> '${log}'`,
    'if [ "$1" = "version" ]; then exit 0; fi',
    'identity=""; issuer=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --certificate-identity-regexp) identity="$2"; shift ;;',
    '    --certificate-oidc-issuer) issuer="$2"; shift ;;',
    '  esac',
    '  shift',
    'done',
    `[ "$issuer" = '${ISSUER}' ] || exit 1`,
    '[ -n "${SHIM_COSIGN_ACCEPTS:-}" ] && [ "$identity" = "$SHIM_COSIGN_ACCEPTS" ]',
  ]);
}

function verifyWithCosign(bundle: string, accepts: string): Run & { calls: string[] } {
  const dir = workDir();
  const bin = toolBin(dir);
  const log = join(dir, 'cosign.log');
  writeFileSync(log, '');
  cosignShim(bin, log);
  const tarball = join(dir, 'genie.tar.gz');
  writeFileSync(tarball, 'tarball');
  const body =
    'source "$1"; COSIGN_BIN="$(command -v cosign)"; if verify_with_cosign "$2" "$3"; then echo VERIFIED; else echo REFUSED; fi';
  const result = run(['bash', '-c', body, 'bash', INSTALL_SH, tarball, bundle], {
    ...baseEnv(dir, bin),
    SHIM_COSIGN_ACCEPTS: accepts,
  });
  return { ...result, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

describe('install.sh — cosign verification', () => {
  test('a release signed under the current name passes on the first identity', () => {
    const result = verifyWithCosign(POST_RENAME, CURRENT_IDENTITY);
    expect(result.stdout.trim()).toBe('VERIFIED');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain(`--certificate-identity-regexp ${CURRENT_IDENTITY} `);
    expect(result.calls[0]).toContain(`--certificate-oidc-issuer ${ISSUER} `);
  });

  test('a release signed before the rename passes on the second identity', () => {
    const result = verifyWithCosign(PRE_RENAME, PRE_RENAME_IDENTITY);
    expect(result.stdout.trim()).toBe('VERIFIED');
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]).toContain(`--certificate-identity-regexp ${CURRENT_IDENTITY} `);
    expect(result.calls[1]).toContain(`--certificate-identity-regexp ${PRE_RENAME_IDENTITY} `);
  });

  test('only the two anchored identities are ever offered to cosign', () => {
    const result = verifyWithCosign(POST_RENAME, '^https://github\\.com/another-owner/genie/.*$');
    expect(result.stdout.trim()).toBe('REFUSED');
    expect(result.calls).toHaveLength(2);
    for (const call of result.calls) {
      const identity = /--certificate-identity-regexp (\S+)/.exec(call)?.[1] ?? '';
      expect([CURRENT_IDENTITY, PRE_RENAME_IDENTITY]).toContain(identity);
    }
  });

  test('the two identities install.sh builds match one certificate identity each and nothing near it', () => {
    // The patterns are read out of install.sh itself, so this is what cosign and gh are handed.
    const built = run(
      [
        'bash',
        '-c',
        'source "$1"; for repo in "${ACCEPTED_REPOS[@]}"; do cosign_identity_for_repo "$repo"; done',
        'bash',
        INSTALL_SH,
      ],
      baseEnv(workDir(), toolBin(workDir())),
    );
    expect(built.exitCode).toBe(0);
    const patterns = built.stdout.trim().split('\n');
    expect(patterns).toEqual([CURRENT_IDENTITY, PRE_RENAME_IDENTITY]);

    const identity = (owner: string, workflow = 'sign-attest.yml', ref = 'refs/heads/main') =>
      `https://github.com/${owner}/genie/.github/workflows/${workflow}@${ref}`;
    const accepted = (value: string) => patterns.filter((pattern) => new RegExp(pattern).test(value)).length;

    expect(accepted(identity('automagik-si'))).toBe(1);
    expect(accepted(identity('automagik-dev'))).toBe(1);
    for (const refused of [
      identity('automagik-other'),
      identity('automagik-si-team'),
      identity('automagik-si', 'release-publish.yml'),
      identity('automagik-dev', 'another.yml'),
      identity('automagik-si', 'sign-attest.yml', 'refs/heads/dev'),
      identity('automagik-dev', 'sign-attest.yml', 'refs/tags/v1'),
      `${identity('automagik-si')}-suffix`,
      `prefix-${identity('automagik-dev')}`,
      identity('automagik-si').replace('github.com', 'githubXcom'),
    ]) {
      expect(accepted(refused), refused).toBe(0);
    }
  });

  for (const mutation of MUTATIONS) {
    test(`a bundle cosign accepts is still refused with ${mutation.name}`, () => {
      const dir = workDir();
      const bundle = bundleWithCertificate(POST_RENAME, mutation.mutate(certificateDer(POST_RENAME)), dir, 'x.bundle');
      const result = verifyWithCosign(bundle, CURRENT_IDENTITY);
      expect(result.stdout.trim()).toBe('REFUSED');
      expect(result.stderr).toContain(mutation.says);
      // cosign said yes exactly once; the second identity is not tried after a refusal.
      expect(result.calls).toHaveLength(1);
    });
  }
});

// ── install.sh: the whole verification step ──────────────────────────────────

type Delivery = { bundle: string; cosignAccepts?: string; gh?: { repo: string; result: string } };

/**
 * `download_and_verify` with curl serving the tarball and the bundle from disk and
 * failing every other URL, so no verifier can be downloaded: what is on the built
 * PATH is all there is.
 */
function downloadAndVerify(delivery: Delivery): Run & { cosignCalls: string[]; ghCalls: string[] } {
  const dir = workDir();
  const bin = toolBin(dir, delivery.gh ? ['jq'] : []);
  const cosignLog = join(dir, 'cosign.log');
  const ghLog = join(dir, 'gh.log');
  writeFileSync(cosignLog, '');
  writeFileSync(ghLog, '');
  cosignShim(bin, cosignLog);
  const served = join(dir, 'served');
  mkdirSync(served);
  writeFileSync(join(served, 'tarball'), 'tarball');
  copyFileSync(delivery.bundle, join(served, 'bundle'));
  script(join(bin, 'curl'), [
    '#!/bin/bash',
    'out=""; url=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) out="$2"; shift ;;',
    '    -*) ;;',
    '    *) url="$1" ;;',
    '  esac',
    '  shift',
    'done',
    'case "$url" in',
    `  https://releases.invalid/base/*.tar.gz.bundle) cp '${join(served, 'bundle')}' "$out" ;;`,
    `  https://releases.invalid/base/*.tar.gz) cp '${join(served, 'tarball')}' "$out" ;;`,
    '  *) exit 22 ;;',
    'esac',
  ]);
  if (delivery.gh) {
    script(join(bin, 'gh'), [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> '${ghLog}'`,
      'if [ "$1 $2" = "attestation --help" ]; then exit 0; fi',
      'repo=""; expr=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --repo) repo="$2"; shift ;;',
      '    --jq) expr="$2"; shift ;;',
      '  esac',
      '  shift',
      'done',
      `[ "$repo" = '${delivery.gh.repo}' ] || { echo 'HTTP 404: Not Found' >&2; exit 1; }`,
      `jq -r "$expr" < '${delivery.gh.result}'`,
    ]);
  }
  const body = 'source "$1"; download_and_verify 6.261111.1 linux-x64-glibc https://releases.invalid/base';
  const result = run(['bash', '-c', body, 'bash', INSTALL_SH], {
    ...baseEnv(dir, bin),
    SHIM_COSIGN_ACCEPTS: delivery.cosignAccepts ?? '',
  });
  const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter(Boolean);
  return { ...result, cosignCalls: lines(cosignLog), ghCalls: lines(ghLog) };
}

describe('install.sh — download_and_verify', () => {
  test('installs a release whose certificate carries both ids', () => {
    const result = downloadAndVerify({ bundle: POST_RENAME, cosignAccepts: CURRENT_IDENTITY });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('cosign verify-blob: OK');
    expect(result.stdout.trim()).toEndWith('genie-6.261111.1-linux-x64-glibc.tar.gz');
  });

  test('exits 4 when cosign accepts a certificate carrying another repository id', () => {
    const dir = workDir();
    const bundle = bundleWithCertificate(
      POST_RENAME,
      MUTATIONS[0].mutate(certificateDer(POST_RENAME)),
      dir,
      'x.bundle',
    );
    const result = downloadAndVerify({ bundle, cosignAccepts: CURRENT_IDENTITY });
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Source Repository Identifier is not ${REPOSITORY_ID}`);
    expect(result.stderr).toContain('refuse to install');
    expect(result.stderr).toContain(`repository id ${REPOSITORY_ID} and owner id ${OWNER_ID}`);
  });

  test('exits 4 when the certificate carries no owner id', () => {
    const dir = workDir();
    const bundle = bundleWithCertificate(
      POST_RENAME,
      MUTATIONS[3].mutate(certificateDer(POST_RENAME)),
      dir,
      'x.bundle',
    );
    const result = downloadAndVerify({ bundle, cosignAccepts: CURRENT_IDENTITY });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('no single Source Repository Owner Identifier');
  });

  test('exits 4 when cosign verifies under neither identity', () => {
    const result = downloadAndVerify({ bundle: POST_RENAME });
    expect(result.exitCode).toBe(4);
    expect(result.cosignCalls.filter((call) => call.startsWith('verify-blob'))).toHaveLength(2);
  });
});

describe.skipIf(!HAS_JQ)('install.sh — gh attestation verification', () => {
  // The recorded file is what `gh attestation verify --format json` printed for the
  // real v6.261108.1 tarball, cut down to the certificate summary. The stand-in
  // evaluates the installer's own --jq expression over it with the host's jq.
  const recorded = (): unknown[] => JSON.parse(readFileSync(GH_RESULT, 'utf8'));

  function resultFile(dir: string, edit: (certificate: Record<string, string>) => void): string {
    const data = recorded() as { verificationResult: { signature: { certificate: Record<string, string> } } }[];
    for (const entry of data) edit(entry.verificationResult.signature.certificate);
    const out = join(dir, 'gh-result.json');
    writeFileSync(out, JSON.stringify(data));
    return out;
  }

  test('accepts a verified attestation whose certificate carries both ids', () => {
    const result = downloadAndVerify({ bundle: PRE_RENAME, gh: { repo: 'automagik-dev/genie', result: GH_RESULT } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('gh attestation: OK');
    expect(result.cosignCalls).toHaveLength(0);
    const verifies = result.ghCalls.filter((call) => call.startsWith('attestation verify'));
    expect(verifies).toHaveLength(2);
    expect(verifies[0]).toContain('--repo automagik-si/genie ');
    expect(verifies[0]).toContain('--predicate-type https://github.com/automagik-si/genie/release-tarballs/v1 ');
    expect(verifies[0]).toContain(`--cert-identity-regex ${CURRENT_IDENTITY} `);
    expect(verifies[1]).toContain('--repo automagik-dev/genie ');
    expect(verifies[1]).toContain('--predicate-type https://github.com/automagik-dev/genie/release-tarballs/v1 ');
    expect(verifies[1]).toContain(`--cert-identity-regex ${PRE_RENAME_IDENTITY} `);
    for (const call of verifies) expect(call).toContain(`--cert-oidc-issuer ${ISSUER} `);
  });

  for (const [name, edit] of [
    ['another repository id', (c: Record<string, string>) => Object.assign(c, { sourceRepositoryIdentifier: '1' })],
    ['another owner id', (c: Record<string, string>) => Object.assign(c, { sourceRepositoryOwnerIdentifier: '1' })],
    ['no repository id', (c: Record<string, string>) => Reflect.deleteProperty(c, 'sourceRepositoryIdentifier')],
  ] as const) {
    test(`an attestation gh verifies is not enough with ${name}`, () => {
      const dir = workDir();
      const result = downloadAndVerify({
        bundle: PRE_RENAME,
        gh: { repo: 'automagik-dev/genie', result: resultFile(dir, edit) },
      });
      // gh's answer is set aside and cosign, which accepts nothing here, decides.
      expect(result.stderr).toContain('does not carry the pinned repository ids');
      expect(result.stderr).not.toContain('gh attestation: OK');
      expect(result.exitCode).toBe(4);
    });
  }

  test('an empty verification result is not an acceptance', () => {
    const dir = workDir();
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '[]');
    const result = downloadAndVerify({ bundle: PRE_RENAME, gh: { repo: 'automagik-dev/genie', result: empty } });
    expect(result.stderr).not.toContain('gh attestation: OK');
    expect(result.exitCode).toBe(4);
  });
});
