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

import { createHash, randomBytes } from 'node:crypto';
import {
  type Dirent,
  type Stats,
  chmodSync,
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
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MANIFEST_NAME,
  PHYSICAL_TREE_IDENTITY_VERSION,
  type PhysicalTreeEntry,
  computeDirDigest,
  computeFileDigest,
  computeLegacyRegularTreeDigest,
  fsyncPath,
  physicalEntryKind,
  readTrimmed,
  writeAllSync,
} from './atomic-fs.js';
import { resolveClaudeDir, resolveCodexDir, resolveHermesHome, resolvePiExtensionsDir } from './genie-home.js';
import { retireMcpServersGenie } from './hermes-mcp-config.js';
import {
  CODEX_AGENT_INVENTORY_NAME,
  inspectCodexAgentOwnership,
  removeCodexPluginRegistration,
} from './runtime-integrations.js';

// ============================================================================
// Contract
// ============================================================================

/** Every retired plugin-era asset family, one per report surface. */
export type LegacyIntegrationSurface =
  | 'codex-plugin-registration'
  | 'codex-plugin-cache'
  | 'codex-role-agent'
  | 'codex-role-agent-inventory'
  | 'codex-legacy-curated-skill'
  | 'claude-plugin-registry'
  | 'claude-plugin-cache'
  | 'claude-marketplace-registration'
  | 'claude-marketplace-cache'
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
  'codex-role-agent-inventory',
  'codex-legacy-curated-skill',
  'claude-plugin-registry',
  'claude-plugin-cache',
  'claude-marketplace-registration',
  'claude-marketplace-cache',
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
 * `managedBy` owner of `.genie-role-agents.json`. Restated from
 * `runtime-integrations.ts`, whose constant is module-private and whose
 * transaction engine wish `skills-everywhere-b` Group 3 deletes; retirement
 * outlives the writer, so the literal it classifies on lives here.
 */
const CODEX_AGENT_INVENTORY_OWNER = 'genie-codex-role-agents';

/**
 * Directory prefixes a crashed role-agent transaction leaves in
 * `<codexHome>/agents/`. Same provenance and same reason as the owner above.
 */
const CODEX_AGENT_TRANSACTION_PREFIXES = [
  '.genie-role-agents.txn-',
  '.genie-role-agents.committed-cleanup-',
  '.genie-role-agents.prepare-',
  '.genie-role-agents.conflict-',
] as const;

/**
 * The single source of truth for the Hermes managed-skills marker.
 *
 * It used to be restated from `hermes-skills-config.ts`, with a test asserting
 * the literal still appeared there. Wish `skills-everywhere-b` Group 5 deletes
 * that module, and a marker owned by a file that no longer exists is not a
 * contract. Retirement is the last reader of this marker on disk — every host
 * that still carries it was written by a release that predates the deletion —
 * so the definition lives here and the drift guard is retired with the writer.
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
    case 'codex-role-agent-inventory':
      return join(homes.codexHome, 'agents', CODEX_AGENT_INVENTORY_NAME);
    case 'codex-legacy-curated-skill':
      return codexLegacyCuratedDir(homes.codexHome);
    case 'claude-plugin-registry':
      return join(homes.claudeDir, 'plugins', 'installed_plugins.json');
    case 'claude-plugin-cache':
      return pluginCacheFamilyDir(homes.claudeDir);
    case 'claude-marketplace-registration':
      return claudeMarketplaceRegistryPath(homes.claudeDir);
    case 'claude-marketplace-cache':
      return claudeMarketplaceCacheDir(homes.claudeDir);
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
  classifyCodexRoleAgentInventory(join(homes.codexHome, 'agents'), entries);
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
  classifyClaudeMarketplaceCache(homes.claudeDir, entries);
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

/**
 * The Codex role-agent inventory sidecar and its transaction debris.
 *
 * `codex-role-agent` classifies only `genie-*.toml`, so the sidecar that names
 * them — and every `.genie-role-agents.{txn,conflict,prepare,committed-cleanup}-*`
 * directory a crashed transaction left behind — survived every retirement run.
 * A host with zero role agents left still carried genie's own inventory file.
 *
 * The name is genie's alone (`runtime-integrations.ts` writes it and nothing
 * else does), so presence at that exact path is the ownership marker; the
 * `managedBy` owner is what separates clean from unprovable.
 */
