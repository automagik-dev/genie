/**
 * doctor — minimal diagnostic checks for a genie install.
 *
 * v5 is zero-daemon: no PostgreSQL, no pm2, no tmux supervision. The doctor
 * therefore only checks the handful of things genie actually depends on:
 *   1. the genie binary + its version (and whether it is on PATH)
 *   2. git present + repo detection
 *   3. the shared .genie/genie.db is openable at the expected schema version
 *   4. the skills prompts are present
 *   5. bun present (genie runs under bun)
 *
 * Human-readable by default; `--json` emits the raw check results. Exits
 * non-zero if any check is a hard failure.
 */

import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DEAD_GENIE_OTEL_EXPORTER, getCodexConfigPath } from '../lib/codex-config.js';
import {
  type CodexPluginProbe,
  type RouteLayerFinding,
  classifyRouteLayers,
  inspectCodexProjectMcp,
  inspectRetiredJsonMcpEntry,
  probeCodexGeniePlugin,
  resolveGitProjectRoots,
} from '../lib/codex-project-mcp.js';
import { loadGenieConfig } from '../lib/genie-config.js';
import { resolveGenieHome as resolveGlobalGenieHome } from '../lib/genie-home.js';
import { classifyLegacyIntegrations } from '../lib/legacy-integration-retirement.js';
import { resolveOmniRuntimeConfig } from '../lib/omni-config.js';
import { type OrcaPluginCompatibilityResult, inspectOrcaPluginLifecycle } from '../lib/orca-plugin-lifecycle.js';

import {
  type AgentSkillHomeSpec,
  KNOWN_AGENT_SKILL_HOMES,
  inventoryFromSkillsDir,
  isSafeSkillName,
  readSkillsInstallRecord,
  releaseTag,
} from '../lib/skills-installer.js';
import {
  CURRENT_SCHEMA_VERSION,
  GenieDbError,
  type ProjectContext,
  openDb,
  resolveProjectContext,
} from '../lib/v5/genie-db.js';
import { VERSION } from '../lib/version.js';
import { checkWorktreeModes, repairWorktreeModes } from './doctor-modes.js';
import { checkLaunchWorktrees, cleanupLaunchWorktrees } from './doctor-worktrees.js';
import {
  cleanupV4,
  detectUncertainKeeps,
  detectV4HomeResidue,
  detectV4Install,
  resolveGenieHome,
  sizeOfPathTree,
} from './legacy-v4.js';

type CheckStatus = 'pass' | 'warn' | 'fail';

