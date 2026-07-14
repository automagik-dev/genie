/**
 * Genie v5 → Warp Launch Configuration emitter.
 *
 * Turns a set of worktree panes into a schema-correct Warp Launch Configuration
 * (https://docs.warp.dev/features/sessions/launch-configurations). The output is
 * a plain object serialized with `Bun.YAML.stringify` — the runtime built-in owns
 * all quoting, so hostile titles/commands (quotes, `&&`, `$(...)`, newlines) round
 * -trip losslessly. No hand-rolled YAML, no new dependency.
 *
 * Warp facts baked in here:
 *   - config files live in a platform-specific dir (see {@link resolveWarpConfigDir}),
 *   - `cwd` MUST be an absolute path — Warp rejects `~` and relative paths,
 *   - tab `color` accepts lowercase ANSI color names only (red/green/yellow/blue/magenta/cyan),
 *   - a tab holds up to a 2x2 grid of panes via nested `split_direction` layouts,
 *   - the launch URI is `warp://launch/<config-name>` (the wish slug).
 *
 * Pure library: no CLI wiring, no console output. Callers own presentation.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// ============================================================================
// Public input types
// ============================================================================

/** A single terminal pane: where it opens and (optionally) what it runs. */
export interface PaneSpec {
  /** Human label for the pane. Optional; emitted verbatim (Warp ignores unknown keys). */
  title?: string;
  /** Absolute working directory. Relative or `~`-prefixed paths are rejected. */
  cwd: string;
  /** Shell command to run on open. Omitted → pane opens an idle shell. */
  command?: string;
}

/** One launch configuration: a slug (names the tab + file) and its panes. */
export interface LaunchSpec {
  /** Identifier used for tab titles and the `genie-<slug>.yaml` filename. */
  slug: string;
  /** Ordered panes. The first is focused; every 4 overflow into a new tab. */
  panes: PaneSpec[];
}

// ============================================================================
// Typed errors (mirrors the GenieDbError base/subclass style in genie-db.ts)
// ============================================================================

/** Base class for every failure raised while building or writing a launch config. */
export class WarpLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarpLaunchError';
  }
}

/** A pane `cwd` was relative or `~`-prefixed — Warp requires an absolute path. */
export class InvalidCwdError extends WarpLaunchError {
  readonly cwd: string;
  constructor(cwd: string) {
    super(`Warp requires an absolute cwd; got ${JSON.stringify(cwd)}. Resolve it before building the launch config.`);
    this.name = 'InvalidCwdError';
    this.cwd = cwd;
  }
}

/** A slug carried a path fragment that could escape the launch-config directory. */
export class UnsafeSlugError extends WarpLaunchError {
  readonly slug: string;
  constructor(slug: string) {
    super(`Unsafe launch slug ${JSON.stringify(slug)}: must not contain '/', '\\', or '..'.`);
    this.name = 'UnsafeSlugError';
    this.slug = slug;
  }
}

/** The target platform has no known Warp launch-configuration directory. */
export class UnsupportedPlatformError extends WarpLaunchError {
  readonly platform: string;
  constructor(platform: string) {
    super(`No known Warp launch-configuration directory for platform ${JSON.stringify(platform)}.`);
    this.name = 'UnsupportedPlatformError';
    this.platform = platform;
  }
}

// ============================================================================
// Output shape (the plain object Bun.YAML serializes)
// ============================================================================

interface LaunchCommand {
  exec: string;
}

/** A leaf pane in the layout tree. */
interface LaunchLeaf {
  cwd: string;
  title?: string;
  commands?: LaunchCommand[];
  is_focused?: boolean;
}

/** An interior split node holding two-or-more child layouts. */
interface LaunchSplit {
  split_direction: 'vertical' | 'horizontal';
  panes: LaunchLayout[];
}

type LaunchLayout = LaunchLeaf | LaunchSplit;

interface LaunchTab {
  title: string;
  color: string;
  layout: LaunchLayout;
}

interface LaunchWindow {
  active_tab_index: number;
  tabs: LaunchTab[];
}

/** The full launch configuration object. */
export interface LaunchConfig {
  name: string;
  windows: LaunchWindow[];
}

// ============================================================================
// Constants
// ============================================================================

/** ANSI color names Warp accepts for `tab.color`, cycled across tabs. */
const TAB_COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const;

/** Max panes Warp lays out cleanly as a 2x2 grid before overflowing to a new tab. */
const MAX_PANES_PER_TAB = 4;

// ============================================================================
// Validation
// ============================================================================

/** Reject any cwd Warp would refuse: empty, `~`-prefixed, or non-absolute. */
function assertAbsoluteCwd(cwd: string): void {
  if (cwd.length === 0 || cwd.startsWith('~') || !isAbsolute(cwd)) {
    throw new InvalidCwdError(cwd);
  }
}

/** Path fragments that would let a slug traverse out of the config dir via the `genie-<slug>.yaml` filename. */
const UNSAFE_SLUG_FRAGMENTS = ['/', '\\', '..'];

/**
 * Reject a slug that could escape the launch-config directory when woven into
 * the `genie-<slug>.yaml` filename. Callers inside genie already validate slugs,
 * but this guards standalone/library use of {@link writeLaunchConfig}.
 */
function assertSafeSlug(slug: string): void {
  if (UNSAFE_SLUG_FRAGMENTS.some((fragment) => slug.includes(fragment))) {
    throw new UnsafeSlugError(slug);
  }
}

// ============================================================================
// Layout construction
// ============================================================================

