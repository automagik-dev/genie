import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Orca accepts exactly two source kinds:
 *
 *  1. a MARKETPLACE source — a git repo whose ROOT holds `orca-marketplace.json`;
 *  2. a PLUGIN source — a git repo whose ROOT holds `orca-plugin.json`, or a
 *     local folder containing `orca-plugin.json`.
 *
 * Genie's shipped manifest lives at `plugins/genie/orca-plugin.json`, which is
 * the only copy Orca ever loads from an installed payload (or from a local
 * folder install of `~/.genie/plugins/genie`). Neither root file is copied into
 * the release tarball — they exist so the PUBLIC REPO ROOT is itself a valid
 * Orca marketplace source and a valid Orca git plugin source. They are
 * source-only, and this test is the contract that keeps them from drifting away
 * from the payload manifest.
 */

const REPO_ROOT = resolve(dirname(import.meta.path), '..');
const ROOT_MANIFEST = join(REPO_ROOT, 'orca-plugin.json');
const PAYLOAD_MANIFEST = join(REPO_ROOT, 'plugins/genie/orca-plugin.json');
const ROOT_MARKETPLACE = join(REPO_ROOT, 'orca-marketplace.json');

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

describe('root Orca manifest and marketplace parity', () => {
  test('both root files parse as JSON objects', () => {
    expect(() => readJsonObject(ROOT_MANIFEST)).not.toThrow();
    expect(() => readJsonObject(ROOT_MARKETPLACE)).not.toThrow();
  });

  test('the root manifest matches the payload manifest on every key except main', () => {
    const root = readJsonObject(ROOT_MANIFEST);
    const payload = readJsonObject(PAYLOAD_MANIFEST);

    expect(Object.keys(root).sort()).toEqual(Object.keys(payload).sort());
    for (const key of Object.keys(payload)) {
      if (key === 'main') continue;
      expect({ key, value: root[key] }).toEqual({ key, value: payload[key] });
    }
    // Identical contribution sets: the root manifest is the same plugin, only
    // re-rooted. It must never grow skills or commands the payload lacks.
    expect(root.contributes).toEqual(payload.contributes);
  });

  test('the root manifest main is repo-root relative and resolves to a real file', () => {
    const root = readJsonObject(ROOT_MANIFEST);
    const payload = readJsonObject(PAYLOAD_MANIFEST);
    expect(typeof root.main).toBe('string');
    expect(typeof payload.main).toBe('string');
    const rootMain = root.main as string;
    const payloadMain = payload.main as string;

    expect(isAbsolute(rootMain)).toBe(false);
    expect(rootMain.startsWith('../')).toBe(false);
    // The root entry point is the payload entry point, re-rooted at the repo root.
    expect(rootMain).toBe(join('plugins/genie', payloadMain));
    expect(existsSync(join(REPO_ROOT, rootMain))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'plugins/genie', payloadMain))).toBe(true);
  });

  test('the root marketplace lists exactly the genie plugin at publisher.id', () => {
    const manifest = readJsonObject(ROOT_MANIFEST);
    const marketplace = readJsonObject(ROOT_MARKETPLACE);
    const plugins = marketplace.plugins;
    if (!Array.isArray(plugins)) throw new Error('root marketplace has no plugins array');
    expect(plugins).toHaveLength(1);

    const entry = plugins[0] as Record<string, unknown>;
    expect(entry.id).toBe(`${manifest.publisher as string}.${manifest.id as string}`);
    expect(entry.description).toBe(manifest.description);
    expect(entry.categories).toEqual(['workflows']);

    // A git source pinned to the stable branch: Orca resolves and pins the
    // fetched commit itself, so `main` (not a tag) is the intended ref.
    const source = entry.source as Record<string, unknown>;
    expect(source.kind).toBe('git');
    expect(source.url).toBe(`${manifest.repository as string}.git`);
    expect(source.ref).toBe('main');
  });

  test('the root manifest is stamped like every other version file', () => {
    const rootVersion = readJsonObject(ROOT_MANIFEST).version;
    expect(rootVersion).toBe(readJsonObject(join(REPO_ROOT, 'package.json')).version);
    expect(rootVersion).toBe(readJsonObject(PAYLOAD_MANIFEST).version);

    // version.ts and the CI bump list must both carry the root manifest.
    expect(readFileSync(join(REPO_ROOT, 'scripts/version.ts'), 'utf8')).toContain("join(rootDir, 'orca-plugin.json')");
    expect(readFileSync(join(REPO_ROOT, '.github/workflows/version.yml'), 'utf8')).toMatch(
      /JSON_FILES=\(\n\s+package\.json\n\s+orca-plugin\.json\n/,
    );
  });

  test('the root manifest is NOT part of the shipped release payload', () => {
    const build = readFileSync(join(REPO_ROOT, 'scripts/build-binary.sh'), 'utf8');
    // Nothing copies the repo-root manifest into the staged tarball, so payload
    // stamping (release-payload-version.ts) must not gate it either.
    expect(build).not.toContain('"${REPO_ROOT}/orca-plugin.json"');
    expect(build).not.toContain('orca-marketplace.json');
    const payloadStamp = readFileSync(join(REPO_ROOT, 'scripts/release-payload-version.ts'), 'utf8');
    expect(payloadStamp).not.toMatch(/^\s+'orca-plugin\.json',$/m);
    expect(payloadStamp).not.toContain("'orca-marketplace.json'");
  });
});