function classifyCodexRoleAgentInventory(agentsDir: string, entries: LegacyIntegrationEntry[]): void {
  const surface = 'codex-role-agent-inventory' as const;
  const path = join(agentsDir, CODEX_AGENT_INVENTORY_NAME);
  const read = readJsonDocument(path);
  if (read.kind === 'value') {
    if (!isPlainObject(read.value)) {
      entries.push({ surface, path, state: 'managed-modified', detail: 'inventory root is not a JSON object' });
    } else if (read.value.managedBy === CODEX_AGENT_INVENTORY_OWNER) {
      entries.push({ surface, path, state: 'managed-clean', detail: 'codex role-agent inventory' });
    } else if (typeof read.value.managedBy === 'string' && read.value.managedBy !== '') {
      entries.push({ surface, path, state: 'unmanaged', detail: `managedBy is ${read.value.managedBy}` });
    } else {
      entries.push({ surface, path, state: 'managed-modified', detail: 'inventory declares no managedBy owner' });
    }
  } else if (read.kind !== 'absent') {
    entries.push(unreadableEntry(surface, path, read));
  }
  for (const child of readdirSafe(agentsDir)) {
    if (!CODEX_AGENT_TRANSACTION_PREFIXES.some((prefix) => child.name.startsWith(prefix))) continue;
    const debris = join(agentsDir, child.name);
    const stat = lstatSafe(debris);
    if (stat === null) continue;
    entries.push(
      stat.isDirectory() && !stat.isSymbolicLink()
        ? { surface, path: debris, state: 'managed-clean', detail: 'role-agent transaction debris' }
        : { surface, path: debris, state: 'unmanaged', detail: 'not a physical directory' },
    );
  }
}

/**
 * `~/.claude/plugins/marketplaces/automagik/` — the marketplace bundle tree
 * `plugin marketplace add` materialized.
 *
 * `claude-plugin-cache` covers `plugins/cache/automagik/genie` and nothing else,
 * so this tree survived retirement while `inspectRuntimeIntegrationEvidence`
 * kept reading its `plugins/genie` child as proof the integration is installed —
 * a host reported "installed" forever. Ownership is that child: a directory
 * under genie's own marketplace name that carries the genie bundle is provably
 * ours; one that does not is reported and left alone.
 */
function classifyClaudeMarketplaceCache(claudeDir: string, entries: LegacyIntegrationEntry[]): void {
  const surface = 'claude-marketplace-cache' as const;
  const path = claudeMarketplaceCacheDir(claudeDir);
  const stat = lstatSafe(path);
  if (stat === null) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    entries.push({ surface, path, state: 'unmanaged', detail: 'not a physical directory' });
    return;
  }
  if (lstatSafe(join(path, 'plugins', 'genie')) === null) {
    entries.push({ surface, path, state: 'managed-modified', detail: 'no plugins/genie bundle under it' });
    return;
  }
  entries.push({ surface, path, state: 'managed-clean', detail: 'automagik marketplace bundle cache' });
}

