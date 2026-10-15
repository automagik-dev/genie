/**
 * Python plugin loader — Wish B Group 3b.
 *
 * Extends the G3a tool plugin loader to accept `.py` files under
 * `<agent-dir>/tools/<name>.py`. A Python plugin is a standalone
 * script the SDK spawns once per tool call:
 *
 *   SDK → spawn(`python3 <plugin.py>`, stdin=JSON args)
 *         → stdout: JSON result
 *         → stderr: diagnostic text (captured, never interpreted)
 *         → exit code: 0 pass, non-zero fail
 *
 * Plugin author contract (minimal, no framework lock-in):
 *
 *   #!/usr/bin/env python3
 *   import json, sys
 *   args = json.load(sys.stdin)
 *   # ... user logic ...
 *   json.dump(result, sys.stdout)
 *
 * Errors are surfaced via typed exceptions so the runAgent wiring
 * classifies them correctly:
 *
 *   InvalidPluginError — plugin script unreadable / interpreter missing
 *   PythonPluginTimeoutError — wall-clock budget exceeded
 *   PythonPluginError — non-zero exit or malformed stdout JSON
 *
 * Out of scope (deferred):
 *   - Heavy sandboxing (seccomp, namespaces, resource limits)
 *   - Virtualenv / dependency management
 *   - Streaming output / partial results
 *   - Cross-language tool composition
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L24, L164-168 +
 * G3b dispatch from simone.
 */
import type { AgentSpec } from "./agent-spec.js";
import type { ToolHandler, ToolRegistry } from "./tool-registry.js";
export declare const DEFAULT_PYTHON_BIN = "python3";
export declare const DEFAULT_TIMEOUT_MS = 30000;
export interface PythonPluginOptions {
    /** Interpreter to spawn. Default `python3`; override for venv paths. */
    readonly pythonBin?: string;
    /** Per-call timeout. Default 30 s. Set to `null` to disable. */
    readonly timeoutMs?: number | null;
    /** Environment variables passed to the subprocess. When omitted the
     *  inherited `process.env` is forwarded unchanged so plugins can
     *  read the usual credentials. Pass `{}` to isolate (no env). */
    readonly env?: Readonly<Record<string, string>>;
    /** Working directory for the subprocess. Defaults to the agent
     *  directory — keeps `pathlib.Path.cwd()` lined up with
     *  `BRAIN_HOME`-style conventions. */
    readonly cwd?: string;
    /** When true, loadPythonPlugins throws `InvalidPluginError` if the
     *  interpreter binary cannot be resolved. Default false. */
    readonly strictInterpreter?: boolean;
}
/** Thrown when the Python script crashes or produces invalid JSON. */
export declare class PythonPluginError extends Error {
    readonly toolName: string;
    readonly exitCode: number | null;
    readonly stderr: string;
    readonly stdout: string;
    constructor(toolName: string, exitCode: number | null, stderr: string, stdout: string, hint?: string);
}
/** Thrown when the subprocess overruns `timeoutMs`. */
export declare class PythonPluginTimeoutError extends Error {
    readonly toolName: string;
    readonly timeoutMs: number;
    constructor(toolName: string, timeoutMs: number);
}
export interface PythonPluginExecResult {
    readonly value: unknown;
    readonly stderr: string;
    readonly durationMs: number;
}
/**
 * Build a `ToolHandler` that shells out to `scriptPath`. Exported so
 * consumers can pre-register individual Python tools (e.g. a vendored
 * utility) without running the discovery step.
 */
export declare function makePythonPluginHandler(toolName: string, scriptPath: string, options?: PythonPluginOptions): ToolHandler;
export declare function resolvePythonScript(agentDir: string, name: string): Promise<string | null>;
export interface PythonLoadResult {
    readonly loaded: readonly string[];
    readonly skipped: readonly string[];
    readonly missing: readonly string[];
}
/**
 * For each tool in `spec.tools` that isn't already in `registry`,
 * attempt to resolve a `.py` plugin and register a subprocess-backed
 * handler. Returns the same loaded/skipped/missing breakdown the G3a
 * loader uses so callers can compose them.
 *
 * Usage pattern — run the G3a loader first (prefers .mjs/.js), then
 * this one for any remaining tool names:
 *
 *   const mj = await loadPluginTools(spec, registry);
 *   const py = await loadPythonPlugins(spec, registry);
 *   // mj.missing ∩ py.loaded  → resolved by Python
 *   // mj.missing \ py.loaded  → genuinely unresolved
 */
export declare function loadPythonPlugins(spec: AgentSpec, registry: ToolRegistry, options?: PythonPluginOptions): Promise<PythonLoadResult>;
//# sourceMappingURL=python-plugin.d.ts.map