export const MINIMUM_BUN_VERSION = '1.3.10';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  suggestion?: string;
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].indexLane`).
   * Only the `jar: index-lane drift` check sets it; see {@link IndexLaneEntry}
   * for the stable per-entry state contract.
   */
  indexLane?: { entries: IndexLaneEntry[] };
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].routeLayers`).
   * Only the `Codex Genie MCP registration` check sets it: the typed config-layer
   * findings (collision, shadowing, global same-key, trust states) from the
   * Group E route-layer classifier.
   */
  routeLayers?: RouteLayerFinding[];
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].advisory`).
   * Only the `Codex CLI` check sets it: the sanitized bounded advisory stderr
   * (e.g. the real sandbox PATH advisory) from the single host observation.
   * Diagnostic metadata only — never a policy decision (Decision 11).
   */
  advisory?: string;
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].skillsChannel`).
   * Only the per-agent `skills: <agent>` lines set it; the record-less
   * `skills: channel` line carries no agent and therefore no rider.
   */
  skillsChannel?: SkillsChannelStatus;
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].legacyIntegrations`).
   * Only the `legacy integrations` check sets it: the marker-owned assets still
   * awaiting retirement. Doctor only OBSERVES them — retirement is `genie update`'s.
   */
  legacyIntegrations?: {
    pending: Array<{ surface: string; path: string }>;
    /**
     * A classifier actually ran. `false` means the check could not observe
     * anything, so an empty `pending` is ignorance, not proof of retirement.
     */
    available: boolean;
  };
}

// ============================================================================
// Output helpers (process.stdout/stderr — no console.* in v5 source)
// ============================================================================

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

const GLYPH: Record<CheckStatus, string> = {
  pass: '\x1b[32m✔\x1b[0m',
  warn: '\x1b[33m!\x1b[0m',
  fail: '\x1b[31m✖\x1b[0m',
};

/** How many `unlinked` INDEX entries `renderCheckLines` names before summarizing the rest. */
const MAX_UNLINKED_LINES = 5;

/**
 * The human lines for one check: its status line, its suggestion, and — for
 * `jar: index-lane drift` — the INDEX entries an operator must open by name,
 * since a `broken`/`unlinked` count alone cannot be acted on. Every `broken`
 * entry is named; `unlinked` is the benign majority (a fresh clone has no
 * roadmap cards at all), so it is capped and the remainder counted.
 */
function renderCheckLines(r: CheckResult): string[] {
  const suffix = r.detail ? ` — ${r.detail}` : '';
  const lines = [`  ${GLYPH[r.status]} ${r.name}${suffix}`];
  if (r.suggestion) lines.push(`      ↳ ${r.suggestion}`);
  let unlinked = 0;
  for (const e of r.indexLane?.entries ?? []) {
    if (e.state === 'broken') lines.push(`      · broken: ${e.entry}`);
    else if (e.state === 'unlinked' && unlinked++ < MAX_UNLINKED_LINES) lines.push(`      · unlinked: ${e.entry}`);
  }
  if (unlinked > MAX_UNLINKED_LINES) lines.push(`      · …and ${unlinked - MAX_UNLINKED_LINES} more unlinked`);
  return lines;
}

function whichBinary(name: string): string | null {
  if (typeof Bun !== 'undefined') {
    try {
      return Bun.which(name);
    } catch {
      return null;
    }
  }
  // Node fallback — same policy as detectPiBinary/detectHermesBinary in agent-sync.
  try {
    const found = execFileSync('which', [name], { encoding: 'utf8' }).trim();
    return found === '' ? null : found;
  } catch {
    return null;
  }
}

// ============================================================================
// Individual checks
// ============================================================================

function checkGenieBinary(): CheckResult[] {
  const results: CheckResult[] = [{ name: `genie version ${VERSION}`, status: 'pass' }];
  const onPath = whichBinary('genie');
  if (onPath) {
    results.push({ name: 'genie on PATH', status: 'pass', detail: onPath });
  } else {
    results.push({
      name: 'genie on PATH',
      status: 'warn',
      detail: 'not found on PATH',
      suggestion: 'Run `genie setup` (or add the install dir to PATH) to invoke genie without an explicit path.',
    });
  }
  return results;
}

function checkGit(root: string | null): CheckResult[] {
  const gitPath = whichBinary('git');
  if (!gitPath) {
    return [
      {
        name: 'git present',
        status: 'fail',
        detail: 'git not found on PATH',
        suggestion: 'Install git — genie resolves the repo root and shared genie.db via git.',
      },
    ];
  }
  const results: CheckResult[] = [{ name: 'git present', status: 'pass', detail: gitPath }];
  if (root !== null) {
    results.push({ name: 'inside a git repository', status: 'pass', detail: root });
  } else {
    results.push({
      name: 'inside a git repository',
      status: 'warn',
      detail: 'not inside a git repository',
      suggestion: 'Run genie from within a git repo — per-repo state lives under <repo>/.genie/.',
    });
  }
  return results;
}

function checkDatabase(root: string | null): CheckResult[] {
  const lifecycle = inspectOrcaPluginLifecycle();
  if (lifecycle.mode === 'orca') {
    return [{ name: 'genie.db', status: 'pass', detail: 'not opened — Orca is the selected lifecycle authority' }];
  }
  const dbPath = join(root ?? process.cwd(), '.genie', 'genie.db');
  if (!existsSync(dbPath)) {
    return [
      {
        name: 'genie.db',
        status: 'pass',
        detail: `absent at ${dbPath} (created on first task/board use)`,
      },
    ];
  }
  try {
    const db = openDb({ path: dbPath });
    try {
      const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
      const version = row?.user_version ?? 0;
      if (version === CURRENT_SCHEMA_VERSION) {
        return [{ name: 'genie.db', status: 'pass', detail: `${dbPath} (schema v${version})` }];
      }
      return [
        {
          name: 'genie.db',
          status: 'fail',
          detail: `${dbPath} reports schema v${version}, expected v${CURRENT_SCHEMA_VERSION}`,
        },
      ];
    } finally {
      db.close();
    }
  } catch (err) {
    const detail = err instanceof GenieDbError ? err.message : err instanceof Error ? err.message : String(err);
    return [{ name: 'genie.db', status: 'fail', detail }];
  }
}

function checkSkills(root: string | null): CheckResult[] {
  // skills/ ships alongside the source tree; resolve it relative to the repo
  // root (dev) — an installed plugin bundle exposes the same directory.
  const candidates = [root === null ? null : join(root, 'skills'), join(import.meta.dir, '..', '..', 'skills')].filter(
    (candidate): candidate is string => candidate !== null,
  );
  const found = candidates.find((p) => existsSync(join(p, 'wish', 'SKILL.md')) || existsSync(join(p, 'wish.md')));
  if (found) {
    return [{ name: 'skills present', status: 'pass', detail: found }];
  }
  return [
    {
      name: 'skills present',
      status: 'warn',
      detail: 'skills/ directory not found',
      suggestion: 'Reinstall genie or run from the repo root so skill prompts resolve.',
    },
  ];
}

// ============================================================================
// skills.sh channel (wish `skills-everywhere`, group 3)
//
// Doctor is a READ-ONLY observer here: it compares what the skills-install
// record claims against what is on disk under each detected agent's skill home
// and reports the drift. It never installs, retires, or repairs anything — not
// even under `--fix`; `genie update` owns every mutation on this surface.
// ============================================================================

/**
 * Machine-readable per-agent skills-channel state (`checks[].skillsChannel`).
 * `detected:false` means the agent's config HOME is absent on this host, which
 * is a perfectly healthy state — it reports `pass`, never a warning.
 */
export interface SkillsChannelStatus {
  agent: string;
  present: number;
  total: number;
  /** Release tag the comparison is made against (the record's, or the binary's). */
  ref: string;
  /** The record's ref no longer matches this binary's release tag. */
  stale: boolean;
  detected: boolean;
  /**
   * An install record exists, so `ref` is the release the skills were actually
   * installed from. When false, `ref` is only this binary's own tag — doctor
   * has no provenance for what is on disk and says so.
   */
  recorded: boolean;
}

const SKILLS_CHANNEL_SUGGESTION = 'Run `genie update` to install the skills.sh channel';

/** `~/.claude` for `['.claude','skills']`, `~/.config/goose` for the goose spec, ... */
function agentConfigHome(spec: AgentSkillHomeSpec, home: string): string {
  return join(home, ...spec.segments.slice(0, -1));
}

/** Home used to resolve agent skill homes. Bun's `homedir()` ignores a mutated `$HOME`. */
function resolveHostHome(explicit?: string): string {
  // `||`, not `??`: an empty `$HOME` is not a home, and joining onto `''`
  // would silently resolve agent skill homes relative to the CWD.
  return explicit ?? (process.env.HOME || homedir());
}

/** Same predicate `existingAgentSkillHomes` uses: a FILE at the path is not a home. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function countInstalledSkills(skillsDir: string, inventory: readonly string[]): number {
  let present = 0;
  for (const name of inventory) {
    // Same traversal floor the record's own consumers use: a name that could
    // climb out of the agent dir is never joined onto it.
    if (!isSafeSkillName(name)) continue;
    if (existsSync(join(skillsDir, name, 'SKILL.md'))) present += 1;
  }
  return present;
}

interface SkillsChannelContext {
  home: string;
  inventory: readonly string[];
  ref: string;
  stale: boolean;
  recorded: boolean;
  binaryTag: string;
}

function evaluateAgentSkillHome(spec: AgentSkillHomeSpec, context: SkillsChannelContext): CheckResult {
  const name = `skills: ${spec.agent}`;
  const total = context.inventory.length;
  if (!isDirectory(agentConfigHome(spec, context.home))) {
    return {
      name,
      status: 'pass',
      detail: 'not detected',
      skillsChannel: {
        agent: spec.agent,
        present: 0,
        total,
        ref: context.ref,
        stale: context.stale,
        detected: false,
        recorded: context.recorded,
      },
    };
  }
  const present = countInstalledSkills(join(context.home, ...spec.segments), context.inventory);
  const rider: SkillsChannelStatus = {
    agent: spec.agent,
    present,
    total,
    ref: context.ref,
    stale: context.stale,
    detected: true,
    recorded: context.recorded,
  };
  // Without a record `ref` is only this binary's tag: the line must not read as
  // if doctor knew which release put those skills on disk.
  const provenanceSuffix = context.recorded
    ? context.stale
      ? ` (stale, binary is ${context.binaryTag})`
      : ''
    : ' (unrecorded)';
  const detail = `${present}/${total} @ ${context.ref}${provenanceSuffix}`;
  if (present === total && !context.stale) return { name, status: 'pass', detail, skillsChannel: rider };
  return { name, status: 'warn', detail, suggestion: SKILLS_CHANNEL_SUGGESTION, skillsChannel: rider };
}

/**
 * One line per known agent skill home, plus a `skills: channel` warning when no
 * install record exists at all.
 *
 * The comparison inventory is the record's when there is one; without a record
 * the delivered tree under `<GENIE_HOME>/skills` is the only remaining truth
 * source, so it is used as the fallback. When BOTH are empty there is nothing
 * to compare against and the single record-less warning is the whole answer.
 */
export function checkSkillsChannel(options: { home?: string; genieHome?: string } = {}): CheckResult[] {
  const home = resolveHostHome(options.home);
  const genieHome = options.genieHome ?? resolveGlobalGenieHome();
  const record = readSkillsInstallRecord(genieHome);
  const binaryTag = releaseTag(VERSION);
  const inventory =
    record !== null && record.inventory.length > 0
      ? record.inventory
      : inventoryFromSkillsDir(join(genieHome, 'skills'));
  const results: CheckResult[] = [];
  if (record === null) {
    results.push({
      name: 'skills: channel',
      status: 'warn',
      detail: 'no install record',
      suggestion: SKILLS_CHANNEL_SUGGESTION,
    });
    if (inventory.length === 0) return results;
  }
  const context: SkillsChannelContext = {
    home,
    inventory,
    ref: record?.ref ?? binaryTag,
    stale: record !== null && record.ref !== binaryTag,
    recorded: record !== null,
    binaryTag,
  };
  for (const spec of KNOWN_AGENT_SKILL_HOMES) results.push(evaluateAgentSkillHome(spec, context));
  return results;
}

// ============================================================================
// Legacy marker-owned integration assets (wish `skills-everywhere`, group 3)
// ============================================================================

/** Classification of one marker-owned legacy asset. Mirrors the group-2 module. */
export type LegacyIntegrationState = 'managed-clean' | 'managed-modified' | 'unmanaged' | 'absent';

export interface LegacyIntegrationEntry {
  surface: string;
  path: string;
  state: LegacyIntegrationState;
}

/**
 * The narrow shape doctor consumes: structurally satisfied by the real
 * `classifyLegacyIntegrations` (its `surface` union widens to `string` and its
 * extra optional homes are not required here), while staying injectable by
 * tests. Doctor observes the classification; it does not own the engine.
 */
export type LegacyClassifier = (homes: { home: string; genieHome: string }) => { entries: LegacyIntegrationEntry[] };

/**
 * Compile-time proof that the real group-2 export satisfies doctor's seam. If
 * `classifyLegacyIntegrations`'s signature or its `LegacyIntegrationState`
 * union ever drifts from doctor's, this assignment fails to typecheck.
 */
const DEFAULT_LEGACY_CLASSIFIER: LegacyClassifier = classifyLegacyIntegrations;

const LEGACY_RETIREMENT_SUGGESTION = 'Run `genie update` to retire them';
/** How many pending paths the check names before summarizing the rest. */
const MAX_LEGACY_PENDING_PATHS = 5;

/**
 * The retirement module is a permanent fixture of the tree, so it is imported
 * statically: a non-literal dynamic specifier is invisible to `bun build`, and
 * the shipped single-file bundle would have degraded to a silent, permanent
 * "classifier unavailable" pass. `deps.legacyClassifier` remains the only seam
 * — `null` forces the unavailable path for tests of that branch.
 */
function resolveLegacyClassifier(deps: DoctorDeps): LegacyClassifier | null {
  if (deps.legacyClassifier !== undefined) return deps.legacyClassifier;
  return DEFAULT_LEGACY_CLASSIFIER;
}

/**
 * The one shape of the unavailable answer: a pass (doctor never fails on its
 * own blindness) that still carries the rider, with `available:false` so a
 * machine reader can tell "nothing pending" from "nothing observed".
 */
function unavailableLegacyResult(reason?: string): CheckResult {
  return {
    name: 'legacy integrations',
    status: 'pass',
    detail: reason === undefined ? 'classifier unavailable' : `classifier unavailable (${reason})`,
    legacyIntegrations: { pending: [], available: false },
  };
}

/**
 * Read-only classification of marker-owned legacy assets still on disk.
 * `managed-clean` is the ONLY pending state: a modified or unmanaged asset is
 * never genie's to retire, and an absent one is already gone.
 */
export async function checkLegacyIntegrations(
  deps: DoctorDeps = {},
  options: { home?: string; genieHome?: string } = {},
): Promise<CheckResult[]> {
  const classifier = resolveLegacyClassifier(deps);
  if (classifier === null) return [unavailableLegacyResult()];
  let entries: LegacyIntegrationEntry[];
  try {
    entries = classifier({
      home: resolveHostHome(options.home),
      genieHome: options.genieHome ?? resolveGlobalGenieHome(),
    }).entries;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [unavailableLegacyResult(reason)];
  }
  const pending = entries
    .filter((entry) => entry.state === 'managed-clean')
    .map((entry) => ({ surface: entry.surface, path: entry.path }));
  if (pending.length === 0) {
    return [
      {
        name: 'legacy integrations',
        status: 'pass',
        detail: 'retired',
        legacyIntegrations: { pending, available: true },
      },
    ];
  }
  const named = pending.slice(0, MAX_LEGACY_PENDING_PATHS).map((entry) => entry.path);
  const remainder = pending.length - named.length;
  const tail = remainder > 0 ? `${named.join(', ')}, …and ${remainder} more` : named.join(', ');
  return [
    {
      name: 'legacy integrations',
      status: 'warn',
      detail: `${pending.length} marker-owned assets pending: ${tail}`,
      suggestion: LEGACY_RETIREMENT_SUGGESTION,
      legacyIntegrations: { pending, available: true },
    },
  ];
}

interface ParsedSemVer {
  core: [number, number, number];
  prerelease: Array<number | string> | null;
}

function parseSemVer(version: string): ParsedSemVer | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version.trim(),
    );
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((part) => {
        if (!/^\d+$/.test(part)) return part;
        if (part.length > 1 && part.startsWith('0')) return Number.NaN;
        return Number(part);
      })
    : null;
  if (prerelease?.some((part) => typeof part === 'number' && !Number.isSafeInteger(part))) return null;
  return { core, prerelease };
}

function compareParts(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? -1) > (right[index] ?? -1) ? 1 : -1;
  }
  return 0;
}

function comparePrereleaseIdentifier(left: number | string, right: number | string): number {
  if (left === right) return 0;
  if (typeof left === 'number' && typeof right === 'number') return left > right ? 1 : -1;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left > right ? 1 : -1;
}

function comparePrerelease(left: Array<number | string> | null, right: Array<number | string> | null): number {
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const comparison = comparePrereleaseIdentifier(a, b);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  const core = compareParts(left.core, right.core);
  return core === 0 ? comparePrerelease(left.prerelease, right.prerelease) : core;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = parseSemVer(actual);
  const right = parseSemVer(minimum);
  if (!left || !right) return false;
  return compareSemVer(left, right) >= 0;
}

export function evaluateBunVersion(bunVersion: string | null, onPath: string | null): CheckResult[] {
  if (bunVersion) {
    if (!versionAtLeast(bunVersion, MINIMUM_BUN_VERSION)) {
      return [
        {
          name: `bun ${bunVersion}`,
          status: 'fail',
          detail: `unsupported; Genie requires Bun >=${MINIMUM_BUN_VERSION}`,
          suggestion: `Run \`bun upgrade\`, then confirm \`bun --version\` is at least ${MINIMUM_BUN_VERSION}.`,
        },
      ];
    }
    return [
      {
        name: `bun ${bunVersion}`,
        status: 'pass',
        detail: onPath ?? 'running under bun',
      },
    ];
  }
  return [
    {
      name: 'bun present',
      status: 'fail',
      detail: 'bun runtime not detected',
      suggestion: 'Install bun (https://bun.sh) — genie is a bun single-file binary.',
    },
  ];
}

