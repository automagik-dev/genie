import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadGenieConfigSync } from './genie-config.js';
import { findWorkspace } from './workspace.js';

export type BrainVaultResolutionSource = 'config' | 'registry' | 'legacy';

export interface BrainVaultResolution {
  source: BrainVaultResolutionSource;
  paths: string[];
  registryCount?: number;
}

export interface StartedBrainVault {
  brainPath: string;
  port: number;
  stop: () => Promise<void>;
}

interface BrainConfigLike {
  brain?: {
    embedded?: boolean;
    paths?: string[];
  };
}

export interface BrainRegistryApi {
  listBrains?: () => unknown | Promise<unknown>;
  listBrainVaults?: () => unknown | Promise<unknown>;
  listVaults?: () => unknown | Promise<unknown>;
  listRegisteredBrains?: () => unknown | Promise<unknown>;
  listRegisteredBrainVaults?: () => unknown | Promise<unknown>;
  getBrainRegistry?: () => unknown | Promise<unknown>;
  readBrainRegistry?: () => unknown | Promise<unknown>;
}

export interface BrainServerApi extends BrainRegistryApi {
  startEmbeddedBrainServer?: (options: {
    brainPath: string;
    geniePgPort: number;
  }) => Promise<{ stop: () => Promise<void>; port: number }>;
}

interface BrainVaultDeps {
  brain?: BrainRegistryApi | null;
  config?: BrainConfigLike;
  cwd?: string;
  homeDir?: string;
  workspaceRoot?: string | null;
  startupConcurrency?: number;
  warn?: (message: string) => void;
  log?: (message: string) => void;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
}

const REGISTRY_PATH_FIELDS = ['homePath', 'brainPath', 'vaultPath', 'path', 'root', 'dir'] as const;
const REGISTRY_COLLECTION_FIELDS = ['paths', 'brains', 'vaults', 'entries', 'items', 'registered'] as const;
const DEFAULT_BRAIN_START_CONCURRENCY = 4;

interface RegisteredBrainVaultDiscovery {
  paths: string[];
  registryCount: number;
}

function getCwd(deps: BrainVaultDeps): string {
  return deps.cwd ?? process.cwd();
}

function getHomeDir(deps: BrainVaultDeps): string {
  return deps.homeDir ?? homedir();
}

function getWorkspaceRoot(deps: BrainVaultDeps): string | null {
  if ('workspaceRoot' in deps) return deps.workspaceRoot ?? null;
  return findWorkspace()?.root ?? null;
}

function getConfig(deps: BrainVaultDeps): BrainConfigLike {
  return deps.config ?? loadGenieConfigSync();
}

function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/')) return join(homeDir, path.slice(2));
  return path;
}

function normalizeBrainVaultPath(path: string, deps: BrainVaultDeps): string {
  return resolve(getCwd(deps), expandHome(path, getHomeDir(deps)));
}

function canonicalBrainVaultPath(path: string, deps: BrainVaultDeps): string {
  const realpath = deps.realpath ?? realpathSync;
  try {
    return realpath(path);
  } catch {
    return resolve(path);
  }
}

export function dedupeBrainVaultPaths(paths: string[], deps: BrainVaultDeps = {}): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const path of paths) {
    const canonical = canonicalBrainVaultPath(path, deps);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push(canonical);
  }
  return deduped;
}

function hasBrainJson(path: string, deps: BrainVaultDeps): boolean {
  const exists = deps.exists ?? existsSync;
  return exists(join(path, 'brain.json'));
}

function filterVaultsWithBrainJson(
  paths: string[],
  source: BrainVaultResolutionSource,
  deps: BrainVaultDeps,
): string[] {
  const warn = deps.warn ?? console.warn;
  const label = source === 'config' ? 'configured' : source === 'registry' ? 'registered' : 'legacy';
  const valid: string[] = [];
  for (const path of paths) {
    if (hasBrainJson(path, deps)) {
      valid.push(path);
      continue;
    }
    warn(`  Brain server: skipped ${label} vault ${path} (missing brain.json)`);
  }
  return valid;
}

function normalizeAndDedupe(paths: string[], deps: BrainVaultDeps): string[] {
  return dedupeBrainVaultPaths(
    paths.map((path) => normalizeBrainVaultPath(path, deps)),
    deps,
  );
}

function pushPathFromEntry(entry: Record<string, unknown>, paths: string[]): boolean {
  let found = false;
  for (const field of REGISTRY_PATH_FIELDS) {
    const value = entry[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      paths.push(value);
      found = true;
    }
  }
  return found;
}

function isRegistryRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectRegistryArray(values: unknown[], paths: string[]): void {
  for (const item of values) collectRegistryPaths(item, paths);
}

function collectRegistryObject(entry: Record<string, unknown>, paths: string[]): void {
  const foundPath = pushPathFromEntry(entry, paths);

  for (const field of REGISTRY_COLLECTION_FIELDS) {
    if (field in entry) collectRegistryPaths(entry[field], paths);
  }

  if (!foundPath) {
    for (const item of Object.values(entry)) {
      if (item && typeof item === 'object') collectRegistryPaths(item, paths);
    }
  }
}

