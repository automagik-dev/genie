import { constants, accessSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_GIT_POINTER_BYTES = 4 * 1024;
const MAX_PARENT_DEPTH = 128;

function normalizeComparablePath(path: string): string {
  if (process.platform !== 'darwin' || !path.startsWith('/private/')) return path;
  const logical = path.slice('/private'.length);
  try {
    return realpathSync(logical) === path ? logical : path;
  } catch {
    return path;
  }
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeComparablePath(root);
  const normalizedCandidate = normalizeComparablePath(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readBoundedPointer(path: string, label: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GIT_POINTER_BYTES) {
    throw new Error(`${label} must be a small physical file: ${path}`);
  }
  const value = readFileSync(path, 'utf8').trim();
  if (!value || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} is malformed: ${path}`);
  }
  return value;
}

function addPhysicalDirectory(path: string, label: string, roots: Set<string>): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory: ${path}`);
  }
  const canonical = realpathSync(path);
  roots.add(canonical);
  return canonical;
}

function addGitMarkerRoots(worktreeRoot: string, markerPath: string, roots: Set<string>): void {
  const marker = lstatSync(markerPath);
  if (marker.isSymbolicLink()) throw new Error(`Git marker must not be a symlink: ${markerPath}`);

  roots.add(realpathSync(worktreeRoot));
  let gitDir: string;
  if (marker.isDirectory()) {
    gitDir = addPhysicalDirectory(markerPath, 'Git directory', roots);
  } else if (marker.isFile()) {
    const pointer = readBoundedPointer(markerPath, 'Git worktree pointer');
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (!match) throw new Error(`Git worktree pointer is malformed: ${markerPath}`);
    gitDir = addPhysicalDirectory(resolve(worktreeRoot, match[1]), 'Git worktree directory', roots);
  } else {
    throw new Error(`Git marker has an unsupported type: ${markerPath}`);
  }

  const commonPointer = join(gitDir, 'commondir');
  let commonValue: string;
  try {
    commonValue = readBoundedPointer(commonPointer, 'Git common-dir pointer');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  }
  const commonDir = addPhysicalDirectory(resolve(gitDir, commonValue), 'Git common directory', roots);
  if (basename(commonDir).toLowerCase() === '.git') {
    roots.add(realpathSync(dirname(commonDir)));
  }
}

/**
 * Discover repository-controlled roots without executing `git` first.
 *
 * This filesystem-only bootstrap is necessary when `git` itself is the
 * executable being authenticated. It includes every enclosing worktree (for
 * nested repositories), linked-worktree git dir, common git dir, and the main
 * checkout that owns a conventional `<root>/.git` common directory.
 */
export function resolveEnclosingGitTrustRoots(cwd: string): string[] {
  const roots = new Set<string>();
  let current = realpathSync(cwd);
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const marker = join(current, '.git');
    try {
      lstatSync(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
        continue;
      }
      throw error;
    }
    addGitMarkerRoots(current, marker, roots);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...roots];
}

/** Validate an already-selected absolute executable against repository trust roots. */
export function validateTrustedExecutablePath(
  name: string,
  candidate: string,
  childCwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!isAbsolute(candidate)) throw new Error(`${name} did not resolve to an absolute executable`);

  const canonicalCwd = realpathSync(childCwd);
  const selectedPath = resolve(candidate);
  const canonical = realpathSync(candidate);
  const forbiddenRoots = new Set([canonicalCwd, ...resolveEnclosingGitTrustRoots(canonicalCwd)]);
  for (const root of forbiddenRoots) {
    if (isSameOrContainedPath(root, selectedPath) || isSameOrContainedPath(root, canonical)) {
      throw new Error(`Refusing repository-local ${name} executable: ${candidate}`);
    }
  }

  if (!statSync(canonical).isFile()) throw new Error(`${name} is not a regular executable file: ${canonical}`);
  accessSync(canonical, platform === 'win32' ? constants.F_OK : constants.X_OK);
  return canonical;
}

/** Resolve through the host PATH once, validate, and return the bound absolute path. */
export function resolveTrustedExecutable(
  name: string,
  childCwd: string,
  which: (command: string) => string | null = (command) => Bun.which(command),
  platform: NodeJS.Platform = process.platform,
): string {
  const candidate = which(name);
  if (!candidate) throw new Error(`${name} did not resolve to an absolute executable`);
  return validateTrustedExecutablePath(name, candidate, childCwd, platform);
}