function checkBun(versionOverride?: string | null, pathOverride?: string | null): CheckResult[] {
  const bunVersion =
    versionOverride === undefined ? (typeof Bun !== 'undefined' ? Bun.version : null) : versionOverride;
  const onPath = pathOverride === undefined ? whichBinary('bun') : pathOverride;
  return evaluateBunVersion(bunVersion, onPath);
}

function codexProjectRouteCheck(root: string | null, probe: CodexPluginProbe, cwd = process.cwd()): CheckResult {
  if (root === null) {
    return {
      name: 'Codex Genie MCP registration',
      status: 'warn',
      detail: 'not inside a Git worktree; project route not inspected',
      suggestion: 'Run `genie doctor` from the repository you want Codex to use.',
    };
  }
  try {
    const route = inspectCodexProjectMcp(root, probe);
    // Group E: distinct typed config-layer findings. Collisions, shadowing, and
    // a global same-key route are hard route defects (preserved, never edited);
    // the trust states block a health CLAIM without failing intact route bytes.
    const findings = classifyRouteLayers({ worktreeRoot: root, cwd, route, globalConfigPath: getCodexConfigPath() });
    const hard = findings.filter(
      (finding) =>
        finding.kind === 'route-collision' ||
        finding.kind === 'route-shadowed' ||
        finding.kind === 'global-route-same-key',
    );
    const trust = findings.filter(
      (finding) => finding.kind === 'untrusted-config' || finding.kind === 'project-trust-required',
    );
    const retired = route.route !== 'none' && route.route !== 'plugin';
    const status: CheckStatus = retired || hard.length > 0 || trust.length > 0 ? 'warn' : 'pass';
    const findingText = findings.map((finding) => `${finding.kind}: ${finding.detail}`).join('; ');
    return {
      name: 'Codex Genie MCP registration',
      status,
      detail: `${retired ? 'retired route remains preserved' : 'retired routes absent'}${findingText.length > 0 ? `; ${findingText}` : ''}`,
      suggestion:
        status === 'pass'
          ? undefined
          : hard.length > 0
            ? 'Resolve the reported user-owned same-key/shadowing layer if desired; Genie never edits it.'
            : trust.length > 0 && route.ok
              ? 'Trust this project in Codex, then start a new Codex task.'
              : 'Run `genie init` to remove a marker-owned historical route; user-owned routes are preserved.',
      ...(findings.length > 0 ? { routeLayers: findings } : {}),
    };
  } catch (error) {
    return {
      name: 'Codex Genie MCP registration',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      suggestion: 'Repair the incomplete marker block, then run `genie init`.',
    };
  }
}

