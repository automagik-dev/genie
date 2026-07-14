import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fixtures for scripts/verify-release.sh realigned to the real release asset
// scheme (wish stable-release-security-gate, F31b): per-tarball
// *.tar.gz + *.tar.gz.bundle (cosign) + *.tar.gz.intoto.jsonl (SLSA), verified
// with `cosign verify-blob --bundle` and `slsa-verifier verify-artifact`. cosign,
// slsa-verifier, and gh are stubbed on PATH so the verifier's control flow +
// exit-code contract is exercised without a real signed release.
const SCRIPT = join(import.meta.dir, 'verify-release.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Stubs {
  cosignExit?: number;
  slsaExit?: number;
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
  writeFileSync(join(stub, 'cosign'), `#!/bin/sh\nexit ${stubs.cosignExit ?? 0}\n`);
  writeFileSync(join(stub, 'slsa-verifier'), `#!/bin/sh\nexit ${stubs.slsaExit ?? 0}\n`);
  writeFileSync(join(stub, 'gh'), '#!/bin/sh\nexit 1\n');
  for (const name of ['cosign', 'slsa-verifier', 'gh']) chmodSync(join(stub, name), 0o755);

  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  const tarball = join(assets, 'genie-5.260714.1-linux-x64-glibc.tar.gz');
  writeFileSync(tarball, 'tarball-bytes');
  if (stubs.bundle !== false) writeFileSync(`${tarball}.bundle`, 'cosign-bundle');
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

  test('a failed cosign signature check exits 2', () => {
    const { stub, tarball } = fixture({ cosignExit: 1 });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain('cosign signature verification failed');
  });

  test('a failed SLSA provenance check exits 4', () => {
    const { stub, tarball } = fixture({ slsaExit: 1 });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(4);
    expect(run.stderr.toString()).toContain('SLSA provenance verification failed');
  });

  test('a missing cosign bundle exits 5', () => {
    const { stub, tarball } = fixture({ bundle: false });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(5);
    expect(run.stderr.toString()).toContain('.bundle');
  });

  test('a missing per-tarball SLSA provenance exits 5', () => {
    const { stub, tarball } = fixture({ intoto: false });
    const run = verifyLocal(stub, tarball);
    expect(run.exitCode).toBe(5);
    expect(run.stderr.toString()).toContain('.intoto.jsonl');
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
