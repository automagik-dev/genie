/**
 * `mikro migrate` — find legacy `rlmx` artifacts on this machine and rewrite
 * them for the `mikro` name.
 *
 * The 2026-08-29 rebrand renamed every public surface (binary, config dir,
 * config file, MCP server key, plugin id, home dir). Anything created before
 * it keeps working only where a fallback exists (see `loadConfig` and
 * `agentRoots`), and the Claude Code plugin registration does not fall back
 * at all — a host that still spawns `rlmx mcp` finds no binary. This command
 * closes that gap in one pass instead of leaving the operator to grep.
 *
 * Scope is deliberately *known artifact types at known locations*, not a
 * machine-wide search-and-replace of the string "rlmx":
 *
 *   - `<dir>/.rlmx/`                 → `<dir>/.mikro/` (+ `rlmx.yaml` → `mikro.yaml`)
 *   - `<dir>/.mcp.json`              → server `rlmx` (`command: rlmx`) → `mikro`
 *   - `~/.rlmx/`                     → `~/.mikro/` (settings, sessions, data)
 *   - `~/.local/bin/rlmx` symlink    → removed (it points at a legacy checkout)
 *   - Claude Code plugin registration (`~/.claude/settings.json`,
 *     `~/.claude/plugins/known_marketplaces.json`,
 *     `~/.claude/plugins/installed_plugins.json`) → `rlmx@rlmx` → `mikro@mikro`
 *   - shell rc files mentioning `~/.rlmx` or `RLMX_*` → reported; rewritten
 *     with `--rc` (backup beside the file). Env vars are always report-only.
 *
 * Dry-run by default: the plan is printed and nothing is written. `--apply`
 * performs it, backing up each rewritten JSON file next to itself. The scan
 * walks the given roots (default: cwd and $HOME) to a bounded depth and skips
 * `node_modules`, `.git`, and other dot-directories, so it stays fast on a
 * home directory full of checkouts.
 */

import { readdir, readFile, writeFile, rename, rm, lstat, readlink, copyFile, mkdir, stat, cp } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

// ─── Types ───────────────────────────────────────────────

export type MigrationKind =
  | "rename-config-dir"
  | "rename-config-file"
  | "rewrite-mcp-json"
  | "migrate-home"
  | "remove-legacy-symlink"
  | "rewrite-claude-plugin"
  | "rewrite-rc"
  | "report";

export interface MigrationAction {
  readonly kind: MigrationKind;
  /** Absolute path the action is about. */
  readonly path: string;
  /** One line a human can read in the plan. */
  readonly detail: string;
  /** True when nothing is written for this action (advice only). */
  readonly reportOnly?: boolean;
  /** Apply the action. Absent for report-only actions. */
  readonly apply?: () => Promise<void>;
}

export interface MigrationPlan {
  readonly roots: readonly string[];
  readonly actions: readonly MigrationAction[];
}

export interface ScanOptions {
  /** Directories to walk for project artifacts. Default: [cwd, home]. */
  roots?: readonly string[];
  /** Home directory (tests override). Default: os.homedir(). */
  home?: string;
  /** Max directory depth below each root. Default 6. */
  maxDepth?: number;
  /** Environment to inspect for RLMX_* variables. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Path substrings to leave alone (backups, snapshots). */
  exclude?: readonly string[];
  /**
   * Rewrite `~/.rlmx` → `~/.mikro` and `RLMX_*` → `MIKRO_*` in shell rc files
   * instead of only reporting them. Off by default: an rc line can encode
   * intent (a venv that lives elsewhere) that a rename would break.
   */
  rewriteRc?: boolean;
}

// ─── Constants ───────────────────────────────────────────