/**
 * Group E: report what a Codex MCP child launched in this repository would
 * resolve — the SAME `resolveProjectContext` the MCP server uses, so
 * doctor and the server can never disagree about project context. An absent
 * database mirrors the `genie.db` check's "created on first use" stance as a
 * warn (the MCP returns a typed error, never a healthy empty board); a
 * bare/submodule/external layout or an unresolvable context is a hard fail.
 */
export function checkCodexProjectContext(root: string | null, injected?: ProjectContext | null): CheckResult[] {
  if (root === null || injected === null) return [];
  // Same stance as the `genie.db` check: under Orca the local store is not the
  // lifecycle authority, so doctor neither resolves project context nor opens
  // the database it would name — reporting a live DB there is a false claim,
  // and opening it is exactly what the orca-mode guard forbids.
  if (inspectOrcaPluginLifecycle().mode === 'orca') {
    return [
      {
        name: 'Codex project context',
        status: 'pass',
        detail: 'not resolved — Orca is the selected lifecycle authority',
      },
    ];
  }
  const context = injected ?? resolveProjectContext(root);
  if (context.kind === 'ok') {
    let db: Database | null = null;
    try {
      db = new Database(context.dbPath, { readonly: true });
      db.query('PRAGMA user_version').get();
    } catch {
      return [
        {
          name: 'Codex project context',
          status: 'fail',
          detail: `Codex MCP returns typed 'project-database-unavailable': unable to open Genie database at ${context.dbPath}`,
          suggestion: 'Repair or replace the repository .genie/genie.db, then rerun `genie doctor`.',
        },
      ];
    } finally {
      db?.close();
    }
    return [
      {
        name: 'Codex project context',
        status: 'pass',
        detail: `storage root ${context.genieStorageRoot}; db ${context.dbPath}`,
      },
    ];
  }
  if (context.kind === 'project-database-unavailable') {
    return [
      {
        name: 'Codex project context',
        status: 'warn',
        detail: `Codex MCP returns typed '${context.kind}' (never a healthy empty board): ${context.detail}`,
        suggestion: 'Run `genie init` (or create the first task) to initialize .genie/genie.db.',
      },
    ];
  }
  return [
    {
      name: 'Codex project context',
      status: 'fail',
      detail: `Codex MCP returns typed '${context.kind}': ${context.detail}`,
      suggestion:
        context.kind === 'unsupported-project-layout'
          ? 'Run Codex tasks from an ordinary or linked non-bare worktree; bare/submodule/external-git-dir layouts are a hard boundary.'
          : 'Verify this is an initialized Git worktree, then run `genie init`.',
    },
  ];
}

/**
 * The surviving MCP-capability surface of an installed Codex plugin cache: the
 * active plugin manifest must declare no `mcpServers` route. Read-only.
 */
function codexPluginSurfaceChecks(probe: CodexPluginProbe): CheckResult[] {
  if (!probe.installed) return [];
  const manifest = probe.activePluginRoot ? join(probe.activePluginRoot, '.codex-plugin', 'plugin.json') : null;
  // Post-Group-A contract (Decisions 1/7): the codex plugin manifest MUST NOT
  // declare mcpServers — a declaration would re-create the second (cache-root)
  // Genie route the wish removed. Absence is the healthy shape.
  let manifestState: 'unproven' | 'unreadable' | 'declares-none' | 'declares-route' = 'unproven';
  if (manifest !== null) {
    manifestState = 'unreadable';
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          manifestState =
            (parsed as Record<string, unknown>).mcpServers === undefined ? 'declares-none' : 'declares-route';
        }
      } catch {
        manifestState = 'unreadable';
      }
    }
  }
  return [
    {
      name: 'Codex Genie MCP capability',
      status: manifestState === 'declares-none' ? 'pass' : 'warn',
      detail:
        manifestState === 'declares-none'
          ? `plugin declares no MCP route; standalone task/board commands are authoritative at ${probe.activePluginRoot}`
          : manifestState === 'declares-route'
            ? `active plugin manifest still declares mcpServers — a second Genie route risks cache-root routing: ${manifest}`
            : manifestState === 'unreadable'
              ? `active plugin manifest is missing or corrupt: ${manifest}`
              : 'active installed plugin root is unproven; source-bundle declarations do not establish runtime health',
      suggestion:
        manifestState === 'declares-none'
          ? undefined
          : manifestState === 'declares-route'
            ? 'Remove the historical Genie plugin from the Codex cache; a second Genie route risks cache-root routing.'
            : 'Remove the historical Genie plugin from the Codex cache.',
    },
  ];
}

