/**
 * The skills.sh channel — the one supported way genie product skills reach an
 * agent home.
 *
 * `genie install` and `genie update` shell out to a PINNED skills CLI
 * (`SKILLS_CLI_VERSION`) with a fixed argv:
 *
 *   npx -y skills@<PINNED> add <GENIE_HOME>/skills --all --copy -g
 *
 * `--all` expands to `--skill '*' --agent '*' -y` inside the CLI (so no extra
 * `-y` belongs on our side), `--copy` writes plain files rather than links, and
 * `-g` selects the global (per-user) scope.
 *
 * THE SOURCE IS THE LOCAL DELIVERED TREE, NOT A GITHUB REF (wish
 * `skills-everywhere-b`, decision 1). The channel used to pass the release repo
 * suffixed with `@v<version>`; skills@1.5.23 IGNORES that `@<ref>` suffix and
 * always serves the repository's DEFAULT BRANCH — measured three ways on
 * 2026-08-31 (a feature-branch head, a bare SHA, and the tag `v5.260712.1`,
 * whose tree carries `pm`/`wizard` and no `quick`, all returned `main`'s 22
 * names including `quick`). A local path source IS resolved correctly, and the
 * signed tarball's own `$GENIE_HOME/skills/` is the only tree genuinely pinned
 * to the running binary — so it is what the CLI is pointed at. `ref` in the
 * record stays the running binary's release tag: it names the delivered
 * VERSION, which is exactly what doctor's freshness check compares.
 *
 * The pinned CLI has no `--json` mode, so its stdout is never parsed for state.
 * What genie needs later — freshness (doctor), writer suppression (agent-sync),
 * and deterministic removal (uninstall) — comes from a record genie writes
 * itself at `<GENIE_HOME>/skills-install.json`, and only after a zero exit.
 * That record must name every directory the CLI actually wrote: on the
 * 2026-08-30 dogfood host the CLI wrote 57 agent homes while genie recorded the
 * four-row `KNOWN_AGENT_SKILL_HOMES` table, so a record-driven `genie uninstall`
 * would have orphaned the other 53 homes. `agentDirs` is therefore a bounded
 * post-install discovery scan of `$HOME` unioned with that table (decision 3),
 * and a pre-install collision snapshot backs up every foreign same-named skill
 * directory `--copy` is about to overwrite (decision 5).
 *
 * Failure policy: a failed skills install NEVER rolls back the promoted binary.
 * The convergence helper prints the exact remedy command, sets `exitCode = 1`,
 * and returns — it does not throw, so an install/update that already swapped
 * bytes stays committed and retryable.
 */

