/**
 * Plugin-era integration retirement — the one place that knows every
 * marker-owned asset the `genie@automagik` plugin era left on a host.
 *
 * Wish `skills-everywhere` replaced four per-agent plugin/mirror writers with a
 * single skills.sh channel (`skills-installer.ts`). An already-installed host
 * therefore carries assets no supported code path writes any more: a Codex
 * plugin registration and cache, Claude marketplace registration/cache, a
 * stamped `council.js`, bare-name role-agent and skill mirrors, Hermes config
 * legs, and symlinks into `$GENIE_HOME/plugins/*`. This module classifies them,
 * and `genie update` retires the provably-clean ones exactly once.
 *
 * Three rules govern every surface:
 *
 *   1. **Classify, then act.** Nothing is removed on path authority. Each entry
 *      is `managed-clean` (provably genie's own, unmodified), `managed-modified`
 *      (ours, but edited/ambiguous), `unmanaged` (someone else's), or `absent`.
 *      ONLY `managed-clean` is removed; everything else is kept AND reported.
 *      Every classifier is the SAME one sync/doctor/uninstall already use —
 *      `inspectManagedSkillTree`, `inspectManagedWorkflow`,
 *      `inspectCodexAgentOwnership`, `readAgentFilesManifestState` +
 *      `computeFileDigest` — so ownership can never drift between the module
 *      that writes an asset and the module that retires it.
 *   2. **Backup first.** Every removed object is copied under
 *      `<GENIE_HOME>/state-backups/integration-retirement-<timestamp>/`,
 *      preserving its home-relative structure — the convention `legacy-v4.ts`
 *      established, including its one exception: a re-downloadable plugin cache
 *      backs up a file MANIFEST instead of its payload.
 *   3. **Idempotent by construction.** A retired surface classifies `absent` on
 *      the next run, so a second pass removes nothing, writes nothing, and
 *      allocates no backup directory. That property is what lets the retirement
 *      run unconditionally at the end of every `genie update`.
 *
 * Deliberately OUT of scope:
 *   - the obsolete Codex OTel exporter block (owned by `migrateDeadGenieOtel`),
 *   - project-scoped `.codex/config.toml` / `.mcp.json` (`codex-project-mcp.ts`),
 *   - `$GENIE_HOME/plugins/{hermes,pi}-genie` themselves — those dirs are
 *     genie-owned payload, not host integration state; only the AGENT-side
 *     references to them are retired,
 *   - the codex role-agent inventory: stale metadata that names removed files
 *     is harmless (every entry classifies `absent`), while rewriting it would
 *     mutate state another owner controls.
 *
 * `~/.claude/plugins/known_marketplaces.json` and `~/.claude/settings.json` are
 * IN scope, but only for the single genie-written key each carries — the
 * `automagik` marketplace entry and `enabledPlugins["genie@automagik"]`. Both
 * files are user-owned, so every other key round-trips untouched and the exact
 * key IS the ownership marker; leaving them behind is what kept a retired host
 * reporting "installed" and left Claude Code an enabled-but-uninstalled plugin.
 */

import {
  type Dirent,
  type Stats,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MANIFEST_NAME,
  TARGET_NAME,
  WORKFLOW_MANIFEST_NAME,
  codexLegacyCuratedDir,
  computeFileDigest,
  inspectManagedSkillTree,
  inspectManagedWorkflow,
  readAgentFilesManifestState,
  resolveHermesConfigPath,
} from './agent-sync.js';
import { fsyncPath, writeAllSync } from './atomic-fs.js';
import { resolveClaudeDir, resolveCodexDir, resolveHermesHome, resolvePiExtensionsDir } from './genie-home.js';
import { retireMcpServersGenie } from './hermes-mcp-config.js';
import { inspectCodexAgentOwnership, removeCodexPluginRegistration } from './runtime-integrations.js';

// ============================================================================
// Contract
// ============================================================================

/** Every retired plugin-era asset family, one per report surface. */
export type LegacyIntegrationSurface =
  | 'codex-plugin-registration'
  | 'codex-plugin-cache'
  | 'codex-role-agent'
  | 'codex-legacy-curated-skill'
  | 'claude-plugin-registry'
  | 'claude-plugin-cache'
  | 'claude-marketplace-registration'
  | 'claude-enabled-plugin'
  | 'claude-workflow'
  | 'claude-agent'
  | 'claude-skill'
  | 'hermes-plugin-link'
  | 'hermes-mcp-server'
  | 'hermes-skills-external-dir'
  | 'pi-extension-link';

export const LEGACY_INTEGRATION_SURFACES: readonly LegacyIntegrationSurface[] = [
  'codex-plugin-registration',
  'codex-plugin-cache',
  'codex-role-agent',
  'codex-legacy-curated-skill',
  'claude-plugin-registry',
  'claude-plugin-cache',
  'claude-marketplace-registration',
  'claude-enabled-plugin',
  'claude-workflow',
  'claude-agent',
  'claude-skill',
  'hermes-plugin-link',
  'hermes-mcp-server',
  'hermes-skills-external-dir',
  'pi-extension-link',
];

/**
 * `managed-clean` is the ONLY removable state. `managed-modified` covers both a
 * user-edited genie asset and an ambiguous marker genie cannot prove it owns;
 * `unmanaged` is provably someone else's object at a path genie also uses.
 */
export type LegacyIntegrationState = 'managed-clean' | 'managed-modified' | 'unmanaged' | 'absent';

export interface LegacyIntegrationEntry {
  surface: LegacyIntegrationSurface;
  path: string;
  state: LegacyIntegrationState;
  /** Operator-facing reason, present when it adds something the state does not. */
  detail?: string;
}