function claudeMarketplaceCacheDir(claudeDir: string): string {
  return join(claudeDir, 'plugins', 'marketplaces', CLAUDE_MARKETPLACE_ID);
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
 * A child WITH a `.genie-sync.json` is classified by the shared
 * `inspectManagedSkillTree`.
 *
 * A child WITHOUT one is ownership-unprovable, so it is NEVER removed — but
 * whether it is even worth reporting depends on the parent:
 *
 *   - `~/.claude/skills` is where the skills.sh channel writes its own plain
 *     `--copy` of every shipped skill. A sidecar-less child there is the normal,
 *     expected shape; emitting an advisory for each would print ~25 `kept` lines
 *     on every `genie update` and bury the surfaces that matter.
 *   - `<codexHome>/skills/.curated` is a hidden lane only the plugin-era sync
 *     ever wrote (Codex itself prunes hidden dirs from discovery, and skills.sh
 *     does not know the path). A sidecar-less child there is a managed-looking
 *     directory whose ownership record is gone — exactly the case an operator
 *     must be told about by path, because retirement will otherwise leave it
 *     silently forever.
 */
function collectManagedSkillMirrors(
  surface: 'claude-skill' | 'codex-legacy-curated-skill',
  parent: string,
  entries: LegacyIntegrationEntry[],
): void {
  for (const child of childDirectories(parent)) {
    const path = join(parent, child.name);
    if (lstatSafe(join(path, MANIFEST_NAME)) === null) {
      if (surface === 'codex-legacy-curated-skill') {
        entries.push({
          surface,
          path,
          state: 'unmanaged',
          detail: 'no .genie-sync.json sidecar — ownership unprovable, left in place',
        });
      }
      continue;
    }
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
    case 'claude-marketplace-cache':
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
    case 'codex-role-agent-inventory':
      // The sidecar is a file; the transaction debris is a directory tree. One
      // recursive remove covers both, and the `agents` dir itself is never
      // pruned -- a user's own agent files may still live there.
      return withBackup(backup, entry, backupObject(backup, entry.path), () => {
        rmSync(entry.path, { recursive: true, force: true });
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

/**
 * Crash-safe in-place rewrite of a user-owned JSON document.
 *
 * `known_marketplaces.json` and `settings.json` belong to the user and this
 * module's whole story is backup-first: a truncating `writeFileSync` that dies
 * mid-flight -- ENOSPC, EIO, a kill between truncate and write -- would leave a
 * half-written or empty file and destroy exactly what the backups promise never
 * to lose. Stage beside the target, write and fsync the staging file, rename
 * over the target (the commit point), then fsync the directory entry. Every
 * failure path unlinks the staging file, so a refused write leaves the original
 * bytes byte-identical and no `.genie-staging-*` residue.
 *
 * The staging sibling is required (not a tmpdir file) so the rename is
 * same-filesystem and therefore atomic.
 */
function writeJsonDocument(path: string, value: unknown): void {
  const staging = join(dirname(path), `.${basename(path)}.genie-staging-${process.pid}-${stagingNonce()}`);
  try {
    writeDurableFile(staging, `${JSON.stringify(value, null, 2)}\n`);
    const mode = lstatSafe(path)?.mode;
    if (mode !== undefined) chmodSync(staging, mode & 0o7777);
    renameSync(staging, path);
  } catch (error) {
    try {
      unlinkSync(staging);
    } catch {
      // Never mask the write failure with a cleanup failure; a staging file the
      // caller can see is strictly better than a corrupted target.
    }
    throw error;
  }
  fsyncPath(dirname(path));
}

function stagingNonce(): string {
  return randomBytes(6).toString('hex');
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

// ============================================================================
// Absorbed from `agent-sync.ts` — module-private
// ============================================================================
//
// This module is `agent-sync.ts`'s only consumer that survives wish
// `skills-everywhere-b`, and it is itself deleted two stable releases after
// that wish ships, so a new shared `src/lib/*.ts` home would outlive its only
// user (Decision 6). Everything below is a verbatim copy of the classifiers and
// their transitive leaf helpers with the `export` keyword dropped; the doc
// comments are preserved as written, including their references to callers that
// consume the ORIGINAL in `agent-sync.ts`. `MANIFEST_NAME`,
// `PHYSICAL_TREE_IDENTITY_VERSION` and the digest primitives are NOT copied:
// they moved to `atomic-fs.ts` with `computeDirDigest`, which outlives this
// module, and a second definition of the manifest name would be a silent
// divergence in what counts as a managed directory.

/** Stamped/synced workflow filename. Exported: doctor/uninstall key their checks on it. */
const TARGET_NAME = 'council.js';

/** Digest-backed ownership record for the stamped council workflow. */
const WORKFLOW_MANIFEST_NAME = `${TARGET_NAME}.genie-sync.json`;

/** Deterministic physical mode for both stamped council artifacts. */
const WORKFLOW_FILE_MODE = 0o644;

/** `managedBy` value that certifies a dir as one this engine owns. Exported: single source of truth. */
const MANAGED_BY = 'genie-agent-sync';

/** Digest stamp for one flat Claude agent file in {@link AgentFilesManifest}. */
interface AgentFileManifestEntry {
  digest: string;
  version: string | null;
  syncedAt: string;
}

/** Shared manifest stored at `~/.claude/agents/.genie-sync.json`. */
interface AgentFilesManifest {
  managedBy: 'genie-agent-sync';
  files: Record<string, AgentFileManifestEntry>;
}

interface ManifestFileSnapshot {
  path: string;
  bytes: Buffer;
  stat: Stats;
}

type SafeManifestFile = ManifestFileSnapshot &
  ({ kind: 'managed'; manifest: AgentFilesManifest } | { kind: 'foreign'; manifest: null });

type AgentManifestState =
  | SafeManifestFile
  | { kind: 'absent'; path: string }
  | { kind: 'unsafe'; path: string; reason: string };

interface SyncManifest {
  managedBy: 'genie-agent-sync';
  version: string | null;
  digest: string;
  syncedAt: string;
  /** Physical-identity schema for managed directories and stamped workflows. */
  identityVersion?: typeof PHYSICAL_TREE_IDENTITY_VERSION;
  /** Stamped workflow target mode; absent from managed-directory manifests. */
  targetMode?: number;
}

/**
 * Retired codex lane (pre-migration): `<codexDir>/skills/.curated`. Codex
 * provably never loaded it — codex-rs prunes hidden dirs from skill discovery
 * (`HiddenDirectoryPolicy::Skip`) and marks `$CODEX_HOME/skills` itself
 * deprecated. Exported so doctor/uninstall can keep checking/cleaning the
 * legacy location on machines that have not synced since the migration.
 */
function codexLegacyCuratedDir(codexDir: string): string {
  return join(codexDir, 'skills', '.curated');
}

function readManifest(dir: string): { manifest: SyncManifest; fileDigest: string } | null {
  try {
    const content = readFileSync(join(dir, MANIFEST_NAME));
    const parsed = JSON.parse(content.toString('utf8')) as Partial<SyncManifest>;
    if (
      parsed.managedBy === MANAGED_BY &&
      typeof parsed.digest === 'string' &&
      /^[a-f0-9]{64}$/.test(parsed.digest) &&
      (parsed.identityVersion === undefined || parsed.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION)
    ) {
      return {
        manifest: {
          managedBy: MANAGED_BY,
          version: parsed.version ?? null,
          digest: parsed.digest,
          syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '',
          ...(parsed.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION
            ? { identityVersion: PHYSICAL_TREE_IDENTITY_VERSION }
            : {}),
        },
        fileDigest: createHash('sha256').update(content).digest('hex'),
      };
    }
  } catch {
    // absent, unreadable, or unparsable → treat as unmanaged
  }
  return null;
}

/**
 * Lightweight, read-only view of the shared agent manifest for external
 * consumers (doctor). Distinguishes a genie-managed manifest (with its per-file
 * entries) from foreign / absent / unsafe WITHOUT exposing the raw byte+stat
 * snapshot. `unsafe` mirrors {@link inspectAgentFilesManifest}'s fail-closed
 * verdict (symlink, non-regular file, multiple hard links, or unreadable) so a
 * diagnostic can surface it as a warning instead of silently reporting healthy.
 */
type AgentFilesManifestView =
  | { kind: 'managed'; files: Record<string, AgentFileManifestEntry> }
  | { kind: 'foreign' }
  | { kind: 'absent' }
  | { kind: 'unsafe'; reason: string };

function readAgentFilesManifestState(dir: string): AgentFilesManifestView {
  const state = inspectAgentFilesManifest(dir);
  switch (state.kind) {
    case 'managed':
      return { kind: 'managed', files: state.manifest.files };
    case 'foreign':
      return { kind: 'foreign' };
    case 'absent':
      return { kind: 'absent' };
    default:
      return { kind: 'unsafe', reason: state.reason };
  }
}

function inspectAgentFilesManifest(dir: string): AgentManifestState {
  const path = join(dir, MANIFEST_NAME);
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return { kind: 'absent', path };
    return { kind: 'unsafe', path, reason: `cannot inspect it: ${errMsg(error)}` };
  }
  if (stat.isSymbolicLink()) return { kind: 'unsafe', path, reason: 'it is a symlink' };
  if (!stat.isFile()) return { kind: 'unsafe', path, reason: 'it is not a regular file' };
  if (stat.nlink !== 1) return { kind: 'unsafe', path, reason: `it has ${stat.nlink} hard links` };

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { kind: 'unsafe', path, reason: `cannot read it: ${errMsg(error)}` };
  }
  const manifest = parseAgentFilesManifest(bytes);
  if (manifest === null) {
    if (isInvalidOrGenieOwnedAgentManifest(bytes)) {
      return { kind: 'unsafe', path, reason: 'it is invalid JSON or claims Genie ownership with an invalid schema' };
    }
    return { kind: 'foreign', path, bytes, stat, manifest: null };
  }
  return { kind: 'managed', path, bytes, stat, manifest };
}

/** Invalid JSON cannot prove foreign ownership; valid JSON is unsafe only when Genie claims it. */
function isInvalidOrGenieOwnedAgentManifest(bytes: Buffer): boolean {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).managedBy === MANAGED_BY
    );
  } catch {
    return true;
  }
}

function parseAgentFileManifestEntry(rawEntry: unknown): AgentFileManifestEntry | null {
  if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) return null;
  const entry = rawEntry as Record<string, unknown>;
  if (Object.keys(entry).sort().join('\0') !== ['digest', 'syncedAt', 'version'].join('\0')) return null;
  if (typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)) return null;
  if (
    entry.version !== null &&
    (typeof entry.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version))
  ) {
    return null;
  }
  if (typeof entry.syncedAt !== 'string') return null;
  try {
    if (new Date(entry.syncedAt).toISOString() !== entry.syncedAt) return null;
  } catch {
    return null;
  }
  return { digest: entry.digest, version: entry.version, syncedAt: entry.syncedAt };
}