export async function checkCodexIntegration(
  root: string | null,
  probe: CodexPluginProbe = probeCodexGeniePlugin(),
): Promise<CheckResult[]> {
  if (!probe.cliAvailable)
    return [{ name: 'Codex CLI', status: 'warn', detail: 'not installed (Claude-only mode available)' }];
  const codex = whichBinary('codex');
  const results: CheckResult[] = [{ name: 'Codex CLI', status: 'pass', detail: codex ?? 'detected by bounded probe' }];
  const configPath = getCodexConfigPath();
  const obsolete = existsSync(configPath) && readFileSync(configPath, 'utf8').includes(DEAD_GENIE_OTEL_EXPORTER);
  results.push({
    name: 'obsolete Genie OTel exporter',
    status: obsolete ? 'warn' : 'pass',
    detail: obsolete ? 'present' : 'absent',
    suggestion: obsolete ? 'Run `genie update` for backup-first removal.' : undefined,
  });
  results.push(codexProjectRouteCheck(root, probe), ...codexPluginSurfaceChecks(probe));
  const config = await loadGenieConfig();
  results.push({ name: 'preferred agent runtime', status: 'pass', detail: config.runtime.defaultAgent });
  return results;
}

/** Warn only when Claude Code's global subagent-model override is present. */
export function checkSubagentModelOverride(env: NodeJS.ProcessEnv = process.env): CheckResult[] {
  if (env.CLAUDE_CODE_SUBAGENT_MODEL === undefined) return [];
  return [
    {
      name: 'CLAUDE_CODE_SUBAGENT_MODEL override',
      status: 'warn',
      detail: 'set globally; it overrides per-agent model pins',
      suggestion: 'Unset CLAUDE_CODE_SUBAGENT_MODEL to let Genie role and stage model pins take effect.',
    },
  ];
}

// ============================================================================
// v4 residue check (detect-only; --fix runs the backup-first cleanup)
// ============================================================================

function prettyBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function safeSizeOf(path: string): number {
  try {
    return sizeOfPathTree(path);
  } catch {
    return 0;
  }
}

/**
 * Detect v4 daemon-era residue (genie home + ~/.claude rules/caches). Pure
 * read — doctor without --fix must mutate nothing. Exported for tests with an
 * injectable home pair.
 *
 * Accounting contract: "reclaimable" counts and bytes cover ONLY what --fix
 * would actually remove (home residue + marker-matched rules + orphaned
 * caches). A user-modified rules file is reported as kept, never counted.
 * Uncertain-keeps are report-only lines (Decision 2) — absent from the
 * manifest, unreachable by --fix.
 */
export function checkV4Residue(home?: string, genieHome?: string): CheckResult[] {
  const gh = genieHome ?? resolveGenieHome(home ?? homedir());
  const residue = detectV4HomeResidue(gh);
  const claude = detectV4Install(home ?? homedir());
  const orphanedCaches = claude.cacheDirs.filter((d) => d.orphaned);
  const rulesReclaimable = claude.rulesFile.status === 'v4-markers';
  const rulesKeptUserModified = claude.rulesFile.status === 'user-modified';
  const uncertainKeeps = detectUncertainKeeps(gh);

  const results: CheckResult[] = [];
  const claudeCount = orphanedCaches.length + (rulesReclaimable ? 1 : 0);
  if (residue.length === 0 && claudeCount === 0 && !rulesKeptUserModified) {
    results.push({ name: 'v4 residue', status: 'pass', detail: 'none found' });
  } else if (residue.length + claudeCount > 0) {
    const totalBytes =
      residue.reduce((sum, r) => sum + r.sizeBytes, 0) +
      (rulesReclaimable ? safeSizeOf(claude.rulesFile.path) : 0) +
      orphanedCaches.reduce((sum, d) => sum + safeSizeOf(d.path), 0);
    results.push({
      name: 'v4 residue',
      status: 'warn',
      detail: `${residue.length + claudeCount} reclaimable item(s) (${residue.length} genie-home, ${claudeCount} claude), ${prettyBytes(totalBytes)}`,
      suggestion: 'Run `genie doctor --fix` to back up and remove (backups: ~/.genie/state-backups/).',
    });
  }
  for (const relic of residue) {
    results.push({ name: `v4 residue: ${relic.relPath}`, status: 'warn', detail: prettyBytes(relic.sizeBytes) });
  }
  if (rulesReclaimable) {
    results.push({
      name: 'v4 residue: ~/.claude rules file',
      status: 'warn',
      detail: prettyBytes(safeSizeOf(claude.rulesFile.path)),
    });
  } else if (rulesKeptUserModified) {
    results.push({
      name: 'v4 residue: ~/.claude rules file',
      status: 'warn',
      detail: 'kept (user-modified) — not counted as reclaimable; --fix will not touch it',
    });
  }
  for (const dir of orphanedCaches) {
    results.push({
      name: `v4 residue: plugin cache ${dir.version}`,
      status: 'warn',
      detail: `orphaned, ${prettyBytes(safeSizeOf(dir.path))}`,
    });
  }
  // Report-only (Decision 2): uncertain names we deliberately never touch.
  for (const name of uncertainKeeps) {
    results.push({
      name: `kept (uncertain): ${name}`,
      status: 'pass',
      detail: 'not provably v4 — never touched by --fix',
    });
  }
  return results;
}

// ============================================================================
// Omni approval hook-timeout guardrail
// ============================================================================

interface HookCommand {
  command?: unknown;
  timeout?: unknown;
}
interface HookMatcher {
  hooks?: unknown;
}
interface CcSettings {
  hooks?: { PreToolUse?: unknown };
}

/** Smallest timeout among settings-shaped PreToolUse entries matching the predicate. */
function minMatchingTimeout(entries: unknown, matches: (command: string) => boolean): number | null {
  if (!Array.isArray(entries)) return null;
  let min: number | null = null;
  for (const entry of entries as HookMatcher[]) {
    if (!Array.isArray(entry?.hooks)) continue;
    for (const h of entry.hooks as HookCommand[]) {
      if (typeof h?.command === 'string' && matches(h.command) && typeof h.timeout === 'number') {
        min = min === null ? h.timeout : Math.min(min, h.timeout);
      }
    }
  }
  return min;
}

/**
 * Smallest `timeout` (SECONDS) among PreToolUse hooks that reach the omni
 * approval handler: `genie hook dispatch` entries in a Claude Code settings
 * object. That minimum is the ceiling the approval handler polls under. null
 * when no such hook is installed. Pure + exported so the guardrail is
 * unit-tested without files on disk.
 */
export function findDispatchHookTimeoutSec(settings: CcSettings): number | null {
  return minMatchingTimeout(settings.hooks?.PreToolUse, (command) => command.includes('hook dispatch'));
}

/**
 * Compare the installed hook timeout against the approval poll budget. Returns
 * null when omni approvals are off (no check emitted). A hook timeout below the
 * budget is a WARN: CC kills `genie hook dispatch` before the omni handler can
 * allow/deny OR reach its timeout→ask fail-safe. Pure + exported for testing.
 */