/** Agent homes the classification reads. Only `home` and `genieHome` are required. */
export interface LegacyIntegrationHomes {
  home: string;
  genieHome: string;
  codexHome?: string;
  claudeDir?: string;
  hermesHome?: string;
  /** `<pi agent dir>/extensions`; defaults to {@link resolvePiExtensionsDir}. */
  piExtensionsDir?: string;
}

interface ResolvedHomes {
  home: string;
  genieHome: string;
  codexHome: string;
  claudeDir: string;
  hermesHome: string;
  piExtensionsDir: string;
}

export interface LegacyIntegrationReport {
  homes: ResolvedHomes;
  /** Every surface appears at least once; a surface with nothing on disk is `absent`. */
  entries: LegacyIntegrationEntry[];
}

export interface RetireLegacyIntegrationsOptions {
  /** Backup root for this run. Created lazily — an empty retirement creates nothing. */
  backupRoot: string;
  now?: Date;
  /**
   * Ordering seam: invoked AFTER an entry's backup is durable and BEFORE its
   * mutation runs. A test that throws here proves backup-before-removal — the
   * only property a passing removal can never demonstrate. Real callers pass
   * nothing.
   */
  onBeforeRemove?: (entry: LegacyIntegrationEntry) => void;
}

export interface LegacyIntegrationRemoval extends LegacyIntegrationEntry {
  /** Where the removed bytes (or, for a plugin cache, its file manifest) were preserved. */
  backupPath: string;
}

export interface LegacyIntegrationFailure extends LegacyIntegrationEntry {
  reason: string;
}

export interface LegacyIntegrationRetirementResult {
  removed: LegacyIntegrationRemoval[];
  /** Everything classified `managed-modified` or `unmanaged`, plus anything that failed. */
  kept: LegacyIntegrationEntry[];
  /** Per-entry errors; a failure keeps the asset and never aborts the remaining surfaces. */
  failures: LegacyIntegrationFailure[];
  backupRoot: string;
  /** False when nothing was ever written under `backupRoot` (it was not created). */
  backupRootUsed: boolean;
}

// ============================================================================
// Marker literals
// ============================================================================

/**
 * The Codex plugin table Genie registers. Removal itself lives in
 * `runtime-integrations.ts` beside `setCodexPluginEnabled`; this classifier only
 * needs to answer "is a registration present, and is it unambiguous?".
 */
const CODEX_PLUGIN_TABLE_HEADER = '[plugins."genie@automagik"]';