function parseAgentFilesManifest(bytes: Buffer): AgentFilesManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.managedBy !== MANAGED_BY) return null;
  if (typeof record.files !== 'object' || record.files === null || Array.isArray(record.files)) return null;
  if (Object.keys(record).sort().join('\0') !== ['files', 'managedBy'].join('\0')) return null;

  const files: Record<string, AgentFileManifestEntry> = {};
  for (const [name, rawEntry] of Object.entries(record.files)) {
    if (!isFlatAgentFilename(name)) return null;
    const entry = parseAgentFileManifestEntry(rawEntry);
    if (entry === null) return null;
    files[name] = entry;
  }
  return { managedBy: MANAGED_BY, files };
}

function isFlatAgentFilename(name: string): boolean {
  return name === basename(name) && name.endsWith('.md') && name !== '.' && name !== '..';
}

/**
 * Return the current v2 physical identity only when the tree still matches its
 * ownership manifest. An untagged v2 digest is an unambiguous transitional
 * record. A content-only v1 digest is accepted only when a caller also proves
 * that the complete current physical tree equals a trusted canonical tree;
 * destructive orphan/legacy-lane callers intentionally provide no such proof.
 */
function acceptedManagedDirPhysicalDigest(
  dir: string,
  manifest: SyncManifest,
  trustedPhysicalDigest?: string,
): string | null {
  const physicalDigest = computeDirDigest(dir);
  if (manifest.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION) {
    return physicalDigest === manifest.digest ? physicalDigest : null;
  }
  // Transitional fixtures/releases could write the v2 digest before adding the
  // explicit schema tag. Exact v2 equality is unambiguous and safe to accept.
  if (physicalDigest === manifest.digest) return physicalDigest;
  const legacyDigest = computeLegacyRegularTreeDigest(dir);
  return legacyDigest !== null && legacyDigest === manifest.digest && physicalDigest === trustedPhysicalDigest
    ? physicalDigest
    : null;
}