const LEGACY_DIR = ".rlmx";
const NEW_DIR = ".mikro";
const LEGACY_YAML = "rlmx.yaml";
const NEW_YAML = "mikro.yaml";
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", ".git", ".cache", ".npm", ".venv", "venv", "__pycache__"]);
const RC_FILES = [".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".config/fish/config.fish"];

// ─── Helpers ─────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Write JSON back with a sibling backup of the original. */
async function rewriteJson(path: string, value: unknown): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFile(path, `${path}.rlmx-backup-${stamp}`);
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function tilde(path: string, home: string): string {
  return path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path;
}

/** `rlmx`, `/usr/local/bin/rlmx`, `rlmx.cmd` … → true. */
function isLegacyCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const base = basename(command.trim());
  return base === "rlmx" || base === "rlmx.cmd" || base === "rlmx.exe";
}

// ─── Project-level artifacts ─────────────────────────────

async function planConfigDir(dir: string, home: string, out: MigrationAction[]): Promise<void> {
  const legacy = join(dir, LEGACY_DIR);
  const target = join(dir, NEW_DIR);
  const legacyYaml = join(legacy, LEGACY_YAML);
  const hasLegacyYaml = await exists(legacyYaml);

  if (await exists(target)) {
    // Both exist: the new dir wins; only surface a leftover yaml the operator
    // might still be editing by mistake.
    if (hasLegacyYaml && !(await exists(join(target, NEW_YAML)))) {
      out.push({
        kind: "rename-config-file",
        path: legacyYaml,
        detail: `${tilde(legacyYaml, home)} → ${tilde(join(target, NEW_YAML), home)} (${NEW_DIR}/ exists but has no ${NEW_YAML})`,
        apply: async () => {
          await rename(legacyYaml, join(target, NEW_YAML));
        },
      });
    } else {
      out.push({
        kind: "report",
        path: legacy,
        reportOnly: true,
        detail: `${tilde(legacy, home)} is shadowed by ${tilde(target, home)} — delete it once nothing else reads it`,
      });
    }
    return;
  }

  out.push({
    kind: "rename-config-dir",
    path: legacy,
    detail: `${tilde(legacy, home)} → ${tilde(target, home)}${hasLegacyYaml ? ` (and ${LEGACY_YAML} → ${NEW_YAML})` : ""}`,
    apply: async () => {
      await rename(legacy, target);
      if (hasLegacyYaml) {
        await rename(join(target, LEGACY_YAML), join(target, NEW_YAML));
      }
    },
  });
}

async function planMcpJson(file: string, home: string, out: MigrationAction[]): Promise<void> {
  const raw = await readJson(file);
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) return;
  const servers = raw.mcpServers;
  const touched: string[] = [];
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || !isLegacyCommand(entry.command)) {
      next[key] = entry;
      continue;
    }
    const newKey = key === "rlmx" && !("mikro" in servers) ? "mikro" : key;
    next[newKey] = { ...entry, command: "mikro" };
    touched.push(key === newKey ? `${key}.command` : `${key} → ${newKey}`);
  }
  if (touched.length === 0) return;
  out.push({
    kind: "rewrite-mcp-json",
    path: file,
    detail: `${tilde(file, home)}: ${touched.join(", ")} (command rlmx → mikro)`,
    apply: async () => {
      await rewriteJson(file, { ...raw, mcpServers: next });
    },
  });
}

async function walk(
  root: string,
  home: string,
  maxDepth: number,
  out: MigrationAction[],
  seen: Set<string>,
  exclude: readonly string[]
): Promise<void> {
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    const real = resolve(dir);
    if (seen.has(real)) continue;
    seen.add(real);

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (exclude.some((x) => path.includes(x))) continue;
      if (entry.isDirectory()) {
        if (entry.name === LEGACY_DIR) {
          // The home dir is handled by planHome — never treat ~/.rlmx as a
          // project config dir.
          if (resolve(dir) !== resolve(home)) await planConfigDir(dir, home, out);
          continue;
        }
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
        if (depth < maxDepth) stack.push({ dir: path, depth: depth + 1 });
      } else if (entry.isFile() && entry.name === ".mcp.json") {
        await planMcpJson(path, home, out);
      }
    }
  }
}

