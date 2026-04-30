/**
 * Hook loader — boot-scan over the three S3 tiers, trust-gate every file,
 * dynamic-`import()` the survivors, validate exports, register them.
 *
 * Tier precedence (highest → lowest):
 *   1. per-team   — ~/.claude/teams/<team>/hooks/*.ts
 *   2. per-repo   — <repo>/.genie/hooks/*.ts
 *   3. global     — ~/.genie/hooks/*.ts
 *
 * Higher tiers shadow lower tiers when a hook with the same `name` is present
 * in both. Shadowing emits `console.warn` listing both source paths and is
 * surfaced as `[shadowed by <path>]` in `genie hook list`. When `genie serve`
 * is started with `--strict-hooks`, any same-`name` collision REFUSES boot.
 *
 * Broken files (parse error, validation failure, import throw) are moved to
 * `_quarantine/<basename>` next to the source dir with a sidecar `.error`
 * file containing the parse-error message + line number; the daemon ALWAYS
 * starts even when every hook is broken (builtin handlers still dispatch).
 *
 * The boot-scan runs once during `startHookSocket()` BEFORE `server.listen()`
 * so the registry is single-writer at boot. Subsequent reloads go through
 * `genie hook reload` which holds a CLI-level lock (Group 2).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRegistry, setRegistry } from './index.js';
import {
  type TrustFile,
  type TrustScope,
  defaultTrustPath,
  parseCapabilities,
  readTrustFile,
  verifyTrust,
} from './trust.js';
import type { Handler, HandlerSource } from './types.js';

/** A discovered hook file (regardless of trust state). */
export interface DiscoveredHook {
  /** Absolute path to the .ts file. */
  path: string;
  /** Tier the file lives under. */
  scope: TrustScope;
  /** Repo remote URL when `scope === 'repo'`; otherwise undefined. */
  repoRemoteUrl?: string;
  /** Team name when `scope === 'team'`; otherwise undefined. */
  teamName?: string;
}

/** Outcome row from the loader — one per discovered file. */
export type LoadStatus =
  | { kind: 'loaded'; handler: Handler; source: DiscoveredHook }
  | { kind: 'shadowed'; handler: Handler; source: DiscoveredHook; shadowedBy: DiscoveredHook }
  | { kind: 'untrusted'; reason: string; source: DiscoveredHook }
  | { kind: 'broken'; error: string; source: DiscoveredHook; quarantined: string };

export interface LoaderOptions {
  /**
   * Repo root used for the `repo` tier scan. Pass the cwd of the running
   * `genie serve --headless` process.
   */
  repoRoot?: string;
  /** Override the trust file path. Defaults to `~/.genie/hooks/trusted.json`. */
  trustPath?: string;
  /** Resolver for the active repo's remote URL — null if `repoRoot` is not a git repo. */
  resolveRepoRemoteUrl?: (repoRoot: string) => string | null;
  /**
   * Custom dynamic-import function (testability). Defaults to `import(url.href)`.
   * Implementations must throw on broken files so the loader can quarantine them.
   */
  importer?: (fileUrl: URL) => Promise<unknown>;
  /** Refuse to boot on same-`name` collisions. Wired up to `genie serve --strict-hooks`. */
  strict?: boolean;
}