type ManagedSkillTreeState = 'unmanaged' | 'managed-clean' | 'managed-modified' | 'corrupt-metadata';

interface ManagedSkillTreeReport {
  path: string;
  state: ManagedSkillTreeState;
  /** Accepted v2 physical identity captured during classification. */
  contentDigest?: string;
  manifestDigest?: string;
}

/** One ownership classifier shared by sync, doctor-facing callers, and uninstall. */
function inspectManagedSkillTree(dir: string): ManagedSkillTreeReport {
  const root = lstatSafe(dir);
  if (root === null || !root.isDirectory() || root.isSymbolicLink()) return { path: dir, state: 'unmanaged' };
  const manifestPath = join(dir, MANIFEST_NAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return lstatSafe(manifestPath) === null
      ? { path: dir, state: 'unmanaged' }
      : { path: dir, state: 'corrupt-metadata' };
  }
  if (typeof raw !== 'object' || raw === null || Reflect.get(raw, 'managedBy') !== MANAGED_BY) {
    return { path: dir, state: 'unmanaged' };
  }
  const manifest = readManifest(dir);
  if (manifest === null) return { path: dir, state: 'corrupt-metadata' };
  try {
    const contentDigest = acceptedManagedDirPhysicalDigest(dir, manifest.manifest);
    return contentDigest === null
      ? { path: dir, state: 'managed-modified' }
      : { path: dir, state: 'managed-clean', contentDigest, manifestDigest: manifest.fileDigest };
  } catch {
    return { path: dir, state: 'managed-modified' };
  }
}