function collectRegistryPaths(value: unknown, paths: string[]): void {
  if (typeof value === 'string') {
    if (value.trim().length > 0) paths.push(value);
    return;
  }
  if (Array.isArray(value)) {
    collectRegistryArray(value, paths);
    return;
  }
  if (isRegistryRecord(value)) collectRegistryObject(value, paths);
}

function countRegistryItems(value: unknown, fallback: number): number {
  if (Array.isArray(value)) return value.length;
  if (!isRegistryRecord(value)) return fallback;

  for (const field of REGISTRY_COLLECTION_FIELDS) {
    const collection = value[field];
    if (Array.isArray(collection)) return collection.length;
    if (isRegistryRecord(collection)) return Object.keys(collection).length;
  }

  return fallback;
}

async function discoverRegisteredBrainVaultPaths(deps: BrainVaultDeps): Promise<RegisteredBrainVaultDiscovery> {
  const brain = deps.brain;
  if (!brain) return { paths: [], registryCount: 0 };

  const registryCalls = [
    'listBrains',
    'listBrainVaults',
    'listVaults',
    'listRegisteredBrains',
    'listRegisteredBrainVaults',
    'getBrainRegistry',
    'readBrainRegistry',
  ] as const;

  for (const name of registryCalls) {
    const read = brain[name];
    if (typeof read !== 'function') continue;
    try {
      const result = await read.call(brain);
      const paths: string[] = [];
      collectRegistryPaths(result, paths);
      if (paths.length > 0) {
        return {
          paths,
          registryCount: countRegistryItems(result, paths.length),
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      (deps.warn ?? console.warn)(`  Brain registry: ${name} failed: ${msg}`);
    }
  }

  return { paths: [], registryCount: 0 };
}

async function findLegacyBrainVault(deps: BrainVaultDeps = {}): Promise<string | null> {
  const cwd = getCwd(deps);
  const homeDir = getHomeDir(deps);
  const workspaceRoot = getWorkspaceRoot(deps);
  const candidates = [
    workspaceRoot ? join(workspaceRoot, 'brain') : undefined,
    cwd,
    join(cwd, 'brain'),
    join(homeDir, 'brain'),
  ].filter((path): path is string => typeof path === 'string');

  for (const path of normalizeAndDedupe(candidates, deps)) {
    if (hasBrainJson(path, deps)) return path;
  }
  return null;
}

export async function findBrainVault(deps: BrainVaultDeps = {}): Promise<string | null> {
  const resolution = await resolveBrainVaults(deps);
  return resolution.paths[0] ?? null;
}

export async function resolveBrainVaults(deps: BrainVaultDeps = {}): Promise<BrainVaultResolution> {
  const configuredPaths = getConfig(deps).brain?.paths;
  if (Array.isArray(configuredPaths) && configuredPaths.length > 0) {
    const paths = filterVaultsWithBrainJson(normalizeAndDedupe(configuredPaths, deps), 'config', deps);
    return { source: 'config', paths };
  }

  const registered = await discoverRegisteredBrainVaultPaths(deps);
  if (registered.paths.length > 0) {
    const paths = filterVaultsWithBrainJson(normalizeAndDedupe(registered.paths, deps), 'registry', deps);
    return { source: 'registry', paths, registryCount: registered.registryCount };
  }

  const legacyPath = await findLegacyBrainVault(deps);
  return { source: 'legacy', paths: legacyPath ? [legacyPath] : [] };
}

function normalizeStartupConcurrency(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BRAIN_START_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

async function allSettledBounded<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;

      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

function warnRegistryDrift(
  resolution: BrainVaultResolution,
  startedCount: number,
  resolvedCount: number,
  deps: BrainVaultDeps,
): void {
  if (resolution.source !== 'registry') return;

  const expectedCount = resolution.registryCount ?? resolvedCount;
  if (startedCount === expectedCount) return;

  const warn = deps.warn ?? console.warn;
  warn(
    `  Brain server: registry drift: started ${startedCount}/${expectedCount} registered vault(s) ` +
      `(${resolvedCount} resolved valid path(s))`,
  );
}

export async function startResolvedBrainVaults(
  resolution: BrainVaultResolution,
  brain: BrainServerApi,
  geniePgPort: number,
  deps: BrainVaultDeps = {},
): Promise<StartedBrainVault[]> {
  const startEmbeddedBrainServer = brain.startEmbeddedBrainServer;
  if (!startEmbeddedBrainServer) return [];

  const warn = deps.warn ?? console.warn;
  const log = deps.log ?? console.log;
  const handles: StartedBrainVault[] = [];
  const paths = dedupeBrainVaultPaths(resolution.paths, deps);
  const concurrency = normalizeStartupConcurrency(deps.startupConcurrency);

  const results = await allSettledBounded(paths, concurrency, async (brainPath) => {
    const handle = await startEmbeddedBrainServer.call(brain, { brainPath, geniePgPort });
    log(`  Brain server ready on port ${handle.port} (${brainPath})`);
    return { brainPath, port: handle.port, stop: handle.stop };
  });

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === 'fulfilled') {
      handles.push(result.value);
    } else {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      warn(`  Brain server: failed for ${paths[index]}: ${msg}`);
    }
  }

  warnRegistryDrift(resolution, handles.length, paths.length, deps);
  return handles;
}
