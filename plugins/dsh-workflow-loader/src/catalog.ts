/**
 * The catalog: the two roots a saved workflow can live in, and the one rule that
 * keeps them from drifting.
 *
 * A Claude Code body discovers `<repo>/.claude/workflows/<name>.js` (project) and
 * `~/.claude/workflows/<name>.js` (personal). Which one wins when both carry the
 * same name is not documented upstream, and a stale personal copy has already
 * shadowed a repository's own file once (`workflows-catalog`, 2026-09-15). So a
 * name that exists in both roots is refused by name rather than resolved by luck.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type MetaBlock, splitMeta } from './dialect';

export type RootKind = 'project' | 'user';

export interface CatalogRoots {
  project: string;
  user: string;
}

export interface WorkflowEntry {
  name: string;
  path: string;
  root: RootKind;
  bytes: number;
  meta: MetaBlock;
}

export interface ResolvedWorkflow {
  name: string;
  path: string;
  root: RootKind;
  meta: MetaBlock;
  /** The body with `export const meta` split off — the engine rejects the export. */
  body: string;
  /**
   * Set when the name exists in both roots and the loader still ran. Today that
   * means the two files are byte-identical (so either one is the same workflow)
   * or `allowShadowing` is on; the operator is told which copy ran and how to
   * make the other one go away.
   */
  warning?: string;
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** A workflow name is a filename stem, never a path. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The two roots. `userWorkflows` is the personal `.claude/workflows` directory
 * itself (the operator can point it elsewhere); the project root is always
 * derived from the working directory, never configured.
 */
export function catalogRoots(cwd: string, userWorkflows = join(homedir(), '.claude', 'workflows')): CatalogRoots {
  return { project: join(cwd, '.claude', 'workflows'), user: userWorkflows };
}

function entriesIn(root: string, kind: RootKind): WorkflowEntry[] {
  let files: string[];
  try {
    files = readdirSync(root);
  } catch {
    return [];
  }
  const entries: WorkflowEntry[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.js')) continue;
    const name = file.slice(0, -3);
    if (!SAFE_NAME.test(name)) continue;
    const path = join(root, file);
    try {
      if (!statSync(path).isFile()) continue;
      const text = readFileSync(path, 'utf8');
      const { meta } = splitMeta(text);
      entries.push({ name, path, root: kind, bytes: Buffer.byteLength(text), meta });
    } catch {}
  }
  return entries;
}

/** Every workflow both roots offer, project first. */
export function listWorkflows(roots: CatalogRoots): WorkflowEntry[] {
  return [...entriesIn(roots.project, 'project'), ...entriesIn(roots.user, 'user')];
}

/** Names that exist in both roots — the collision the loader refuses. */
export function collisions(roots: CatalogRoots): string[] {
  const project = new Set(entriesIn(roots.project, 'project').map((entry) => entry.name));
  return entriesIn(roots.user, 'user')
    .map((entry) => entry.name)
    .filter((name) => project.has(name));
}

/** Resolve one workflow by name, or explain exactly why it cannot be resolved. */
export function resolveWorkflow(name: string, roots: CatalogRoots, allowShadowing = false): ResolvedWorkflow {
  if (!SAFE_NAME.test(name)) {
    throw new CatalogError(`"${name}" is not a workflow name: expected a filename stem like \`council\``);
  }
  const projectPath = join(roots.project, `${name}.js`);
  const userPath = join(roots.user, `${name}.js`);
  const inProject = existsSync(projectPath);
  const inUser = existsSync(userPath);
  // A name in both roots is the COMMON case on an installed host: genie's
  // workflows channel copies every shipped catalog file into the personal root,
  // so a repository carrying its own catalog collides with it by default. Which
  // root wins is undocumented upstream (and a stale personal copy shadowed a
  // repository's own file once, 2026-09-15), so the loader compares the two
  // files: byte-identical copies cannot disagree, and a divergent pair is still
  // refused by name. `allowShadowing` remains the explicit override.
  let warning: string | undefined;
  if (inProject && inUser && !allowShadowing) {
    const sameBytes = readIfPresent(projectPath) === readIfPresent(userPath);
    if (!sameBytes) {
      throw new CatalogError(
        `"${name}" exists in both roots and the two files differ, so this loader does not guess which one you meant:\n  ${projectPath}\n  ${userPath}\nDelete or update the one you do not want, or set allowShadowing to accept the project copy.`,
      );
    }
    warning = `"${name}" exists in both roots and the copies are byte-identical, so the project copy ran: ${projectPath} (personal copy left in place: ${userPath})`;
  }
  const path = inProject ? projectPath : inUser ? userPath : '';
  if (!path) {
    const available = listWorkflows(roots).map((entry) => entry.name);
    const shown = available.slice(0, 20);
    throw new CatalogError(
      `no workflow named "${name}".${
        shown.length
          ? `\nAvailable: ${shown.join(', ')}${available.length > shown.length ? `, +${available.length - shown.length} more` : ''}`
          : `\nNo .claude/workflows catalog was found at ${roots.project} or ${roots.user}`
      }`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (failure) {
    throw new CatalogError(`could not read ${path}: ${failure instanceof Error ? failure.message : 'unknown error'}`);
  }
  const { meta, body } = splitMeta(text);
  return { name, path, root: inProject ? 'project' : 'user', meta, body, ...(warning ? { warning } : {}) };
}

/** Read a file, or undefined when it cannot be read — a comparison, not a load. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