/** Build one leaf pane, marking it focused when it is the first pane overall. */
function buildLeaf(pane: PaneSpec, isFocused: boolean): LaunchLeaf {
  const leaf: LaunchLeaf = { cwd: pane.cwd };
  if (pane.title !== undefined) leaf.title = pane.title;
  if (pane.command !== undefined) leaf.commands = [{ exec: pane.command }];
  if (isFocused) leaf.is_focused = true;
  return leaf;
}

/**
 * Assemble 1–4 leaves into a layout tree. Two panes split vertically; three or
 * four nest a horizontal split inside a vertical one to form the 2x2 grid.
 */
function buildLayout(leaves: LaunchLeaf[]): LaunchLayout {
  switch (leaves.length) {
    case 1:
      return leaves[0];
    case 2:
      return { split_direction: 'vertical', panes: [leaves[0], leaves[1]] };
    case 3:
      return {
        split_direction: 'vertical',
        panes: [{ split_direction: 'horizontal', panes: [leaves[0], leaves[1]] }, leaves[2]],
      };
    default:
      return {
        split_direction: 'vertical',
        panes: [
          { split_direction: 'horizontal', panes: [leaves[0], leaves[1]] },
          { split_direction: 'horizontal', panes: [leaves[2], leaves[3]] },
        ],
      };
  }
}

/** Title for the tab at `index`: the bare slug first, then `<slug> (2)`, `(3)`, … */
function tabTitle(slug: string, index: number): string {
  return index === 0 ? slug : `${slug} (${index + 1})`;
}

// ============================================================================
// buildLaunchConfig — pure
// ============================================================================

/**
 * Build the launch-configuration object for `spec`. Pure: no IO, no globals.
 * Panes chunk into tabs of at most {@link MAX_PANES_PER_TAB}; the very first
 * pane is focused; tab colors cycle through {@link TAB_COLORS}.
 *
 * @throws {InvalidCwdError} if any pane cwd is relative or `~`-prefixed.
 * @throws {WarpLaunchError} if the spec has no panes.
 */
export function buildLaunchConfig(spec: LaunchSpec): LaunchConfig {
  if (spec.panes.length === 0) {
    throw new WarpLaunchError(`Launch spec ${JSON.stringify(spec.slug)} has no panes.`);
  }
  for (const pane of spec.panes) assertAbsoluteCwd(pane.cwd);

  const tabs: LaunchTab[] = [];
  for (let tabIndex = 0; tabIndex * MAX_PANES_PER_TAB < spec.panes.length; tabIndex++) {
    const chunk = spec.panes.slice(tabIndex * MAX_PANES_PER_TAB, (tabIndex + 1) * MAX_PANES_PER_TAB);
    const leaves = chunk.map((pane, i) => buildLeaf(pane, tabIndex === 0 && i === 0));
    tabs.push({
      title: tabTitle(spec.slug, tabIndex),
      color: TAB_COLORS[tabIndex % TAB_COLORS.length],
      layout: buildLayout(leaves),
    });
  }

  return { name: spec.slug, windows: [{ active_tab_index: 0, tabs }] };
}

/** Serialize {@link buildLaunchConfig}'s object to YAML via the Bun built-in. */
export function buildLaunchConfigYaml(spec: LaunchSpec): string {
  return Bun.YAML.stringify(buildLaunchConfig(spec));
}

// ============================================================================
// Filesystem + URI
// ============================================================================

/** Options for resolving the platform-specific Warp config directory. */
export interface ResolveDirOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. Consulted for `XDG_DATA_HOME` on Linux. */
  env?: Record<string, string | undefined>;
  /** Defaults to `os.homedir()`. */
  homedir?: string;
}

/**
 * Resolve the directory Warp reads launch configurations from:
 *   - macOS:  `~/.warp/launch_configurations`
 *   - Linux:  `${XDG_DATA_HOME:-~/.local/share}/warp-terminal/launch_configurations`
 *
 * Platform and env are injectable so tests exercise every branch without touching
 * the host. Unknown platforms raise {@link UnsupportedPlatformError}.
 */
export function resolveWarpConfigDir(opts: ResolveDirOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? homedir();

  if (platform === 'darwin') {
    return join(home, '.warp', 'launch_configurations');
  }
  if (platform === 'linux') {
    const xdg = env.XDG_DATA_HOME;
    const base = xdg && xdg.length > 0 ? xdg : join(home, '.local', 'share');
    return join(base, 'warp-terminal', 'launch_configurations');
  }
  throw new UnsupportedPlatformError(platform);
}

/** Options for {@link writeLaunchConfig}. */
export interface WriteOptions extends ResolveDirOptions {
  /** Explicit output directory. Overrides {@link resolveWarpConfigDir}. */
  dir?: string;
}

/**
 * Write `spec` to `genie-<slug>.yaml` in the Warp config dir (created if absent).
 * Returns the absolute path written. Validation happens before any IO, so an
 * unsafe slug or invalid cwd throws without creating the dir or a partial file.
 *
 * @throws {UnsafeSlugError} if the slug contains `/`, `\`, or `..`.
 * @throws {InvalidCwdError} if any pane cwd is relative or `~`-prefixed.
 */
export function writeLaunchConfig(spec: LaunchSpec, opts: WriteOptions = {}): string {
  assertSafeSlug(spec.slug);
  const yaml = buildLaunchConfigYaml(spec);
  const dir = opts.dir ?? resolveWarpConfigDir(opts);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `genie-${spec.slug}.yaml`);
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

/**
 * Build the `warp://launch/<config-name>` URI that opens a written config.
 * Warp resolves this relative identifier against its launch-configuration
 * directory and matches it to the YAML top-level `name`. Absolute paths produce
 * a double-slash URI that Warp rejects. Encode the identifier as one URI path
 * component so reserved characters cannot change URI semantics.
 */
export function launchUri(configName: string): string {
  return `warp://launch/${encodeURIComponent(configName)}`;
}
