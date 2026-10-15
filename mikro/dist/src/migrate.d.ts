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
export type MigrationKind = "rename-config-dir" | "rename-config-file" | "rewrite-mcp-json" | "migrate-home" | "remove-legacy-symlink" | "rewrite-claude-plugin" | "rewrite-rc" | "report";
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
/** The textual rewrite `--rc` applies to one rc line. */
export declare function rewriteRcLine(line: string): string;
/** Build the migration plan. Pure inspection — nothing is written. */
export declare function scanLegacy(options?: ScanOptions): Promise<MigrationPlan>;
/** Apply every writable action in order; returns what was applied. */
export declare function applyPlan(plan: MigrationPlan): Promise<MigrationAction[]>;
/** Human-readable plan. */
export declare function formatPlan(plan: MigrationPlan, home?: string): string;
/** Relative-to-root display helper for tests and reports. */
export declare function relToRoot(root: string, path: string): string;
//# sourceMappingURL=migrate.d.ts.map