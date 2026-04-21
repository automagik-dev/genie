/**
 * Installer resolution diagnostic for `genie doctor`.
 *
 * Detects which package manager's global install resolves first on PATH,
 * surfaces stale-shadow scenarios (e.g. `bun remove -g @automagik/genie`
 * wasn't run, npm-global now shadows it but bun still lives on PATH),
 * and suggests concrete `<installer> remove -g` commands.
 *
 * Why this exists: `@automagik/genie` ships via multiple installers
 * (bun, npm, pnpm, yarn). Users who `npm install -g @automagik/genie@next`
 * but still have `~/.bun/bin` higher on PATH end up running a stale copy
 * and the version tag looks frozen. `genie doctor` should flag the drift.
 *
 * Pure-function-friendly layout:
 *   - `probeInstallers()` / `probeResolvedBinary()` do I/O.
 *   - `classifyInstallerResolution()` is a pure state -> CheckResult[]
 *     translator so behavior is unit-testable without spawning processes.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PKG_NAME = '@automagik/genie';

export type InstallerId = 'npm' | 'bun' | 'pnpm' | 'yarn';

export interface InstallerEntry {
  /** Which package manager owns the global install. */
  installer: InstallerId;
  /** Absolute path to the global bin shim (`<bin-dir>/genie`). */
  binPath: string;
  /** Resolved `package.json` path for `@automagik/genie`. */
  packageJsonPath: string;
  /** Version string from the resolved `package.json`. */
  version: string;
}

export interface ResolvedBinary {
  /** Output of `which genie` (or equivalent). */
  path: string;
  /** Symlink-resolved real path, used to match against installer entries. */
  realPath: string;
}

interface InstallerResolutionState {
  resolved: ResolvedBinary | null;
  installers: InstallerEntry[];
}

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message?: string;
  suggestion?: string;
}

/**
 * Spawn a short-lived process and capture trimmed stdout. Returns `null`
 * on non-zero exit or thrown errors so callers can treat "installer
 * missing" and "installer present but errored" uniformly.
 */