/** Scan one directory for `.ts` files (non-recursive, ignores `_quarantine`). */
function scanDir(dirAbs: string): string[] {
  if (!existsSync(dirAbs)) return [];
  const entries = readdirSync(dirAbs);
  return entries
    .filter((name) => name.endsWith('.ts') && !name.startsWith('_') && !name.endsWith('.test.ts'))
    .map((name) => join(dirAbs, name))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

/** List discovered hook files across the three tiers in PRECEDENCE order (team > repo > global). */
export function discoverHooks(opts: LoaderOptions): DiscoveredHook[] {
  const home = homedir();
  const discovered: DiscoveredHook[] = [];

  // Tier 1 — per-team. Scan every team directory the operator has registered.
  const teamsRoot = join(home, '.claude', 'teams');
  if (existsSync(teamsRoot)) {
    for (const teamName of readdirSync(teamsRoot)) {
      if (teamName.startsWith('_')) continue; // skip _archived/, etc.
      const teamHooksDir = join(teamsRoot, teamName, 'hooks');
      for (const path of scanDir(teamHooksDir)) {
        discovered.push({ path, scope: 'team', teamName });
      }
    }
  }

  // Tier 2 — per-repo.
  if (opts.repoRoot) {
    const repoHooksDir = join(opts.repoRoot, '.genie', 'hooks');
    const repoRemoteUrl = opts.resolveRepoRemoteUrl?.(opts.repoRoot) ?? undefined;
    for (const path of scanDir(repoHooksDir)) {
      discovered.push({ path, scope: 'repo', repoRemoteUrl });
    }
  }

  // Tier 3 — global.
  const globalHooksDir = join(home, '.genie', 'hooks');
  for (const path of scanDir(globalHooksDir)) {
    discovered.push({ path, scope: 'global' });
  }

  return discovered;
}

/** Move a broken file to `_quarantine/<basename>` with a sidecar `.error` file. */
function quarantine(filePath: string, errorMessage: string): string {
  const dir = dirname(filePath);
  const quarantineDir = join(dir, '_quarantine');
  if (!existsSync(quarantineDir)) mkdirSync(quarantineDir, { recursive: true });
  const basename = filePath.split('/').pop() ?? 'unknown.ts';
  const target = join(quarantineDir, basename);
  try {
    renameSync(filePath, target);
  } catch {
    /* best-effort — file may have been removed mid-scan */
  }
  try {
    writeFileSync(`${target}.error`, errorMessage, 'utf-8');
  } catch {
    /* best-effort */
  }
  return target;
}

/** Validate the shape of an imported handler. Returns null if valid; error message otherwise. */
function validateHandler(imported: unknown): string | null {
  if (typeof imported !== 'object' || imported === null) {
    return 'expected default export to be an object';
  }
  const handler = imported as Partial<Handler>;
  if (handler.version !== '1') {
    return `unknown handler version: ${String(handler.version)} (expected '1')`;
  }
  if (typeof handler.name !== 'string' || handler.name.length === 0) {
    return 'handler.name must be a non-empty string';
  }
  if (typeof handler.event !== 'string') {
    return 'handler.event must be a HookEventName string';
  }
  if (typeof handler.priority !== 'number' || Number.isNaN(handler.priority)) {
    return 'handler.priority must be a finite number';
  }
  if (typeof handler.fn !== 'function') {
    return 'handler.fn must be a function';
  }
  return null;
}

/**
 * Boot-scan loader entry point.
 *
 * Returns the per-file outcome list AND replaces the live handler registry
 * with `[builtins, ...newly-loaded]`. Builtins are preserved as the first
 * tier; external handlers are appended in scope-precedence order so that
 * `resolveHandlers()` returns them in the right priority order on the next
 * dispatch.
 *
 * Same-`name` shadowing: the FIRST occurrence (highest precedence by scan
 * order) wins; subsequent occurrences emit `console.warn` and appear in the
 * outcome list as `kind: 'shadowed'`. Strict mode throws instead.
 */
export async function loadExternalHooks(opts: LoaderOptions = {}): Promise<LoadStatus[]> {
  const trustPath = opts.trustPath ?? defaultTrustPath();
  let trustFile: TrustFile;
  try {
    trustFile = readTrustFile(trustPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[hook-loader] trust file unreadable at ${trustPath}: ${msg} — refusing to load any external hooks`);
    return [];
  }

  const importer = opts.importer ?? ((url: URL) => import(url.href));
  const discovered = discoverHooks(opts);
  const loaded: Handler[] = [];
  const seenNames = new Map<string, DiscoveredHook>();
  const outcomes: LoadStatus[] = [];

  for (const source of discovered) {
    const verify = verifyTrust(source.path, trustFile, { currentRepoRemoteUrl: source.repoRemoteUrl });
    if (!verify.trusted) {
      outcomes.push({ kind: 'untrusted', reason: verify.reason, source });
      continue;
    }

    let imported: { default?: unknown };
    try {
      imported = (await importer(pathToFileURL(resolvePath(source.path)))) as { default?: unknown };
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const quarantined = quarantine(source.path, msg);
      outcomes.push({ kind: 'broken', error: msg, source, quarantined });
      continue;
    }

    const handlerCandidate = imported.default;
    const validationError = validateHandler(handlerCandidate);
    if (validationError !== null) {
      const quarantined = quarantine(source.path, validationError);
      outcomes.push({ kind: 'broken', error: validationError, source, quarantined });
      continue;
    }

    // Stamp source + manifest_path from the loader's perspective; ignore any
    // values the author may have set via defineHook (the helper intentionally
    // produces placeholder values for these fields).
    const stamped: Handler = {
      ...(handlerCandidate as Handler),
      source: source.scope as HandlerSource,
      manifest_path: source.path,
    };

    const existing = seenNames.get(stamped.name);
    if (existing) {
      // Shadowing: the FIRST occurrence in scan order keeps the slot. We scan
      // in tier-precedence order (team > repo > global) so the higher-tier
      // file wins, the lower-tier file is reported as shadowed.
      console.warn(
        `[hook-loader] handler name collision: "${stamped.name}" registered from ${existing.path} (${existing.scope}) shadows ${source.path} (${source.scope})`,
      );
      if (opts.strict) {
        throw new Error(
          `--strict-hooks: handler name collision on "${stamped.name}" between ${existing.path} and ${source.path}`,
        );
      }
      outcomes.push({ kind: 'shadowed', handler: stamped, source, shadowedBy: existing });
      continue;
    }

    // Capabilities are advisory metadata for `genie hook trust` UX; the loader
    // doesn't enforce them at runtime (vm.Context isolation lands in delivery #4).
    void parseCapabilities(readFileSync(source.path, 'utf-8'));

    seenNames.set(stamped.name, source);
    loaded.push(stamped);
    outcomes.push({ kind: 'loaded', handler: stamped, source });
  }

  // Atomic registry swap — builtins kept as the first tier, external handlers
  // appended in tier-precedence order.
  const builtins = getRegistry().filter((h) => h.source === 'builtin');
  setRegistry([...builtins, ...loaded]);
  return outcomes;
}