/** Codex's own per-hook approval rows for the retired plugin, in either on-disk shape. */
const CODEX_HOOK_STATE_ROW = /(^|\n)[ \t]*(\[hooks\.state\."genie@automagik:|"genie@automagik:[^"]*"[ \t]*=)/;

/** The Claude marketplace plugin id, as it appears in `installed_plugins.json`. */
const CLAUDE_PLUGIN_ID = 'genie@automagik';

/**
 * The marketplace NAME genie registers in `known_marketplaces.json` (written by
 * `plugin marketplace add <bundle root>`; see `runtime-integrations.ts`'s
 * `readClaudeMarketplaceSource` for the entry shape this classifier reads).
 */
const CLAUDE_MARKETPLACE_ID = 'automagik';

/**
 * Restated from `hermes-skills-config.ts` (its `MARKER` is module-private).
 * `legacy-integration-retirement.test.ts` asserts the literal still appears in
 * that file, so the two can never drift apart silently.
 */
const HERMES_SKILLS_MARKER = '# genie:managed:skills.external_dirs';

/**
 * Shared prefix of `hermes-mcp-config.ts`'s begin/end marker pair. Classification
 * counts occurrences (2 = one well-formed pair); removal is delegated to that
 * module's `retireMcpServersGenie`, so only the count logic lives here.
 */
const HERMES_MCP_MARKER_PREFIX = '# genie:managed:mcp_servers.genie';

// ============================================================================
// Classification
// ============================================================================

export function classifyLegacyIntegrations(homes: LegacyIntegrationHomes): LegacyIntegrationReport {
  const resolved: ResolvedHomes = {
    home: homes.home,
    genieHome: homes.genieHome,
    codexHome: homes.codexHome ?? resolveCodexDir(process.env, homes.home),
    claudeDir: homes.claudeDir ?? resolveClaudeDir(),
    hermesHome: homes.hermesHome ?? resolveHermesHome(),
    piExtensionsDir: homes.piExtensionsDir ?? resolvePiExtensionsDir(),
  };
  const entries: LegacyIntegrationEntry[] = [];
  classifyCodex(resolved, entries);
  classifyClaude(resolved, entries);
  classifyHermes(resolved, entries);
  classifyPi(resolved, entries);
  for (const surface of LEGACY_INTEGRATION_SURFACES) {
    if (entries.some((entry) => entry.surface === surface)) continue;
    entries.push({ surface, path: surfaceRoot(surface, resolved), state: 'absent' });
  }
  return { homes: resolved, entries };
}

/** The canonical path a surface with nothing on disk reports as `absent`. */
function surfaceRoot(surface: LegacyIntegrationSurface, homes: ResolvedHomes): string {
  switch (surface) {
    case 'codex-plugin-registration':
      return join(homes.codexHome, 'config.toml');
    case 'codex-plugin-cache':
      return pluginCacheFamilyDir(homes.codexHome);
    case 'codex-role-agent':
      return join(homes.codexHome, 'agents');
    case 'codex-legacy-curated-skill':
      return codexLegacyCuratedDir(homes.codexHome);
    case 'claude-plugin-registry':
      return join(homes.claudeDir, 'plugins', 'installed_plugins.json');
    case 'claude-plugin-cache':
      return pluginCacheFamilyDir(homes.claudeDir);
    case 'claude-marketplace-registration':
      return claudeMarketplaceRegistryPath(homes.claudeDir);
    case 'claude-enabled-plugin':
      return claudeSettingsPath(homes.claudeDir);
    case 'claude-workflow':
      return join(homes.claudeDir, 'workflows', TARGET_NAME);
    case 'claude-agent':
      return join(homes.claudeDir, 'agents');
    case 'claude-skill':
      return join(homes.claudeDir, 'skills');
    case 'hermes-plugin-link':
      return join(homes.hermesHome, 'plugins', 'genie');
    case 'hermes-mcp-server':
    case 'hermes-skills-external-dir':
      return resolveHermesConfigPath(homes.hermesHome);
    default:
      return join(homes.piExtensionsDir, 'genie');
  }
}

function classifyCodex(homes: ResolvedHomes, entries: LegacyIntegrationEntry[]): void {
  entries.push(classifyCodexRegistration(join(homes.codexHome, 'config.toml')));
  collectPluginCacheGenerations('codex-plugin-cache', homes.codexHome, entries);
  for (const entry of inspectCodexAgentOwnership(homes.codexHome).entries) {
    const state =
      entry.ownership === 'managed-clean'
        ? 'managed-clean'
        : entry.ownership === 'managed-modified'
          ? 'managed-modified'
          : entry.ownership === 'user-owned'
            ? 'unmanaged'
            : 'absent';
    entries.push({ surface: 'codex-role-agent', path: entry.path, state, detail: `role ${entry.state}` });
  }
  collectManagedSkillMirrors('codex-legacy-curated-skill', codexLegacyCuratedDir(homes.codexHome), entries);
}

/**
 * Present + unambiguous is the whole ownership test here: the table header and
 * the `genie@automagik:` hook rows are literals only Genie (and Codex, on
 * Genie's behalf) ever writes. More than one plugin table is the one shape that
 * is ours-but-unprovable — the same "exactly one section" rule
 * `setCodexPluginEnabled` refuses on — so it is kept, never guessed at.
 */
function classifyCodexRegistration(configPath: string): LegacyIntegrationEntry {
  const surface = 'codex-plugin-registration' as const;
  const stat = lstatSafe(configPath);
  if (stat === null) return { surface, path: configPath, state: 'absent' };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { surface, path: configPath, state: 'unmanaged', detail: 'not a physical file' };
  }
  let content: string;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch (error) {
    return { surface, path: configPath, state: 'unmanaged', detail: `unreadable: ${errMsg(error)}` };
  }
  const tables = content.split(CODEX_PLUGIN_TABLE_HEADER).length - 1;
  if (tables === 0 && !CODEX_HOOK_STATE_ROW.test(content)) {
    return { surface, path: configPath, state: 'absent' };
  }
  if (tables > 1) {
    return { surface, path: configPath, state: 'managed-modified', detail: `${tables} plugin tables (ambiguous)` };
  }
  return { surface, path: configPath, state: 'managed-clean' };
}

function classifyClaude(homes: ResolvedHomes, entries: LegacyIntegrationEntry[]): void {
  for (const candidate of [
    join(homes.claudeDir, 'plugins', 'installed_plugins.json'),
    join(homes.claudeDir, 'installed_plugins.json'),
  ]) {
    const entry = classifyClaudePluginRegistry(candidate);
    if (entry.state !== 'absent') entries.push(entry);
  }
  collectPluginCacheGenerations('claude-plugin-cache', homes.claudeDir, entries);
  entries.push(classifyClaudeMarketplaceRegistration(claudeMarketplaceRegistryPath(homes.claudeDir), homes.genieHome));
  entries.push(classifyClaudeEnabledPlugin(claudeSettingsPath(homes.claudeDir)));
  entries.push(classifyClaudeWorkflow(join(homes.claudeDir, 'workflows')));
  collectManagedClaudeAgents(join(homes.claudeDir, 'agents'), entries);
  collectManagedSkillMirrors('claude-skill', join(homes.claudeDir, 'skills'), entries);
}

function classifyClaudePluginRegistry(path: string): LegacyIntegrationEntry {
  const surface = 'claude-plugin-registry' as const;
  const read = readJsonDocument(path);
  if (read.kind !== 'value') return unreadableEntry(surface, path, read);
  const pruned = pruneClaudePluginEntries(read.value);
  return pruned.removed === 0
    ? { surface, path, state: 'absent' }
    : { surface, path, state: 'managed-clean', detail: `${pruned.removed} registration entr(y|ies)` };
}

function claudeMarketplaceRegistryPath(claudeDir: string): string {
  return join(claudeDir, 'plugins', 'known_marketplaces.json');
}

function claudeSettingsPath(claudeDir: string): string {
  return join(claudeDir, 'settings.json');
}

/**
 * The `automagik` marketplace row `plugin marketplace add <bundle root>` wrote.
 * Ownership is the SOURCE, never the name: only a `directory` source resolving
 * inside `$GENIE_HOME` is provably the registration genie itself made, so an
 * operator who re-pointed `automagik` at their own checkout (or a git source)
 * keeps it. The file is user-owned; only this one key is ever dropped.
 */
function classifyClaudeMarketplaceRegistration(path: string, genieHome: string): LegacyIntegrationEntry {
  const surface = 'claude-marketplace-registration' as const;
  const read = readJsonDocument(path);
  if (read.kind !== 'value') return unreadableEntry(surface, path, read);
  if (!isPlainObject(read.value)) {
    return { surface, path, state: 'unmanaged', detail: 'registry root is not a JSON object' };
  }
  const registration = read.value[CLAUDE_MARKETPLACE_ID];
  if (registration === undefined) return { surface, path, state: 'absent' };
  const source = isPlainObject(registration) ? registration.source : undefined;
  const kind = isPlainObject(source) ? source.source : undefined;
  const sourcePath = isPlainObject(source) ? source.path : undefined;
  if (kind !== 'directory' || typeof sourcePath !== 'string' || !isSameOrContained(genieHome, sourcePath)) {
    return {
      surface,
      path,
      state: 'unmanaged',
      detail: `${CLAUDE_MARKETPLACE_ID} is not registered from a directory under ${genieHome}`,
    };
  }
  return { surface, path, state: 'managed-clean', detail: `${CLAUDE_MARKETPLACE_ID} marketplace registration` };
}

/**
 * `enabledPlugins["genie@automagik"]` in the user's own `settings.json`. The key
 * is written by nobody but the plugin-era install, so its PRESENCE is the
 * marker — `false` proves an owned registration exactly as `true` does (the
 * rule `inspectClaudeSettings` already uses). Everything else in the file,
 * including other enabled plugins, round-trips.
 */
function classifyClaudeEnabledPlugin(path: string): LegacyIntegrationEntry {
  const surface = 'claude-enabled-plugin' as const;
  const read = readJsonDocument(path);
  if (read.kind !== 'value') return unreadableEntry(surface, path, read);
  if (!isPlainObject(read.value)) {
    return { surface, path, state: 'unmanaged', detail: 'settings root is not a JSON object' };
  }
  const enabled = read.value.enabledPlugins;
  if (enabled === undefined) return { surface, path, state: 'absent' };
  if (!isPlainObject(enabled)) return { surface, path, state: 'unmanaged', detail: 'enabledPlugins is not an object' };
  if (!Object.hasOwn(enabled, CLAUDE_PLUGIN_ID)) return { surface, path, state: 'absent' };
  return { surface, path, state: 'managed-clean', detail: `enabledPlugins["${CLAUDE_PLUGIN_ID}"]` };
}

type JsonDocument =
  | { kind: 'value'; value: unknown }
  | { kind: 'absent' }
  | { kind: 'unreadable'; state: 'unmanaged' | 'managed-modified'; detail: string };

/** Shared JSON read for the three user-owned registries this module edits. */
function readJsonDocument(path: string): JsonDocument {
  const stat = lstatSafe(path);
  if (stat === null) return { kind: 'absent' };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { kind: 'unreadable', state: 'unmanaged', detail: 'not a physical file' };
  }
  try {
    return { kind: 'value', value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { kind: 'unreadable', state: 'managed-modified', detail: `unparseable JSON: ${errMsg(error)}` };
  }
}

function unreadableEntry(
  surface: LegacyIntegrationSurface,
  path: string,
  read: Exclude<JsonDocument, { kind: 'value' }>,
): LegacyIntegrationEntry {
  return read.kind === 'absent'
    ? { surface, path, state: 'absent' }
    : { surface, path, state: read.state, detail: read.detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyClaudeWorkflow(workflowsDir: string): LegacyIntegrationEntry {
  const surface = 'claude-workflow' as const;
  const inspected = inspectManagedWorkflow(workflowsDir);
  if (inspected.state === 'managed-clean') {
    return { surface, path: inspected.targetPath, state: 'managed-clean' };
  }
  if (inspected.state === 'unmanaged') {
    return lstatSafe(inspected.targetPath) === null
      ? { surface, path: inspected.targetPath, state: 'absent' }
      : { surface, path: inspected.targetPath, state: 'unmanaged', detail: 'no genie ownership sidecar' };
  }
  return { surface, path: inspected.targetPath, state: 'managed-modified', detail: inspected.state };
}

/**
 * Manifest-owned bare-name role agents. Ownership comes from
 * `~/.claude/agents/.genie-sync.json`; cleanliness from the SAME digest the
 * manifest recorded, so a hand-edited agent is `managed-modified` and survives.
 */
function collectManagedClaudeAgents(agentsDir: string, entries: LegacyIntegrationEntry[]): void {
  const manifest = readAgentFilesManifestState(agentsDir);
  if (manifest.kind === 'absent') return;
  if (manifest.kind !== 'managed') {
    entries.push({
      surface: 'claude-agent',
      path: join(agentsDir, MANIFEST_NAME),
      state: 'unmanaged',
      detail: manifest.kind === 'unsafe' ? `unsafe manifest: ${manifest.reason}` : 'foreign manifest',
    });
    return;
  }
  for (const [name, owned] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) {
    const path = join(agentsDir, name);
    const stat = lstatSafe(path);
    if (stat === null) {
      entries.push({ surface: 'claude-agent', path, state: 'absent' });
      continue;
    }
    const clean = stat.isFile() && !stat.isSymbolicLink() && digestOrNull(path) === owned.digest;
    entries.push({
      surface: 'claude-agent',
      path,
      state: clean ? 'managed-clean' : 'managed-modified',
      ...(clean ? {} : { detail: 'digest differs from the manifest' }),
    });
  }
}

/**
 * Managed bare-name skill mirrors under a skills parent.
 *
 * A child WITHOUT a `.genie-sync.json` is not a candidate at all and produces no
 * entry: that is the skills.sh channel's own plain copy (or a user's skill), not
 * a plugin-era mirror, and listing every one of them would bury the report.
 * A child WITH one is classified by the shared `inspectManagedSkillTree`.
 */
function collectManagedSkillMirrors(
  surface: 'claude-skill' | 'codex-legacy-curated-skill',
  parent: string,
  entries: LegacyIntegrationEntry[],
): void {
  for (const child of childDirectories(parent)) {
    const path = join(parent, child.name);
    if (lstatSafe(join(path, MANIFEST_NAME)) === null) continue;
    const inspected = inspectManagedSkillTree(path);
    if (inspected.state === 'managed-clean') {
      entries.push({ surface, path, state: 'managed-clean' });
      continue;
    }
    entries.push(
      inspected.state === 'unmanaged'
        ? { surface, path, state: 'unmanaged', detail: 'sync manifest is not genie-owned' }
        : { surface, path, state: 'managed-modified', detail: inspected.state },
    );
  }
}

/**
 * Version generations under `<agentHome>/plugins/cache/automagik/genie/`. The
 * namespace is genie's alone, so a physical directory there is ours; anything
 * else (a symlink, a file) is left for a human.
 */
function collectPluginCacheGenerations(
  surface: 'codex-plugin-cache' | 'claude-plugin-cache',
  agentHome: string,
  entries: LegacyIntegrationEntry[],
): void {
  const family = pluginCacheFamilyDir(agentHome);
  for (const child of readdirSafe(family)) {
    const path = join(family, child.name);
    const stat = lstatSafe(path);
    if (stat === null) continue;
    entries.push(
      stat.isDirectory() && !stat.isSymbolicLink()
        ? { surface, path, state: 'managed-clean' }
        : { surface, path, state: 'unmanaged', detail: 'not a physical directory' },
    );
  }
}

function pluginCacheFamilyDir(agentHome: string): string {
  return join(agentHome, 'plugins', 'cache', 'automagik', 'genie');
}

function classifyHermes(homes: ResolvedHomes, entries: LegacyIntegrationEntry[]): void {
  for (const linkPath of hermesLinkPaths(homes.hermesHome)) {
    const entry = classifyGenieLink('hermes-plugin-link', linkPath, homes.genieHome, 'hermes-genie');
    if (entry.state !== 'absent') entries.push(entry);
  }
  const configPath = resolveHermesConfigPath(homes.hermesHome);
  const stat = lstatSafe(configPath);
  if (stat === null) return;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    for (const surface of ['hermes-mcp-server', 'hermes-skills-external-dir'] as const) {
      entries.push({ surface, path: configPath, state: 'unmanaged', detail: 'not a physical file' });
    }
    return;
  }
  let content: string;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch (error) {
    for (const surface of ['hermes-mcp-server', 'hermes-skills-external-dir'] as const) {
      entries.push({ surface, path: configPath, state: 'unmanaged', detail: `unreadable: ${errMsg(error)}` });
    }
    return;
  }
  entries.push(
    classifyByMarkerCount('hermes-mcp-server', configPath, occurrences(content, HERMES_MCP_MARKER_PREFIX), 2),
  );
  entries.push(
    classifyByMarkerCount('hermes-skills-external-dir', configPath, occurrences(content, HERMES_SKILLS_MARKER), 1),
  );
}

/** `expected` marks = one well-formed managed block; anything else is unprovable and kept. */
function classifyByMarkerCount(
  surface: LegacyIntegrationSurface,
  path: string,
  found: number,
  expected: number,
): LegacyIntegrationEntry {
  if (found === 0) return { surface, path, state: 'absent' };
  if (found === expected) return { surface, path, state: 'managed-clean' };
  return { surface, path, state: 'managed-modified', detail: `${found} markers (expected ${expected})` };
}

/** `<hermesHome>/plugins/genie` plus the same link under every well-named profile. */
function hermesLinkPaths(hermesHome: string): string[] {
  const paths = [join(hermesHome, 'plugins', 'genie')];
  const profilesRoot = join(hermesHome, 'profiles');
  for (const child of childDirectories(profilesRoot)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(child.name)) continue;
    paths.push(join(profilesRoot, child.name, 'plugins', 'genie'));
  }
  return paths;
}

function classifyPi(homes: ResolvedHomes, entries: LegacyIntegrationEntry[]): void {
  entries.push(
    classifyGenieLink('pi-extension-link', join(homes.piExtensionsDir, 'genie'), homes.genieHome, 'pi-genie'),
  );
}

/**
 * A plugin link is ours only when it is a symlink resolving INTO the genie-owned
 * source dir it was created from — never on pathname alone, so a dev checkout
 * symlinked at the same path is preserved.
 */
function classifyGenieLink(
  surface: 'hermes-plugin-link' | 'pi-extension-link',
  linkPath: string,
  genieHome: string,
  sourceName: string,
): LegacyIntegrationEntry {
  const stat = lstatSafe(linkPath);
  if (stat === null) return { surface, path: linkPath, state: 'absent' };
  if (!stat.isSymbolicLink()) return { surface, path: linkPath, state: 'unmanaged', detail: 'not a symlink' };
  let target: string;
  try {
    target = readlinkSync(linkPath);
  } catch (error) {
    return { surface, path: linkPath, state: 'unmanaged', detail: `unreadable link: ${errMsg(error)}` };
  }
  const resolved = resolve(dirname(linkPath), target);
  const owned = [join(genieHome, 'plugins', sourceName), join(genieHome, 'bin', 'plugins', sourceName)];
  return owned.some((root) => isSameOrContained(root, resolved))
    ? { surface, path: linkPath, state: 'managed-clean' }
    : { surface, path: linkPath, state: 'unmanaged', detail: `points outside ${sourceName}: ${target}` };
}

// ============================================================================
// Retirement
// ============================================================================

interface BackupContext {
  root: string;
  home: string;
  used: boolean;
  stamp: string;
  /** Live count of objects written under `root`, so a discarded backup can un-use it. */
  writes: number;
  onBeforeRemove?: (entry: LegacyIntegrationEntry) => void;
}

/** One backup attempt. `wrote` is false when the destination already held pristine bytes. */
interface BackupWrite {
  path: string;
  wrote: boolean;
}

/** What a surface's mutation actually did. `changed: false` means nothing was written. */
interface EntryRetirement {
  changed: boolean;
  /** Why nothing changed — carried onto the kept entry, never onto a removal. */
  detail?: string;
}

interface EntryOutcome extends EntryRetirement {
  backupPath: string;
}

export function retireLegacyIntegrations(
  report: LegacyIntegrationReport,
  options: RetireLegacyIntegrationsOptions,
): LegacyIntegrationRetirementResult {
  const now = options.now ?? new Date();
  const backup: BackupContext = {
    root: options.backupRoot,
    home: report.homes.home,
    used: false,
    stamp: now.toISOString(),
    writes: 0,
    onBeforeRemove: options.onBeforeRemove,
  };
  const result: LegacyIntegrationRetirementResult = {
    removed: [],
    kept: [],
    failures: [],
    backupRoot: options.backupRoot,
    backupRootUsed: false,
  };
  for (const entry of report.entries) {
    if (entry.state === 'absent') continue;
    if (entry.state !== 'managed-clean') {
      result.kept.push(entry);
      continue;
    }
    try {
      const outcome = retireEntry(entry, report.homes, backup, now);
      // A remover that made NO change never counts as a removal: the entry is
      // classified-clean but not in a shape this module can retire, so it is
      // kept and reported, and its backup is discarded — otherwise every future
      // update would "retire" it again and allocate a fresh backup root forever.
      if (outcome.changed) result.removed.push({ ...entry, backupPath: outcome.backupPath });
      else {
        result.kept.push({
          ...entry,
          state: 'managed-modified',
          detail: outcome.detail ?? 'nothing to remove (unrecognized shape)',
        });
      }
    } catch (error) {
      result.kept.push(entry);
      result.failures.push({ ...entry, reason: errMsg(error) });
    }
  }
  result.backupRootUsed = backup.used;
  return result;
}

/**
 * Back up, then retire, one classified-clean entry.
 *
 * Every arm reports what its mutation ACTUALLY did: the three surfaces whose
 * removers are content-preserving editors (the Codex registration, and the two
 * Hermes config legs) can classify clean and still find nothing they own to
 * remove — a `genie@automagik:` row outside `[hooks.state]`, a marker on a
 * comment line — and that `unchanged` must never be reported as a removal.
 */
function retireEntry(
  entry: LegacyIntegrationEntry,
  homes: ResolvedHomes,
  backup: BackupContext,
  now: Date,
): EntryOutcome {
  switch (entry.surface) {
    case 'codex-plugin-registration':
      return withBackup(backup, entry, backupObject(backup, entry.path), () => {
        const removal = removeCodexPluginRegistration(entry.path);
        if (!removal.ok) throw new Error(removal.detail);
        return {
          changed: removal.status === 'removed',
          detail: `codex config carries no removable registration (${removal.status})`,
        };
      });
    case 'codex-plugin-cache':
    case 'claude-plugin-cache':
      // Re-downloadable payload: a file listing is the backup (legacy-v4 rule).
      return withBackup(backup, entry, backupTreeManifest(backup, entry.path, entry.surface), () => {
        rmSync(entry.path, { recursive: true, force: true });
        // The generation was the family dir's only reason to exist.
        pruneEmptyDir(dirname(entry.path));
        pruneEmptyDir(dirname(dirname(entry.path)));
        return { changed: true };
      });
    case 'codex-role-agent':
    case 'claude-agent':
      return withBackup(backup, entry, backupObject(backup, entry.path), () => {
        unlinkSync(entry.path);
        return { changed: true };
      });
    case 'codex-legacy-curated-skill':
    case 'claude-skill':
      return withBackup(backup, entry, backupObject(backup, entry.path), () => {
        rmSync(entry.path, { recursive: true, force: true });
        if (entry.surface === 'codex-legacy-curated-skill') pruneEmptyDir(codexLegacyCuratedDir(homes.codexHome));
        return { changed: true };
      });
    case 'claude-plugin-registry':
      return withBackup(backup, entry, backupObject(backup, entry.path), () => ({
        changed: writeClaudePluginRegistryWithoutGenie(entry.path),
        detail: 'no genie@automagik registration entry left to drop',
      }));
    case 'claude-marketplace-registration':
      return withBackup(backup, entry, backupObject(backup, entry.path), () => ({
        changed: removeClaudeMarketplaceRegistration(entry.path),
        detail: `no ${CLAUDE_MARKETPLACE_ID} marketplace entry left to drop`,
      }));
    case 'claude-enabled-plugin':
      return withBackup(backup, entry, backupObject(backup, entry.path), () => ({
        changed: removeClaudeEnabledPlugin(entry.path),
        detail: `no enabledPlugins["${CLAUDE_PLUGIN_ID}"] key left to drop`,
      }));
    case 'claude-workflow': {
      const sidecar = join(dirname(entry.path), WORKFLOW_MANIFEST_NAME);
      const written = backupObject(backup, entry.path);
      backupObject(backup, sidecar);
      return withBackup(backup, entry, written, () => {
        unlinkSync(entry.path);
        rmSync(sidecar, { force: true });
        return { changed: true };
      });
    }
    case 'hermes-mcp-server':
      return withBackup(backup, entry, backupObject(backup, entry.path), () => ({
        changed: retireMcpServersGenie({ configPath: entry.path, now }).status !== 'unchanged',
        detail: 'no complete managed MCP marker block to remove',
      }));
    case 'hermes-skills-external-dir':
      return withBackup(backup, entry, backupObject(backup, entry.path), () => ({
        changed: removeMarkedExternalDir(entry.path) !== 'unchanged',
        detail: 'no marked external_dirs item to remove',
      }));
    default:
      return withBackup(backup, entry, backupSymlink(backup, entry.path), () => {
        unlinkSync(entry.path);
        return { changed: true };
      });
  }
}

/**
 * The backup-before-removal contract, in one place: the backup is already
 * durable when `remove` runs, a THROWN removal keeps it (it is the recovery
 * material for a half-applied mutation), and a removal that changed nothing
 * discards it so no run leaves an empty backup root behind.
 */
function withBackup(
  backup: BackupContext,
  entry: LegacyIntegrationEntry,
  written: BackupWrite,
  remove: () => EntryRetirement,
): EntryOutcome {
  backup.onBeforeRemove?.(entry);
  const outcome = remove();
  if (!outcome.changed) discardBackupWrite(backup, written);
  return { ...outcome, backupPath: written.path };
}

/** Remove a directory only when it is empty; anything else is a caller's asset. */
function pruneEmptyDir(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Missing, non-empty, or unreadable — all mean "leave it alone".
  }
}