type ManagedWorkflowState = 'unmanaged' | 'managed-clean' | 'managed-modified' | 'corrupt-metadata';

interface ManagedWorkflowReport {
  targetPath: string;
  manifestPath: string;
  state: ManagedWorkflowState;
  /** Accepted physical identity captured by the ownership read. */
  targetDigest?: string;
  manifestDigest?: string;
  targetMode?: number;
  manifestMode?: number;
}

function readWorkflowManifest(path: string): {
  status: 'missing' | 'valid' | 'corrupt';
  manifest?: SyncManifest;
  fileDigest?: string;
} {
  const stat = lstatSafe(path);
  if (stat === null) return { status: 'missing' };
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'corrupt' };
  try {
    const content = readFileSync(path);
    const parsed = JSON.parse(content.toString('utf8')) as Partial<SyncManifest>;
    if (
      parsed.managedBy !== MANAGED_BY ||
      typeof parsed.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.digest) ||
      (parsed.version !== null && parsed.version !== undefined && typeof parsed.version !== 'string') ||
      typeof parsed.syncedAt !== 'string' ||
      (parsed.identityVersion !== undefined && parsed.identityVersion !== PHYSICAL_TREE_IDENTITY_VERSION) ||
      (parsed.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION && !isPhysicalMode(parsed.targetMode))
    ) {
      return { status: 'corrupt' };
    }
    return {
      status: 'valid',
      manifest: {
        managedBy: MANAGED_BY,
        version: parsed.version ?? null,
        digest: parsed.digest,
        syncedAt: parsed.syncedAt,
        ...(parsed.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION
          ? { identityVersion: PHYSICAL_TREE_IDENTITY_VERSION, targetMode: parsed.targetMode }
          : {}),
      },
      fileDigest: createHash('sha256').update(content).digest('hex'),
    };
  } catch {
    return { status: 'corrupt' };
  }
}

