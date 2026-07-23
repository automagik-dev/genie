/**
 * Group E — lifecycle-truth integration: the pure policy seams that make
 * `genie setup --codex` and `genie doctor` derive their Codex claims from the
 * SAME observed facts instead of re-deciding them per surface.
 *
 * Two concerns live here, both pure (all IO is injected):
 *
 * 1. The shared delivery gate (Decision 9): one assessment of the observed
 *    snapshot's authenticated delivery record against the installed canonical
 *    target. Setup applies it BEFORE its first prompt or activation-owned
 *    mutation; doctor applies it so a missing/invalid/mismatched record can
 *    never coexist with a green `current` claim. The executor's
 *    `beginActivation` inner guard remains the authoritative defense in depth
 *    immediately before the first journal write — this gate never replaces it.
 *
 * 2. The route-layer classifier: distinct typed findings for the config-layer
 *    states doctor/init must report WITHOUT editing user-owned config — a
 *    plugin/project route collision, a user-owned same-key project route, a
 *    nested `.codex/config.toml` shadowing the root marker block (the
 *    effective-layer shadowing case), a global same-key route, and the Codex
 *    project-trust states. Findings are reports, never mutations: a collision
 *    or shadowing layer is preserved exactly as found (Decision 8).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { CodexActivationSnapshot } from './codex-activation.js';
import {
  type ActivationDeliveryExpectation,
  type DeliveryIncompleteResult,
  type DeliveryRecordReadState,
  assessAuthenticatedDelivery,
  buildDeliveryIncompleteResult,
} from './codex-host-observation.js';
import type { CodexProjectMcpResult } from './codex-project-mcp.js';

// ============================================================================
// 1. Shared delivery gate (Decision 9)
// ============================================================================

export type SnapshotDeliveryGate =
  /** A present, structurally valid record binding the installed canonical target. */
  | { kind: 'matching' }
  /** The canonical payload itself is unavailable; the caller's earlier payload guard owns this state. */
  | { kind: 'unassessable'; detail: string }
  /** Missing/invalid/mismatched record: the one consistent `delivery-incomplete` result. */
  | { kind: 'incomplete'; result: DeliveryIncompleteResult };

/**
 * Assess the snapshot's delivery record against the installed canonical target
 * (core binding: exact target version + canonical payload tree digest). This is
 * the same expectation shape `beginActivation`'s inner guard enforces, so setup
 * refusing here and the executor refusing later can never disagree on why.
 */
export function assessSnapshotDelivery(snapshot: CodexActivationSnapshot): SnapshotDeliveryGate {
  if (snapshot.canonical.status !== 'ok') {
    return { kind: 'unassessable', detail: `canonical payload is unavailable: ${snapshot.canonical.detail}` };
  }
  const expectation: ActivationDeliveryExpectation = {
    targetVersion: snapshot.canonical.version.canonical,
    canonicalPayloadSha256: snapshot.canonical.digest,
  };
  const assessment = assessAuthenticatedDelivery(snapshotDeliveryReadState(snapshot), expectation);
  if (assessment === 'matching') return { kind: 'matching' };
  return { kind: 'incomplete', result: buildDeliveryIncompleteResult(assessment) };
}

/** Map the snapshot's delivery fact onto the pure assessment's read-state shape. */
export function snapshotDeliveryReadState(snapshot: CodexActivationSnapshot): DeliveryRecordReadState {
  const fact = snapshot.delivery;
  if (fact.status === 'present') return { status: 'present', record: fact.record };
  if (fact.status === 'invalid') return { status: 'invalid', detail: fact.detail };
  return { status: 'absent' };
}

// ============================================================================
// 2. Route-layer classifier (typed config-layer diagnostics)
// ============================================================================

export type RouteLayerFinding =
  /** Two effective same-key routes (plugin+project) or a user-owned same-key project route. */
  | { kind: 'route-collision'; detail: string }
  /** A nested `.codex/config.toml` nearer to the CWD defines `mcp_servers.genie`, shadowing the root marker. */
  | { kind: 'route-shadowed'; ownerPath: string; detail: string }
  /** The global `~/.codex/config.toml` defines a same-key `mcp_servers.genie` route. */
  | { kind: 'global-route-same-key'; path: string; detail: string }
  /** The project has an explicit non-trusted `trust_level` in the global Codex config. */
  | { kind: 'untrusted-config'; detail: string }
  /** No Codex trust entry exists for the project; trust is required before route health can be claimed. */
  | { kind: 'project-trust-required'; detail: string };

export interface RouteLayerInput {
  /** The worktree root owning the marker-managed project route. */
  worktreeRoot: string;
  /** The effective CWD whose root-to-CWD config chain is inspected for shadowing. */
  cwd: string;
  /** The read-only route inspection result (`inspectCodexProjectMcp`). */
  route: Pick<CodexProjectMcpResult, 'route' | 'detail'>;
  /** The global Codex config path (`getCodexConfigPath()`). */
  globalConfigPath: string;
  /** Bounded file reader seam; returns null when absent/unreadable. */
  readFile?: (path: string) => string | null;
  /** Existence seam for chain-walk directories. */
  exists?: (path: string) => boolean;
}