// ============================================================================
// Backups (legacy-v4 convention: home-relative structure under one run root)
// ============================================================================

function backupDestination(backup: BackupContext, path: string): string {
  const rel = relative(backup.home, path);
  const insideHome = rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
  // A relocated agent home (CODEX_HOME, PI_CODING_AGENT_DIR, …) can sit outside
  // `home`; those land under `absolute/` rather than climbing out of the root.
  return insideHome ? join(backup.root, rel) : join(backup.root, 'absolute', path.replace(/^[/\\]+/, ''));
}

/**
 * Copy one object (file, directory tree, or symlink) into the run's backup root.
 * First write wins: two surfaces sharing a path (the Hermes config legs) preserve
 * the PRISTINE bytes, not the half-retired ones.
 */
function backupObject(backup: BackupContext, path: string): BackupWrite {
  const dest = backupDestination(backup, path);
  if (existsSync(dest)) return { path: dest, wrote: false };
  if (lstatSafe(path) === null) return { path: dest, wrote: false };
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  cpSync(path, dest, { recursive: true, verbatimSymlinks: true });
  return recordBackupWrite(backup, dest);
}

/** A symlink's recovery material is its target; record it as text. */
function backupSymlink(backup: BackupContext, path: string): BackupWrite {
  const dest = `${backupDestination(backup, path)}.symlink`;
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  writeDurableFile(dest, `${readlinkSync(path)}\n`);
  return recordBackupWrite(backup, dest);
}

