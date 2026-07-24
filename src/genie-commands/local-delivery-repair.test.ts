import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { scanPhysicalTree } from '../lib/codex-activation.js';
import type { DeliveryEvidencePlatformId } from '../lib/codex-delivery-evidence.js';
import { buildTestDeliveryEvidencePack } from '../lib/codex-delivery-evidence.test-support.js';
import { acquireLifecycleLease } from '../lib/codex-lifecycle-lease.js';
import { VERSION } from '../lib/version.js';
import {
  LOCAL_DELIVERY_REPAIR_REQUEST_MAX_BYTES,
  assertLocalDeliveryRepairEnabled,
  materializeLocalDeliveryRepair,
  parseLocalDeliveryRepairRequest,
} from './local-delivery-repair.js';
import { projectLocalDeliveryRepairDirective, resolvePlatformId, resolveUpdateExecutionMode } from './update.js';

const CLI = join(import.meta.dir, '..', 'genie.ts');
const roots: string[] = [];

interface LocalFiles {
  root: string;
  platformId: DeliveryEvidencePlatformId;
  request: {
    schemaVersion: 1;
    platformId: DeliveryEvidencePlatformId;
    artifact: string;
    manifest: string;
    descriptor: string;
    bundle: string;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `genie-local-delivery-${label}-`)));
  roots.push(root);
  return root;
}

function platformId(): DeliveryEvidencePlatformId {
  return resolvePlatformId() as DeliveryEvidencePlatformId;
}

function manifestBytes(platform: DeliveryEvidencePlatformId, version = VERSION): string {
  return JSON.stringify({
    schema_version: 1,
    channel: 'dev',
    version,
    released_at: '2026-07-23T00:00:00Z',
    tarball_base: `https://github.com/automagik-dev/genie/releases/download/v${version}`,
    platforms: [platform],
  });
}

function basicFiles(label = 'fixture'): LocalFiles {
  const root = tempRoot(label);
  const platform = platformId();
  const artifact = join(root, `genie-${VERSION}-${platform}.tar.gz`);
  const manifest = join(root, 'manifest.json');
  const descriptor = join(root, 'descriptor.json');
  const bundle = join(root, 'bundle.json');
  writeFileSync(artifact, 'artifact');
  writeFileSync(manifest, manifestBytes(platform));
  writeFileSync(descriptor, '{"descriptor":true}');
  writeFileSync(bundle, '{"bundle":true}');
  return {
    root,
    platformId: platform,
    request: { schemaVersion: 1, platformId: platform, artifact, manifest, descriptor, bundle },
  };
}

