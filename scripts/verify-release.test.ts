import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// Fixtures for scripts/verify-release.sh realigned to the real release asset
// scheme (wish stable-release-security-gate, F31b): per-tarball
// *.tar.gz + *.tar.gz.bundle (cosign) + *.tar.gz.intoto.jsonl (SLSA), verified
// with `cosign verify-blob --bundle` and `slsa-verifier verify-artifact`. cosign,
// slsa-verifier, and gh are stubbed on PATH so the verifier's control flow +
// exit-code contract is exercised without a real signed release.
//
// The cosign bundle is a REAL release bundle, because after cosign accepts it the
// script reads GitHub's two repository ids out of the certificate inside
// (scripts/release-certificate-ids.test.ts owns that reader's own cases).
const SCRIPT = join(import.meta.dir, 'verify-release.sh');
const CERTIFICATES = join(import.meta.dir, '..', 'tests', 'fixtures', 'release-certificates');
const POST_RENAME_BUNDLE = join(CERTIFICATES, 'genie-6.261111.1-linux-x64-glibc.tar.gz.bundle');
const PRE_RENAME_BUNDLE = join(CERTIFICATES, 'genie-6.261108.1-linux-x64-glibc.tar.gz.bundle');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Stubs {
  cosignExit?: number;
  slsaExit?: number;
  /** cosign accepts only an identity naming this repository (default: any). */
  cosignAccepts?: string;
  /** The bundle laid beside the tarball (default: the real post-rename one). */
  bundleFrom?: string;
  /** Literal bundle bytes instead of a real bundle. */
  bundleText?: string;
}

/** Lay down a stub bin dir (cosign, slsa-verifier, gh) plus a tarball with the
 *  requested sidecars, and return { tarball, path }. gh is stubbed to report its
 *  attestation subsystem unavailable so the best-effort cross-check is skipped
 *  (no network). */
function fixture(stubs: Stubs & { bundle?: boolean; intoto?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'genie-verify-release-'));
  roots.push(root);
  const stub = join(root, 'stub');
  mkdirSync(stub, { recursive: true });
  const accepts = stubs.cosignAccepts
    ? `case "$*" in *"/${stubs.cosignAccepts}/"*) exit 0 ;; *) exit 1 ;; esac`
    : `exit ${stubs.cosignExit ?? 0}`;
  writeFileSync(join(stub, 'cosign'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(root, 'cosign.log')}'\n${accepts}\n`);
  writeFileSync(
    join(stub, 'slsa-verifier'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(root, 'slsa.log')}'\nexit ${stubs.slsaExit ?? 0}\n`,
  );
  writeFileSync(join(stub, 'gh'), '#!/bin/sh\nexit 1\n');
  // Stock macOS readlink has no -f. Any accidental dependency on readlink is
  // therefore a portability failure even when these tests run on GNU hosts.
  writeFileSync(join(stub, 'readlink'), '#!/bin/sh\nexit 99\n');
  for (const name of ['cosign', 'slsa-verifier', 'gh', 'readlink']) chmodSync(join(stub, name), 0o755);

  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  const tarball = join(assets, 'genie-5.260714.1-linux-x64-glibc.tar.gz');
  writeFileSync(tarball, 'tarball-bytes');
  if (stubs.bundleText !== undefined) writeFileSync(`${tarball}.bundle`, stubs.bundleText);
  else if (stubs.bundle !== false) copyFileSync(stubs.bundleFrom ?? POST_RENAME_BUNDLE, `${tarball}.bundle`);
  if (stubs.intoto !== false) writeFileSync(`${tarball}.intoto.jsonl`, 'slsa-provenance');
  return { root, stub, tarball };
}

