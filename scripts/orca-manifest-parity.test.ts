import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Orca accepts exactly two source kinds:
 *
 *  1. a MARKETPLACE source — a git repo whose ROOT holds `orca-marketplace.json`;
 *  2. a PLUGIN source — a git repo whose ROOT holds `orca-plugin.json`, or a
 *     local folder containing `orca-plugin.json`.
 *
 * Genie's only manifest lives at `plugins/genie/orca-plugin.json`. The genie
 * repository ROOT can never be the plugin install tree: Orca's loader rejects
 * any tree containing a symlink, and caps an install at 2000 files / 50 MB —
 * this repo has `docs -> .docs-vendor/genie` and a five-figure file count. So
 * the plugin is published as a TREE-ONLY ref (`orca-plugin` from main,
 * `orca-plugin-dev` from dev) whose root IS `plugins/genie`, republished by
 * `.github/workflows/orca-plugin-ref.yml`.
 *
 * The repo root therefore carries exactly one Orca file: `orca-marketplace.json`,
 * a source-only index that points Orca at that ref. This test is the contract
 * that keeps the index pointing at the real plugin identity, and keeps
 * `plugins/genie` inside the limits that make the published subtree installable.
 */

const REPO_ROOT = resolve(dirname(import.meta.path), '..');
const PAYLOAD_DIR = join(REPO_ROOT, 'plugins/genie');
const PAYLOAD_MANIFEST = join(PAYLOAD_DIR, 'orca-plugin.json');
const ROOT_MARKETPLACE = join(REPO_ROOT, 'orca-marketplace.json');
const PLUGIN_REF = 'orca-plugin';

// Orca's bundled loader limits, mirrored here so the published subtree can never
// silently grow past what Orca will install.
const MAX_FILES = 2000;

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Enumerate the committed `plugins/genie` tree — the exact bytes the workflow
 * republishes as the plugin ref — reporting every path and every symlink
 * (git mode 120000) in it.
 */
function payloadTree(): { paths: string[]; symlinks: string[] } {
  const listed = Bun.spawnSync(['git', '-C', REPO_ROOT, 'ls-files', '-s', '--', 'plugins/genie']);
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  const paths: string[] = [];
  const symlinks: string[] = [];
  for (const line of listed.stdout.toString().split('\n')) {
    if (line.length === 0) continue;
    const [meta, path] = line.split('\t');
    paths.push(path);
    if (meta.startsWith('120000 ')) symlinks.push(path);
  }
  return { paths, symlinks };
}

describe('Orca marketplace index and published plugin subtree', () => {
  test('both Orca JSON documents parse as JSON objects', () => {
    expect(() => readJsonObject(ROOT_MARKETPLACE)).not.toThrow();
    expect(() => readJsonObject(PAYLOAD_MANIFEST)).not.toThrow();
  });

  test('the root marketplace lists exactly the genie plugin at publisher.id', () => {
    const manifest = readJsonObject(PAYLOAD_MANIFEST);
    const marketplace = readJsonObject(ROOT_MARKETPLACE);
    const plugins = marketplace.plugins;
    if (!Array.isArray(plugins)) throw new Error('root marketplace has no plugins array');
    expect(plugins).toHaveLength(1);

    const entry = plugins[0] as Record<string, unknown>;
    expect(entry.id).toBe(`${manifest.publisher as string}.${manifest.id as string}`);
    expect(entry.description).toBe(manifest.description);
    expect(entry.categories).toEqual(['workflows']);
  });

  test('the marketplace source points at the tree-only plugin ref, not at a branch of this repo', () => {
    const manifest = readJsonObject(PAYLOAD_MANIFEST);
    const marketplace = readJsonObject(ROOT_MARKETPLACE);
    const entry = (marketplace.plugins as Record<string, unknown>[])[0];
    const source = entry.source as Record<string, unknown>;

    expect(source.kind).toBe('git');
    expect(source.url).toBe(`${manifest.repository as string}.git`);
    // `main`/`dev` are NOT installable: their root is the repo root, which holds
    // no orca-plugin.json, contains a symlink, and blows past Orca's file cap.
    expect(source.ref).toBe(PLUGIN_REF);
  });

  test('the plugin ref is republished from plugins/genie by a workflow, not by hand', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/orca-plugin-ref.yml'), 'utf8');
    expect(workflow).toContain('HEAD:plugins/genie');
    expect(workflow).toContain('git commit-tree');
    // main publishes the ref the marketplace points at; dev publishes the
    // pre-release channel.
    expect(workflow).toContain(`main) TARGET_REF=${PLUGIN_REF} ;;`);
    expect(workflow).toContain('dev)  TARGET_REF=orca-plugin-dev ;;');
    expect(workflow).toContain('refs/heads/${TARGET_REF}');
  });

  test('plugins/genie is installable as an Orca plugin root: a manifest, no symlinks, inside the file cap', () => {
    const { paths, symlinks } = payloadTree();
    // Orca rejects the whole tree on the first symlink ("unsafe file path or symlink").
    expect(symlinks).toEqual([]);
    expect(paths.length).toBeLessThanOrEqual(MAX_FILES);
    expect(paths).toContain('plugins/genie/orca-plugin.json');
  });

  test('the payload manifest main is a plain relative path that resolves inside the subtree', () => {
    const manifest = readJsonObject(PAYLOAD_MANIFEST);
    expect(typeof manifest.main).toBe('string');
    const main = manifest.main as string;
    expect(main.startsWith('/')).toBe(false);
    expect(main.startsWith('../')).toBe(false);
    // Resolved against the SUBTREE root (which is what Orca sees), not the repo root.
    expect(statSync(join(PAYLOAD_DIR, main)).isFile()).toBe(true);
  });

  test('the repo root carries no orca-plugin.json — the root is not an installable plugin tree', () => {
    expect(readdirSync(REPO_ROOT)).not.toContain('orca-plugin.json');
    // Nothing may stamp or gate a root manifest that must not exist.
    expect(readFileSync(join(REPO_ROOT, 'scripts/version.ts'), 'utf8')).not.toContain(
      "join(rootDir, 'orca-plugin.json')",
    );
    expect(readFileSync(join(REPO_ROOT, '.github/workflows/version.yml'), 'utf8')).not.toMatch(
      /JSON_FILES=\(\n\s+package\.json\n\s+orca-plugin\.json\n/,
    );
  });

  test('the marketplace index is source-only and never ships in the release payload', () => {
    const build = readFileSync(join(REPO_ROOT, 'scripts/build-binary.sh'), 'utf8');
    expect(build).not.toContain('orca-marketplace.json');
    const payloadStamp = readFileSync(join(REPO_ROOT, 'scripts/release-payload-version.ts'), 'utf8');
    expect(payloadStamp).not.toContain("'orca-marketplace.json'");
  });
});