function backupTreeManifest(backup: BackupContext, path: string, label: string): BackupWrite {
  const dest = join(backup.root, 'cache-manifests', `${label}-${path.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const lines = [`# plugin cache manifest — ${path}`, `# removed: ${backup.stamp}`, ...listRelativeFiles(path)];
  writeDurableFile(dest, `${lines.join('\n')}\n`);
  return recordBackupWrite(backup, dest);
}

/**
 * Mark one backup object as written and force it to disk BEFORE its original is
 * unlinked. `cpSync`/`writeFileSync` only reach the page cache, so a crash
 * between the copy and the removal could otherwise lose both the asset and the
 * only copy of it. File fsync is strict (a failure throws, the entry is kept and
 * reported); the directory-entry flushes are best-effort, exactly as in
 * `atomic-fs.ts`.
 */
function recordBackupWrite(backup: BackupContext, dest: string): BackupWrite {
  fsyncBackupTree(dest);
  fsyncBackupAncestors(backup, dirname(dest));
  backup.used = true;
  backup.writes += 1;
  return { path: dest, wrote: true };
}

/** Write a whole file and fsync it before the descriptor is closed. */
function writeDurableFile(path: string, content: string): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeAllSync(fd, Buffer.from(content, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncBackupTree(path: string): void {
  const stat = lstatSafe(path);
  // A verbatim-copied symlink carries no bytes of its own, and opening it would
  // fsync whatever it points at instead.
  if (stat === null || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const child of readdirSafe(path)) fsyncBackupTree(join(path, child.name));
  }
  fsyncPath(path);
}

function fsyncBackupAncestors(backup: BackupContext, from: string): void {
  let current = from;
  while (isSameOrContained(backup.root, current)) {
    fsyncPath(current);
    const parent = dirname(current);
    if (current === backup.root || parent === current) break;
    current = parent;
  }
  fsyncPath(dirname(backup.root));
}

/**
 * Undo one backup write when its removal turned out to change nothing, pruning
 * every directory the write created — up to and including the run root, so an
 * update that retires nothing leaves no `state-backups/` generation behind.
 */
function discardBackupWrite(backup: BackupContext, written: BackupWrite): void {
  if (!written.wrote) return;
  rmSync(written.path, { recursive: true, force: true });
  backup.writes -= 1;
  let current = dirname(written.path);
  while (isSameOrContained(backup.root, current)) {
    pruneEmptyDir(current);
    if (existsSync(current)) break;
    const parent = dirname(current);
    if (current === backup.root || parent === current) break;
    current = parent;
  }
  if (backup.writes === 0) {
    pruneEmptyDir(backup.root);
    // A run that retired nothing leaves no trace at all, not even the
    // `state-backups/` parent this run would have been the first to create.
    pruneEmptyDir(dirname(backup.root));
    backup.used = false;
  }
}

function listRelativeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSafe(dir)) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else out.push(relative(root, entryPath));
    }
  };
  walk(root);
  return out.sort();
}

