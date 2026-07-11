#!/usr/bin/env bun

/**
 * Keep the Codex plugin's committed skills payload identical to the canonical
 * top-level skills tree. The mirror is deliberately physical: Codex plugin
 * components must remain inside the plugin root, and source installs must not
 * depend on a packager dereferencing an escaping symlink.
 *
 * Usage:
 *   bun scripts/sync-plugin-skills.ts --write  # regenerate the mirror
 *   bun scripts/sync-plugin-skills.ts --check  # fail on inventory/parity drift
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function repositoryRootFromModuleUrl(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

const REPO_ROOT = repositoryRootFromModuleUrl(import.meta.url);
const DEFAULT_PLUGIN_ROOT = join(REPO_ROOT, 'plugins', 'genie');

export const SHIPPED_SKILL_NAMES = [
  'architecture',
  'brainstorm',
  'code-quality',
  'council',
  'docs',
  'dream',
  'dx-docs',
  'fix',
  'genie',
  'genie-hacks',
  'omni',
  'perf',
  'pm',
  'qa',
  'refine',
  'repo-hygiene',
  'report',
  'review',
  'supply-chain',
  'trace',
  'wish',
  'wizard',
  'work',
] as const;

export interface SkillMirrorOptions {
  canonicalDir?: string;
  /** Required when sync tests/tools use a non-repository plugin root. */
  pluginRoot?: string;
  pluginSkillsDir?: string;
  expectedSkillNames?: readonly string[];
}

interface TreeFile {
  relativePath: string;
  digest: string;
  executable: boolean;
}

function canonicalDir(options: SkillMirrorOptions): string {
  return options.canonicalDir ?? join(REPO_ROOT, 'skills');
}

function pluginSkillsDir(options: SkillMirrorOptions): string {
  return options.pluginSkillsDir ?? join(DEFAULT_PLUGIN_ROOT, 'skills');
}

function expectedSkillNames(options: SkillMirrorOptions): readonly string[] {
  return options.expectedSkillNames ?? SHIPPED_SKILL_NAMES;
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertPhysicalDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must be a physical directory, not a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

function listTreeFiles(root: string, label: string): TreeFile[] {
  assertPhysicalDirectory(root, label);
  const files: TreeFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      const rel = relative(root, path);
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${rel}`);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`${label} contains an unsupported entry: ${rel}`);
      files.push({
        relativePath: rel,
        digest: digestFile(path),
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  };

  walk(root);
  return files;
}

export function assertShippedSkillInventory(options: SkillMirrorOptions = {}): string[] {
  const root = canonicalDir(options);
  assertPhysicalDirectory(root, 'canonical skills tree');
  const actual = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  const expected = [...expectedSkillNames(options)].sort();

  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `shipped skill inventory drift (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }

  for (const name of expected) {
    const skillRoot = join(root, name);
    assertPhysicalDirectory(skillRoot, `skill ${name}`);
    if (!existsSync(join(skillRoot, 'agents', 'openai.yaml'))) {
      throw new Error(`skill ${name} is missing agents/openai.yaml`);
    }
  }
  return actual;
}

export function assertPluginSkillsInSync(options: SkillMirrorOptions = {}): void {
  assertShippedSkillInventory(options);
  const sourceRoot = canonicalDir(options);
  const mirrorRoot = pluginSkillsDir(options);
  const source = listTreeFiles(sourceRoot, 'canonical skills tree');
  const mirror = listTreeFiles(mirrorRoot, 'plugin skills mirror');

  const sourceMap = new Map(source.map((entry) => [entry.relativePath, entry]));
  const mirrorMap = new Map(mirror.map((entry) => [entry.relativePath, entry]));
  const missing = [...sourceMap.keys()].filter((path) => !mirrorMap.has(path));
  const extra = [...mirrorMap.keys()].filter((path) => !sourceMap.has(path));
  const changed = [...sourceMap.entries()]
    .filter(([path, entry]) => {
      const mirrored = mirrorMap.get(path);
      return mirrored && (entry.digest !== mirrored.digest || entry.executable !== mirrored.executable);
    })
    .map(([path]) => path);

  if (missing.length > 0 || extra.length > 0 || changed.length > 0) {
    throw new Error(
      [
        'plugin skills mirror drift',
        `missing: ${missing.join(', ') || 'none'}`,
        `extra: ${extra.join(', ') || 'none'}`,
        `changed: ${changed.join(', ') || 'none'}`,
        'run `bun scripts/sync-plugin-skills.ts --write` and commit the result',
      ].join('; '),
    );
  }
}

function copyPhysicalTree(sourceRoot: string, destinationRoot: string): void {
  mkdirSync(destinationRoot, { recursive: true });
  const walk = (sourceDir: string): void => {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = join(sourceDir, entry.name);
      const rel = relative(sourceRoot, source);
      const destination = join(destinationRoot, rel);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error(`canonical skills tree contains a symlink: ${rel}`);
      if (stat.isDirectory()) {
        mkdirSync(destination, { recursive: true });
        walk(source);
        continue;
      }
      if (!stat.isFile()) throw new Error(`canonical skills tree contains an unsupported entry: ${rel}`);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      chmodSync(destination, stat.mode & 0o777);
    }
  };
  walk(sourceRoot);
}

