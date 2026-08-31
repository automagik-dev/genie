import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  stampReleasePayloadVersion,
  verifyCommittedReleaseVersions,
  verifyReleasePayloadVersion,
} from './release-payload-version.ts';

describe('release payload version contract', () => {
  const roots: string[] = [];
  const repoRoot = join(import.meta.dir, '..');

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function writeJson(root: string, relativePath: string, value: unknown): void {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'genie-release-payload-version-'));
    roots.push(root);
    writeJson(root, 'package.json', { name: '@automagik/genie', version: '5.000000.0' });
    for (const path of ['plugins/genie/package.json', 'plugins/genie/orca-plugin.json']) {
      writeJson(root, path, { name: 'genie', version: '5.000000.0' });
    }
    return root;
  }

  test('the committed release metadata exactly matches the package version', () => {
    const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

    expect(verifyCommittedReleaseVersions(repoRoot)).toBe(packageVersion);
    // The committed native Orca manifest is advisory (stamped inside the payload);
    // it only has to be a well-formed version string, not the package version —
    // main's workflow_run bump list may lag dev's by a field.
    expect(JSON.parse(readFileSync(join(repoRoot, 'plugins/genie/orca-plugin.json'), 'utf8')).version).toMatch(
      /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/,
    );
  });

  test('stamps and verifies VERSION plus every copied version-bearing manifest', () => {
    const root = fixture();
    const version = '5.260711.9-rc.1';
    writeJson(root, 'plugins/genie/package.json', {
      metadata: { version: 'nested-must-not-change' },
      name: 'genie-plugin',
      version: '5.000000.0',
    });

    stampReleasePayloadVersion(root, version);

    expect(() => verifyReleasePayloadVersion(root, version)).not.toThrow();
    expect(readFileSync(join(root, 'VERSION'), 'utf8')).toBe(`${version}\n`);
    for (const path of ['plugins/genie/package.json', 'plugins/genie/orca-plugin.json']) {
      expect(JSON.parse(readFileSync(join(root, path), 'utf8')).version).toBe(version);
    }
    expect(JSON.parse(readFileSync(join(root, 'plugins/genie/package.json'), 'utf8')).metadata.version).toBe(
      'nested-must-not-change',
    );
  });

  test('verification catches one diverging copied manifest', () => {
    const root = fixture();
    const version = '5.260711.10';
    stampReleasePayloadVersion(root, version);
    writeJson(root, 'plugins/genie/package.json', { name: 'genie-plugin', version: '5.260711.9' });

    expect(() => verifyReleasePayloadVersion(root, version)).toThrow('plugins/genie/package.json');
  });

  test('verification catches a diverging or missing native Orca manifest', () => {
    const root = fixture();
    const version = '5.260711.10';
    stampReleasePayloadVersion(root, version);
    writeJson(root, 'plugins/genie/orca-plugin.json', { id: 'genie', version: '5.260711.9' });
    expect(() => verifyReleasePayloadVersion(root, version)).toThrow('orca-plugin.json');

    rmSync(join(root, 'plugins/genie/orca-plugin.json'));
    expect(() => verifyReleasePayloadVersion(root, version)).toThrow('metadata is missing');
  });

  test('source preflight rejects committed drift before a staged override can hide it', () => {
    const root = fixture();
    expect(verifyCommittedReleaseVersions(root)).toBe('5.000000.0');

    writeJson(root, 'plugins/genie/package.json', { name: 'genie-plugin', version: '5.999999.1' });
    expect(() => verifyCommittedReleaseVersions(root)).toThrow('committed version mismatch in');
    expect(() => verifyCommittedReleaseVersions(root)).toThrow('plugins/genie/package.json');
  });

  // The Orca manifest's shipped copy is stamped inside the payload; the
  // committed value is advisory. Gating it coupled dev CI to the bump list of
  // the `version.yml` on main (workflow_run runs main's copy), which blocked
  // every dev release between 5.260829.5 and .8 on 2026-08-30.
  test('source preflight tolerates a lagging committed native Orca manifest', () => {
    const root = fixture();
    writeJson(root, 'plugins/genie/orca-plugin.json', { id: 'genie', version: '5.000000.0-lagging' });
    expect(verifyCommittedReleaseVersions(root)).toBe('5.000000.0');

    stampReleasePayloadVersion(root, '5.260711.10');
    expect(JSON.parse(readFileSync(join(root, 'plugins/genie/orca-plugin.json'), 'utf8')).version).toBe('5.260711.10');
  });

  test('fails closed on missing metadata and malformed versions', () => {
    const root = fixture();
    rmSync(join(root, 'plugins/genie/package.json'));
    expect(() => stampReleasePayloadVersion(root, '5.260711.10')).toThrow('metadata is missing');

    const second = fixture();
    expect(() => stampReleasePayloadVersion(second, '../escape')).toThrow('invalid release version');
  });

  test('build-binary wires both stage stamping and post-copy verification', () => {
    const buildScript = readFileSync(join(import.meta.dir, 'build-binary.sh'), 'utf8');
    const sourcePreflight = buildScript.indexOf('release-payload-version.ts" --verify-source');
    const stageStamp = buildScript.indexOf('release-payload-version.ts" --stamp');
    expect(sourcePreflight).toBeGreaterThan(-1);
    expect(sourcePreflight).toBeLessThan(stageStamp);
    expect(buildScript).toContain('release-payload-version.ts" --stamp');
    expect(buildScript).toContain('release-payload-version.ts" --verify');
    expect(buildScript).toContain('"plugins/genie/orca-plugin.json"');
    expect(buildScript).toContain('"plugins/genie/orca-entrypoint.min.js"');
  });

  test('tarball builds are gated by source version verification', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/build-tarballs.yml'), 'utf8');

    expect(workflow).toContain('verify-source-version:');
    expect(workflow).toContain('bun scripts/release-payload-version.ts --verify-source .');
    expect(workflow).toContain('needs: verify-source-version');
  });
});