// ============================================================================
// Content-preserving edits
// ============================================================================

/**
 * Drop every `genie@automagik` registration from a parsed Claude plugin
 * registry, in any of the three shapes the file is known to use — a bare string
 * in a list, an object carrying `id`/`pluginId`, or a key on a map — while
 * preserving every other key, including ones genie does not understand.
 */
function pruneClaudePluginEntries(value: unknown): { value: unknown; removed: number } {
  if (Array.isArray(value)) {
    let removed = 0;
    const next: unknown[] = [];
    for (const item of value) {
      if (isClaudeGeniePluginRecord(item)) {
        removed += 1;
        continue;
      }
      const pruned = pruneClaudePluginEntries(item);
      removed += pruned.removed;
      next.push(pruned.value);
    }
    return { value: next, removed };
  }
  if (typeof value !== 'object' || value === null) return { value, removed: 0 };
  let removed = 0;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === CLAUDE_PLUGIN_ID) {
      removed += 1;
      continue;
    }
    const pruned = pruneClaudePluginEntries(item);
    removed += pruned.removed;
    next[key] = pruned.value;
  }
  return { value: next, removed };
}

function isClaudeGeniePluginRecord(item: unknown): boolean {
  if (item === CLAUDE_PLUGIN_ID) return true;
  if (typeof item !== 'object' || item === null) return false;
  return Reflect.get(item, 'id') === CLAUDE_PLUGIN_ID || Reflect.get(item, 'pluginId') === CLAUDE_PLUGIN_ID;
}

