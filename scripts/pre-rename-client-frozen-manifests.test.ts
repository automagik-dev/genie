import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// What a genie released before the 2026-11 repository rename does with the two
// channel manifests that are frozen for it.
//
// The client is src/genie-commands/update.ts at the last commit before the rename
// fix, with everything it imports, taken out of this repository's history with
// `git archive` and loaded as it is. Nothing in it is replaced except the manifest
// fetcher, which is its own test seam and here serves the files this branch commits.
// Its addresses, its version comparison and its verifier are the shipped ones, and
// the cryptography is real.
//
// This needs that commit in the object store. A shallow clone does not have it, and
// every test here is then SKIPPED, by name.

const REPO_ROOT = join(import.meta.dir, '..');
const PRE_RENAME_COMMIT = '1d6eb08ba67a9df43600d05fa45779e90bd82ccc';
const EVIDENCE = join(REPO_ROOT, 'tests', 'fixtures', 'delivery-evidence');
const OLD_RAW = 'https://raw.githubusercontent.com/automagik-dev/genie/main/.well-known';
const OLD_API = 'https://api.github.com/repos/automagik-dev/genie/contents/.well-known';

/** The frozen pair, and the published evidence of the release each one names. */
const FROZEN = [
  {
    channel: 'stable',
    file: 'latest.json',
    version: '6.261108.1',
    descriptor: 'genie-6.261108.1-linux-x64-glibc.tar.gz.stable.delivery.json',
    artifactSha256: 'ac6575fd7349d8f2dca242af52c62af969c792e783d6d0467bed1de55e0cbf59',
  },
  {
    channel: 'dev',
    file: 'dev.json',
    version: '6.261109.9',
    descriptor: 'genie-6.261109.9-linux-x64-glibc.tar.gz.dev.delivery.json',
    artifactSha256: 'd583469de0aa78763faea54ae16421bdf74234ffae1529ffb6af4d53eb83bdbc',
  },
] as const;

interface Manifest {
  version: string;
  channel: string;
  tarball_base: string;
  manifestBytes: string;
}
interface PreRenameClient {
  manifestUrlForChannel: (channel: string) => string;
  manifestApiUrlForChannel: (channel: string) => string;
  fetchLatestManifest: (
    channel: string,
    options: { fetcher: (url: string) => Promise<string | null> },
  ) => Promise<Manifest | null>;
  shortCircuitIfCurrent: (installed: string, latest: string | null) => boolean;
  decideDowngrade: (args: { installedVersion: string; latestVersion: string; explicitChannel: boolean }) => {
    kind: string;
  };
}
interface PreRenameVerifier {
  verifyDeliveryEvidenceArtifact: (input: Record<string, unknown>) => {
    descriptor: { repository: string; version: string };
  };
}

const history =
  Bun.spawnSync(['git', 'cat-file', '-e', `${PRE_RENAME_COMMIT}^{commit}`], { cwd: REPO_ROOT }).exitCode === 0;
const scratch: string[] = [];
let client: PreRenameClient;
let verifier: PreRenameVerifier;

beforeAll(async () => {
  if (!history) return;
  const tree = mkdtempSync(join(tmpdir(), 'genie-pre-rename-client-'));
  scratch.push(tree);
  const archive = Bun.spawnSync(['git', 'archive', PRE_RENAME_COMMIT, 'src', 'package.json', 'tsconfig.json'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
  });
  expect(archive.exitCode).toBe(0);
  expect(Bun.spawnSync(['tar', '-x', '-C', tree], { stdin: archive.stdout }).exitCode).toBe(0);
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(tree, 'node_modules'));
  client = (await import(join(tree, 'src', 'genie-commands', 'update.ts'))) as PreRenameClient;
  verifier = (await import(join(tree, 'src', 'lib', 'delivery-evidence-verify.ts'))) as PreRenameVerifier;
});