/**
 * Prove the destructive destination before rmSync. `dirname(destination)` is
 * not a guard (it is true for every path), so callers must name the owning
 * plugin root and the destination must be exactly its `skills` child.
 */
function assertSafeMirrorDestination(options: SkillMirrorOptions, sourceRoot: string, mirrorRoot: string): void {
  const source = resolve(sourceRoot);
  const destination = resolve(mirrorRoot);
  const owningPluginRoot = resolve(options.pluginRoot ?? DEFAULT_PLUGIN_ROOT);
  const expectedDestination = join(owningPluginRoot, 'skills');

  if (destination === source) {
    throw new Error(`plugin skills destination must differ from canonical source: ${destination}`);
  }
  if (destination !== expectedDestination) {
    throw new Error(
      `plugin skills destination must be the expected in-plugin mirror ${expectedDestination}, got ${destination}`,
    );
  }

  assertPhysicalDirectory(owningPluginRoot, 'plugin root');
  if (realpathSync(dirname(destination)) !== realpathSync(owningPluginRoot)) {
    throw new Error(`plugin skills destination parent resolves outside the plugin root: ${destination}`);
  }

  if (!existsSync(destination)) return;
  const destinationStat = lstatSync(destination);
  if (destinationStat.isSymbolicLink()) {
    const target = realpathSync(destination);
    const detail = target === realpathSync(source) ? ' (resolves to canonical source)' : '';
    throw new Error(`plugin skills destination must not be a symlink${detail}: ${destination}`);
  }
  if (!destinationStat.isDirectory()) {
    throw new Error(`plugin skills destination must be a directory or absent: ${destination}`);
  }
  if (realpathSync(destination) === realpathSync(source)) {
    throw new Error(`plugin skills destination resolves to canonical source: ${destination}`);
  }
}

export function syncPluginSkills(options: SkillMirrorOptions = {}): void {
  assertShippedSkillInventory(options);
  const sourceRoot = canonicalDir(options);
  const mirrorRoot = pluginSkillsDir(options);

  assertSafeMirrorDestination(options, sourceRoot, mirrorRoot);

  rmSync(mirrorRoot, { recursive: true, force: true });
  copyPhysicalTree(sourceRoot, mirrorRoot);
  assertPluginSkillsInSync(options);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
    console.error('Usage: bun scripts/sync-plugin-skills.ts --check|--write');
    process.exit(2);
  }

  try {
    if (args[0] === '--write') syncPluginSkills();
    else assertPluginSkillsInSync();
    console.log(`sync-plugin-skills: OK (${SHIPPED_SKILL_NAMES.length} physical skills, byte-identical mirror)`);
  } catch (error) {
    console.error(`sync-plugin-skills: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
