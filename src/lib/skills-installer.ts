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
 * What genie needs later — freshness (doctor),
 * and deterministic removal (uninstall) — comes from a record genie writes
 * itself at `<GENIE_HOME>/skills-install.json`, and only after a zero exit.
 * That record must name every directory the CLI actually wrote: on the
 * 2026-08-30 dogfood host the CLI wrote 57 agent homes while genie recorded the
 * four-row `KNOWN_AGENT_SKILL_HOMES` table, so a record-driven `genie uninstall`
 * would have orphaned the other 53 homes. `agentDirs` is therefore a bounded
 * post-install discovery scan of `$HOME` unioned with that table (decision 3),
 * and a pre-install collision snapshot backs up every foreign same-named skill
 * directory `--copy` is about to overwrite, in every home genie can name before
 * the spawn (decision 5).
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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { atomicRenameDirectoryNoClobber, fsyncParentDir, fsyncPath } from './atomic-fs.js';
import { resolveGenieHome } from './genie-home.js';
import {
  type CommandResult,
  type CommandRunner,
  type IntegrationSelection,
  runBoundedIntegrationCommand,
} from './runtime-integrations.js';

/**
 * Pinned skills CLI. Bumping it is an ordinary dependency PR (wish decision 1),
 * but never a blind one: `KNOWN_AGENT_SKILL_HOMES` below is GENIE-owned, while
 * the set of homes the CLI actually writes and the discovery scan that finds
 * them afterwards are the CLI's. The two drift independently. Bumping this pin
 * therefore requires re-verifying, against what the NEW CLI writes on a real
 * host, both the homes table and the post-install discovery scan — otherwise
 * `genie doctor` compares the recorded `agentDirs` against a set the installer
 * no longer produces and reports a permanent false stale/missing result.
 */
export const SKILLS_CLI_VERSION = '1.5.23';

/**
 * The delivered skills tree, relative to GENIE_HOME — the install source.
 *
 * The root is pinned EXPLICITLY to `<GENIE_HOME>/skills` rather than to
 * `$GENIE_HOME` itself, so the CLI can never see a multi-root tree whose
 * discovery behaviour nobody has specified. (Until the Claude plugin was
 * deleted, a delivered `$GENIE_HOME` really did hold a second byte-identical
 * tree at `plugins/genie/skills/`; the explicit pin is what made that safe and
 * is what keeps any future sibling tree safe.)
 */
export const SKILLS_SOURCE_DIR_NAME = 'skills';

/** The pinned local install source for a given GENIE_HOME. */
export function skillsSourceRoot(genieHome: string): string {
  return join(genieHome, SKILLS_SOURCE_DIR_NAME);
}

/** Record file name, resolved under GENIE_HOME. */
export const SKILLS_INSTALL_RECORD_NAME = 'skills-install.json';

/**
 * npm download + the full inventory across every detected agent home is well
 * inside a minute on a warm cache and can take a few on a cold one. 5 minutes
 * is the ceiling `runBoundedIntegrationCommand` accepts. (Deliberately no
 * literal skill count here: the top-level inventory is 25 at the time of
 * writing and moves with every skill added, and a stale number in a timeout
 * rationale reads as a contract nobody re-measured.)
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

/**
 * One retired skill directory this run could NOT archive, carried in the record
 * so the receipt never loses it: doctor names it, the next `genie update`
 * retries it, and `genie uninstall` either removes it (when `digest` still
 * proves it is genie's byte-identical install) or reports it. Dropping these
 * entries — the pre-fix behaviour — made a preserved directory invisible to all
 * three consumers forever.
 */
const skillsPreservedSchema = z.object({
  agentDir: z
    .string()
    .refine(isTraversalFreeAbsolutePath, 'preserved agent dir must be a traversal-free absolute path'),
  skill: z.string().regex(SKILL_NAME_PATTERN),
  /** Operator-facing reason, reproduced verbatim by doctor. */
  reason: z.string().min(1),
  /**
   * The digest genie proved BEFORE it declined to move the directory. Absent
   * whenever the directory was never proven genie's (a legacy record, a user
   * edit, a redirected agent home) — and an absent digest can never authorize a
   * deletion, so uninstall reports those instead.
   */
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'digest must be a lowercase sha256 hex string')
    .optional(),
});

