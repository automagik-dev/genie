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
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
/** Extensions the loader will try, in priority order. */
const PLUGIN_EXTENSIONS = [".mjs", ".js"];
export class MissingPluginError extends Error {
    toolName;
    triedPaths;
    constructor(toolName, triedPaths) {
        super(`plugin for tool "${toolName}" not found. Tried:\n  ${triedPaths.join("\n  ")}`);
        this.name = "MissingPluginError";
        this.toolName = toolName;
        this.triedPaths = triedPaths;
    }
}
export class InvalidPluginError extends Error {
    toolName;
    pluginPath;
    constructor(toolName, pluginPath, reason) {
        super(`plugin "${toolName}" at ${pluginPath} is invalid: ${reason}`);
        this.name = "InvalidPluginError";
        this.toolName = toolName;
        this.pluginPath = pluginPath;
    }
}
async function fileExists(path) {
    try {
        const s = await stat(path);
        return s.isFile();
    }
    catch {
        return false;
    }
}
export async function resolvePluginPath(agentDir, name) {
    const tried = [];
    for (const ext of PLUGIN_EXTENSIONS) {
        const candidate = join(agentDir, "tools", `${name}${ext}`);
        tried.push(candidate);
        if (await fileExists(candidate))
            return { path: candidate, tried };
    }
    return { path: null, tried };
}
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Read and validate the optional schema sidecar beside a resolved plugin. */
export async function readPluginSchema(toolName, pluginPath) {
    const sidecarPath = join(dirname(pluginPath), `${toolName}.schema.json`);
    let source;
    try {
        source = await readFile(sidecarPath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return undefined;
        throw new InvalidPluginError(toolName, sidecarPath, `schema could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch (err) {
        throw new InvalidPluginError(toolName, sidecarPath, `schema is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isPlainObject(parsed)) {
        throw new InvalidPluginError(toolName, sidecarPath, "schema must be a plain object");
    }
    const allowedKeys = new Set(["description", "parameters"]);
    const unknownKey = Object.keys(parsed).find((key) => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
        throw new InvalidPluginError(toolName, sidecarPath, `schema has unknown top-level key "${unknownKey}"`);
    }
    if ("description" in parsed && typeof parsed.description !== "string") {
        throw new InvalidPluginError(toolName, sidecarPath, "schema description must be a string");
    }
    if ("parameters" in parsed) {
        if (!isPlainObject(parsed.parameters)) {
            throw new InvalidPluginError(toolName, sidecarPath, "schema parameters must be a plain object");
        }
        if ("type" in parsed.parameters && parsed.parameters.type !== "object") {
            throw new InvalidPluginError(toolName, sidecarPath, 'schema parameters.type must be "object" when present');
        }
    }
    return parsed;
}
function coerceDefaultExport(mod, toolName, pluginPath) {
    if (!mod || typeof mod !== "object") {
        throw new InvalidPluginError(toolName, pluginPath, "module did not evaluate to an object");
    }
    const m = mod;
    const handler = m.default;
    if (typeof handler !== "function") {
        throw new InvalidPluginError(toolName, pluginPath, "missing default export (expected `export default async (args, ctx) => ...`)");
    }
    return handler;
}
/**
 * Load every plugin listed in `spec.tools` into `registry`. Returns a
 * breakdown of loaded / skipped / missing names so callers can log
 * the outcome. Tool names already in the registry are skipped (not
 * overridden) — consumer-supplied handlers
 * always win.
 */
export async function loadPluginTools(spec, registry, options = {}) {
    const loaded = [];
    const skipped = [];
    const missing = [];
    for (const name of spec.tools) {
        if (registry.has(name)) {
            skipped.push(name);
            continue;
        }
        const { path, tried } = await resolvePluginPath(spec.dir, name);
        if (!path) {
            if (options.strict)
                throw new MissingPluginError(name, tried);
            missing.push(name);
            continue;
        }
        // Use the file:// URL form — dynamic import() on a bare absolute
        // path fails on Windows and in some Node configs. `pathToFileURL`
        // handles both without surprises.
        const mod = (await import(pathToFileURL(path).href));
        const handler = coerceDefaultExport(mod, name, path);
        const schema = await readPluginSchema(name, path);
        registry.register(name, handler, schema);
        loaded.push(name);
    }
    return { loaded, skipped, missing };
}
//# sourceMappingURL=tool-loader.js.map