// ─── Home-level artifacts ────────────────────────────────

async function planHome(home: string, out: MigrationAction[]): Promise<void> {
  const legacy = join(home, LEGACY_DIR);
  const target = join(home, NEW_DIR);
  if (!(await exists(legacy))) return;

  if (!(await exists(target))) {
    out.push({
      kind: "migrate-home",
      path: legacy,
      detail: `~/${LEGACY_DIR} → ~/${NEW_DIR} (settings.json, sessions, data; a checkout at ~/${LEGACY_DIR}/rlmx becomes ~/${NEW_DIR}/mikro)`,
      apply: async () => {
        await rename(legacy, target);
        const oldCheckout = join(target, "rlmx");
        if ((await exists(oldCheckout)) && !(await exists(join(target, "mikro")))) {
          await rename(oldCheckout, join(target, "mikro"));
        }
      },
    });
    return;
  }

  // Both exist (install.sh already migrated, or a stale checkout was
  // re-created under the old path). Carry over settings.json if the new home
  // has none; everything else is reported, not merged.
  const legacySettings = join(legacy, "settings.json");
  const targetSettings = join(target, "settings.json");
  if ((await exists(legacySettings)) && !(await exists(targetSettings))) {
    out.push({
      kind: "migrate-home",
      path: legacySettings,
      detail: `~/${LEGACY_DIR}/settings.json → ~/${NEW_DIR}/settings.json (new home has none)`,
      apply: async () => {
        await copyFile(legacySettings, targetSettings);
      },
    });
  }
  let leftovers: string[] = [];
  try {
    leftovers = await readdir(legacy);
  } catch {
    // unreadable — still worth reporting the dir itself
  }
  out.push({
    kind: "report",
    path: legacy,
    reportOnly: true,
    detail: `~/${LEGACY_DIR} still exists beside ~/${NEW_DIR}${leftovers.length ? ` (${leftovers.join(", ")})` : ""} — nothing reads it any more; remove it when you are sure`,
  });
}

async function planSymlink(home: string, out: MigrationAction[]): Promise<void> {
  const link = join(home, ".local", "bin", "rlmx");
  let target: string;
  try {
    const st = await lstat(link);
    if (!st.isSymbolicLink()) return;
    target = await readlink(link);
  } catch {
    return;
  }
  out.push({
    kind: "remove-legacy-symlink",
    path: link,
    detail: `remove ~/.local/bin/rlmx → ${target} (legacy binary name; \`mikro\` is the CLI)`,
    apply: async () => {
      await rm(link, { force: true });
    },
  });
}

// ─── Claude Code plugin registration ─────────────────────

const LEGACY_PLUGIN_ID = "rlmx@rlmx";
const NEW_PLUGIN_ID = "mikro@mikro";

/** Marketplace source for a directory install of the mikro checkout. */
function mikroMarketplaceSource(home: string): Record<string, unknown> {
  return { source: "directory", path: join(home, NEW_DIR, "mikro") };
}