export function evaluateOmniHookTimeout(params: {
  enabled: boolean;
  pollBudgetMs: number;
  timeoutSec: number | null;
}): CheckResult | null {
  if (!params.enabled) return null;
  const name = 'omni hook timeout > pollBudget';
  // pollBudgetMs MUST stay STRICTLY below the hook timeout (genie-config.ts), so
  // the smallest safe whole-second timeout is the first that exceeds pollBudgetMs.
  const needSec = Math.floor(params.pollBudgetMs / 1000) + 1;
  if (params.timeoutSec === null) {
    return {
      name,
      status: 'warn',
      detail: 'omni approvals enabled but no genie dispatch PreToolUse timeout found (settings or plugin manifests)',
      suggestion: `Install the genie PreToolUse hook with a timeout ≥ ${needSec}s so approvals can resolve.`,
    };
  }
  const timeoutMs = params.timeoutSec * 1000;
  // At timeoutMs === pollBudgetMs there is no margin — CC can kill the hook the
  // instant the poll budget expires — so the strict contract warns on equal too.
  if (timeoutMs <= params.pollBudgetMs) {
    return {
      name,
      status: 'warn',
      detail: `hook timeout ${params.timeoutSec}s (${timeoutMs}ms) ≤ pollBudget ${params.pollBudgetMs}ms — CC may kill the hook before it can allow/deny or reach its ask fail-safe`,
      suggestion: `Raise the PreToolUse \`genie hook dispatch\` timeout to ≥ ${needSec}s (e.g. 120) in ~/.claude/settings.json.`,
    };
  }
  return {
    name,
    status: 'pass',
    detail: `hook timeout ${params.timeoutSec}s (${timeoutMs}ms) > pollBudget ${params.pollBudgetMs}ms`,
  };
}

async function checkOmniHookTimeout(): Promise<CheckResult[]> {
  const rt = await resolveOmniRuntimeConfig();
  if (!rt.approvals.enabled) return []; // omni off → stay silent
  let timeoutSec: number | null = null;
  try {
    const settings = existsSync(join(homedir(), '.claude', 'settings.json'))
      ? (JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as CcSettings)
      : {};
    timeoutSec = findDispatchHookTimeoutSec(settings);
  } catch {
    timeoutSec = null; // unreadable/malformed settings → treated as "not found"
  }
  const result = evaluateOmniHookTimeout({ enabled: true, pollBudgetMs: rt.approvals.pollBudgetMs, timeoutSec });
  return result ? [result] : [];
}

// ============================================================================
// Omni bridge health probe
// ============================================================================

/** omni CLI's own fallback API URL (packages/cli/src/commands/status.ts). */
export const OMNI_BRIDGE_DEFAULT_URL = 'http://localhost:8882';
/** Bounded probe budget — doctor is interactive; the bridge answers locally. */
export const OMNI_BRIDGE_PROBE_TIMEOUT_MS = 3_000;

/**
 * Evaluate the omni bridge health probe. Returns null when omni is not
 * configured (no check emitted). The probe moved here from the retired omni
 * plugin SessionStart health hook (hooks-v2#retire): `genie doctor` replaces
 * the hook's per-session health scan with an on-demand diagnostic — no
 * auto-install, no auto-recovery. Pure + exported for testing.
 */
export function evaluateOmniBridgeHealth(params: {
  configured: boolean;
  apiStatus: string | null;
  version?: string;
  error?: string;
}): CheckResult | null {
  if (!params.configured) return null;
  const name = 'omni bridge health';
  const versionSuffix = params.version ? ` (v${params.version})` : '';
  if (params.apiStatus === 'healthy') {
    return { name, status: 'pass', detail: `omni bridge healthy${versionSuffix}` };
  }
  if (params.apiStatus !== null) {
    return {
      name,
      status: 'warn',
      detail: `omni bridge reports status "${params.apiStatus}"${versionSuffix}`,
      suggestion: 'Inspect the bridge with `omni status`; `omni start` brings it up.',
    };
  }
  return {
    name,
    status: 'warn',
    detail: `omni bridge unreachable${params.error ? ` (${params.error})` : ''}`,
    suggestion: 'Start the bridge with `omni start` (or `genie omni serve`), then re-run `genie doctor`.',
  };
}

interface OmniBridgeHealthProbe {
  status: string | null;
  version?: string;
  error?: string;
}

/** One bounded GET to the bridge's health endpoint; never throws. */
async function fetchOmniBridgeHealth(apiUrl: string, fetchImpl: typeof fetch): Promise<OmniBridgeHealthProbe> {
  try {
    const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/api/v2/health`, {
      headers: { 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(OMNI_BRIDGE_PROBE_TIMEOUT_MS),
    });
    const health = (await response.json()) as { status?: unknown; version?: unknown };
    return {
      status: typeof health.status === 'string' ? health.status : 'unknown',
      version: typeof health.version === 'string' ? health.version : undefined,
    };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Probe the configured omni bridge. Silent when omni is not configured
 * (no `apiUrl`/`apiKey` in genie config or env) so a machine that never uses
 * omni carries no probe noise. `fetchImpl` is a test seam; production uses
 * the global fetch.
 */
export async function checkOmniBridgeHealth(fetchImpl: typeof fetch = fetch): Promise<CheckResult[]> {
  const rt = await resolveOmniRuntimeConfig();
  if (rt.apiUrl === undefined && rt.apiKey === undefined) return []; // omni off → stay silent
  const probe = await fetchOmniBridgeHealth(rt.apiUrl ?? OMNI_BRIDGE_DEFAULT_URL, fetchImpl);
  const result = evaluateOmniBridgeHealth({
    configured: true,
    apiStatus: probe.status,
    version: probe.version,
    error: probe.error,
  });
  return result ? [result] : [];
}

// ============================================================================
// jar: index-lane drift — INDEX.md sections vs roadmap board lanes
//
// One tracker: the `roadmap` board owns placement truth; `.genie/INDEX.md` prose
// stays hand-written. This WARNING-LEVEL check joins each INDEX entry's FIRST
// `brainstorms/<slug>/` or `wishes/<slug>/` link to the roadmap card WHERE
// `tasks.wish = slug`, then verifies that card's lane against the section it sits
// under. It never flips doctor `ok:false`. An entry with no such link, no
// matching card, or a laneless card is 'unlinked' (NEVER 'drift') — drift is
// reserved for a resolved card whose lane contradicts its INDEX section. A link
// whose target no longer exists is 'broken', decided BEFORE any lane comparison.
// ============================================================================

/**
 * One INDEX entry's placement verdict. Rides `--json` as
 * `checks[].indexLane.entries` — deterministic and order-stable (INDEX order).
 * The four state names are the machine-readable contract:
 *   - ok       : the resolved roadmap card's lane agrees with the section.
 *   - drift    : the resolved card's lane contradicts the section.
 *   - broken   : the link resolves to a path that does not exist — decided
 *                before the lane comparison, so it outranks drift.
 *   - unlinked : no first brainstorms/wishes link, no matching roadmap card,
 *                or the card carries no lane — never counted as drift.
 */
export interface IndexLaneEntry {
  /** Stable text prefix: the first link's label, else the trimmed line prefix. */
  entry: string;
  /** Resolved lifecycle slug, or null when the entry has no brainstorms/wishes link. */
  slug: string | null;
  /** INDEX section: Raw | Simmering | Ready | Poured. */
  section: string;
  /** The roadmap card's lane, or null when nothing resolves. */
  lane: string | null;
  state: 'ok' | 'drift' | 'broken' | 'unlinked';
}

/** Section → the set of roadmap lanes that AGREE with it (the group brief's contract). */
const INDEX_SECTION_LANES: Record<string, ReadonlySet<string>> = {
  Raw: new Set(['Idea']),
  Simmering: new Set(['Brainstorm']),
  Ready: new Set(['Brainstorm', 'Wish']),
  Poured: new Set(['Wish', 'Work', 'Review', 'Done']),
};

/**
 * First markdown link into `brainstorms/<slug>/…` or `wishes/<slug>/…`.
 * Groups: 1 label, 2 directory, 3 slug, 4 path remainder (possibly empty).
 * Groups 2–4 rejoin as the `.genie`-relative target handed to the resolver.
 */
const INDEX_ENTRY_LINK = /\[([^\]]*)\]\((?:\.\/)?(brainstorms|wishes)\/([^/)]+)\/([^)]*)\)/;

function truncateIndexEntry(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

/**
 * Parse INDEX.md into per-entry lane verdicts. Pure: the caller supplies
 * `laneForSlug`, which returns the resolving roadmap card's lane or null, and
 * `targetExists`, which answers whether a `.genie`-relative link target is on
 * disk. Both are required: a defaulted resolver would silently fail open and
 * report every dangling link as filed. This function performs no filesystem IO
 * of its own. Only the four lifecycle sections are inspected; any other heading
 * is ignored (its bullets are skipped). Every `- ` bullet under a lifecycle
 * section — including indented sub-bullets — is one entry.
 */
export function evaluateIndexLaneDrift(
  indexText: string,
  laneForSlug: (slug: string) => string | null,
  targetExists: (relativePath: string) => boolean,
): IndexLaneEntry[] {
  const entries: IndexLaneEntry[] = [];
  let section: string | null = null;
  for (const line of indexText.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      // Object.hasOwn, not `in`: a hand-written heading like `## constructor`
      // must not resolve to an Object.prototype member (whose `.has` call
      // below would crash the whole doctor run).
      section = Object.hasOwn(INDEX_SECTION_LANES, heading[1]) ? heading[1] : null;
      continue;
    }
    if (section === null || !/^\s*-\s+/.test(line)) continue;
    const content = line.replace(/^\s*-\s+/, '');
    const link = INDEX_ENTRY_LINK.exec(line);
    if (link === null) {
      entries.push({ entry: truncateIndexEntry(content), slug: null, section, lane: null, state: 'unlinked' });
      continue;
    }
    const [, rawLabel, dir, slug, remainder] = link;
    const label = rawLabel.trim();
    const lane = laneForSlug(slug);
    // A dead target outranks every lane verdict: there is nothing to file.
    const state: IndexLaneEntry['state'] = !targetExists(`${dir}/${slug}/${remainder}`)
      ? 'broken'
      : lane === null
        ? 'unlinked'
        : INDEX_SECTION_LANES[section].has(lane)
          ? 'ok'
          : 'drift';
    entries.push({ entry: label.length > 0 ? label : truncateIndexEntry(content), slug, section, lane, state });
  }
  return entries;
}

