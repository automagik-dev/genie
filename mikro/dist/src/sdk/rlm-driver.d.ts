/**
 * rlm-driver — Wish B Group 2b/c + mikro#78.
 *
 * Adapts the mikro LLM backend to the `IterationDriver` contract
 * defined in `src/sdk/agent.ts`. Two modes:
 *
 *   1. **Legacy one-shot mode** (no `tools` config) — the original
 *      behavior: one `llmCompleteSimple` call per iteration, whole
 *      response surfaced as `emit_done.payload.answer`. Preserved
 *      byte-compatibly so existing consumers (cli cutover, simple
 *      agents without tools) keep working.
 *
 *   2. **Tool-dispatch mode** (mikro#78, `tools` config present) —
 *      multi-turn conversation loop with native function-calling:
 *      construction throws `NoExposableToolsError` when no tool
 *      remaining after `expose` has a schema.
 *
 *        • ToolRegistry schemas → pi-ai `Tool[]` → provider-native
 *          function declarations (Gemini functionDeclarations,
 *          Anthropic tools, OpenAI functions — pi-ai handles the
 *          per-provider shape).
 *        • Each LLM call is followed by a check for `ToolCall`
 *          content blocks; any that are present are yielded as
 *          `tool_call` steps, their outcomes come back via
 *          `yield`'s return value (runAgent manual-iterates), and
 *          we append a `toolResult` message to the pi-ai history
 *          before the next call.
 *        • Loop terminates when the LLM emits a pure-text
 *          response (stopReason === "stop") OR an explicit
 *          `emit_done` tool call OR the max-tool-iterations cap
 *          is hit.
 *        • runAgent's permission chain, validate retry pipeline,
 *          session/checkpoint primitives all continue to fire —
 *          the driver stays hermetic and the event flow is
 *          identical to the G2b contract.
 *
 * Design constraints:
 *
 *   • Zero touch to `src/rlm.ts` — the existing CLI entry (`rlmLoop`)
 *     stays byte-for-byte unchanged. This module is additive.
 *   • Legacy path still shares `llmCompleteSimple` with rlm.ts, so
 *     any provider / thinking-level / budget work that lands in
 *     `llm.ts` automatically benefits this driver.
 *   • Tool-dispatch path calls pi-ai `completeSimple` directly —
 *     the tool-aware plumbing (Context.tools, ToolResultMessage,
 *     preserving AssistantMessage across turns) is inherent to
 *     pi-ai's transport layer, so we bypass the legacy `llm.ts`
 *     wrapper rather than bolt tool support on there.
 *   • Python REPL tool-call parsing (mikro-specific ```tool_call``` code
 *     blocks) is still NOT done here — that's the rlm.ts CLI's
 *     concern and a separate slice. This driver does NATIVE
 *     function-calling only, which is what Tier 2 brain-consuming
 *     agents need.
 *
 * Consumers compose it via `runAgent({ driver: rlmDriver(cfg),
 * toolRegistry: registry })` — never called directly by user code.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L93 (wave 5
 * dogfood), plus the "prove end-to-end wiring against real LLM"
 * mandate added in the G2b review cycle; mikro#78 for the native
 * tool-dispatch loop that unblocks Tier 2 agents.
 */
import type { AssistantMessage as PiAssistantMessage, Context as PiContext } from "@earendil-works/pi-ai";
import type { ModelConfig } from "../config.js";
import { type LLMResponse } from "../llm.js";
import type { IterationDriver, IterationRequest } from "./agent.js";
import type { ToolRegistry } from "./tool-registry.js";
/**
 * Tool-dispatch config for mikro#78. When present on `RlmDriverConfig`,
 * the driver enters multi-turn tool-dispatch mode.
 */
export interface RlmDriverToolsConfig {
    /** Source of tool schemas the LLM will be offered. At least one
     *  exposed tool must have a schema (via `registry.register(name,
     *  handler, schema)`), otherwise construction throws
     *  `NoExposableToolsError`. */
    readonly registry: ToolRegistry;
    /**
     * Hard cap on LLM calls per iteration (defense against infinite
     * tool-calling loops). When exceeded, the driver yields an
     * `error` step with the partial answer. Default: 16.
     */
    readonly maxToolIterations?: number;
    /**
     * Optional list of tool names to expose to the LLM. When
     * omitted, every registry tool with a schema is exposed. Useful
     * when the agent.yaml whitelist is stricter than the registry
     * (e.g. pre-registered tools you don't want this agent to
     * see). Order is preserved in the tools[] array.
     */
    readonly expose?: readonly string[];
}
export interface RlmDriverConfig {
    /** Model config — same shape rlm.ts uses. */
    readonly model: ModelConfig;
    /** Optional SYSTEM.md contents; prepended to each turn's prompt. */
    readonly system?: string;
    /**
     * Injectable LLM completion fn for the legacy (no-tools) path.
     * Defaults to the real `llmCompleteSimple` so production just
     * calls Gemini. Tests pass a mock to validate the driver's event
     * sequence without a live model. Ignored when `tools` is set —
     * the tool-dispatch path needs pi-ai's native `completeSimple`
     * for tool-aware transport, and exposes a separate `toolsLlm`
     * injection point for tests.
     */
    readonly llm?: (prompt: string, modelConfig: ModelConfig, signal?: AbortSignal) => Promise<LLMResponse>;
    /**
     * Hook for retry hints. When present, the driver injects the hint
     * into the prompt prefix on iterations where `req.retryHint` is
     * set by the runAgent validate pipeline. Default: prepends a
     * labelled block.
     */
    readonly retryHintFormatter?: (hint: string) => string;
    /**
     * Tool-dispatch config (mikro#78). When set, switches the driver
     * into multi-turn native-function-calling mode.
     */
    readonly tools?: RlmDriverToolsConfig;
    /**
     * Injectable pi-ai completion fn for the tool-dispatch path.
     * Defaults to the real `completeSimple` so production just calls
     * Gemini / Anthropic / OpenAI with native function-calling. Tests
     * pass a mock to validate the tool loop without a live model.
     */
    readonly toolsLlm?: (context: PiContext, modelConfig: ModelConfig, signal?: AbortSignal) => Promise<PiAssistantMessage>;
}
export declare class NoExposableToolsError extends Error {
    constructor(handlerNames: readonly string[]);
}
/**
 * Render the iteration's prompt. Keeps it intentionally simple — the
 * driver's job is to get a response surface, not to reproduce the
 * full SYSTEM.md / TOOLS.md / CRITERIA.md synthesis rlm.ts does.
 * Callers needing the full rlm.ts prompt stack should wait for the
 * CLI-cutover slice.
 */
export declare function formatRlmPrompt(config: RlmDriverConfig, req: IterationRequest): string;
/**
 * Build an `IterationDriver` that drives the LLM. Legacy one-shot
 * mode is used only when `tools` is absent. When `tools` is present,
 * construction throws unless at least one tool remaining after
 * `expose` has a schema; otherwise it uses multi-turn tool dispatch.
 */
export declare function rlmDriver(config: RlmDriverConfig): IterationDriver;
//# sourceMappingURL=rlm-driver.d.ts.map