/** One preserved retired skill directory; see {@link skillsPreservedSchema}. */
export type SkillsPreservedEntry = z.infer<typeof skillsPreservedSchema>;

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
  /**
   * Retired skill directories left on disk for a human. Optional for the same
   * decision-2 reason as `source`: a required field would invalidate every
   * record already written and silently turn `genie uninstall` into a no-op.
   */
  preserved: z.array(skillsPreservedSchema).optional(),
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
   * backs up under it is an agent skill home. Any second physical skill tree
   * inside `$GENIE_HOME` would be byte-equal to the source and carry the
   * tarball's own extraction stamp — exactly what the selection rule keeps — so
   * without this prune it could be selected as a home this install "wrote",
   * inflating the honest N and putting a path inside `$GENIE_HOME` into the
   * uninstall manifest. The `plugins/genie/skills/` mirror that motivated this
   * left with the Claude plugin; the prune stays as the structural guarantee.
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

/**
 * One candidate as the PRE-install snapshot found it.
 *
 * `digest` is the foreign directory's content digest at that moment: the
 * evidence `finalizeCollisionSnapshot` uses afterwards to decide whether the
 * install actually replaced it, instead of guessing from a discovery heuristic.
 * `backedUp` says whether its bytes were copied under the backup root — only
 * homes genie can name in advance are copied (see `collisionBackupHomes`).
 */
export interface StagedSkillsCollision extends SkillsCollision {
  digest: string | null;
  backedUp: boolean;
}

export interface SkillsCollisionSnapshot {
  collisions: StagedSkillsCollision[];
  /** Allocated lazily: `null` when nothing was copied. */
  backupRoot: string | null;
  /** Directories that could not be backed up, and were therefore NOT recorded. */
  failures: string[];
}

export interface SkillsCollisionSnapshotOptions {
  /** Candidate skill homes that already exist, absolute. */
  homes: readonly string[];
  /**
   * The subset of `homes` whose collisions are COPIED into the backup root.
   * Everything else is fingerprinted only — detected, digested and reported,
   * never duplicated into GENIE_HOME. Defaults to every home.
   */
  backupHomes?: readonly string[];
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
 * install overwrites it — but only in the homes `backupHomes` names.
 *
 * `--all` gives no per-home veto, so "refuse for that home" is unimplementable
 * without abandoning the `--all` contract (decisions 4/5): collisions are
 * detected, backed up, recorded and reported — never refused, and never
 * restored (restoration is explicitly out of scope). A directory that cannot be
 * backed up is NOT recorded as handled; it is reported as a failure instead, so
 * the operator line can never claim a backup that does not exist.
 *
 * A candidate outside `backupHomes` is still DETECTED — its digest is taken —
 * but none of its bytes are read into the backup. That is M4: on the 2026-09-15
 * dogfood host 152 directories under `~/.Trash`, `~/backups`, `~/workspace` and
 * another product'"'"'s tree were copied into GENIE_HOME by a snapshot that swept
 * the whole `$HOME` walk, and the installer wrote none of them.
 *
 * Never throws.
 */
export function snapshotSkillsCollisions(options: SkillsCollisionSnapshotOptions): SkillsCollisionSnapshot {
  const now = options.now ?? (() => new Date());
  const previous = options.previous ?? null;
  const collisions: StagedSkillsCollision[] = [];
  const failures: string[] = [];
  const backupHomes = options.backupHomes === undefined ? null : new Set(options.backupHomes);
  let backupRoot: string | null = null;
  for (const home of options.homes) {
    for (const skill of options.inventory) {
      const target = join(home, skill);
      if (!isForeignSkillDir(target, { sourceRoot: options.sourceRoot, skill, previous })) continue;
      const digest = computeSkillDirDigest(target);
      if (backupHomes !== null && !backupHomes.has(home)) {
        collisions.push({ dir: target, skill, digest, backedUp: false });
        continue;
      }
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
      collisions.push({ dir: target, skill, digest, backedUp: true });
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
  /** Injectable archival move for deterministic concurrent-edit tests. */
  renameRetiredSkill?: (source: string, destination: string) => void;
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
}): { dirs: string[]; warnings: string[]; scanOk: boolean } {
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
  return { dirs, warnings, scanOk: scan.status === 'ok' };
}

/** What happened to one retired skill directory. */
type RetirementDisposition =
  | { kind: 'absent' }
  | { kind: 'archived' }
  | { kind: 'preserved'; reason: string; digest?: string };

interface SkillsRetirementContext {
  home: string;
  genieHome: string;
  previous: SkillsInstallRecord;
  /** The inventory the delivered tree is about to install. */
  inventory: readonly string[];
  /** Every digest the PREVIOUS record vouches for, keyed by absolute path. */
  expectedDigests: ReadonlyMap<string, string>;
  rename: (source: string, destination: string) => void;
  now: () => Date;
  backupRoot?: string;
}

interface RetiredSkillPlan {
  target: string;
  /** `target` relative to `home` — the path mirrored inside the backup root. */
  mirrored: string;
  expected: string;
  expectedParent: string;
  original: Stats;
}

/**
 * Digests the previous record vouches for: its ordinary `dirDigests`, plus the
 * digests carried on `preserved` entries — which is what lets a retirement that
 * was deferred one release still be proven genie's on the next attempt.
 */
function previousDigests(previous: SkillsInstallRecord): Map<string, string> {
  const digests = new Map(Object.entries(previous.dirDigests ?? {}));
  for (const entry of previous.preserved ?? []) {
    if (entry.digest === undefined) continue;
    const target = join(entry.agentDir, entry.skill);
    if (!digests.has(target)) digests.set(target, entry.digest);
  }
  return digests;
}

/**
 * Directories this install must try to retire: every recorded agent dir crossed
 * with the skills this release no longer delivers, PLUS every directory the
 * previous run preserved. That second source is the retry channel — without it
 * a preserved directory drops out of the record and is never looked at again.
 */
function retirementTargets(
  previous: SkillsInstallRecord,
  inventory: readonly string[],
): { agentDir: string; skill: string }[] {
  const removed = previous.inventory.filter((name) => !inventory.includes(name));
  const targets: { agentDir: string; skill: string }[] = [];
  const seen = new Set<string>();
  const add = (agentDir: string, skill: string): void => {
    const key = join(agentDir, skill);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ agentDir, skill });
  };
  for (const agentDir of new Set(previous.agentDirs)) {
    for (const skill of removed) add(agentDir, skill);
  }
  // A preserved skill this release delivers again is no longer retired.
  for (const entry of previous.preserved ?? []) {
    if (!inventory.includes(entry.skill)) add(entry.agentDir, entry.skill);
  }
  return targets;
}