import { type Hash, createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { fsyncPath } from './atomic-fs.js';
import { resolveGenieHome } from './genie-home.js';
import {
  type CommandResult,
  type CommandRunner,
  type IntegrationSelection,
  runBoundedIntegrationCommand,
} from './runtime-integrations.js';

/** Pinned skills CLI. Bumping it is an ordinary dependency PR (wish decision 1). */
export const SKILLS_CLI_VERSION = '1.5.23';

/**
 * The delivered skills tree, relative to GENIE_HOME — the install source.
 *
 * A delivered `$GENIE_HOME` holds TWO physical skill trees (`build-binary.sh`
 * stages `plugins/` and `skills/` side by side, so `plugins/genie/skills/` is a
 * byte-identical committed mirror). The root is pinned EXPLICITLY to
 * `<GENIE_HOME>/skills` so the CLI can never see a two-root tree whose
 * discovery behaviour nobody has specified.
 */
export const SKILLS_SOURCE_DIR_NAME = 'skills';

/** The pinned local install source for a given GENIE_HOME. */
export function skillsSourceRoot(genieHome: string): string {
  return join(genieHome, SKILLS_SOURCE_DIR_NAME);
}

/** Record file name, resolved under GENIE_HOME. */
export const SKILLS_INSTALL_RECORD_NAME = 'skills-install.json';

/**
 * npm download + 22 skills across every detected agent home is well inside a
 * minute on a warm cache and can take a few on a cold one. 5 minutes is the
 * ceiling `runBoundedIntegrationCommand` accepts.
 */
const SKILLS_INSTALL_TIMEOUT_MS = 300_000;
const SKILLS_INSTALL_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/**
 * Genie-owned table of global agent skill homes, relative to the user's home.
 * The skills CLI discovers agents itself; this table exists so genie can record
 * WHERE the install landed without parsing CLI stdout, and so `uninstall` and
 * `doctor` share one definition of "an agent skill home".
 *
 * Entries are candidates: only those that exist after a successful install are
 * recorded, so a host without goose/windsurf records nothing for them.
 *
 * `.codex/skills` and `.cursor/skills` are deliberately NOT in this table.
 * Empirically verified against skills.sh 1.5.23 (`--all --copy -g`): that CLI
 * never creates either directory. Codex reads the shared `~/.agents/skills`
 * home — the `agents` row below IS the Codex home. Listing `.codex/skills`
 * here made doctor report a permanent false `skills: codex 0/n` warning on
 * every Codex host.
 */
export interface AgentSkillHomeSpec {
  readonly agent: string;
  readonly segments: readonly string[];
}

export const KNOWN_AGENT_SKILL_HOMES: readonly AgentSkillHomeSpec[] = [
  { agent: 'claude', segments: ['.claude', 'skills'] },
  // `agents` is also the Codex skill home; skills.sh creates no `.codex/skills`.
  { agent: 'agents', segments: ['.agents', 'skills'] },
  { agent: 'goose', segments: ['.config', 'goose', 'skills'] },
  { agent: 'windsurf', segments: ['.codeium', 'windsurf', 'skills'] },
];

export interface AgentSkillHome {
  agent: string;
  dir: string;
}

/** Absolute candidate skill homes for `home`, in table order. */
export function agentSkillHomes(home: string = homedir()): AgentSkillHome[] {
  return KNOWN_AGENT_SKILL_HOMES.map((entry) => ({ agent: entry.agent, dir: join(home, ...entry.segments) }));
}

/** The subset of `agentSkillHomes` that exists as a directory right now. */
export function existingAgentSkillHomes(home: string = homedir()): AgentSkillHome[] {
  return agentSkillHomes(home).filter((candidate) => isDirectory(candidate.dir));
}

/**
 * Skill directory names are used as path segments during uninstall, so the
 * record only accepts names that cannot traverse: no separators, no leading
 * dot, no `.`/`..`.
 */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The single traversal guard for recorded skill names. Every consumer that
 * joins a recorded name onto an agent dir (the installer's inventory scan and
 * `genie uninstall`'s record-driven removal) MUST route through this, so the
 * two can never drift apart.
 */
export function isSafeSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/** Absolute and free of `.`/`..` segments, so it can never climb out of itself. */
function isTraversalFreeAbsolutePath(value: string): boolean {
  if (!isAbsolute(value)) return false;
  return !value.split(sep).some((segment) => segment === '.' || segment === '..');
}

/** One foreign skill directory the install was about to overwrite. */
const skillsCollisionSchema = z.object({
  dir: z.string().refine(isTraversalFreeAbsolutePath, 'collision dir must be a traversal-free absolute path'),
  skill: z.string().regex(SKILL_NAME_PATTERN),
});

const skillsInstallRecordSchema = z.object({
  /** Release tag actually installed, e.g. `v5.260830.16`. */
  ref: z.string().min(1),
  /**
   * What the CLI was pointed at, e.g. `local:/home/u/.genie/skills`.
   *
   * OPTIONAL, and that is load-bearing (wish `skills-everywhere-b`, decision
   * 2): `readSkillsInstallRecord` returns `null` for a schema-invalid record,
   * so a REQUIRED new field would invalidate every 5.260830.x record on disk —
   * turning doctor into `(unrecorded)` and `genie uninstall` into a silent
   * no-op over the directories those records still authorize.
   */
  source: z.string().min(1).optional(),
  cliVersion: z.string().min(1),
  inventory: z.array(z.string().regex(SKILL_NAME_PATTERN)),
  /**
   * Recorded agent skill homes. The schema cannot check membership in
   * `agentSkillHomes(home)`: the record carries no home of its own, and the
   * running HOME at READ time is not necessarily the HOME that wrote it (a
   * different user, a relocated home, or the injected `home` seam in tests) —
   * a membership check here would reject legitimate records and, worse, is
   * validated on WRITE too, where it would break the installer's own `home`
   * override. So the schema enforces the traversal-proof floor (absolute, no
   * `.`/`..` segments) and the shape check that actually matters at the point
   * of use lives in the consumer: `removeSkillsChannelInstall` only deletes a
   * real directory it recorded, under a name `isSafeSkillName` accepts.
   */
  agentDirs: z.array(
    z.string().refine(isTraversalFreeAbsolutePath, 'agent dir must be a traversal-free absolute path'),
  ),
  /**
   * Content digest of every `<agentDir>/<skill name>` directory the install
   * actually wrote, keyed by that absolute path — the proof `genie uninstall`
   * recomputes before deleting. Optional so records written by 5.260830.x
   * (before digests existed) still read; those legacy records never authorize
   * a deletion, uninstall preserves and reports their directories instead.
   */
  dirDigests: z
    .record(
      z.string().refine(isTraversalFreeAbsolutePath, 'digest key must be a traversal-free absolute path'),
      z.string().regex(/^[0-9a-f]{64}$/, 'digest must be a lowercase sha256 hex string'),
    )
    .optional(),
  /**
   * Foreign same-named skill directories this install overwrote, snapshotted
   * and backed up first. Optional for the same decision-2 reason as `source`.
   */
  collisions: z.array(skillsCollisionSchema).optional(),
  installedAt: z.string().min(1),
});

export type SkillsInstallRecord = z.infer<typeof skillsInstallRecordSchema>;

export function skillsInstallRecordPath(genieHome: string = resolveGenieHome()): string {
  return join(genieHome, SKILLS_INSTALL_RECORD_NAME);
}

/**
 * `null` for absent, unreadable, non-JSON, or schema-invalid records — and for
 * anything at that path that is not a PHYSICAL regular file. A symlink there is
 * an attacker-supplied redirect into a file genie would then treat as an
 * uninstall manifest, so it is rejected the same way
 * `readIntegrationConsentState` rejects one (rejected as absent rather than
 * thrown: this reader's whole contract is "never throw").
 */
export function readSkillsInstallRecord(genieHome: string = resolveGenieHome()): SkillsInstallRecord | null {
  const path = skillsInstallRecordPath(genieHome);
  let raw: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = skillsInstallRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Atomic, 0600, fsynced — same convention as the integration consent record.
 *
 * Deliberately a CLOBBERING publish, so `publishRegularFileNoClobber` does not
 * fit: every install and update rewrites this record in place, and a no-clobber
 * publish would fail against the previous release's record. Crash-safety comes
 * from staging + file fsync + rename + a directory-metadata flush instead, and
 * the staging file is unlinked on every failure path so a throw (a full disk, a
 * read-only home) cannot leave `skills-install.json.staging-<pid>` behind.
 */
export function writeSkillsInstallRecord(genieHome: string, record: SkillsInstallRecord): void {
  const validated = skillsInstallRecordSchema.parse(record);
  const target = skillsInstallRecordPath(genieHome);
  // GENIE_HOME may not exist yet on a very early install; 0o700 so a permissive
  // umask cannot leave it group-writable (the install promoter rejects that).
  mkdirSync(genieHome, { recursive: true, mode: 0o700 });
  const staging = `${target}.staging-${process.pid}`;
  let published = false;
  try {
    writeFileSync(staging, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fsyncPath(staging);
    renameSync(staging, target);
    published = true;
  } finally {
    if (!published) {
      try {
        unlinkSync(staging);
      } catch {
        // Nothing to clean up (the staging write itself failed), or the home is
        // unwritable — either way the original error is the one worth raising.
      }
    }
  }
  // Durable directory entry: without this flush the rename can be lost on a
  // crash even though the bytes were fsynced. Best-effort inside `fsyncPath`.
  fsyncPath(genieHome);
}

/** Best-effort record removal; `true` when a record was present and is now gone. */
export function deleteSkillsInstallRecord(genieHome: string): boolean {
  try {
    unlinkSync(skillsInstallRecordPath(genieHome));
    return true;
  } catch {
    return false;
  }
}

/**
 * Top-level `<root>/<name>/SKILL.md` directory names, sorted. Nested SKILL.md
 * files are deliberately ignored: the release inventory is exactly the set of
 * top-level skill directories the skills CLI publishes.
 */
export function inventoryFromSkillsDir(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!SKILL_NAME_PATTERN.test(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!isDirectory(join(root, entry.name))) continue;
    if (!existsSync(join(root, entry.name, 'SKILL.md'))) continue;
    names.push(entry.name);
  }
  return names.sort();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Domain separator so a skill-dir digest can never collide with — or be
 * substituted by — any other genie digest scheme.
 */
const SKILL_DIR_DIGEST_DOMAIN = 'genie-skill-dir-v1';

type SkillDirEntryKind = 'directory' | 'file' | 'symlink' | 'other';

interface SkillDirEntry {
  rel: string;
  kind: SkillDirEntryKind;
  /** File bytes, or the raw symlink target; empty for directories/other kinds. */
  payload: Buffer;
}

function collectSkillDirEntries(root: string, current: string, out: SkillDirEntry[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    const kind: SkillDirEntryKind = entry.isSymbolicLink()
      ? 'symlink'
      : entry.isDirectory()
        ? 'directory'
        : entry.isFile()
          ? 'file'
          : 'other';
    out.push({
      rel: relative(root, absolute).split(sep).join('/'),
      kind,
      payload:
        kind === 'file'
          ? readFileSync(absolute)
          : kind === 'symlink'
            ? Buffer.from(readlinkSync(absolute))
            : Buffer.alloc(0),
    });
    // Only real directories recurse: a symlink is hashed by its target path,
    // never followed (the same fail-closed rule as every other genie digest).
    if (kind === 'directory') collectSkillDirEntries(root, absolute, out);
  }
}

function updateSkillDirDigestField(digest: Hash, value: Buffer): void {
  digest.update(`${value.length}:`);
  digest.update(value);
  digest.update('\0');
}

/**
 * Content digest of one installed `<agentDir>/<skill>` directory: a SHA-256
 * over a deterministic walk (sorted relative paths; exact file bytes; symlink
 * targets as read). `null` for anything unreadable or not a physical directory
 * — callers must treat `null` as "unverified" and never delete unverified dirs.
 */
export function computeSkillDirDigest(dir: string): string | null {
  let rootStat: Stats;
  try {
    rootStat = lstatSync(dir);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const entries: SkillDirEntry[] = [];
  try {
    collectSkillDirEntries(dir, dir, entries);
  } catch {
    return null;
  }
  entries.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  const digest = createHash('sha256');
  updateSkillDirDigestField(digest, Buffer.from(SKILL_DIR_DIGEST_DOMAIN));
  for (const entry of entries) {
    updateSkillDirDigestField(digest, Buffer.from(entry.rel));
    updateSkillDirDigestField(digest, Buffer.from(entry.kind));
    updateSkillDirDigestField(digest, entry.payload);
  }
  return digest.digest('hex');
}

// ============================================================================
// Discovery scan — what the CLI ACTUALLY wrote (wish `skills-everywhere-b`, G1)
// ============================================================================

/**
 * Directory names the `$HOME` walk never descends into. Package caches hold
 * thousands of vendored `skills` directories that no agent ever reads, and
 * `.git` can hold a checked-out one; none of them is an agent skill home.
 *
 * `state-backups` is genie's own backup-root name (the convention `legacy-v4.ts`
 * established and the collision snapshot below reuses). Nothing under it is a
 * live agent home, and a recorded path under it would let `genie uninstall`
 * delete the very copy the snapshot took — so the walk never enters it.
 */
const SKILLS_SCAN_PRUNED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.cache',
  '.npm',
  '.git',
  'state-backups',
]);

/** `~/.config/goose/skills` is depth 3; the deepest known home is shallower still. */
const SKILLS_SCAN_MAX_DEPTH = 6;
/**
 * DIRECTORIES the walk may consider before it gives up and reports `capped`.
 *
 * The cost this bounds is one `readdirSync` per directory, so plain files must
 * NOT count toward it. Counting every directory entry (the first cut of this
 * scan) made the cap fire on any ordinary developer `$HOME`: a real host
 * measured 112,885 entries under the same depth/prune rules — 2.3x a 50,000
 * entry cap — so the scan reported `capped`, `agentDirs` silently fell back to
 * the four-row known-home table, and the honest-N defect this group exists to
 * fix survived in production. The same walk on that host opens far fewer
 * directories and finishes in ~340 ms, i.e. 3% of the wall-clock budget below,
 * which is the bound actually meant to bind. This ceiling is the runaway-walk
 * backstop, not the working limit.
 */
const SKILLS_SCAN_MAX_DIRS = 200_000;
/** Wall-clock ceiling for one walk. */
const SKILLS_SCAN_BUDGET_MS = 10_000;

/**
 * Filesystem timestamp granularity is 1 s on some filesystems (HFS+, a few NFS
 * servers), so a file written microseconds AFTER the captured start can carry
 * an mtime a fraction of a second BEFORE it. The window opens this much early
 * rather than dropping a home the install genuinely wrote.
 */
const SKILLS_SCAN_CLOCK_TOLERANCE_MS = 1_000;

/** A `SKILL.md` larger than this is not one of ours; comparing it is pointless. */
const SKILLS_PROBE_MAX_BYTES = 1024 * 1024;

export type SkillsHomeScanStatus = 'ok' | 'capped' | 'failed';

export interface SkillsHomeScanResult {
  status: SkillsHomeScanStatus;
  /** Absolute directories named `skills`, sorted. Empty unless `status` is `ok`. */
  dirs: string[];
  /** Why the scan was abandoned; absent when `status` is `ok`. */
  reason?: string;
}

export interface SkillsHomeScanOptions {
  /** The user home to walk. */
  home: string;
  /** The delivered source tree — pruned, because it is never an agent home. */
  sourceRoot: string;
  /**
   * Genie's own state root — pruned whole, because nothing genie delivers or
   * backs up under it is an agent skill home. A delivered `$GENIE_HOME` holds
   * TWO physical skill trees (`build-binary.sh` stages `plugins/` beside
   * `skills/`, so `plugins/genie/skills/` is a byte-identical committed
   * mirror); the mirror is byte-equal to the source and carries the tarball's
   * own extraction stamp, so without this prune it can be selected as a home
   * this install "wrote" — inflating the honest N and putting a path inside
   * `$GENIE_HOME` into the uninstall manifest.
   */
  genieHome?: string;
  maxDepth?: number;
  /** Ceiling on DIRECTORIES considered, not on directory entries. */
  maxDirs?: number;
  budgetMs?: number;
  /** Injectable millisecond clock for the wall-clock cap. */
  nowMs?: () => number;
}

interface ScanFrame {
  dir: string;
  depth: number;
}

/** True for `root` itself and anything beneath it; both paths must be resolved. */
function isAtOrUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * What the walk does with one directory entry.
 *
 * `Dirent.isDirectory()` is lstat-shaped: a symlink answers false here, so a
 * link pointing anywhere — inside `$HOME` or out of it — is never followed and
 * never recorded.
 */
function classifyScanChild(
  child: Dirent,
  absolute: string,
  pruned: { sourceRoot: string; genieHome: string | null },
): 'skip' | 'home' | 'descend' {
  if (!child.isDirectory()) return 'skip';
  if (SKILLS_SCAN_PRUNED_DIR_NAMES.has(child.name)) return 'skip';
  const resolved = resolve(absolute);
  if (isAtOrUnder(resolved, pruned.sourceRoot)) return 'skip';
  if (pruned.genieHome !== null && isAtOrUnder(resolved, pruned.genieHome)) return 'skip';
  if (!isTraversalFreeAbsolutePath(absolute)) return 'skip';
  // A skill home is a leaf for this walk: its children are skills.
  return child.name === SKILLS_SOURCE_DIR_NAME ? 'home' : 'descend';
}

/**
 * Every physical directory named `skills` at depth ≤ `maxDepth` below `home`.
 *
 * A FIXED candidate table cannot track a self-discovering CLI whose registry
 * names 77 agents and which wrote 57 homes on one measured host, so the record
 * is built from what is on disk instead. Bounded by construction: directory
 * cap, wall-clock cap, depth cap, and `readdir`-with-`Dirent` traversal that
 * treats a symlink as a leaf — so the walk can never be led out of `$HOME`, and
 * an unreadable directory is skipped rather than fatal.
 *
 * The caps count DIRECTORIES, never plain files: an ordinary developer `$HOME`
 * carries six figures of files under these prune rules, and counting them made
 * the scan cap out — and silently fall back to the four-row known-home table —
 * on exactly the hosts this scan exists for.
 *
 * Never throws. A cap or an unexpected failure returns NO directories: the
 * caller falls back to the known-home floor, which can only ever record fewer
 * directories than the truth, never a directory that is not genie's.
 */
export function scanSkillsHomes(options: SkillsHomeScanOptions): SkillsHomeScanResult {
  const maxDepth = options.maxDepth ?? SKILLS_SCAN_MAX_DEPTH;
  const maxDirs = options.maxDirs ?? SKILLS_SCAN_MAX_DIRS;
  const budgetMs = options.budgetMs ?? SKILLS_SCAN_BUDGET_MS;
  const nowMs = options.nowMs ?? (() => Date.now());
  const deadline = nowMs() + budgetMs;
  const pruned = {
    sourceRoot: resolve(options.sourceRoot),
    genieHome: options.genieHome === undefined ? null : resolve(options.genieHome),
  };
  const found: string[] = [];
  const stack: ScanFrame[] = [{ dir: options.home, depth: 0 }];
  // The home itself is the first directory opened.
  let dirs = 1;
  try {
    while (stack.length > 0) {
      const frame = stack.pop() as ScanFrame;
      if (nowMs() > deadline) {
        return { status: 'capped', dirs: [], reason: `time budget of ${budgetMs} ms exhausted` };
      }
      let children: Dirent[];
      try {
        children = readdirSync(frame.dir, { withFileTypes: true });
      } catch {
        // An unreadable directory (permissions, a race) is not a scan failure.
        continue;
      }
      for (const child of children) {
        const absolute = join(frame.dir, child.name);
        const verdict = classifyScanChild(child, absolute, pruned);
        // Files, symlinks and pruned trees cost nothing and are not counted.
        if (verdict === 'skip') continue;
        dirs += 1;
        if (dirs > maxDirs) {
          return { status: 'capped', dirs: [], reason: `directory cap of ${maxDirs} exhausted` };
        }
        if (verdict === 'home') found.push(absolute);
        else if (frame.depth + 1 < maxDepth) stack.push({ dir: absolute, depth: frame.depth + 1 });
      }
    }
  } catch (error) {
    return { status: 'failed', dirs: [], reason: errorMessage(error) };
  }
  return { status: 'ok', dirs: found.sort() };
}

/** Physical-regular-file bytes, or `null` for anything else. */
function readProbeFile(path: string): Buffer | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > SKILLS_PROBE_MAX_BYTES) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * The freshness stamp of one path: the LATER of birth time and modification
 * time.
 *
 * The wish specifies "birthtime, falling back to mtime". Taking the later of
 * the two is that rule plus the one case it misses: `--copy` rewrites an
 * ALREADY EXISTING `SKILL.md` in place, which leaves the inode's birth time at
 * the previous release's install. Every home written by this run therefore has
 * a fresh mtime even when its birth time is old, and a stale foreign home has
 * neither.
 */
function freshnessStampMs(path: string): number | null {
  try {
    const stat = lstatSync(path);
    return Math.max(Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : 0, stat.mtimeMs);
  } catch {
    return null;
  }
}

export interface SkillsHomeSelectionOptions {
  /** Candidate directories, typically `scanSkillsHomes().dirs`. */
  dirs: readonly string[];
  /** The delivered source tree the install was pointed at. */
  sourceRoot: string;
  /** The inventory entry used as the byte-equality probe (`inventory[0]`). */
  probe: string;
  /** Epoch ms captured immediately before the CLI was spawned. */
  since: number;
  toleranceMs?: number;
}

/**
 * The candidates this install actually wrote: a directory qualifies iff its
 * `<probe>/SKILL.md` is byte-equal to the delivered tree's AND either that file
 * or the directory itself carries a timestamp inside the install window.
 *
 * Byte-equality alone would adopt a home some other tool populated from the
 * same public tree; the window alone would adopt any `skills` directory the
 * user happened to touch. Both together is what makes the recorded set
 * `genie uninstall` deletes from provably this install's own work.
 */
export function selectSkillsHomesWrittenBy(options: SkillsHomeSelectionOptions): string[] {
  const expected = readProbeFile(join(options.sourceRoot, options.probe, 'SKILL.md'));
  if (expected === null) return [];
  const floor = options.since - (options.toleranceMs ?? SKILLS_SCAN_CLOCK_TOLERANCE_MS);
  const selected: string[] = [];
  for (const dir of options.dirs) {
    const probeFile = join(dir, options.probe, 'SKILL.md');
    const actual = readProbeFile(probeFile);
    if (actual === null || !actual.equals(expected)) continue;
    const stamps = [freshnessStampMs(probeFile), freshnessStampMs(dir)].filter(
      (value): value is number => value !== null,
    );
    if (stamps.length === 0) continue;
    if (Math.max(...stamps) < floor) continue;
    selected.push(dir);
  }
  return selected;
}

// ============================================================================
// Collision snapshot — never silently destroy a foreign skill
// ============================================================================

export interface SkillsCollision {
  /** The foreign skill directory `--copy` was about to overwrite. */
  dir: string;
  /** The inventory name it collides with. */
  skill: string;
}

export interface SkillsCollisionSnapshot {
  collisions: SkillsCollision[];
  /** Allocated lazily: `null` when nothing collided. */
  backupRoot: string | null;
  /** Directories that could not be backed up, and were therefore NOT recorded. */
  failures: string[];
}

export interface SkillsCollisionSnapshotOptions {
  /** Candidate skill homes that already exist, absolute. */
  homes: readonly string[];
  inventory: readonly string[];
  /** The delivered source tree the install is about to copy from. */
  sourceRoot: string;
  genieHome: string;
  /** The user home the backup mirrors paths relative to. */
  home: string;
  /** The previous install record, whose digests prove prior genie provenance. */
  previous?: SkillsInstallRecord | null;
  now?: () => Date;
}

function isGenieOwned(target: string, expectedSkillMd: Buffer | null, previous: SkillsInstallRecord | null): boolean {
  const actual = readProbeFile(join(target, 'SKILL.md'));
  if (expectedSkillMd !== null && actual !== null && actual.equals(expectedSkillMd)) return true;
  const recorded = previous?.dirDigests?.[target];
  if (recorded === undefined) return false;
  return computeSkillDirDigest(target) === recorded;
}

/**
 * True for a physical directory at `<home>/<skill>` that is NOT genie's: not
 * byte-equal to the delivered tree and not proven by the previous record's
 * digest. A file or a symlink at that name is not a collision — `--copy` writes
 * directories, so nothing this channel wrote can be either.
 */
function isForeignSkillDir(
  target: string,
  context: { sourceRoot: string; skill: string; previous: SkillsInstallRecord | null },
): boolean {
  if (!isSafeSkillName(context.skill)) return false;
  if (!isTraversalFreeAbsolutePath(target)) return false;
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch {
    return false;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  const expected = readProbeFile(join(context.sourceRoot, context.skill, 'SKILL.md'));
  return !isGenieOwned(target, expected, context.previous);
}

/**
 * Copy every foreign same-named skill directory out of harm's way BEFORE the
 * install overwrites it.
 *
 * `--all` gives no per-home veto, so "refuse for that home" is unimplementable
 * without abandoning the `--all` contract (decisions 4/5): collisions are
 * detected, backed up, recorded and reported — never refused, and never
 * restored (restoration is explicitly out of scope). A directory that cannot be
 * backed up is NOT recorded as handled; it is reported as a failure instead, so
 * the operator line can never claim a backup that does not exist.
 *
 * Never throws.
 */
export function snapshotSkillsCollisions(options: SkillsCollisionSnapshotOptions): SkillsCollisionSnapshot {
  const now = options.now ?? (() => new Date());
  const previous = options.previous ?? null;
  const collisions: SkillsCollision[] = [];
  const failures: string[] = [];
  let backupRoot: string | null = null;
  for (const home of options.homes) {
    for (const skill of options.inventory) {
      const target = join(home, skill);
      if (!isForeignSkillDir(target, { sourceRoot: options.sourceRoot, skill, previous })) continue;
      const mirrored = relative(options.home, target);
      if (mirrored === '' || mirrored.startsWith('..') || isAbsolute(mirrored)) {
        failures.push(`${target}: outside ${options.home}; not backed up`);
        continue;
      }
      backupRoot ??= join(
        options.genieHome,
        'state-backups',
        `skills-collision-${now().toISOString().replace(/[:.]/g, '-')}`,
      );
      try {
        const destination = join(backupRoot, mirrored);
        // Owner-only: the backup root lives under GENIE_HOME/state-backups and
        // may carry a foreign operator's skill content.
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        cpSync(target, destination, { recursive: true });
      } catch (error) {
        failures.push(`${target}: ${errorMessage(error)}`);
        continue;
      }
      collisions.push({ dir: target, skill });
    }
  }
  return { collisions, backupRoot, failures };
}

/** `5.260830.16` and `v5.260830.16` both normalize to the `v`-prefixed tag. */
export function releaseTag(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * The production argv, verbatim. No extra `-y`: `--all` already expands to
 * `--skill '*' --agent '*' -y` inside the pinned CLI.
 *
 * `sourceRoot` is an absolute LOCAL path — never a `<repo>@<ref>` GitHub
 * source, which the pinned CLI silently resolves to the default branch (see the
 * module header).
 */
export function buildSkillsAddArgv(options: { sourceRoot: string }): string[] {
  return ['npx', '-y', `skills@${SKILLS_CLI_VERSION}`, 'add', options.sourceRoot, '--all', '--copy', '-g'];
}

/** The operator-facing remedy line for any skills-channel failure. */
export function skillsInstallRemedy(sourceRoot: string): string {
  return `Run: ${buildSkillsAddArgv({ sourceRoot }).join(' ')}`;
}

export type ExecutableProbe = (name: string) => string | null;

export type NodePreflight = { ok: true } | { ok: false; reason: string };

/**
 * The skills CLI is a node package run through `npx`; both must be on PATH.
 * Probing before spawning turns "command not found" noise into one actionable
 * reason.
 */
export function preflightNode(deps: { which?: ExecutableProbe } = {}): NodePreflight {
  const which = deps.which ?? ((name: string) => Bun.which(name));
  const missing = ['node', 'npx'].filter((name) => which(name) === null);
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `${missing.join(' and ')} not found on PATH (the skills CLI runs on Node)`,
  };
}

export interface SkillsInstallOptions {
  /** Running binary version; normalized to a `v`-prefixed release tag. */
  version: string;
  genieHome: string;
  /** Injected command runner; defaults to the bounded integration runner. */
  spawn?: CommandRunner;
  which?: ExecutableProbe;
  /** Override the delivered skills tree (defaults to `<genieHome>/skills`). */
  skillsRoot?: string;
  /** Override the user home used to resolve agent skill homes. */
  home?: string;
  now?: () => Date;
  /** Injectable millisecond clock for the discovery window and the scan caps. */
  nowMs?: () => number;
  /** Scan bounds, for tests that need a small fixture budget. */
  scan?: Pick<SkillsHomeScanOptions, 'maxDepth' | 'maxDirs' | 'budgetMs'>;
}

/**
 * `warnings` rides BOTH variants on purpose: the collision snapshot runs before
 * the spawn, so a foreign skill directory can be copied into
 * `<GENIE_HOME>/state-backups/…` and the install then fail. Dropping the
 * warnings on the failure path would leave that backup — possibly taken after
 * the CLI already overwrote the live path — entirely unreported.
 */
export type SkillsInstallOutcome =
  | { ok: true; record: SkillsInstallRecord; warnings?: string[] }
  | { ok: false; reason: string; remedy: string; warnings?: string[] };

/**
 * Every agent skill home this install can prove it wrote, unioned with the
 * known-home floor so the record can never shrink below the previous
 * behaviour (decision 3). Sorted floor-first, then the scanned remainder.
 */
function resolveAgentDirs(options: {
  home: string;
  genieHome: string;
  sourceRoot: string;
  probe: string;
  since: number;
  nowMs: () => number;
  scan?: Pick<SkillsHomeScanOptions, 'maxDepth' | 'maxDirs' | 'budgetMs'>;
}): { dirs: string[]; warnings: string[] } {
  const floor = existingAgentSkillHomes(options.home).map((entry) => entry.dir);
  const warnings: string[] = [];
  const scan = scanSkillsHomes({
    home: options.home,
    sourceRoot: options.sourceRoot,
    genieHome: options.genieHome,
    nowMs: options.nowMs,
    ...options.scan,
  });
  let discovered: string[] = [];
  if (scan.status === 'ok') {
    discovered = selectSkillsHomesWrittenBy({
      dirs: scan.dirs,
      sourceRoot: options.sourceRoot,
      probe: options.probe,
      since: options.since,
    });
  } else {
    // Never fail the install for a scan: fall back to the union floor, loudly.
    warnings.push(`skills: scan ${scan.status} (${scan.reason ?? 'no reason given'}); recorded the known homes only`);
  }
  const dirs: string[] = [];
  for (const dir of [...floor, ...discovered]) {
    if (!isTraversalFreeAbsolutePath(dir)) continue;
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return { dirs, warnings };
}

/**
 * Preflight → collision snapshot → spawn the pinned CLI → (only on a zero exit)
 * discovery scan and record.
 * Never throws: every failure is a returned reason plus the remedy command.
 */
export function runSkillsInstall(options: SkillsInstallOptions): SkillsInstallOutcome {
  const skillsRoot = options.skillsRoot ?? skillsSourceRoot(options.genieHome);
  const remedy = skillsInstallRemedy(skillsRoot);
  if (options.version.trim() === '') {
    return { ok: false, reason: 'running binary version is unknown', remedy };
  }
  const preflight = preflightNode({ which: options.which });
  if (!preflight.ok) return { ok: false, reason: preflight.reason, remedy };

  const home = options.home ?? homedir();
  const nowMs = options.nowMs ?? (() => Date.now());
  const warnings: string[] = [];
  // The inventory is read BEFORE the spawn because the collision snapshot needs
  // the names the install is about to write. The delivered tree is genie's own
  // and the CLI only reads it, so the value is still the one recorded below.
  const inventory = inventoryFromSkillsDir(skillsRoot);

  const snapshot = snapshotCollisionsSafely({ ...options, home, skillsRoot, inventory, warnings });

  const argv = buildSkillsAddArgv({ sourceRoot: skillsRoot });
  const run = options.spawn ?? runBoundedIntegrationCommand;
  // Captured immediately before the spawn: the discovery window opens here.
  const startedAtMs = nowMs();
  let result: CommandResult;
  try {
    result = run(argv[0], argv.slice(1), {
      timeoutMs: SKILLS_INSTALL_TIMEOUT_MS,
      maxOutputBytes: SKILLS_INSTALL_OUTPUT_LIMIT_BYTES,
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), remedy, warnings };
  }
  if (result.exitCode !== 0) return { ok: false, reason: describeFailure(result), remedy, warnings };

  // A zero exit with nothing to record is not a success: the delivered tree is
  // what doctor's freshness check, agent-sync's writer suppression, and
  // uninstall's removal all read back. Recording an empty inventory would make
  // uninstall a silent no-op over skills that are actually on disk.
  if (inventory.length === 0) return { ok: false, reason: `no skills found under ${skillsRoot}`, remedy, warnings };

  const agents = resolveAgentDirs({
    home,
    genieHome: options.genieHome,
    sourceRoot: skillsRoot,
    probe: inventory[0] as string,
    since: startedAtMs,
    nowMs,
    scan: options.scan,
  });
  warnings.push(...agents.warnings);
  // Digest every directory the CLI actually wrote, so `genie uninstall` can
  // later prove a directory is still genie's byte-identical install before it
  // deletes it. A combination that did not land (or cannot be read) records no
  // digest: uninstall then preserves that directory instead of deleting it.
  const dirDigests: Record<string, string> = {};
  for (const agentDir of agents.dirs) {
    for (const name of inventory) {
      const target = join(agentDir, name);
      const digest = computeSkillDirDigest(target);
      if (digest !== null) dirDigests[target] = digest;
    }
  }
  const record: SkillsInstallRecord = {
    ref: releaseTag(options.version),
    source: `local:${skillsRoot}`,
    cliVersion: SKILLS_CLI_VERSION,
    inventory,
    agentDirs: agents.dirs,
    dirDigests,
    ...(snapshot.collisions.length > 0 ? { collisions: snapshot.collisions } : {}),
    installedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  try {
    writeSkillsInstallRecord(options.genieHome, record);
  } catch (error) {
    return { ok: false, reason: `could not record the install: ${errorMessage(error)}`, remedy, warnings };
  }
  return { ok: true, record, warnings };
}

/**
 * The pre-install snapshot, wrapped so no filesystem surprise inside it can
 * fail an install (decision 5: detect, back up, record, report — never refuse).
 */
function snapshotCollisionsSafely(context: {
  home: string;
  genieHome: string;
  skillsRoot: string;
  inventory: string[];
  warnings: string[];
  now?: () => Date;
}): SkillsCollisionSnapshot {
  const empty: SkillsCollisionSnapshot = { collisions: [], backupRoot: null, failures: [] };
  if (context.inventory.length === 0) return empty;
  let snapshot: SkillsCollisionSnapshot;
  try {
    const preScan = scanSkillsHomes({
      home: context.home,
      sourceRoot: context.skillsRoot,
      genieHome: context.genieHome,
    });
    const homes: string[] = [];
    for (const dir of [...existingAgentSkillHomes(context.home).map((entry) => entry.dir), ...preScan.dirs]) {
      if (!homes.includes(dir)) homes.push(dir);
    }
    snapshot = snapshotSkillsCollisions({
      homes,
      inventory: context.inventory,
      sourceRoot: context.skillsRoot,
      genieHome: context.genieHome,
      home: context.home,
      previous: readSkillsInstallRecord(context.genieHome),
      now: context.now,
    });
  } catch (error) {
    context.warnings.push(`skills: collision snapshot failed (${errorMessage(error)}); no foreign skill was backed up`);
    return empty;
  }
  for (const collision of snapshot.collisions) {
    context.warnings.push(
      `skills: collision: ${collision.dir} (${collision.skill}) — backed up to ${snapshot.backupRoot ?? '(none)'}`,
    );
  }
  for (const failure of snapshot.failures) {
    context.warnings.push(`skills: collision not backed up: ${failure}`);
  }
  return snapshot;
}

/**
 * The diagnosis line. stderr is where the CLI puts its failure, so its last
 * non-empty line wins whenever stderr has one; stdout is only consulted when
 * stderr is silent. Concatenating the two (the previous behaviour) let a
 * trailing progress line on stdout mask the actual error.
 */
function describeFailure(result: CommandResult): string {
  if (result.timedOut) return `skills CLI timed out after ${SKILLS_INSTALL_TIMEOUT_MS} ms`;
  const tail = lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout);
  return tail === undefined ? `skills CLI exited ${result.exitCode}` : `skills CLI exited ${result.exitCode}: ${tail}`;
}

function lastNonEmptyLine(stream: string): string | undefined {
  const lines = stream
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.at(-1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type SkillsChannelConvergenceResult =
  | { status: 'skipped'; reason: string }
  | { status: 'installed'; record: SkillsInstallRecord }
  | { status: 'failed'; reason: string };

export interface SkillsChannelConvergenceOptions extends Omit<SkillsInstallOptions, 'genieHome'> {
  /** Persisted integration consent: `none` skips the channel entirely. */
  selection: IntegrationSelection;
  genieHome: string;
  log?: (line: string) => void;
  /** Injected installer for command-level wiring tests. */
  install?: (options: SkillsInstallOptions) => SkillsInstallOutcome;
}

/**
 * The single skills-channel step both command seams call.
 *
 * Consent `none` skips it; every other selection installs to ALL detected
 * agents (wish `skills-everywhere` decision 3 — an explicit widening of the
 * install-consent contract for skills only, because skills.sh already installs
 * per-agent and a consent-narrowed `-a <agents>` argv is the documented
 * fallback if that is ever contested).
 */
export function runSkillsChannelConvergence(options: SkillsChannelConvergenceOptions): SkillsChannelConvergenceResult {
  const emit = options.log ?? defaultLog;
  if (options.selection === 'none') {
    emit('skills: skipped (consent: none)');
    return { status: 'skipped', reason: 'consent: none' };
  }
  const outcome = (options.install ?? runSkillsInstall)(options);
  if (!outcome.ok) {
    emit(`Skills install failed: ${outcome.reason}. ${outcome.remedy}`);
    // The pre-spawn collision snapshot may already have backed a foreign skill
    // directory up; a failed install must still say where those bytes went.
    for (const warning of outcome.warnings ?? []) emit(warning);
    // Deliberately non-fatal: the promoted binary is never rolled back for a
    // skills-channel failure. Exit code only.
    process.exitCode = 1;
    return { status: 'failed', reason: outcome.reason };
  }
  const { record } = outcome;
  // `agentDirs.length` is the SCANNED count, not the size of a fixed table: the
  // number the operator reads is the number `genie uninstall` will act on.
  emit(
    `skills: installed ${record.inventory.length} skill(s) from ${record.source ?? record.ref} into ${record.agentDirs.length} agent dir(s)`,
  );
  for (const warning of outcome.warnings ?? []) emit(warning);
  return { status: 'installed', record };
}

function defaultLog(line: string): void {
  console.log(line);
}