afterAll(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The client's own manifest read, answered with the bytes this branch commits at the old location. */
async function readFrozen(channel: string, file: string): Promise<Manifest> {
  const bytes = readFileSync(join(REPO_ROOT, '.well-known', file), 'utf8');
  const asked: string[] = [];
  const manifest = await client.fetchLatestManifest(channel, {
    fetcher: async (url) => {
      asked.push(url);
      return url === `${OLD_RAW}/${file}` || url === `${OLD_API}/${file}?ref=main` ? bytes : null;
    },
  });
  expect(asked.sort()).toEqual([`${OLD_API}/${file}?ref=main`, `${OLD_RAW}/${file}`].sort());
  if (manifest === null) throw new Error('the pre-rename client read no manifest');
  return manifest;
}

describe.skipIf(!history)('the pre-rename update client, unmodified (needs commit 1d6eb08b in the clone)', () => {
  test('reads its channel from .well-known/latest.json and .well-known/dev.json, never from v2', () => {
    expect(client.manifestUrlForChannel('stable')).toBe(`${OLD_RAW}/latest.json`);
    expect(client.manifestUrlForChannel('dev')).toBe(`${OLD_RAW}/dev.json`);
    expect(client.manifestApiUrlForChannel('stable')).toBe(`${OLD_API}/latest.json?ref=main`);
    expect(client.manifestApiUrlForChannel('dev')).toBe(`${OLD_API}/dev.json?ref=main`);
  });

  test.each([...FROZEN])('$channel: an install on $version is up to date', async ({ channel, file, version }) => {
    const manifest = await readFrozen(channel, file);
    expect(manifest.version).toBe(version);
    // True is the client's "already up to date" return: nothing is downloaded and the command exits 0.
    expect(client.shortCircuitIfCurrent(version, manifest.version)).toBe(true);
    expect(
      client.decideDowngrade({ installedVersion: version, latestVersion: manifest.version, explicitChannel: false })
        .kind,
    ).toBe('current');
  });

  test.each([...FROZEN])(
    '$channel: an older install is offered $version, and its published evidence verifies against the frozen file',
    async ({ channel, file, version, descriptor, artifactSha256 }) => {
      const manifest = await readFrozen(channel, file);
      expect(client.shortCircuitIfCurrent('6.261101.1', manifest.version)).toBe(false);
      expect(
        client.decideDowngrade({
          installedVersion: '6.261101.1',
          latestVersion: manifest.version,
          explicitChannel: false,
        }).kind,
      ).toBe('upgrade');

      const facts = verifier.verifyDeliveryEvidenceArtifact({
        descriptorBytes: readFileSync(join(EVIDENCE, descriptor)),
        bundleBytes: readFileSync(join(EVIDENCE, `${descriptor}.sigstore.json`)),
        manifestBytes: Buffer.from(manifest.manifestBytes),
        targetVersion: version,
        channel,
        platformId: 'linux-x64-glibc',
        platformTriple: 'linux-x64',
        releaseTag: `v${version}`,
        releaseName: `genie-${version}-linux-x64-glibc.tar.gz`,
        artifactSha256,
      });
      expect(facts.descriptor.repository).toBe('automagik-dev/genie');
      expect(facts.descriptor.version).toBe(version);
    },
  );

  test.each([...FROZEN])(
    '$channel: one changed byte in the frozen file and that evidence no longer verifies',
    async (frozen) => {
      const manifest = await readFrozen(frozen.channel, frozen.file);
      expect(() =>
        verifier.verifyDeliveryEvidenceArtifact({
          descriptorBytes: readFileSync(join(EVIDENCE, frozen.descriptor)),
          bundleBytes: readFileSync(join(EVIDENCE, `${frozen.descriptor}.sigstore.json`)),
          manifestBytes: Buffer.from(`${manifest.manifestBytes} `),
          targetVersion: frozen.version,
          channel: frozen.channel,
          platformId: 'linux-x64-glibc',
          platformTriple: 'linux-x64',
          releaseTag: `v${frozen.version}`,
          releaseName: `genie-${frozen.version}-linux-x64-glibc.tar.gz`,
          artifactSha256: frozen.artifactSha256,
        }),
      ).toThrow();
    },
  );
});

test.skipIf(history)(
  'SKIPPED: the pre-rename update client check needs commit 1d6eb08b, which this clone does not have',
  () => {},
);