/**
 * wish → lane for every `roadmap` card that carries both. Read-only: opens the
 * shared DB read-only (no schema mutation, no write lock), tolerating a missing
 * DB, a missing `lane` column, or any read failure by degrading to an empty map
 * (every linked entry then reports 'unlinked', never 'drift'). First wish wins.
 */
function roadmapLanesByWish(dbPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dbPath)) return map;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT t.wish AS wish, t.lane AS lane FROM tasks t JOIN boards b ON t.board_id = b.id WHERE b.name = 'roadmap' AND t.wish IS NOT NULL AND t.lane IS NOT NULL",
      )
      .all() as Array<{ wish: string; lane: string }>;
    for (const row of rows) if (!map.has(row.wish)) map.set(row.wish, row.lane);
  } catch {
    return new Map();
  } finally {
    db?.close();
  }
  return map;
}

/**
 * Does a `.genie`-relative INDEX link target exist? `#anchor` suffixes are
 * stripped (the anchor lives inside the document, not on disk) and a trailing
 * slash is tolerated, so a bare `wishes/<slug>/` link resolves against the
 * directory itself. The only filesystem IO in this check's link handling.
 * A target that resolves outside `.genie/` is `broken` without touching disk,
 * so `../` traversal in a link cannot turn `doctor --json` into an oracle for
 * paths elsewhere on the machine.
 */
function indexTargetExists(genieDir: string, relativePath: string): boolean {
  const withoutAnchor = relativePath.split('#')[0].replace(/\/+$/, '');
  if (withoutAnchor.length === 0) return false;
  const full = resolve(genieDir, withoutAnchor);
  const rootDir = resolve(genieDir);
  if (full !== rootDir && !full.startsWith(rootDir + sep)) return false;
  return existsSync(full);
}

/**
 * The `jar: index-lane drift` warning-level check. Absent INDEX.md → a single
 * pass line (nothing to lint). Otherwise one line summarizing
 * ok/drift/broken/unlinked counts, WARN when ≥1 entry drifts or is broken, plus
 * the stable per-entry payload.
 */
export function checkIndexLaneDrift(root: string | null, databaseRoot: string | null): CheckResult[] {
  const name = 'jar: index-lane drift';
  if (inspectOrcaPluginLifecycle().mode === 'orca') {
    return [{ name, status: 'pass', detail: 'not read — Orca is the selected lifecycle authority' }];
  }
  const base = root ?? process.cwd();
  const indexPath = join(base, '.genie', 'INDEX.md');
  if (!existsSync(indexPath)) {
    return [{ name, status: 'pass', detail: `no ${indexPath} (nothing to lint)` }];
  }
  let indexText: string;
  try {
    indexText = readFileSync(indexPath, 'utf8');
  } catch (err) {
    return [
      { name, status: 'pass', detail: `INDEX.md unreadable (${err instanceof Error ? err.message : String(err)})` },
    ];
  }
  const dbPath = join(databaseRoot ?? base, '.genie', 'genie.db');
  const lanes = roadmapLanesByWish(dbPath);
  const genieDir = join(base, '.genie');
  const entries = evaluateIndexLaneDrift(
    indexText,
    (slug) => lanes.get(slug) ?? null,
    (relativePath) => indexTargetExists(genieDir, relativePath),
  );
  const drift = entries.filter((e) => e.state === 'drift').length;
  const broken = entries.filter((e) => e.state === 'broken').length;
  const unlinked = entries.filter((e) => e.state === 'unlinked').length;
  const ok = entries.filter((e) => e.state === 'ok').length;
  const suggestions: string[] = [];
  if (drift > 0) {
    suggestions.push(
      'An INDEX section disagrees with its roadmap card lane — move the card to the matching lane or the entry to the matching section.',
    );
  }
  if (broken > 0) {
    suggestions.push('An INDEX link points at a path that no longer exists — repoint or remove the entry.');
  }
  return [
    {
      name,
      status: drift > 0 || broken > 0 ? 'warn' : 'pass',
      detail: `${entries.length} INDEX entries: ${ok} ok, ${drift} drift, ${broken} broken, ${unlinked} unlinked`,
      suggestion: suggestions.length > 0 ? suggestions.join(' ') : undefined,
      indexLane: { entries },
    },
  ];
}