const MAX_CONFIG_BYTES = 512 * 1024;
const GENIE_SERVER_HEADER_RE = /^\s*\[mcp_servers\.(?:genie|"genie")\]\s*(?:#.*)?$/m;

function defaultReadFile(path: string): string | null {
  try {
    const content = readFileSync(path, 'utf8');
    return content.length > MAX_CONFIG_BYTES ? null : content;
  } catch {
    return null;
  }
}

/**
 * Classify the config-layer states around the project route. Pure over the
 * injected readers; reports findings without touching any layer. Collisions and
 * shadowing are hard route defects; the trust states are advisories that block
 * a health CLAIM (doctor must say trust is required) without failing the route
 * bytes themselves.
 */
export function classifyRouteLayers(input: RouteLayerInput): RouteLayerFinding[] {
  const readFile = input.readFile ?? defaultReadFile;
  const exists = input.exists ?? existsSync;
  const findings: RouteLayerFinding[] = [];

  if (input.route.route === 'conflict') {
    findings.push({
      kind: 'route-collision',
      detail: `plugin and project routes are both effective: ${input.route.detail ?? 'route conflict'}`,
    });
  } else if (input.route.route === 'unmanaged-fallback') {
    findings.push({
      kind: 'route-collision',
      detail: `user-owned [mcp_servers.genie] project route is preserved and requires user resolution: ${input.route.detail ?? 'unmanaged route'}`,
    });
  }

  const shadowOwner = nearestShadowingConfig(input.worktreeRoot, input.cwd, readFile, exists);
  if (shadowOwner !== null) {
    findings.push({
      kind: 'route-shadowed',
      ownerPath: shadowOwner,
      detail: `nested ${join(shadowOwner, '.codex', 'config.toml')} defines [mcp_servers.genie] nearer to the CWD and shadows the root marker route`,
    });
  }

  const globalConfig = readFile(input.globalConfigPath);
  if (globalConfig !== null && GENIE_SERVER_HEADER_RE.test(globalConfig)) {
    findings.push({
      kind: 'global-route-same-key',
      path: input.globalConfigPath,
      detail:
        'global Codex config defines a same-key [mcp_servers.genie] route; it is preserved and requires user resolution',
    });
  }

  const trust = projectTrustState(globalConfig, input.worktreeRoot);
  if (trust.state === 'untrusted') {
    findings.push({
      kind: 'untrusted-config',
      detail: `Codex marks this project '${trust.level}'; its project config (including the Genie route) is inert until the user trusts it`,
    });
  } else if (trust.state === 'unknown') {
    findings.push({
      kind: 'project-trust-required',
      detail:
        'Codex has no trust entry for this project; approve it in Codex before the project route can be claimed healthy',
    });
  }

  return findings;
}

/**
 * Walk the root-to-CWD directory chain (nearest to CWD first, root excluded)
 * and return the first directory whose `.codex/config.toml` defines a same-key
 * genie route. Returns null when the CWD is not under the root or no layer
 * shadows the marker.
 */
function nearestShadowingConfig(
  worktreeRoot: string,
  cwd: string,
  readFile: (path: string) => string | null,
  exists: (path: string) => boolean,
): string | null {
  // Physical identity: a logical root (e.g. macOS /var/...) and a physical CWD
  // (/private/var/...) describe the same chain; without realpath the walk
  // would silently skip and under-report shadowing.
  const root = safeRealpath(worktreeRoot);
  let current = safeRealpath(cwd);
  const rel = relative(root, current);
  if (rel.startsWith('..') || rel.split(sep).includes('..')) return null;
  while (current !== root) {
    const configPath = join(current, '.codex', 'config.toml');
    if (exists(configPath)) {
      const content = readFile(configPath);
      if (content !== null && GENIE_SERVER_HEADER_RE.test(content)) return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

type ProjectTrustState = { state: 'trusted' } | { state: 'untrusted'; level: string } | { state: 'unknown' };

/**
 * Bounded, targeted read of the global Codex config's `[projects."<root>"]`
 * trust entry. TOML-shaped but deliberately not a full TOML parser: it matches
 * the exact section header Codex writes for the absolute project path and reads
 * `trust_level` within that section only. An unreadable/absent config or a
 * missing section is `unknown` (trust cannot be inferred; Decision: never claim
 * health for a project Codex has not trusted).
 */
export function projectTrustState(globalConfig: string | null, worktreeRoot: string): ProjectTrustState {
  if (globalConfig === null) return { state: 'unknown' };
  // Codex records the project path as it saw it; tolerate both the logical and
  // the physical spelling of the same directory (macOS /var vs /private/var).
  const candidates = [...new Set([resolve(worktreeRoot), safeRealpath(worktreeRoot)])];
  for (const candidate of candidates) {
    const found = trustEntryFor(globalConfig, candidate);
    if (found !== null) return found;
  }
  return { state: 'unknown' };
}

function trustEntryFor(globalConfig: string, projectPath: string): ProjectTrustState | null {
  const escapedPath = projectPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const headerExact = `[projects."${escapedPath}"]`;
  let inSection = false;
  for (const rawLine of globalConfig.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inSection = line === headerExact;
      continue;
    }
    if (!inSection) continue;
    const match = line.match(/^trust_level\s*=\s*"([^"]*)"/);
    if (match !== null) {
      return match[1] === 'trusted' ? { state: 'trusted' } : { state: 'untrusted', level: match[1] ?? '' };
    }
  }
  return null;
}

/** Physical path identity with a logical fallback for not-yet-existing paths. */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