function writeClaudePluginRegistryWithoutGenie(path: string): boolean {
  const pruned = pruneClaudePluginEntries(JSON.parse(readFileSync(path, 'utf8')));
  if (pruned.removed === 0) return false;
  writeJsonDocument(path, pruned.value);
  return true;
}

/**
 * Drop ONLY the `automagik` key from Claude's marketplace registry. Every other
 * marketplace — and every key genie does not understand — round-trips.
 */
function removeClaudeMarketplaceRegistration(path: string): boolean {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlainObject(parsed) || !Object.hasOwn(parsed, CLAUDE_MARKETPLACE_ID)) return false;
  const next = { ...parsed };
  delete next[CLAUDE_MARKETPLACE_ID];
  writeJsonDocument(path, next);
  return true;
}

/**
 * Drop ONLY `enabledPlugins["genie@automagik"]` from the user's settings. The
 * `enabledPlugins` map itself survives — empty if that was its last key — because
 * the file belongs to the user and this key is the only thing genie ever wrote.
 */
function removeClaudeEnabledPlugin(path: string): boolean {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlainObject(parsed)) return false;
  const enabled = parsed.enabledPlugins;
  if (!isPlainObject(enabled) || !Object.hasOwn(enabled, CLAUDE_PLUGIN_ID)) return false;
  const nextEnabled = { ...enabled };
  delete nextEnabled[CLAUDE_PLUGIN_ID];
  writeJsonDocument(path, { ...parsed, enabledPlugins: nextEnabled });
  return true;
}