/**
 * The `mcp: retired \`genie mcp\` registration` check. Every repo that ran
 * `genie init` before the MCP server was retired carries a `genie` entry in
 * `.mcp.json` that launches `genie mcp` — a command that now prints its
 * retirement diagnostic and exits 1, so Claude Code shows it as a permanently
 * failed MCP server. Warning-level: it never flips doctor `ok:false`, because
 * `.mcp.json` is a user-owned file and the repair is one command away.
 */
export function checkRetiredJsonMcpEntry(root: string | null): CheckResult[] {
  const name = 'mcp: retired `genie mcp` registration';
  const finding = inspectRetiredJsonMcpEntry(root ?? process.cwd());
  if (finding.state !== 'present') return [{ name, status: 'pass', detail: finding.detail }];
  return [
    {
      name,
      status: 'warn',
      detail: `${finding.path} still registers the retired \`genie mcp\` server, which Claude Code shows as failed`,
      suggestion:
        'Run `genie init` in this repository to retire that entry (the file is backed up first and every other server is preserved), or delete the "genie" entry from .mcp.json by hand.',
    },
  ];
}

// ============================================================================
// Entry point
// ============================================================================

export interface DoctorDeps {
  /** Pre-resolved worktree root; explicit null means outside Git. */
  root?: string | null;
  /** Main checkout root that owns the shared genie.db. */
  databaseRoot?: string | null;
  /** Injected one-shot plugin state keeps tests away from the live Codex home. */
  pluginProbe?: CodexPluginProbe;
  /** Runtime-version seam so tests can cover the declared Bun engine boundary. */
  bunVersion?: string | null;
  /** PATH seam paired with bunVersion. */
  bunPath?: string | null;
  /** Injects the typed project-context fact (explicit `null` = skip the check). */
  projectContext?: ProjectContext | null;
  /** A3 public compatibility probe seam for Orca-mode diagnostics. */
  orcaCompatibilityProbe?: () => Promise<OrcaPluginCompatibilityResult>;
  /**
   * Legacy marker-owned asset classifier. Omitted = the real statically-imported
   * group-2 classifier; explicit `null` = force the "classifier unavailable"
   * branch (tests only).
   */
  legacyClassifier?: LegacyClassifier | null;
}

export async function checkOrcaLifecycle(deps: DoctorDeps, probeLiveRuntime = true): Promise<CheckResult[]> {
  const state = inspectOrcaPluginLifecycle();
  const payloadStatus =
    state.payload === 'owned-clean' || (state.mode === 'standalone' && state.payload === 'unmanaged');
  const results: CheckResult[] = [
    {
      name: 'orchestration authority',
      status: state.mode === 'invalid' ? 'fail' : 'pass',
      detail: `mode=${state.mode}; payload=${state.payload}; host_registration=${state.hostRegistration}`,
      suggestion: state.recovery,
    },
  ];
  if (state.mode !== 'orca') return results;
  if (!payloadStatus) {
    const authority = results[0];
    if (authority !== undefined) results[0] = { ...authority, status: 'fail' };
    return results;
  }
  if (!probeLiveRuntime && deps.orcaCompatibilityProbe === undefined) return results;
  try {
    const probe =
      deps.orcaCompatibilityProbe ??
      (async () => {
        const { createOrcaPluginRuntime } = await import('../../plugins/genie/orca-runtime.js');
        return createOrcaPluginRuntime().probe();
      });
    const compatibility = await probe();
    results.push({
      name: 'Orca compatibility',
      status: 'pass',
      detail: `runtime=${compatibility.runtimeVersion}; contract=${compatibility.contract}; runtime_id=${compatibility.runtimeId}`,
    });
  } catch (error) {
    results.push({
      name: 'Orca compatibility',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      suggestion: 'Use a supported Orca runtime, then retry `genie setup --orchestration-mode orca`.',
    });
  }
  return results;
}

export async function doctorCommand(options?: { json?: boolean; fix?: boolean }, deps: DoctorDeps = {}): Promise<void> {
  // One bounded Git resolution and one bounded Codex plugin query feed every
  // downstream check. No doctor branch independently re-spawns either probe.
  const injectedRoot = deps.root === null || typeof deps.root === 'string';
  const gitRoots = injectedRoot ? null : resolveGitProjectRoots();
  const root = injectedRoot ? (deps.root ?? null) : (gitRoots?.worktreeRoot ?? null);
  const databaseRoot =
    deps.databaseRoot === null || typeof deps.databaseRoot === 'string'
      ? deps.databaseRoot
      : (gitRoots?.commonRoot ?? root);

  // --fix: run the cleanups BEFORE the checks so the report below reflects the
  // post-fix state, and AFTER the Git resolution above because the worktree
  // cleanup is scoped to the resolved repo root. Without --fix, detection only —
  // both residue checks are pure reads and nothing on disk changes. In --json
  // mode stdout belongs to the JSON document, so cleanup chatter goes to stderr.
  const cleanupOptions = options?.json ? { logSink: (line: string) => process.stderr.write(`${line}\n`) } : {};
  if (options?.fix) {
    cleanupV4(cleanupOptions);
    cleanupLaunchWorktrees(root, cleanupOptions);
    // Mode repair runs AFTER worktree removal: the removal scan decides on the
    // pre-repair state, so a worktree whose only dirt is mode drift is never
    // removed in the same run that tightens it (removal stays fail-closed on
    // the state the user last saw; the next --fix may reclaim it).
    repairWorktreeModes(root, cleanupOptions);
  }

  const pluginProbe = deps.pluginProbe?.cliAvailable !== undefined ? deps.pluginProbe : probeCodexGeniePlugin();
  const results: CheckResult[] = [
    ...checkGenieBinary(),
    ...(await checkOrcaLifecycle(deps, !injectedRoot || deps.orcaCompatibilityProbe !== undefined)),
    ...checkGit(root),
    ...checkDatabase(databaseRoot),
    ...checkSkills(root),
    ...checkSkillsChannel(),
    ...(await checkLegacyIntegrations(deps)),
    ...checkBun(deps.bunVersion, deps.bunPath),
    ...checkSubagentModelOverride(),
    ...(await checkCodexIntegration(root, pluginProbe)),
    // Live context resolution only when the root itself was live-resolved: an
    // injected root without an injected context is a unit-test seam, not a repo.
    ...checkCodexProjectContext(
      root,
      deps.projectContext !== undefined ? deps.projectContext : injectedRoot ? null : undefined,
    ),
    ...checkV4Residue(),
    ...checkLaunchWorktrees(root),
    ...checkWorktreeModes(root),
    ...(await checkOmniHookTimeout()),
    ...(await checkOmniBridgeHealth()),
    ...checkIndexLaneDrift(root, databaseRoot),
    ...checkRetiredJsonMcpEntry(root),
  ];

  const failed = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');

  if (options?.json) {
    out(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2));
  } else {
    out('genie doctor');
    out('');
    for (const line of results.flatMap(renderCheckLines)) out(line);
    out('');
    if (failed.length > 0) out(`\x1b[31m${failed.length} check(s) failed.\x1b[0m`);
    else if (warnings.length > 0) out(`\x1b[33m${warnings.length} warning(s) need attention.\x1b[0m`);
    else out('\x1b[32mAll checks passed.\x1b[0m');
  }

  if (failed.length > 0) process.exitCode = 1;
}