/**
 * Prove the directory is the recorded, unchanged genie install before anything
 * moves. Returns the disposition to report instead when it cannot.
 *
 * Each refusal is named separately, because each is a different operator
 * action, and only a refusal that is purely about CONTENT carries the recorded
 * digest forward. A digest on a preserved entry is what lets the next
 * `genie update` notice the user reverted their edit and finally retire the
 * directory — and what lets `genie uninstall` delete it once it matches again.
 * The path-level refusals carry none: an absent digest can never authorize a
 * deletion, which is exactly the refusal that branch just made.
 */
function planRetiredSkillArchival(
  agentDir: string,
  skill: string,
  context: SkillsRetirementContext,
): RetiredSkillPlan | RetirementDisposition {
  const target = join(agentDir, skill);
  if (!existsSync(target)) return { kind: 'absent' };
  const mirrored = relative(context.home, target);
  const expected = context.expectedDigests.get(target);
  const contained = mirrored !== '' && !mirrored.startsWith('..') && !isAbsolute(mirrored);
  // Allow a symlinked HOME, but never follow a redirected agent home below it.
  const expectedParent = join(realpathSync(context.home), dirname(mirrored));
  const parentMatches = contained && realpathSync(dirname(target)) === expectedParent;
  const original = parentMatches ? lstatSync(target) : null;
  if (original === null) return { kind: 'preserved', reason: 'outside the recorded agent home' };
  if (expected === undefined) return { kind: 'preserved', reason: 'no recorded content digest' };
  if (computeSkillDirDigest(target) !== expected) {
    return { kind: 'preserved', reason: 'content changed since the recorded install', digest: expected };
  }
  return { target, mirrored, expected, expectedParent, original };
}

/** `EXDEV` is the one rename failure a verified copy can legitimately stand in for. */
function isCrossDeviceError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EXDEV';
}

/**
 * Rename when both paths share a filesystem; copy when they do not.
 *
 * `GENIE_HOME` on another mount is ordinary (`/data/genie`, a bind-mounted
 * agent home, a container volume) and a bare `renameSync` turned that into
 * `EXDEV: cross-device link not permitted` — aborting before the record was
 * written, so `genie update` failed identically forever. The copy keeps the
 * backup-first guarantee: bytes land in the backup root and are verified there
 * BEFORE the original is removed.
 *
 * Returns `true` when the bytes were RENAMED (inode identity preserved, so the
 * caller can compare it) and `false` when they were copied.
 */