async function planClaudePlugin(home: string, out: MigrationAction[]): Promise<void> {
  const claudeDir = join(home, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const knownPath = join(claudeDir, "plugins", "known_marketplaces.json");
  const installedPath = join(claudeDir, "plugins", "installed_plugins.json");
  const newCheckout = join(home, NEW_DIR, "mikro");
  const cacheNew = join(claudeDir, "plugins", "cache", "mikro", "mikro", "0.1.0");

  // settings.json: enabledPlugins + extraKnownMarketplaces
  const settings = await readJson(settingsPath);
  if (isRecord(settings)) {
    const enabled = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : undefined;
    const markets = isRecord(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : undefined;
    const changes: string[] = [];
    if (enabled && LEGACY_PLUGIN_ID in enabled) changes.push(`enabledPlugins ${LEGACY_PLUGIN_ID} → ${NEW_PLUGIN_ID}`);
    if (markets && "rlmx" in markets) changes.push(`extraKnownMarketplaces rlmx → mikro (${tilde(newCheckout, home)})`);
    if (changes.length) {
      out.push({
        kind: "rewrite-claude-plugin",
        path: settingsPath,
        detail: `${tilde(settingsPath, home)}: ${changes.join("; ")}`,
        apply: async () => {
          const next: Record<string, unknown> = { ...settings };
          if (enabled && LEGACY_PLUGIN_ID in enabled) {
            const { [LEGACY_PLUGIN_ID]: was, ...rest } = enabled;
            next.enabledPlugins = { ...rest, [NEW_PLUGIN_ID]: was };
          }
          if (markets && "rlmx" in markets) {
            const { rlmx: _old, ...rest } = markets;
            next.extraKnownMarketplaces = { ...rest, mikro: { source: mikroMarketplaceSource(home) } };
          }
          await rewriteJson(settingsPath, next);
        },
      });
    }
  }

  // known_marketplaces.json
  const known = await readJson(knownPath);
  if (isRecord(known) && "rlmx" in known) {
    out.push({
      kind: "rewrite-claude-plugin",
      path: knownPath,
      detail: `${tilde(knownPath, home)}: marketplace rlmx → mikro (${tilde(newCheckout, home)})`,
      apply: async () => {
        const { rlmx: _old, ...rest } = known;
        await rewriteJson(knownPath, {
          ...rest,
          mikro: {
            source: mikroMarketplaceSource(home),
            installLocation: newCheckout,
            lastUpdated: new Date().toISOString(),
          },
        });
      },
    });
  }

  // installed_plugins.json + the plugin cache the host reads at startup
  const installed = await readJson(installedPath);
  if (isRecord(installed) && isRecord(installed.plugins) && LEGACY_PLUGIN_ID in installed.plugins) {
    out.push({
      kind: "rewrite-claude-plugin",
      path: installedPath,
      detail: `${tilde(installedPath, home)}: ${LEGACY_PLUGIN_ID} → ${NEW_PLUGIN_ID}, cache → ${tilde(cacheNew, home)}`,
      apply: async () => {
        const plugins = installed.plugins as Record<string, unknown>;
        const { [LEGACY_PLUGIN_ID]: entries, ...rest } = plugins;
        const now = new Date().toISOString();
        const rewritten = Array.isArray(entries)
          ? entries.map((e) => (isRecord(e) ? { ...e, installPath: cacheNew, lastUpdated: now } : e))
          : entries;
        // Seed the cache from the checkout's plugin source so the host finds
        // the plugin on its next start without a network fetch.
        const pluginSrc = join(newCheckout, "plugins", "claude-code");
        if (await exists(pluginSrc)) {
          await mkdir(dirname(cacheNew), { recursive: true });
          await cp(pluginSrc, cacheNew, { recursive: true, force: true });
        }
        await rewriteJson(installedPath, { ...installed, plugins: { ...rest, [NEW_PLUGIN_ID]: rewritten } });
      },
    });
  }
}

// ─── Report-only: shell rc and env ───────────────────────

const RC_LEGACY = /RLMX_|(~|\$HOME|\$\{HOME\}|\/home\/[^/\s"']+)\/\.rlmx\b/;

/** The textual rewrite `--rc` applies to one rc line. */
export function rewriteRcLine(line: string): string {
  return line
    .replace(/RLMX_/g, "MIKRO_")
    .replace(/((?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s"']+)\/)\.rlmx\b/g, "$1.mikro");
}

async function planShellAndEnv(
  home: string,
  env: NodeJS.ProcessEnv,
  out: MigrationAction[],
  rewriteRc: boolean
): Promise<void> {
  for (const rc of RC_FILES) {
    const file = join(home, rc);
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    const hits = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trim().startsWith("#") && RC_LEGACY.test(line));
    if (hits.length === 0) continue;
    if (rewriteRc) {
      out.push({
        kind: "rewrite-rc",
        path: file,
        detail: `${tilde(file, home)}: rewrite ${hits.length} line${hits.length === 1 ? "" : "s"} (~/.rlmx → ~/.mikro, RLMX_* → MIKRO_*): ${hits.map((h) => h.n).join(", ")}`,
        apply: async () => {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          await copyFile(file, `${file}.rlmx-backup-${stamp}`);
          const next = lines.map((line) => (!line.trim().startsWith("#") && RC_LEGACY.test(line) ? rewriteRcLine(line) : line));
          await writeFile(file, next.join("\n"), "utf-8");
        },
      });
      continue;
    }
    for (const { line, n } of hits) {
      out.push({
        kind: "report",
        path: file,
        reportOnly: true,
        detail: `${tilde(file, home)}:${n} references the legacy name — re-run with --rc to rewrite, or edit by hand: ${line.trim().slice(0, 100)}`,
      });
    }
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith("RLMX_")) {
      out.push({
        kind: "report",
        path: `env:${name}`,
        reportOnly: true,
        detail: `env ${name} is set — the new name is ${name.replace(/^RLMX_/, "MIKRO_")}`,
      });
    }
  }
}

// ─── Entry points ────────────────────────────────────────

/** Build the migration plan. Pure inspection — nothing is written. */
export async function scanLegacy(options: ScanOptions = {}): Promise<MigrationPlan> {
  const home = resolve(options.home ?? homedir());
  const roots = [...new Set((options.roots ?? [process.cwd(), home]).map((r) => resolve(r)))];
  const maxDepth = options.maxDepth ?? 6;
  const env = options.env ?? process.env;
  const exclude = (options.exclude ?? []).filter(Boolean);
  const actions: MigrationAction[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    try {
      if (!(await stat(root)).isDirectory()) continue;
    } catch {
      continue;
    }
    // A root that *is* a project dir with .rlmx/ is handled by the walk of its
    // parent listing; walking the root itself covers its children.
    await walk(root, home, maxDepth, actions, seen, exclude);
  }
  await planHome(home, actions);
  await planSymlink(home, actions);
  await planClaudePlugin(home, actions);
  await planShellAndEnv(home, env, actions, Boolean(options.rewriteRc));

  // Stable order: writes first (grouped by kind), then advice.
  const order: MigrationKind[] = [
    "migrate-home",
    "rename-config-dir",
    "rename-config-file",
    "rewrite-mcp-json",
    "remove-legacy-symlink",
    "rewrite-claude-plugin",
    "rewrite-rc",
    "report",
  ];
  actions.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.path.localeCompare(b.path));
  return { roots, actions };
}

/** Apply every writable action in order; returns what was applied. */
export async function applyPlan(plan: MigrationPlan): Promise<MigrationAction[]> {
  const done: MigrationAction[] = [];
  for (const action of plan.actions) {
    if (!action.apply) continue;
    await action.apply();
    done.push(action);
  }
  return done;
}

/** Human-readable plan. */
export function formatPlan(plan: MigrationPlan, home = homedir()): string {
  const writes = plan.actions.filter((a) => !a.reportOnly);
  const advice = plan.actions.filter((a) => a.reportOnly);
  const lines: string[] = [];
  lines.push(`mikro migrate — scanned ${plan.roots.map((r) => tilde(r, home)).join(", ")}`);
  if (plan.actions.length === 0) {
    lines.push("  no legacy rlmx artifacts found.");
    return lines.join("\n");
  }
  if (writes.length) {
    lines.push(`  ${writes.length} change${writes.length === 1 ? "" : "s"}:`);
    for (const a of writes) lines.push(`    [${a.kind}] ${a.detail}`);
  }
  if (advice.length) {
    lines.push(`  ${advice.length} to review by hand:`);
    for (const a of advice) lines.push(`    [note] ${a.detail}`);
  }
  return lines.join("\n");
}

/** Relative-to-root display helper for tests and reports. */
export function relToRoot(root: string, path: string): string {
  return relative(root, path) || ".";
}