function stageRoot(root: string, suffix = ''): string {
  const path = join(root, `stage${suffix}`);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function requestJson(files: LocalFiles): string {
  return JSON.stringify(files.request);
}

function isolatedEnv(root: string, overrides: Record<string, string> = {}): Record<string, string> {
  const excluded = new Set([
    'GENIE_BUNDLE_ROOT',
    'GENIE_LIFECYCLE_LEASE_OWNER',
    'GENIE_LIFECYCLE_LEASE_PATH',
    'GENIE_RELEASE_DOGFOOD',
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !excluded.has(entry[0]),
    ),
  );
  const home = join(root, 'home');
  const genieHome = join(root, 'genie-home');
  const codexHome = join(root, 'codex-home');
  const temp = join(root, 'tmp');
  for (const path of [home, genieHome, codexHome, temp]) mkdirSync(path, { recursive: true });
  return {
    ...env,
    HOME: home,
    GENIE_HOME: genieHome,
    CODEX_HOME: codexHome,
    TMPDIR: temp,
    NO_COLOR: '1',
    ...overrides,
  };
}

function runCli(
  root: string,
  args: string[],
  overrides: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bun', CLI, ...args], {
    env: isolatedEnv(root, overrides),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('local delivery request and physical-file boundary', () => {
  test('requires the release-dogfood capability value exactly', () => {
    expect(() => assertLocalDeliveryRepairEnabled(undefined)).toThrow('GENIE_RELEASE_DOGFOOD=1');
    expect(() => assertLocalDeliveryRepairEnabled('true')).toThrow('GENIE_RELEASE_DOGFOOD=1');
    expect(() => assertLocalDeliveryRepairEnabled('1')).not.toThrow();
  });

  test('accepts only a bounded exact schema', () => {
    const files = basicFiles('schema');
    expect(parseLocalDeliveryRepairRequest(requestJson(files))).toEqual(files.request);
    expect(() =>
      parseLocalDeliveryRepairRequest(JSON.stringify({ ...files.request, testOnlySkipSignature: true })),
    ).toThrow('exact schema-v1 fields');
    expect(() => parseLocalDeliveryRepairRequest('{}')).toThrow('exact schema-v1 fields');
    expect(() => parseLocalDeliveryRepairRequest('x'.repeat(LOCAL_DELIVERY_REPAIR_REQUEST_MAX_BYTES + 1))).toThrow(
      '1-16384 UTF-8 bytes',
    );
  });

  test('snapshots canonical files and preserves exact raw manifest bytes', () => {
    const files = basicFiles('snapshot');
    const rawManifest = readFileSync(files.request.manifest, 'utf8');
    const materialized = materializeLocalDeliveryRepair(
      requestJson(files),
      stageRoot(files.root),
      files.platformId,
      VERSION,
    );
    expect(materialized.manifest.manifestBytes).toBe(rawManifest);
    expect(materialized.manifest.manifestSha256).toBe(createHash('sha256').update(rawManifest).digest('hex'));
    expect(basename(materialized.artifactPath)).toBe(`genie-${VERSION}-${files.platformId}.tar.gz`);
    writeFileSync(files.request.artifact, 'changed outside snapshot');
    expect(readFileSync(materialized.artifactPath, 'utf8')).toBe('artifact');
  });

  test('rejects relative, non-canonical, symlinked, and physically aliased inputs', () => {
    const relative = basicFiles('relative');
    expect(() =>
      parseLocalDeliveryRepairRequest(JSON.stringify({ ...relative.request, artifact: './candidate.tar.gz' })),
    ).toThrow('bounded absolute canonical path');

    const nonCanonical = basicFiles('noncanonical');
    const spelledWithDot = `${dirname(nonCanonical.request.artifact)}/./${basename(nonCanonical.request.artifact)}`;
    expect(() =>
      materializeLocalDeliveryRepair(
        JSON.stringify({ ...nonCanonical.request, artifact: spelledWithDot }),
        stageRoot(nonCanonical.root),
        nonCanonical.platformId,
        VERSION,
      ),
    ).toThrow('not its absolute canonical physical path');

    for (const field of ['artifact', 'manifest', 'descriptor', 'bundle'] as const) {
      const files = basicFiles(`symlink-${field}`);
      const linkRoot = join(files.root, `${field}-link-root`);
      mkdirSync(linkRoot);
      const link = join(linkRoot, basename(files.request[field]));
      symlinkSync(files.request[field], link);
      expect(() =>
        materializeLocalDeliveryRepair(
          JSON.stringify({ ...files.request, [field]: link }),
          stageRoot(files.root, `-${field}`),
          files.platformId,
          VERSION,
        ),
      ).toThrow('not its absolute canonical physical path');
    }

    const aliased = basicFiles('hardlink');
    const alias = join(aliased.root, 'descriptor-alias.json');
    linkSync(aliased.request.artifact, alias);
    expect(() =>
      materializeLocalDeliveryRepair(
        JSON.stringify({ ...aliased.request, descriptor: alias }),
        stageRoot(aliased.root),
        aliased.platformId,
        VERSION,
      ),
    ).toThrow('distinct physical files');
  });

  test('rejects platform, manifest version, and exact manifest-schema drift', () => {
    const files = basicFiles('bindings');
    const otherPlatform = files.platformId === 'darwin-arm64' ? 'linux-arm64' : 'darwin-arm64';
    expect(() =>
      materializeLocalDeliveryRepair(
        JSON.stringify({ ...files.request, platformId: otherPlatform }),
        stageRoot(files.root, '-platform'),
        files.platformId,
        VERSION,
      ),
    ).toThrow('differs from this runtime');

    writeFileSync(files.request.manifest, manifestBytes(files.platformId, '5.260722.1'));
    expect(() =>
      materializeLocalDeliveryRepair(requestJson(files), stageRoot(files.root, '-version'), files.platformId, VERSION),
    ).toThrow('differs from the running binary VERSION');

    writeFileSync(
      files.request.manifest,
      JSON.stringify({ ...JSON.parse(manifestBytes(files.platformId)), artifact_sha256: 'a'.repeat(64) }),
    );
    expect(() =>
      materializeLocalDeliveryRepair(requestJson(files), stageRoot(files.root, '-schema'), files.platformId, VERSION),
    ).toThrow('exact schema-v1 fields');
  });
});

describe('local delivery update-mode and trailer boundary', () => {
  test('is a distinct mode and conflicts with every normal update control', () => {
    expect(resolveUpdateExecutionMode({ publishLocalDelivery: '{}' }, undefined)).toBe('publish-local-delivery');
    for (const conflict of [
      { dev: true },
      { homolog: true },
      { next: true },
      { stable: true },
      { yes: true },
      { restart: false },
      { verify: false },
      { skipMaintenance: true },
      { rollback: true },
      { syncOnly: true },
      { postDeliveryConverge: true },
      { printUpdateCapabilities: true },
      { json: true },
    ]) {
      expect(() => resolveUpdateExecutionMode({ publishLocalDelivery: '{}', ...conflict }, undefined)).toThrow(
        'cannot be combined',
      );
    }
    expect(() => resolveUpdateExecutionMode({ publishLocalDelivery: '{}' }, '1')).toThrow('cannot be combined');
  });

  test('projects only the standard result, incomplete, and busy trailers', () => {
    const failed = projectLocalDeliveryRepairDirective({ action: 'failed', detail: 'tampered' });
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout.join('\n')).toContain('"code":"delivery-incomplete"');
    expect(failed.stderr.join('\n')).toContain('tampered');

    const busy = projectLocalDeliveryRepairDirective({ action: 'busy', detail: 'setup owns lease' });
    expect(busy.exitCode).toBe(2);
    expect(busy.stdout.join('\n')).toContain('"code":"codex-lifecycle-busy"');

    const pending = projectLocalDeliveryRepairDirective({ action: 'exit-handoff' });
    expect(pending.exitCode).toBe(2);
    expect(pending.stdout.join('\n')).toContain('"code":"activation-pending"');
    expect(projectLocalDeliveryRepairDirective({ action: 'proceed-current' }).exitCode).toBe(0);
    expect(projectLocalDeliveryRepairDirective({ action: 'repaired-current' }).exitCode).toBe(0);
  });

  test('the CLI keeps the option hidden and refuses missing capability or mixed modes', () => {
    const root = tempRoot('cli-gate');
    const help = runCli(root, ['update', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).not.toContain('--publish-local-delivery');

    const missing = runCli(root, ['update', '--publish-local-delivery', '{}']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('GENIE_RELEASE_DOGFOOD=1');
    expect(missing.stdout).toContain('"code":"delivery-incomplete"');

    const conflict = runCli(root, ['update', '--publish-local-delivery', '{}', '--dev'], {
      GENIE_RELEASE_DOGFOOD: '1',
    });
    expect(conflict.exitCode).not.toBe(0);
    expect(conflict.stderr).toContain('cannot be used with option');
  });

  test('the CLI rejects exact-schema and symlink violations before lifecycle state access', () => {
    const files = basicFiles('cli-paths');
    const extra = runCli(
      files.root,
      ['update', '--publish-local-delivery', JSON.stringify({ ...files.request, unsigned: true })],
      { GENIE_RELEASE_DOGFOOD: '1' },
    );
    expect(extra.exitCode).toBe(1);
    expect(extra.stderr).toContain('exact schema-v1 fields');
    expect(extra.stdout).toContain('"code":"delivery-incomplete"');

    const manifestLink = join(files.root, 'manifest-link.json');
    symlinkSync(files.request.manifest, manifestLink);
    const linked = runCli(
      files.root,
      ['update', '--publish-local-delivery', JSON.stringify({ ...files.request, manifest: manifestLink })],
      { GENIE_RELEASE_DOGFOOD: '1' },
    );
    expect(linked.exitCode).toBe(1);
    expect(linked.stderr).toContain('not its absolute canonical physical path');
    expect(linked.stdout).toContain('"code":"delivery-incomplete"');
  });

  test('a held Codex lifecycle lease returns the standard busy trailer with exit 2', () => {
    const files = basicFiles('cli-busy');
    const genieHome = join(files.root, 'genie-home');
    mkdirSync(genieHome, { recursive: true });
    const lease = acquireLifecycleLease('setup-activation', { genieHome });
    if (!lease.ok) throw new Error(lease.detail);
    try {
      const result = runCli(files.root, ['update', '--publish-local-delivery', requestJson(files)], {
        GENIE_HOME: genieHome,
        GENIE_RELEASE_DOGFOOD: '1',
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('is busy');
      expect(result.stdout).toContain('"code":"codex-lifecycle-busy"');
    } finally {
      lease.release();
    }
  });
});

describe('local delivery embedded-trust command boundary', () => {
  test('rejects descriptor tampering without invoking a network verifier or publishing a record', () => {
    const root = tempRoot('cli-tamper');
    const platform = platformId();
    const payload = join(root, 'payload');
    const payloadTree = join(payload, 'plugins', 'genie');
    mkdirSync(payloadTree, { recursive: true });
    writeFileSync(join(payloadTree, 'plugin.txt'), 'candidate payload\n');
    writeFileSync(join(payload, 'VERSION'), `${VERSION}\n`);
    const binary = join(payload, 'genie');
    writeFileSync(
      binary,
      `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf 'genie ${VERSION}\\n'; exit 0; fi\nexit 0\n`,
    );
    chmodSync(binary, 0o755);
    const tree = scanPhysicalTree(payloadTree);
    if (tree.status !== 'ok' || tree.digest === undefined) throw new Error(`fixture tree is ${tree.status}`);
    const artifact = join(root, `genie-${VERSION}-${platform}.tar.gz`);
    const archived = Bun.spawnSync(['tar', '-czf', artifact, '-C', payload, '.'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (archived.exitCode !== 0) throw new Error(archived.stderr.toString());
    const binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
    const artifactSha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
    const pack = buildTestDeliveryEvidencePack({
      descriptor: {
        version: VERSION,
        channel: 'dev',
        platformId: platform,
        platformTriple: `${process.platform}-${process.arch}`,
        releaseTag: `v${VERSION}`,
        releaseName: basename(artifact),
        artifactSha256,
        installedBinarySha256: binarySha256,
        canonicalPayloadSha256: tree.digest,
      },
    });
    const manifest = join(root, 'manifest.json');
    const descriptor = join(root, 'descriptor.json');
    const bundle = join(root, 'bundle.json');
    writeFileSync(manifest, pack.manifestBytes);
    writeFileSync(descriptor, `${pack.descriptorBytes} `);
    writeFileSync(bundle, pack.bundleBytes);

    const genieHome = join(root, 'genie-home');
    mkdirSync(join(genieHome, 'bin'), { recursive: true });
    cpSync(payloadTree, join(genieHome, 'plugins', 'genie'), { recursive: true });
    writeFileSync(join(genieHome, 'VERSION'), `${VERSION}\n`);
    cpSync(binary, join(genieHome, 'bin', 'genie'));
    chmodSync(join(genieHome, 'bin', 'genie'), 0o755);

    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin);
    const networkLog = join(root, 'network.log');
    const codex = join(fakeBin, 'codex');
    writeFileSync(
      codex,
      '#!/bin/sh\nif [ "$1" = "plugin" ] && [ "$2" = "list" ]; then printf \'{"installed":[]}\\n\'; exit 0; fi\nexit 1\n',
    );
    chmodSync(codex, 0o755);
    for (const command of ['curl', 'gh', 'cosign']) {
      const path = join(fakeBin, command);
      writeFileSync(path, `#!/bin/sh\nprintf '${command}\\n' >> '${networkLog}'\nexit 91\n`);
      chmodSync(path, 0o755);
    }

    const request = JSON.stringify({
      schemaVersion: 1,
      platformId: platform,
      artifact,
      manifest,
      descriptor,
      bundle,
    });
    const result = runCli(root, ['update', '--publish-local-delivery', request], {
      GENIE_HOME: genieHome,
      GENIE_RELEASE_DOGFOOD: '1',
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('DSSE subject does not bind the exact descriptor bytes');
    expect(result.stdout).toContain('"code":"delivery-incomplete"');
    expect(readFileIfPresent(networkLog)).toBe('');
    expect(readFileIfPresent(join(genieHome, '.codex-plugin-delivery-record.json'))).toBe('');

    const source = readFileSync(join(import.meta.dir, 'update.ts'), 'utf8');
    const start = source.indexOf('async function runLocalDeliveryRepairMode');
    const end = source.indexOf('/** Build the real repair seams', start);
    const boundary = source.slice(start, end);
    expect(boundary).not.toContain('skipAttestation');
    expect(boundary).not.toContain('evidenceVerification');
    expect(boundary).not.toContain('GENIE_TEST');
  });
});

function readFileIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
