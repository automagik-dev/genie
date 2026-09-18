/**
 * scripts/mikro/trusted-source.ts — the agent files and the `.mikro/` configuration a
 * pull request cannot rewrite.
 *
 * The trusted source is a git REF read in the INVOKING checkout — the git toplevel of
 * the process's working directory — never in `--dir`, which is the tree under review
 * and may be a linked worktree on a PR branch OR a separate clone with an
 * attacker-chosen `origin`. Every parameter here is called `invokingRoot` for that
 * reason: passing `--dir` to any of these functions is the bug this module exists to
 * make impossible to write by accident.
 *
 * What is trusted, and why a ref rather than a directory: the primary checkout may sit
 * on any branch and may be dirty, so "the base branch" as a DIRECTORY is unreliable. A
 * ref in the common object store is exactly the base branch, reads the same from every
 * linked worktree, and cannot be changed by editing a PR worktree.
 *
 * Out of the threat model, deliberately: a process that already runs commands as the
 * operator can move the ref. This boundary defends against PR CONTENT, not against an
 * executor with shell access.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment variables that make `git` answer for a repository OTHER than the one
 * `-C <dir>` names. A git hook — or any parent that exported them — sets `GIT_DIR`,
 * `GIT_WORK_TREE` and `GIT_INDEX_FILE`, and `-C` does NOT override them: every probe
 * here would then resolve a ref, and therefore a TRUSTED SOURCE, chosen by ambient
 * environment rather than by the operator's working directory.
 */
const AMBIENT_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE',
] as const;

/** The caller's environment with {@link AMBIENT_GIT_VARS} removed; everything else (PATH included) survives. */
export function gitProbeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const stripped = new Set<string>(AMBIENT_GIT_VARS);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !stripped.has(key)) out[key] = value;
  return out;
}

/** One directory name, never a path: `<agents>/<agent>/agent.yaml` and the git pathspec are joined from it. */
export const AGENT_DIR_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** The four files mikro loads from `<dir>/.mikro/`; `TOOLS.md` is Python injected straight into the REPL. */
export const MIKRO_CONFIG_FILES = ['mikro.yaml', 'TOOLS.md', 'SYSTEM.md', 'CRITERIA.md'] as const;