function moveRetiredSkillDir(target: string, destination: string, context: SkillsRetirementContext): boolean {
  try {
    context.rename(target, destination);
    return true;
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
  }
  try {
    // `verbatimSymlinks` keeps link targets byte-identical to what the digest
    // hashes; rewriting them would fail the post-copy verification below.
    cpSync(target, destination, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return false;
}

/** Restore a changed directory without overwriting a newly created live path. */
function restoreChangedRetiredSkill(plan: RetiredSkillPlan, destination: string): string {
  try {
    if (realpathSync(dirname(plan.target)) !== plan.expectedParent) {
      throw new Error('agent home changed during retirement');
    }
    atomicRenameDirectoryNoClobber(destination, plan.target);
  } catch (error) {
    throw new Error(`retired skill changed during archival; recover ${destination} manually: ${errorMessage(error)}`);
  }
  fsyncParentDir(destination);
  fsyncParentDir(plan.target);
  return 'changed during archival; restored';
}

/**
 * `state-backups/skills-retirement-<compact ISO 8601>/` — the same sortable
 * family as `integration-retirement-<timestamp>` and the collision snapshot.
 * `mkdtemp` was a third naming scheme whose random suffix does not sort.
 */
function ensureRetirementBackupRoot(context: SkillsRetirementContext): string {
  if (context.backupRoot === undefined) {
    const stamp = context.now().toISOString().replace(/[:.]/g, '-');
    const root = join(context.genieHome, 'state-backups', `skills-retirement-${stamp}`);
    // Owner-only: the tree holds whatever the retired skill directories held.
    mkdirSync(root, { recursive: true, mode: 0o700 });
    context.backupRoot = root;
  }
  return context.backupRoot;
}

/** Move the proven directory into the backup root, verifying it on arrival. */
function commitRetiredSkillArchive(plan: RetiredSkillPlan, context: SkillsRetirementContext): RetirementDisposition {
  const destination = join(ensureRetirementBackupRoot(context), plan.mirrored);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const renamed = moveRetiredSkillDir(plan.target, destination, context);
  fsyncParentDir(destination);
  fsyncParentDir(plan.target);
  // The TOCTOU guard: the bytes that arrived must still be the bytes the plan
  // proved. A rename can also be compared by inode identity; a copy cannot.
  const archived = computeSkillDirDigest(destination) === plan.expected;
  if (!renamed) {
    if (!archived) {
      rmSync(destination, { recursive: true, force: true });
      return { kind: 'preserved', reason: 'changed during archival; kept in place', digest: plan.expected };
    }
    // Only now, with a verified copy in the backup root, does the original go.
    rmSync(plan.target, { recursive: true, force: true });
    fsyncParentDir(plan.target);
    return { kind: 'archived' };
  }
  const moved = lstatSync(destination);
  if (!archived || moved.dev !== plan.original.dev || moved.ino !== plan.original.ino) {
    return { kind: 'preserved', reason: restoreChangedRetiredSkill(plan, destination), digest: plan.expected };
  }
  return { kind: 'archived' };
}

/** True unless everything under `dir` is an empty directory tree. */
function holdsNoFiles(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.every((entry) => entry.isDirectory() && holdsNoFiles(join(dir, entry.name)));
}

/**
 * A backup root that never received a single byte — every failure path before
 * the first successful move — is removed rather than left behind. Each retry of
 * a failing `genie update` used to leak one empty tree under `state-backups/`.
 */
function discardEmptyRetirementBackupRoot(context: SkillsRetirementContext): void {
  const root = context.backupRoot;
  if (root === undefined || !holdsNoFiles(root)) return;
  try {
    rmSync(root, { recursive: true, force: true });
    context.backupRoot = undefined;
  } catch {
    // Best effort: an unremovable empty backup root never fails an install.
  }
}

/** How many already-gone retirement targets are named before the rest are counted. */
const MAX_REPORTED_ABSENT_TARGETS = 5;

/** Running tally of one retirement pass, rendered by {@link reportRetirement}. */
interface RetirementTally {
  archivedBySkill: Map<string, number>;
  preserved: SkillsPreservedEntry[];
  /** `<agentDir>/<skill>` paths the record named that were not on disk. */
  absent: string[];
  attention: string[];
  targets: number;
}

/**
 * The operator-facing rendering of one retirement pass.
 *
 * An ABSENT target used to produce no output at all, which is what made the
 * 2026-09-15 loss invisible: a whole recorded agent home had been replaced
 * mid-run, and the transcript read `retired <skill> from 56 agent dir(s)`
 * against a 57-home record with nothing explaining the gap. Every disposition
 * is now named or counted, and the summary reconciles against the target count.
 */
function reportRetirement(tally: RetirementTally, backupRoot: string | undefined, warnings: string[]): void {
  let archived = 0;
  for (const skill of [...tally.archivedBySkill.keys()].sort()) {
    const count = tally.archivedBySkill.get(skill) as number;
    archived += count;
    warnings.push(`skills: retired ${skill} from ${count} agent dir(s)`);
  }
  if (backupRoot !== undefined) warnings.push(`skills: retirement backups under ${backupRoot}`);
  warnings.push(...tally.attention);
  for (const target of tally.absent.slice(0, MAX_REPORTED_ABSENT_TARGETS)) {
    warnings.push(`skills: retirement: ${target} was already gone — nothing to archive`);
  }
  const unnamed = tally.absent.length - Math.min(tally.absent.length, MAX_REPORTED_ABSENT_TARGETS);
  if (unnamed > 0) warnings.push(`skills: retirement: +${unnamed} more recorded target(s) were already gone`);
  if (tally.targets === 0) return;
  warnings.push(
    `skills: retirement: ${archived} archived, ${tally.preserved.length} preserved, ${tally.absent.length} already absent of ${tally.targets} recorded target(s)`,
  );
}

/**
 * Archive every directory this release retires, and report it in a form a human
 * can read: ONE line per removed skill (not per agent dir x skill — 11 removed
 * skills over the 57 homes the dogfood host records is 627 identical lines),
 * ONE line naming the backup root, one line per preserved directory, up to five
 * already-gone targets plus a remainder count, and one reconciling summary.
 *
 * Returns the preserved entries for the record; warnings are pushed as they are
 * produced so a throw still reports what already happened.
 */
function retireRemovedSkills(context: SkillsRetirementContext, warnings: string[]): SkillsPreservedEntry[] {
  const tally: RetirementTally = {
    archivedBySkill: new Map(),
    preserved: [],
    absent: [],
    attention: [],
    targets: 0,
  };
  try {
    for (const { agentDir, skill } of retirementTargets(context.previous, context.inventory)) {
      tally.targets += 1;
      const planned = planRetiredSkillArchival(agentDir, skill, context);
      const disposition = 'kind' in planned ? planned : commitRetiredSkillArchive(planned, context);
      if (disposition.kind === 'archived') {
        tally.archivedBySkill.set(skill, (tally.archivedBySkill.get(skill) ?? 0) + 1);
      } else if (disposition.kind === 'preserved') {
        const { reason, digest } = disposition;
        tally.preserved.push({ agentDir, skill, reason, ...(digest === undefined ? {} : { digest }) });
        tally.attention.push(
          `skills: preserved retired skill ${join(agentDir, skill)} (${reason}); review it manually`,
        );
      } else {
        tally.absent.push(join(agentDir, skill));
      }
    }
  } finally {
    discardEmptyRetirementBackupRoot(context);
    reportRetirement(tally, context.backupRoot, warnings);
  }
  return tally.preserved;
}

/**
 * Digest every directory the CLI actually wrote, so `genie uninstall` can later
 * prove a directory is still genie's byte-identical install before it deletes
 * it. A combination that did not land (or cannot be read) records no digest:
 * uninstall then preserves that directory instead of deleting it.
 */
function digestInstalledSkillDirs(agentDirs: readonly string[], inventory: readonly string[]): Record<string, string> {
  const dirDigests: Record<string, string> = {};
  for (const agentDir of agentDirs) {
    for (const name of inventory) {
      const target = join(agentDir, name);
      const digest = computeSkillDirDigest(target);
      if (digest !== null) dirDigests[target] = digest;
    }
  }
  return dirDigests;
}

/**
 * Every recorded agent home that is no longer a directory on disk.
 *
 * Reported and KEPT in the new record. Silently dropping one erased the only
 * evidence it was ever recorded: on the 2026-09-15 dogfood host a home was
 * replaced mid-update and the record self-healed from 57 entries to 57
 * different ones, so neither the transcript nor `genie doctor` could show that
 * eleven recorded directories had gone missing without a backup.
 */
function reportVanishedAgentDirs(previous: SkillsInstallRecord | null, warnings: string[]): string[] {
  if (previous === null) return [];
  const vanished = [...new Set(previous.agentDirs)].filter(
    (dir) => isTraversalFreeAbsolutePath(dir) && !isDirectory(dir),
  );
  for (const dir of vanished) {
    warnings.push(
      `skills: recorded agent dir ${dir} no longer exists; kept in the record so the next run still names it`,
    );
  }
  return vanished;
}

/**
 * Preflight → archive the skills this release retires → collision snapshot →
 * spawn the pinned CLI → discovery scan → record.
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
  const now = options.now ?? (() => new Date());
  const warnings: string[] = [];
  // The inventory is read BEFORE the spawn because the collision snapshot needs
  // the names the install is about to write. The delivered tree is genie's own
  // and the CLI only reads it, so the value is still the one recorded below.
  const inventory = inventoryFromSkillsDir(skillsRoot);
  const previous = readSkillsInstallRecord(options.genieHome);
  const vanished = reportVanishedAgentDirs(previous, warnings);

  // RETIREMENT RUNS BEFORE THE INSTALL PASS. `--all` rewrites every supported
  // agent home wholesale, so a home skills.sh replaces takes the previous
  // release's retired directories with it — on 2026-09-15 eleven recorded
  // directories and a user's own symlink were destroyed that way, minutes
  // before a retirement pass that then found nothing to back up. Archiving
  // first is what puts those bytes in `state-backups/` no matter what the
  // install does to the home afterwards.
  // An empty delivered tree never retires anything: every recorded skill would
  // read as removed. It fails below, after the spawn, where it always has.
  let preserved: SkillsPreservedEntry[] = [];
  if (previous !== null && inventory.length > 0) {
    try {
      preserved = retireRemovedSkills(
        {
          home,
          genieHome: options.genieHome,
          previous,
          inventory,
          expectedDigests: previousDigests(previous),
          rename: options.renameRetiredSkill ?? renameSync,
          now,
        },
        warnings,
      );
    } catch (error) {
      return {
        ok: false,
        reason: `could not retire the skills this release drops: ${errorMessage(error)}`,
        remedy: 'Run: genie update (retries retirement using the previous install record)',
        warnings,
      };
    }
  }

  const snapshot = snapshotCollisionsSafely({ ...options, home, skillsRoot, inventory, previous, warnings, nowMs });
  // What the snapshot staged is judged — kept and reported, or discarded — by
  // re-digesting the originals after the spawn. It is therefore correct on
  // every exit path below, including the ones where the install never ran.
  const finalizeCollisions = (): SkillsCollision[] =>
    finalizeCollisionSnapshot({ snapshot, home, genieHome: options.genieHome, warnings });

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
    finalizeCollisions();
    return { ok: false, reason: error instanceof Error ? error.message : String(error), remedy, warnings };
  }
  if (result.exitCode !== 0) {
    finalizeCollisions();
    return { ok: false, reason: describeFailure(result), remedy, warnings };
  }

  // A zero exit with nothing to record is not a success: the delivered tree is
  // what doctor's freshness check and uninstall's removal both read back.
  // Recording an empty inventory would make uninstall a silent no-op over
  // skills that are actually on disk.
  if (inventory.length === 0) {
    finalizeCollisions();
    return { ok: false, reason: `no skills found under ${skillsRoot}`, remedy, warnings };
  }

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
  const dirDigests = digestInstalledSkillDirs(agents.dirs, inventory);
  // A zero exit that wrote no verifiable skill directory anywhere is not a
  // success. It is the one replacement check retirement can no longer make for
  // itself now that it runs first: the retired bytes are already archived and
  // reported, and refusing the record keeps `genie update` retrying.
  if (Object.keys(dirDigests).length === 0) {
    finalizeCollisions();
    return { ok: false, reason: 'the skills CLI wrote no verifiable skill directory', remedy, warnings };
  }
  const collisions = finalizeCollisions();
  try {
    const record: SkillsInstallRecord = {
      ref: releaseTag(options.version),
      source: `local:${skillsRoot}`,
      cliVersion: SKILLS_CLI_VERSION,
      inventory,
      // Recorded homes are never dropped, only added to: `agentDirs` is
      // `genie uninstall`'s removal authority, and a vanished entry that fell
      // out of the record took the proof it ever existed with it.
      agentDirs: [...agents.dirs, ...vanished.filter((dir) => !agents.dirs.includes(dir))],
      dirDigests,
      ...(collisions.length > 0 ? { collisions } : {}),
      ...(preserved.length > 0 ? { preserved } : {}),
      installedAt: now().toISOString(),
    };
    writeSkillsInstallRecord(options.genieHome, record);
    return { ok: true, record, warnings };
  } catch (error) {
    return {
      ok: false,
      reason: `could not finalize the skills install: ${errorMessage(error)}`,
      remedy: 'Run: genie update (retries retirement using the previous install record)',
      warnings,
    };
  }
}

/**
 * Every directory the install could conceivably overwrite: the agent homes
 * `--all` writes (the known table, whether or not they exist yet), the homes
 * the previous record proves the CLI wrote last time, and — because neither
 * list can track a self-discovering CLI whose registry names 77 agents — every
 * `skills` directory the bounded `$HOME` walk finds.
 *
 * The walk is deliberately UNFILTERED here — but DETECTION is all it feeds.
 * Narrowing detection to the known table would lose the signal for any of the
 * 53 homes on the 2026-09-15 dogfood host that the four-row table does not
 * name. What gets COPIED is the far narrower `collisionBackupHomes` set, and
 * what is finally kept and reported is decided by digest evidence in
 * `finalizeCollisionSnapshot`.
 */
function collisionCandidateHomes(context: {
  home: string;
  genieHome: string;
  skillsRoot: string;
  previous: SkillsInstallRecord | null;
  nowMs?: () => number;
  scan?: Pick<SkillsHomeScanOptions, 'maxDepth' | 'maxDirs' | 'budgetMs'>;
}): string[] {
  const scan = scanSkillsHomes({
    home: context.home,
    sourceRoot: context.skillsRoot,
    genieHome: context.genieHome,
    nowMs: context.nowMs,
    ...context.scan,
  });
  const homes: string[] = [];
  const candidates = [
    ...agentSkillHomes(context.home).map((entry) => entry.dir),
    ...(context.previous?.agentDirs ?? []),
    ...scan.dirs,
  ];
  for (const dir of candidates) {
    if (!isTraversalFreeAbsolutePath(dir)) continue;
    if (!homes.includes(dir)) homes.push(dir);
  }
  return homes;
}

/** True when at least one delivered skill name under `home` is provably genie's own. */
function hasGenieOwnedSkill(
  home: string,
  context: { skillsRoot: string; inventory: readonly string[]; previous: SkillsInstallRecord | null },
): boolean {
  for (const skill of context.inventory) {
    if (!isSafeSkillName(skill)) continue;
    const target = join(home, skill);
    if (!isDirectory(target)) continue;
    if (isGenieOwned(target, readProbeFile(join(context.skillsRoot, skill, 'SKILL.md')), context.previous)) return true;
  }
  return false;
}

/**
 * The homes whose collisions are COPIED before the spawn — genie's answer to
 * "which directories is the installer about to write?", answered with evidence
 * rather than with a `$HOME` sweep:
 *
 *  - the known table, which `--all` writes by construction;
 *  - every dir the previous record proves the CLI wrote last time (57 of them
 *    on the dogfood host, 53 outside the table — this is what keeps M1's
 *    `~/.openclaw` case backed up);
 *  - any other discovered home that ALREADY carries a genie-owned skill dir, so
 *    a home genie delivered to before a record existed is covered too.
 *
 * Everything else the walk finds — `~/.Trash/skills`, `~/backups/skills`, a
 * checkout under `~/workspace` — is detected and digested but never duplicated
 * into GENIE_HOME. If such a directory nevertheless changes across the install,
 * `finalizeCollisionSnapshot` says so in plain words instead of pretending a
 * backup exists.
 */
function collisionBackupHomes(context: {
  home: string;
  skillsRoot: string;
  inventory: readonly string[];
  previous: SkillsInstallRecord | null;
  candidates: readonly string[];
}): string[] {
  const homes = new Set<string>([
    ...agentSkillHomes(context.home).map((entry) => entry.dir),
    ...(context.previous?.agentDirs ?? []),
  ]);
  for (const dir of context.candidates) {
    if (homes.has(dir)) continue;
    if (hasGenieOwnedSkill(dir, context)) homes.add(dir);
  }
  return [...homes];
}

/** Remove now-empty ancestors of `path`, stopping below (and excluding) `stopAt`. */
function removeEmptyAncestors(path: string, stopAt: string): void {
  let current = dirname(path);
  while (current.startsWith(`${stopAt}${sep}`)) {
    try {
      if (readdirSync(current).length > 0) return;
      // Verified empty one line above; `recursive` is what makes `rm` accept a
      // directory at all (a bare `rmSync` on one throws `ERR_FS_EISDIR`).
      rmSync(current, { recursive: true, force: true });
    } catch {
      return;
    }
    current = dirname(current);
  }
}

/** Drop one staged copy, and the mirrored directories it leaves behind. */
function discardStagedCollision(collision: SkillsCollision, context: { backupRoot: string; home: string }): void {
  const mirrored = relative(context.home, collision.dir);
  if (mirrored === '' || mirrored.startsWith('..') || isAbsolute(mirrored)) return;
  const staged = join(context.backupRoot, mirrored);
  try {
    rmSync(staged, { recursive: true, force: true });
  } catch {
    return;
  }
  removeEmptyAncestors(staged, context.backupRoot);
}

/** The snapshot found this directory, and it is byte-for-byte what it was then. */
function collisionIsUntouched(collision: StagedSkillsCollision): boolean {
  if (collision.digest === null) return false;
  return computeSkillDirDigest(collision.dir) === collision.digest;
}

/**
 * Decide which staged collision copies survive, and report them honestly.
 *
 * Retention is decided by EVIDENCE, never by a verdict about which homes the
 * install "probably" wrote: a staged copy is discarded only when the original
 * is still exactly what the snapshot copied. Anything else — replaced, removed,
 * or unreadable — keeps its copy and is reported. That is what makes the
 * failure paths safe too: a spawn that never ran leaves every original intact,
 * so its staging cleans itself up, while a spawn that died halfway keeps
 * precisely the copies whose originals it had already overwritten.
 *
 * Never throws; returns the collisions that belong in the record.
 */
function finalizeCollisionSnapshot(context: {
  snapshot: SkillsCollisionSnapshot;
  home: string;
  genieHome: string;
  warnings: string[];
}): SkillsCollision[] {
  const { snapshot, warnings } = context;
  for (const failure of snapshot.failures) {
    warnings.push(`skills: collision not backed up: ${failure}`);
  }
  const backupRoot = snapshot.backupRoot;
  const kept: SkillsCollision[] = [];
  for (const collision of snapshot.collisions) {
    if (collisionIsUntouched(collision)) {
      if (collision.backedUp && backupRoot !== null) {
        discardStagedCollision(collision, { backupRoot, home: context.home });
      }
      continue;
    }
    kept.push({ dir: collision.dir, skill: collision.skill });
    warnings.push(
      collision.backedUp && backupRoot !== null
        ? `skills: collision: ${collision.dir} (${collision.skill}) — the install replaced a foreign skill dir; its previous contents are backed up to ${backupRoot}`
        : `skills: collision: ${collision.dir} (${collision.skill}) — the install changed a foreign skill dir that lies outside every agent home genie could name before the install, so no copy of it was taken`,
    );
  }
  pruneCollisionBackups({ genieHome: context.genieHome, home: context.home });
  return kept;
}

const COLLISION_PRUNE_MAX_ROOTS = 32;
const COLLISION_PRUNE_MAX_FILES = 4000;
const COLLISION_PRUNE_MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Byte-equal regular files at both paths, within the compare budget. */
function sameFileContents(left: string, right: string): boolean {
  try {
    const leftStat = lstatSync(left);
    const rightStat = lstatSync(right);
    if (!leftStat.isFile() || !rightStat.isFile()) return false;
    if (leftStat.size !== rightStat.size) return false;
    if (leftStat.size > COLLISION_PRUNE_MAX_FILE_BYTES) return false;
    return readFileSync(left).equals(readFileSync(right));
  } catch {
    return false;
  }
}

/**
 * True when every file under `root` still has a byte-identical live original,
 * i.e. the copy protects nothing. Anything unreadable, unexpected or over
 * budget answers `false`, so a doubtful backup is always kept.
 */
function collisionBackupIsRedundant(root: string, home: string, budget: { files: number }): boolean {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) return false;
      if (--budget.files < 0) return false;
      const rel = relative(root, path);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
      if (!sameFileContents(path, join(home, rel))) return false;
    }
  }
  return true;
}