interface PhysicalRegularFileIdentity {
  kind: 'regular';
  mode: number;
  digest: string;
}

type PhysicalFileIdentity =
  | { kind: 'absent' }
  | PhysicalRegularFileIdentity
  | { kind: 'directory'; mode: number }
  | { kind: 'symlink'; mode: number; target: string }
  | { kind: 'other'; mode: number; entry: PhysicalTreeEntry['kind'] }
  | { kind: 'unreadable'; code: string };

function physicalFileIdentity(path: string): PhysicalFileIdentity {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', code };
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    try {
      return { kind: 'symlink', mode, target: readlinkSync(path) };
    } catch (error) {
      return { kind: 'unreadable', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
    }
  }
  if (stat.isDirectory()) return { kind: 'directory', mode };
  if (!stat.isFile()) return { kind: 'other', mode, entry: physicalEntryKind(stat) };
  try {
    return { kind: 'regular', mode, digest: computeFileDigest(path) };
  } catch (error) {
    return { kind: 'unreadable', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
  }
}

function isPhysicalMode(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o7777;
}

/**
 * Resolve the Hermes `config.yaml` for the live profile the plugin-link lane
 * targets: the active sticky profile's home when a safe `active_profile` is set,
 * else the default Hermes home. Mirrors {@link ensureStickyProfileLink}'s
 * validation so a config write lands in the same home whose plugins/genie link is
 * converged. An unsafe/invalid profile falls back to the default home (never an
 * escaped path); the link lane already surfaces the invalid-profile failure.
 */
function resolveHermesConfigPath(hermesHome: string): string {
  return join(resolveHermesProfileHome(hermesHome), 'config.yaml');
}

function resolveHermesProfileHome(hermesHome: string): string {
  const active = readTrimmed(join(hermesHome, 'active_profile'));
  if (active === null || active === '') return hermesHome;
  // Same guard the sticky-link lane enforces — an invalid/unsafe profile name
  // must never redirect a write outside the profiles root.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(active) || active === '.' || active === '..') return hermesHome;
  const profilesRoot = resolve(hermesHome, 'profiles');
  const profileRoot = resolve(profilesRoot, active);
  if (!profileRoot.startsWith(`${profilesRoot}${sep}`)) return hermesHome;
  return profileRoot;
}

/** Classify council.js using only its sidecar ownership grant and recorded digest. */
function inspectManagedWorkflow(targetDir: string): ManagedWorkflowReport {
  const targetPath = join(targetDir, TARGET_NAME);
  const manifestPath = join(targetDir, WORKFLOW_MANIFEST_NAME);
  const ownership = readWorkflowManifest(manifestPath);
  if (ownership.status === 'missing') return { targetPath, manifestPath, state: 'unmanaged' };
  if (ownership.status === 'corrupt') return { targetPath, manifestPath, state: 'corrupt-metadata' };
  const targetIdentity = physicalFileIdentity(targetPath);
  const manifestIdentity = physicalFileIdentity(manifestPath);
  const expectedTargetMode =
    ownership.manifest?.identityVersion === PHYSICAL_TREE_IDENTITY_VERSION
      ? ownership.manifest.targetMode
      : WORKFLOW_FILE_MODE;
  const clean =
    targetIdentity.kind === 'regular' &&
    targetIdentity.digest === ownership.manifest?.digest &&
    targetIdentity.mode === expectedTargetMode &&
    manifestIdentity.kind === 'regular' &&
    manifestIdentity.digest === ownership.fileDigest &&
    manifestIdentity.mode === WORKFLOW_FILE_MODE;
  return {
    targetPath,
    manifestPath,
    state: clean ? 'managed-clean' : 'managed-modified',
    ...(clean && targetIdentity.kind === 'regular' && manifestIdentity.kind === 'regular'
      ? {
          targetDigest: targetIdentity.digest,
          manifestDigest: manifestIdentity.digest,
          targetMode: targetIdentity.mode,
          manifestMode: manifestIdentity.mode,
        }
      : {}),
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
