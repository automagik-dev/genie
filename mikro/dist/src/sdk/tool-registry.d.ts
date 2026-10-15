/**
 * Tool registry — Wish B Group 3a + mikro#78.
 *
 * Maps tool names declared in `agent.yaml` (`tools: [...]`) to
 * in-process handler functions the SDK can dispatch to. Both
 * consumer-registered handlers and loader-registered
 * handlers (TS plugins from `<agent-dir>/tools/<name>.ts`) land in
 * the same registry.
 *
 * Each handler may carry an optional `ToolSchema` (mikro#78) — the
 * description + JSON-Schema parameters the rlmDriver feeds into the
 * LLM's native function-calling channel. Handlers without schemas are
 * still dispatchable (via explicit `tool_call` steps emitted by a
 * driver that composes the args another way) but will NOT be exposed
 * to the LLM as callable functions.
 *
 * The registry is deliberately boring: `register`, `get`, `list`,
 * `has`, `describe`, `listSchemas`. Anything richer — permission
 * overlays, timeouts, retries — belongs in the runAgent dispatch path,
 * not here.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L24, L164-168;
 * mikro#78 (tool dispatch in rlmDriver).
 */
import type { ToolResolver } from "./agent.js";
export interface ToolContext {
    readonly tool: string;
    readonly sessionId: string;
    readonly iteration: number;
    readonly signal: AbortSignal;
}
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<unknown>;
/**
 * Optional metadata describing a tool's invocation contract. When
 * present, the rlmDriver forwards this to the LLM as a native
 * function-calling tool. When absent, the tool is only dispatchable
 * via out-of-band mechanisms (e.g. a custom driver that emits
 * `tool_call` steps with args it sourced itself).
 *
 * `parameters` is a plain JSON Schema object — any valid draft-07 /
 * 2020-12 shape works. pi-ai normalizes this for each provider
 * (Gemini functionDeclarations, Anthropic input_schema, etc.) so the
 * same object ships to every backend.
 */
export interface ToolSchema {
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
}
export interface ToolRegistry {
    register(name: string, handler: ToolHandler, schema?: ToolSchema): void;
    get(name: string): ToolHandler | undefined;
    has(name: string): boolean;
    list(): readonly string[];
    /** Replace the handler for a name if it exists; no-op otherwise.
     *  When `schema` is supplied it replaces the existing one. */
    override(name: string, handler: ToolHandler, schema?: ToolSchema): boolean;
    /** Metadata describing how the LLM should call this tool. `undefined`
     *  when the caller registered a handler without a schema. */
    describe(name: string): ToolSchema | undefined;
    /** Snapshot of every `{name, schema}` with a schema attached — the
     *  list of tools eligible for native function-calling. Tools
     *  without schemas are omitted. */
    listSchemas(): readonly {
        readonly name: string;
        readonly schema: ToolSchema;
    }[];
}
export declare class UnknownToolError extends Error {
    readonly toolName: string;
    constructor(name: string);
}
/** Create a fresh in-memory tool registry. Simple Map under the hood. */
export declare function createToolRegistry(): ToolRegistry;
/**
 * Adapt a `ToolRegistry` into the `ToolResolver` shape `runAgent`
 * accepts. When the requested tool is missing, throws
 * `UnknownToolError` so the wiring surfaces it as a
 * `ToolCallAfter{ok:false}` + `Error{phase:"tool"}` pair (handled
 * by the existing runAgent error plumbing — no new event needed).
 */
export declare function toolRegistryAsResolver(registry: ToolRegistry): ToolResolver;
//# sourceMappingURL=tool-registry.d.ts.map