function verifyLocal(stub: string, tarball: string) {
  return Bun.spawnSync(['bash', SCRIPT, '--local', tarball], {
    env: { PATH: `${stub}:${process.env.PATH ?? ''}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('verify-release.sh (F31b — real asset scheme)', () => {
  test('verifies a tarball with a cosign bundle + per-tarball SLSA provenance', () => {
    const { stub, tarball } = fixture({});
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(0);
    const out = run.stdout.toString();
    expect(out).toContain('cosign verify-blob --bundle');
    expect(out).toContain('slsa-verifier verify-artifact');
    expect(out).toContain('cosign-signed AND SLSA-attested');
  });

  test('local verification resolves a relative path without GNU readlink -f', () => {
    const { stub, tarball } = fixture({});
    const run = Bun.spawnSync(['bash', SCRIPT, '--local', basename(tarball)], {
      cwd: dirname(tarball),
      env: { PATH: `${stub}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('verified 1 tarball');
  });

  test('a failed cosign signature check exits 2', () => {
    const { stub, tarball } = fixture({ cosignExit: 1 });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain('cosign signature verification failed');
  });

  test('a release signed under the current name is checked against that name', () => {
    const { root, stub, tarball } = fixture({ cosignAccepts: 'automagik-si/genie' });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(0);
    const cosign = readFileSync(join(root, 'cosign.log'), 'utf8').trim().split('\n');
    expect(cosign).toHaveLength(1);
    expect(cosign[0]).toContain(
      '--certificate-identity-regexp ^https://github\\.com/automagik-si/genie/\\.github/workflows/sign-attest\\.yml@refs/heads/main$ ',
    );
    expect(cosign[0]).toContain('--certificate-oidc-issuer https://token.actions.githubusercontent.com ');
    expect(readFileSync(join(root, 'slsa.log'), 'utf8')).toContain('--source-uri github.com/automagik-si/genie ');
    expect(run.stdout.toString()).toContain('repository id 1030039430');
  });

  test('a release signed before the rename verifies under the name it was signed with', () => {
    const { root, stub, tarball } = fixture({ cosignAccepts: 'automagik-dev/genie', bundleFrom: PRE_RENAME_BUNDLE });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(0);
    const cosign = readFileSync(join(root, 'cosign.log'), 'utf8').trim().split('\n');
    expect(cosign).toHaveLength(2);
    expect(cosign[1]).toContain(
      '--certificate-identity-regexp ^https://github\\.com/automagik-dev/genie/\\.github/workflows/sign-attest\\.yml@refs/heads/main$ ',
    );
    expect(readFileSync(join(root, 'slsa.log'), 'utf8')).toContain('--source-uri github.com/automagik-dev/genie ');
  });

  test('a third repository name is never offered to cosign', () => {
    const { root, stub, tarball } = fixture({ cosignAccepts: 'another-owner/genie' });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(2);
    expect(readFileSync(join(root, 'cosign.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  test('a bundle cosign accepts exits 2 when its certificate carries another repository id', () => {
    const text = readFileSync(POST_RENAME_BUNDLE, 'utf8');
    const pem = Buffer.from(/"cert":"([^"]+)"/.exec(text)?.[1] ?? '', 'base64').toString('utf8');
    const der = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
    const at = der.indexOf(Buffer.from('1030039430'));
    expect(at).toBeGreaterThan(0);
    der.write('1030039431', at);
    const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
    const changed = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
    const bundleText = text.replace(/"cert":"[^"]+"/, `"cert":"${Buffer.from(changed).toString('base64')}"`);
    const { root, stub, tarball } = fixture({ bundleText });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain('Source Repository Identifier is not 1030039430');
    expect(run.stderr.toString()).toContain('does not carry the pinned repository ids');
    // Refused before the provenance leg runs.
    expect(() => readFileSync(join(root, 'slsa.log'), 'utf8')).toThrow();
  });

  test('a bundle cosign accepts exits 2 when no certificate can be read from it', () => {
    const { stub, tarball } = fixture({ bundleText: 'cosign-bundle' });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain('could not read the certificate');
  });

  test('a failed SLSA provenance check exits 4', () => {
    const { stub, tarball } = fixture({ slsaExit: 1 });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(4);
    expect(run.stderr.toString()).toContain('SLSA provenance verification failed');
  });

  const missingAssets: Array<[string, Parameters<typeof fixture>[0], string]> = [
    ['cosign bundle', { bundle: false }, '.bundle'],
    ['per-tarball SLSA provenance', { intoto: false }, '.intoto.jsonl'],
  ];

  test.each(missingAssets)('a missing %s exits 5', (_, missing, named) => {
    const { stub, tarball } = fixture(missing);
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(5);
    expect(run.stderr.toString()).toContain(named);
  });

  test('no arguments prints usage and exits 64', () => {
    const { stub } = fixture({});
    const run = Bun.spawnSync(['bash', SCRIPT], {
      env: { PATH: `${stub}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(run.exitCode).toBe(64);
  });
});