async function runSilent(cmd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Walk up from the real bin target looking for a `package.json` whose
 * `name` matches `@automagik/genie`. Bounded to 8 levels so broken
 * symlinks pointing into shared trees can't cause runaway traversal.
 */
function findPackageJson(realBinPath: string): { path: string; version: string } | null {
  let dir = dirname(realBinPath);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === PKG_NAME && typeof parsed.version === 'string') {
          return { path: candidate, version: parsed.version };
        }
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

async function probeOne(installer: InstallerId, binDir: string | null): Promise<InstallerEntry | null> {
  if (!binDir) return null;
  const binPath = join(binDir, 'genie');
  if (!existsSync(binPath)) return null;
  const real = safeRealpath(binPath);
  const pkg = findPackageJson(real);
  if (!pkg) return null;
  return { installer, binPath, packageJsonPath: pkg.path, version: pkg.version };
}

/**
 * Probe the four supported installers for a global `@automagik/genie`
 * install. Each probe is best-effort — a missing installer, failed
 * command, or absent bin all yield `null` and are filtered out.
 */
async function probeInstallers(): Promise<InstallerEntry[]> {
  const entries: InstallerEntry[] = [];

  // npm: `npm root -g` returns the global node_modules dir; the bin dir
  // lives at `<prefix>/bin`, which is `<root>/../bin`.
  const npmRoot = await runSilent('npm', ['root', '-g']);
  const npmBin = npmRoot ? join(dirname(npmRoot), 'bin') : null;

  // bun: `bun pm -g bin` returns the bin dir directly.
  const bunBin = await runSilent('bun', ['pm', '-g', 'bin']);

  // pnpm: `pnpm root -g` is a node_modules dir; pnpm's bin dir sits next
  // to it. Users may set PNPM_HOME which short-circuits this, so we try
  // the env var first then fall back.
  const pnpmRoot = await runSilent('pnpm', ['root', '-g']);
  const pnpmBin = process.env.PNPM_HOME ?? (pnpmRoot ? join(dirname(pnpmRoot), 'bin') : null);

  // yarn v1: `yarn global bin` returns the bin dir. Yarn v2+ doesn't
  // support global installs — probe fails cleanly there.
  const yarnBin = await runSilent('yarn', ['global', 'bin']);

  const probes: Array<[InstallerId, string | null]> = [
    ['npm', npmBin],
    ['bun', bunBin],
    ['pnpm', pnpmBin],
    ['yarn', yarnBin],
  ];

  for (const [id, dir] of probes) {
    const entry = await probeOne(id, dir);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Probe the binary that currently resolves on PATH. */
async function probeResolvedBinary(): Promise<ResolvedBinary | null> {
  const path = await runSilent('which', ['genie']);
  if (!path) return null;
  return { path, realPath: safeRealpath(path) };
}

/**
 * Compare semver-ish numeric version strings. Returns negative when
 * `a < b`, positive when `a > b`, zero otherwise. Non-numeric segments
 * sort as zero — good enough for the calendar-versioned genie releases
 * used here; callers aren't branching on prerelease labels.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10));
  const pb = b.split('.').map((s) => Number.parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const nb = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function uninstallHint(installer: InstallerId): string {
  switch (installer) {
    case 'npm':
      return `npm uninstall -g ${PKG_NAME}`;
    case 'bun':
      return `bun remove -g ${PKG_NAME}`;
    case 'pnpm':
      return `pnpm remove -g ${PKG_NAME}`;
    case 'yarn':
      return `yarn global remove ${PKG_NAME}`;
  }
}

/**
 * Map a probed state to a list of `CheckResult` rows suitable for
 * `genie doctor`. Pure function — exposed for unit testing.
 *
 * Classification:
 *   - No `which genie` hit  -> `warn` (not on PATH).
 *   - Resolver hits but no installer owns the bin -> `warn` (likely dev
 *     checkout / manual symlink; package-manager updates won't replace it).
 *   - Resolver matches an installer entry; no duplicates -> `pass`.
 *   - Resolver matches an installer; duplicates exist -> `warn`, prefer
 *     the highest-version installer and suggest removing the others.
 *   - Duplicates exist and resolver is stale relative to the highest
 *     available version -> `warn`, suggest reinstall via the resolver's
 *     installer (so it wins on PATH) OR removal of the stale one.
 */
export function classifyInstallerResolution(state: InstallerResolutionState): CheckResult[] {
  const { resolved, installers } = state;

  if (!resolved) {
    return [
      {
        name: 'Resolved binary',
        status: 'warn',
        message: '`which genie` returned nothing',
        suggestion: 'Add the installer bin dir to PATH, or reinstall with: npm install -g @automagik/genie',
      },
    ];
  }

  // Identify which installer (if any) owns the resolved binary by
  // comparing real paths — symlink chains (bun's `<bin>/genie -> ../install/global/...`)
  // otherwise won't match the listed bin dir string-equal.
  const owner = installers.find((e) => safeRealpath(e.binPath) === resolved.realPath) ?? null;

  const rows: CheckResult[] = [];

  if (!owner) {
    rows.push({
      name: 'Resolved binary',
      status: 'warn',
      message: `${resolved.path} (not owned by a detected installer)`,
      suggestion:
        'Likely a dev checkout or manual symlink. Package-manager updates (`npm i -g`, `bun add -g`) will not replace this binary.',
    });
    for (const entry of installers) {
      rows.push({
        name: `Also installed via ${entry.installer}`,
        status: 'warn',
        message: `${entry.version} at ${entry.binPath}`,
      });
    }
    return rows;
  }

  rows.push({
    name: 'Resolved binary',
    status: 'pass',
    message: `${resolved.path} (${owner.installer} @ ${owner.version})`,
  });

  const others = installers.filter((e) => e.installer !== owner.installer);
  if (others.length === 0) {
    return rows;
  }

  // Duplicates exist — figure out whether the resolver is stale.
  const sorted = [...installers].sort((a, b) => compareVersions(b.version, a.version));
  const newest = sorted[0];
  const resolverIsStale = compareVersions(owner.version, newest.version) < 0;

  for (const entry of others) {
    const stale = compareVersions(entry.version, owner.version) < 0;
    rows.push({
      name: `Also installed via ${entry.installer}`,
      status: 'warn',
      message: `${entry.version}${stale ? ' (stale)' : ''} at ${entry.binPath}`,
      suggestion: `Remove with: ${uninstallHint(entry.installer)}`,
    });
  }

  if (resolverIsStale) {
    rows.push({
      name: 'Update path',
      status: 'warn',
      message: `${owner.installer}@${owner.version} is stale; ${newest.installer}@${newest.version} is newer but shadowed`,
      suggestion: `Either reinstall via the resolver (${uninstallHint(owner.installer).replace('uninstall', 'install').replace('remove', 'add')}) or remove the resolver so ${newest.installer} takes over.`,
    });
  }

  return rows;
}

/** High-level entry point: probe + classify in one call for `doctor`. */
export async function collectInstallerResolution(): Promise<CheckResult[]> {
  const [resolved, installers] = await Promise.all([probeResolvedBinary(), probeInstallers()]);
  return classifyInstallerResolution({ resolved, installers });
}
