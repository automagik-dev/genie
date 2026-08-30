/**
 * The skills.sh channel — the one supported way genie product skills reach an
 * agent home.
 *
 * `genie install` and `genie update` shell out to a PINNED skills CLI
 * (`SKILLS_CLI_VERSION`) with a fixed argv:
 *
 *   npx -y skills@<PINNED> add automagik-dev/genie@v<version> --all --copy -g
 *
 * `--all` expands to `--skill '*' --agent '*' -y` inside the CLI (so no extra
 * `-y` belongs on our side), `--copy` writes plain files rather than links, and
 * `-g` selects the global (per-user) scope. `<version>` is always the RUNNING
 * binary's version: both call seams execute inside the freshly promoted binary,
 * so the release tag and the delivered `$GENIE_HOME/skills/` tree agree.
 *
 * The pinned CLI has no `--json` mode, so its stdout is never parsed for state.
 * What genie needs later — freshness (doctor), writer suppression (agent-sync),
 * and deterministic removal (uninstall) — comes from a record genie writes
 * itself at `<GENIE_HOME>/skills-install.json`, and only after a zero exit.
 *
 * Failure policy: a failed skills install NEVER rolls back the promoted binary.
 * The convergence helper prints the exact remedy command, sets `exitCode = 1`,
 * and returns — it does not throw, so an install/update that already swapped
 * bytes stays committed and retryable.
 */

import type { Dirent } from 'node:fs';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
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

/** The public release repo the skills are published from. */
export const SKILLS_RELEASE_REPO = 'automagik-dev/genie';

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
 * recorded, so a host without cursor/goose/windsurf records nothing for them.
 */
export interface AgentSkillHomeSpec {
  readonly agent: string;
  readonly segments: readonly string[];
}

export const KNOWN_AGENT_SKILL_HOMES: readonly AgentSkillHomeSpec[] = [
  { agent: 'claude', segments: ['.claude', 'skills'] },
  { agent: 'codex', segments: ['.codex', 'skills'] },
  { agent: 'cursor', segments: ['.cursor', 'skills'] },
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

const skillsInstallRecordSchema = z.object({
  /** Release tag actually installed, e.g. `v5.260830.16`. */
  ref: z.string().min(1),
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

/** `5.260830.16` and `v5.260830.16` both normalize to the `v`-prefixed tag. */
export function releaseTag(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * The production argv, verbatim. No extra `-y`: `--all` already expands to
 * `--skill '*' --agent '*' -y` inside the pinned CLI.
 */
export function buildSkillsAddArgv(options: { version: string }): string[] {
  return [
    'npx',
    '-y',
    `skills@${SKILLS_CLI_VERSION}`,
    'add',
    `${SKILLS_RELEASE_REPO}@${releaseTag(options.version)}`,
    '--all',
    '--copy',
    '-g',
  ];
}

/** The operator-facing remedy line for any skills-channel failure. */
export function skillsInstallRemedy(version: string): string {
  return `Run: ${buildSkillsAddArgv({ version }).join(' ')}`;
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
}

export type SkillsInstallOutcome =
  | { ok: true; record: SkillsInstallRecord }
  | { ok: false; reason: string; remedy: string };

/**
 * Preflight → spawn the pinned CLI → (only on a zero exit) write the record.
 * Never throws: every failure is a returned reason plus the remedy command.
 */
export function runSkillsInstall(options: SkillsInstallOptions): SkillsInstallOutcome {
  const remedy = skillsInstallRemedy(options.version);
  if (options.version.trim() === '') {
    return { ok: false, reason: 'running binary version is unknown', remedy };
  }
  const preflight = preflightNode({ which: options.which });
  if (!preflight.ok) return { ok: false, reason: preflight.reason, remedy };

  const argv = buildSkillsAddArgv({ version: options.version });
  const run = options.spawn ?? runBoundedIntegrationCommand;
  let result: CommandResult;
  try {
    result = run(argv[0], argv.slice(1), {
      timeoutMs: SKILLS_INSTALL_TIMEOUT_MS,
      maxOutputBytes: SKILLS_INSTALL_OUTPUT_LIMIT_BYTES,
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), remedy };
  }
  if (result.exitCode !== 0) return { ok: false, reason: describeFailure(result), remedy };

  // A zero exit with nothing to record is not a success: the delivered tree is
  // what doctor's freshness check, agent-sync's writer suppression, and
  // uninstall's removal all read back. Recording an empty inventory would make
  // uninstall a silent no-op over skills that are actually on disk.
  const skillsRoot = options.skillsRoot ?? join(options.genieHome, 'skills');
  const inventory = inventoryFromSkillsDir(skillsRoot);
  if (inventory.length === 0) return { ok: false, reason: `no skills found under ${skillsRoot}`, remedy };

  const record: SkillsInstallRecord = {
    ref: releaseTag(options.version),
    cliVersion: SKILLS_CLI_VERSION,
    inventory,
    agentDirs: existingAgentSkillHomes(options.home).map((entry) => entry.dir),
    installedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  try {
    writeSkillsInstallRecord(options.genieHome, record);
  } catch (error) {
    return { ok: false, reason: `could not record the install: ${errorMessage(error)}`, remedy };
  }
  return { ok: true, record };
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
    // Deliberately non-fatal: the promoted binary is never rolled back for a
    // skills-channel failure. Exit code only.
    process.exitCode = 1;
    return { status: 'failed', reason: outcome.reason };
  }
  const { record } = outcome;
  emit(
    `skills: installed ${record.inventory.length} skill(s) from ${SKILLS_RELEASE_REPO}@${record.ref} into ${record.agentDirs.length} agent dir(s)`,
  );
  return { status: 'installed', record };
}

function defaultLog(line: string): void {
  console.log(line);
}