/**
 * Drop the `skills-collision-*` roots that no longer protect anything —
 * including the ones an EARLIER run left behind when it could not prove what
 * the install had written. A root is removed only when every file in it still
 * matches its live original, so a root holding the user's replaced bytes is
 * never touched; an empty root trivially qualifies. Never throws.
 */
function pruneCollisionBackups(context: { genieHome: string; home: string }): void {
  const base = join(context.genieHome, 'state-backups');
  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  const budget = { files: COLLISION_PRUNE_MAX_FILES };
  let roots = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('skills-collision-')) continue;
    if (++roots > COLLISION_PRUNE_MAX_ROOTS) return;
    const root = join(base, entry.name);
    if (!collisionBackupIsRedundant(root, context.home, budget)) continue;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A root that cannot be removed is harmless: it is a redundant copy.
    }
  }
}

/**
 * The pre-install snapshot, wrapped so no filesystem surprise inside it can
 * fail an install (decision 5: detect, back up, record, report — never refuse).
 *
 * Reporting is NOT done here: the snapshot runs before the spawn, and what it
 * staged is only judged once discovery knows which homes the install wrote.
 */
function snapshotCollisionsSafely(context: {
  home: string;
  genieHome: string;
  skillsRoot: string;
  inventory: string[];
  previous: SkillsInstallRecord | null;
  warnings: string[];
  now?: () => Date;
  nowMs?: () => number;
  scan?: Pick<SkillsHomeScanOptions, 'maxDepth' | 'maxDirs' | 'budgetMs'>;
}): SkillsCollisionSnapshot {
  const empty: SkillsCollisionSnapshot = { collisions: [], backupRoot: null, failures: [] };
  if (context.inventory.length === 0) return empty;
  try {
    const candidates = collisionCandidateHomes(context);
    return snapshotSkillsCollisions({
      homes: candidates,
      backupHomes: collisionBackupHomes({ ...context, candidates }),
      inventory: context.inventory,
      sourceRoot: context.skillsRoot,
      genieHome: context.genieHome,
      home: context.home,
      previous: context.previous,
      now: context.now,
    });
  } catch (error) {
    context.warnings.push(`skills: collision snapshot failed (${errorMessage(error)}); no foreign skill was backed up`);
    return empty;
  }
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
