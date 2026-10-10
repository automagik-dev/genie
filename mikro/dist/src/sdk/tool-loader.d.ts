/**
 * Plugin loader — Wish B Group 3a.
 *
 * Reads an `AgentSpec.tools[]` list and populates a `ToolRegistry` by
 * dynamically importing each plugin file from `<agent-dir>/tools/`.
 * TypeScript-source loading is deferred to G3b (needs a TS runtime
 * like tsx when plugins haven't been pre-compiled). This PR supports
 * the universally-portable extensions: `.mjs` and `.js`.
 *
 * Contract for a plugin file (`tools/<name>.js` or `.mjs`):
 *
 *   export default async function(args, ctx) { return result; }
 *
 * The default export must be a function satisfying `ToolHandler`.
 * Named exports are ignored; the loader only looks at `module.default`.
 *
 * Resolution algorithm:
 *   1. `<agentDir>/tools/<name>.mjs`  ← preferred (ESM, explicit)
 *   2. `<agentDir>/tools/<name>.js`   ← fallback
 *   3. Miss → `MissingPluginError` with every attempted path listed.
 *
 * Plugins that aren't listed in `AgentSpec.tools` are NEVER loaded, so
 * a stray file under `tools/` can't sneak in. Conversely, tool names
 * already present in the registry (e.g. consumer-supplied at startup)
 * are skipped silently — the agent.yaml declaration is a *request*,
 * not an override.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L24, L164-168.
 */
import type { AgentSpec } from "./agent-spec.js";
import type { ToolRegistry, ToolSchema } from "./tool-registry.js";
export interface LoadResult {
    /** Names that were newly added to the registry. */
    readonly loaded: readonly string[];
    /** Names already in the registry (pre-registered by the consumer). */
    readonly skipped: readonly string[];
    /** Tool names missing a plugin file — a warning, not a fatal error. */
    readonly missing: readonly string[];
}
export declare class MissingPluginError extends Error {
    readonly toolName: string;
    readonly triedPaths: readonly string[];
    constructor(toolName: string, triedPaths: readonly string[]);
}
export declare class InvalidPluginError extends Error {
    readonly toolName: string;
    readonly pluginPath: string;
    constructor(toolName: string, pluginPath: string, reason: string);
}
export declare function resolvePluginPath(agentDir: string, name: string): Promise<{
    path: string | null;
    tried: readonly string[];
}>;
/** Read and validate the optional schema sidecar beside a resolved plugin. */
export declare function readPluginSchema(toolName: string, pluginPath: string): Promise<ToolSchema | undefined>;
export interface LoadOptions {
    /** When true, missing plugin files throw `MissingPluginError` instead
     *  of accumulating on `LoadResult.missing`. Default: false (non-fatal).
     *  Use `strict: true` for production startup to fail-fast on typos. */
    readonly strict?: boolean;
}
/**
 * Load every plugin listed in `spec.tools` into `registry`. Returns a
 * breakdown of loaded / skipped / missing names so callers can log
 * the outcome. Tool names already in the registry are skipped (not
 * overridden) — consumer-supplied handlers
 * always win.
 */
export declare function loadPluginTools(spec: AgentSpec, registry: ToolRegistry, options?: LoadOptions): Promise<LoadResult>;
//# sourceMappingURL=tool-loader.d.ts.map