function writeJsonDocument(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Drop the marked `skills.external_dirs` item, and the now-childless
 * `external_dirs:` key with it, preserving every other line byte-for-byte. The
 * result must still parse as YAML and must carry no marker — otherwise the write
 * is refused and the config stays exactly as it was (refusal is acceptable,
 * corruption never is, mirroring `mergeSkillsExternalDir`'s invariant).
 */
function removeMarkedExternalDir(configPath: string): 'updated' | 'unchanged' {
  const original = readFileSync(configPath, 'utf8');
  const marked = new RegExp(`^\\s*-\\s+.*${escapeRegExp(HERMES_SKILLS_MARKER)}\\s*$`);
  const lines = original.split('\n');
  const kept = lines.filter((line) => !marked.test(line));
  if (kept.length === lines.length) return 'unchanged';
  const next = pruneChildlessExternalDirsKeys(kept).join('\n');
  if (next.includes(HERMES_SKILLS_MARKER)) throw new Error('refusing to write: managed marker survived removal');
  try {
    Bun.YAML.parse(next);
  } catch (error) {
    throw new Error(`refusing to write: result would not parse as YAML (${errMsg(error)})`);
  }
  writeFileSync(configPath, next, 'utf8');
  return 'updated';
}

function pruneChildlessExternalDirsKeys(lines: string[]): string[] {
  const out = [...lines];
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const header = /^([ \t]*)external_dirs:[ \t]*(#.*)?$/.exec(out[index]);
    if (header === null) continue;
    const indent = header[1].length;
    let hasItem = false;
    for (let cursor = index + 1; cursor < out.length; cursor += 1) {
      const line = out[cursor];
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      if (line.length - line.trimStart().length <= indent) break;
      if (trimmed.startsWith('- ')) hasItem = true;
    }
    if (!hasItem) out.splice(index, 1);
  }
  return out;
}

// ============================================================================
// Convergence step (the shape `genie update` calls)
// ============================================================================

export interface LegacyIntegrationRetirementOptions {
  homes: LegacyIntegrationHomes;
  log?: (line: string) => void;
  now?: Date;
}

/**
 * Classify, retire, and report in the operator-facing vocabulary. Never throws:
 * a per-surface failure is reported and keeps its asset, because a retirement
 * failure must not fail an update whose bytes are already swapped.
 */
export function runLegacyIntegrationRetirement(
  options: LegacyIntegrationRetirementOptions,
): LegacyIntegrationRetirementResult {
  const emit = options.log ?? (() => undefined);
  const now = options.now ?? new Date();
  const report = classifyLegacyIntegrations(options.homes);
  const backupRoot = join(
    options.homes.genieHome,
    'state-backups',
    `integration-retirement-${now.toISOString().replace(/[:.]/g, '-')}`,
  );
  const result = retireLegacyIntegrations(report, { backupRoot, now });
  for (const entry of result.removed) emit(`retired ${entry.surface}: ${entry.path}`);
  for (const entry of result.kept) {
    const why = entry.detail === undefined ? '' : ` — ${entry.detail}`;
    emit(`kept (${entry.state === 'unmanaged' ? 'unmanaged' : 'modified'}) ${entry.surface}: ${entry.path}${why}`);
  }
  for (const failure of result.failures) emit(`  retirement failed for ${failure.path}: ${failure.reason}`);
  // A run with failures is never "nothing to retire": something WAS owed and did
  // not happen, and the operator has to see that even when nothing came off.
  if (result.failures.length > 0) emit(`retirement incomplete: ${result.failures.length} failure(s)`);
  else if (result.removed.length === 0) emit('nothing to retire');
  if (result.backupRootUsed) emit(`retirement backups: ${result.backupRoot}`);
  return result;
}

// ============================================================================
// Small shared helpers
// ============================================================================

function lstatSafe(path: string): Stats | null {
  try {
    return lstatSync(path) ?? null;
  } catch {
    return null;
  }
}

function readdirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function childDirectories(dir: string): Dirent[] {
  return readdirSafe(dir).filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
}

function digestOrNull(path: string): string | null {
  try {
    return computeFileDigest(path);
  } catch {
    return null;
  }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function isSameOrContained(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