/** One git read in the invoking checkout, with the ambient git environment stripped. Bytes, because blobs are compared byte for byte. */
function gitRead(invokingRoot: string, args: string[]): { ok: boolean; bytes: Buffer } {
  try {
    const probe = Bun.spawnSync(['git', '-C', invokingRoot, ...args], {
      env: gitProbeEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { ok: probe.exitCode === 0, bytes: Buffer.from(probe.stdout) };
  } catch {
    // no git binary, no repository: nothing is trusted rather than something is assumed
    return { ok: false, bytes: Buffer.alloc(0) };
  }
}

/**
 * Why this ref may not be used, or null when the NAME is well formed. Two separate
 * refusals: a leading `-` is refused before git ever sees the token (it would be read
 * as an option), and everything else is `git check-ref-format --allow-onelevel`, which
 * accepts `origin/dev`, `dev` and a bare object name and rejects `bad..name`, a
 * trailing `.lock`, a control character and the rest of the ref-name grammar.
 */
export function refFormatError(ref: string): string | null {
  if (!ref.trim()) return 'a ref is required';
  if (ref.startsWith('-')) return `${ref} may not start with "-": a ref is never an option`;
  try {
    const probe = Bun.spawnSync(['git', 'check-ref-format', '--allow-onelevel', ref], { env: gitProbeEnv() });
    if (probe.exitCode !== 0) return `${ref} is not a valid git ref name (git check-ref-format)`;
  } catch {
    return `${ref} could not be checked: no usable git on this host`;
  }
  return null;
}

/** The full ref name when git knows one (`origin/dev` → `refs/remotes/origin/dev`), else the commit-ish as typed. */
function fullName(invokingRoot: string, ref: string): string {
  const named = gitRead(invokingRoot, ['rev-parse', '--symbolic-full-name', ref]);
  const out = named.ok ? named.bytes.toString('utf8').trim() : '';
  return out || ref;
}

/** True when `ref` names a commit in this checkout. */
function resolvesToCommit(invokingRoot: string, ref: string): boolean {
  return gitRead(invokingRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;
}

export interface TrustedRef {
  /** The ref whose blobs are trusted, or null when none could be resolved (the shipped agents are then used). */
  ref: string | null;
  /** Why this ref won, or why none did — reported so a silent fallback cannot hide a broken repository agent. */
  reason: string;
}

/**
 * The ref whose `.mikro/` content this run trusts.
 *
 * With `--agents-ref` it is the operator's ref, validated and resolved. Without it, it
 * is `<base>` — the target of the invoking checkout's `origin/HEAD` — taken as the
 * LOCAL branch when `origin/<base>` is an ancestor of it, and as `origin/<base>`
 * otherwise. The local-base rule is what makes a committed-but-unpushed agent usable on
 * a repository that commits straight to its base branch; it trusts every local commit on
 * that branch, including one merged locally from an unreviewed PR, which is why
 * `wish.js` passes `--agents-ref origin/<base>` and never relies on it.
 *
 * A ref that does not resolve is not a usage error: it degrades to the shipped agents
 * with the reason, so a repository with no `origin/HEAD` still gets a working agent.
 * Only a MALFORMED ref is refused, and that refusal belongs to the CLI.
 */
export function resolveTrustedRef(invokingRoot: string, explicit?: string): TrustedRef {
  if (explicit) {
    const bad = refFormatError(explicit);
    if (bad) return { ref: null, reason: `--agents-ref ${bad}` };
    if (!resolvesToCommit(invokingRoot, explicit))
      return { ref: null, reason: `--agents-ref ${explicit} names no commit in the invoking checkout` };
    return { ref: fullName(invokingRoot, explicit), reason: `--agents-ref ${explicit}` };
  }
  const head = gitRead(invokingRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const target = head.ok ? head.bytes.toString('utf8').trim() : '';
  const base = target.startsWith('refs/remotes/origin/') ? target.slice('refs/remotes/origin/'.length) : '';
  if (!base)
    return {
      ref: null,
      reason:
        'the invoking checkout has no origin/HEAD, so it names no base branch — run git remote set-head origin -a, or pass --agents-ref',
    };
  const remote = `refs/remotes/origin/${base}`;
  if (!resolvesToCommit(invokingRoot, remote))
    return { ref: null, reason: `origin/HEAD names ${base}, but origin/${base} resolves to no commit` };
  const local = `refs/heads/${base}`;
  if (resolvesToCommit(invokingRoot, local) && gitRead(invokingRoot, ['merge-base', '--is-ancestor', remote, local]).ok)
    return { ref: local, reason: `the local branch ${base}, which contains origin/${base}` };
  return { ref: remote, reason: `origin/${base}` };
}

/** One blob at the trusted ref, or null when the ref does not carry that path. */
export function readTrustedBlob(invokingRoot: string, ref: string, path: string): string | null {
  const blob = gitRead(invokingRoot, ['show', `${ref}:${path}`]);
  return blob.ok ? blob.bytes.toString('utf8') : null;
}

export interface MaterializedAgents {
  /** The directory holding `<agent>/agent.yaml`, inside a 0700 temp tree — what the runtime is pointed at. */
  agentsDir: string;
  /** Removes the temp tree. Idempotent, and called on success, on failure and on a thrown error. */
  dispose(): void;
}

/** Every regular file under `root`, as paths relative to it. */
function filesUnder(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(root, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Materialize `<ref>:.mikro/agents/<agent>/` into a 0700 temp directory and prove it is
 * that tree, byte for byte.
 *
 * `git archive` is the extraction, and it is also the reason the proof exists: archive
 * applies `export-ignore` and `export-subst` from the `.gitattributes` at the ref, so a
 * repository could otherwise drop a file from the agent — or rewrite a line of its
 * SYSTEM.md — in a way `git show` never shows. Every extracted file is therefore
 * compared against `git show <ref>:<path>`, the extracted set is compared against
 * `git ls-tree`, and `agent.yaml` and `SYSTEM.md` must carry bytes. Any mismatch
 * disposes the tree and returns null with the reason, which the caller reports before
 * falling back to the shipped agents.
 */
export function materializeAgent(
  invokingRoot: string,
  ref: string,
  agent: string,
  onSkip?: (reason: string) => void,
): MaterializedAgents | null {
  const skip = (reason: string): null => {
    onSkip?.(reason);
    return null;
  };
  if (!AGENT_DIR_NAME.test(agent)) return skip(`${agent} is not a usable agent directory name`);
  const prefix = `.mikro/agents/${agent}`;
  const listed = gitRead(invokingRoot, ['ls-tree', '-r', '-z', '--name-only', ref, '--', prefix]);
  if (!listed.ok) return skip(`${ref} could not be read in the invoking checkout`);
  const paths = listed.bytes.toString('utf8').split('\0').filter(Boolean);
  if (!paths.includes(`${prefix}/agent.yaml`)) return skip(`${ref} carries no ${prefix}/agent.yaml`);
  const root = mkdtempSync(join(tmpdir(), 'mikro-agents-'));
  chmodSync(root, 0o700);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const archive = Bun.spawnSync(['git', '-C', invokingRoot, 'archive', '--format=tar', ref, prefix], {
      env: gitProbeEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (archive.exitCode !== 0) throw new Error(`git archive ${ref} ${prefix} exited ${archive.exitCode}`);
    const extract = Bun.spawnSync(['tar', '-x', '-f', '-', '-C', root], {
      stdin: archive.stdout,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (extract.exitCode !== 0) throw new Error(`tar could not extract the archive (exit ${extract.exitCode})`);
    const extracted = filesUnder(root).sort();
    for (const path of paths) {
      const abs = join(root, path);
      if (!existsSync(abs)) throw new Error(`${path} is missing from the archive (an export-ignore attribute?)`);
      const blob = gitRead(invokingRoot, ['show', `${ref}:${path}`]);
      if (!blob.ok) throw new Error(`${ref}:${path} could not be read`);
      if (!Buffer.from(readFileSync(abs)).equals(blob.bytes))
        throw new Error(`${path} differs from ${ref}:${path} (an export-subst or filter attribute?)`);
    }
    const unexpected = extracted.filter((p) => !paths.includes(p));
    if (unexpected.length) throw new Error(`the archive carries ${unexpected[0]}, which ${ref} does not`);
    for (const name of ['agent.yaml', 'SYSTEM.md']) {
      const rel = `${prefix}/${name}`;
      if (paths.includes(rel) && statSync(join(root, rel)).size === 0) throw new Error(`${rel} is empty at ${ref}`);
    }
    return { agentsDir: join(root, '.mikro', 'agents'), dispose };
  } catch (error) {
    dispose();
    const why = error instanceof Error ? error.message : String(error);
    return skip(`${agent} could not be materialized from ${ref}: ${why}`);
  }
}
