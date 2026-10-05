/**
 * `agent.yaml` parser — Wish B Group 3.
 *
 * Minimal schema matching the folder-based agent convention from
 * wish A (khal-os/brain `.agents/<name>/agent.yaml`). Only the fields
 * the SDK needs for plugin loading + runAgent wiring are parsed here;
 * extra YAML keys are preserved on the returned `extras` bag so
 * consumers can layer their own schema on top without forking this
 * parser.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L24, L164-168.
 */
import { type ThinkingLevel } from "../gemini.js";
export interface AgentBudget {
    readonly maxCost?: number;
    readonly maxIterations?: number;
    readonly maxDepth?: number;
}
export interface AgentScope {
    readonly reads?: readonly string[];
    readonly writes?: readonly string[];
}
/**
 * Per-agent system-prompt assembly overrides — the `agent.yaml` equivalent of
 * mikro.yaml's `prompt:` block. `undefined` means "not declared", so the
 * ambient config decides.
 */
export interface AgentPrompt {
    /**
     * Opt out of the appended REPL/FINAL termination protocol
     * (`src/stop-protocol.ts`). Consumers apply it by writing
     * `config.prompt.appendStopProtocol` (see `applyAgent` in
     * `src/mcp/server.ts`), which is the same field mikro.yaml's
     * `prompt.append-stop-protocol` writes — an agent's declaration simply
     * outranks the ambient one.
     */
    readonly appendStopProtocol?: boolean;
}
export interface AgentSpec {
    /** Agent directory on disk — parent of agent.yaml. All tool-file
     *  resolutions are relative to this path. */
    readonly dir: string;
    readonly schemaVersion: number;
    readonly toolsApi: number;
    readonly shape: "single-step" | "loop" | "recurse";
    readonly model?: string;
    readonly tools: readonly string[];
    readonly systemPath?: string;
    /**
     * Reasoning effort for this agent's own model calls — the `agent.yaml`
     * equivalent of `mikro --thinking`. `undefined` means "not declared".
     *
     * Consumers apply it by writing `config.gemini.thinkingLevel`, the single
     * field `llmComplete` turns into pi-ai's `reasoning` option (see
     * `applyAgent` in `src/mcp/server.ts`). Two honest caveats:
     *
     * 1. Despite the `gemini.` prefix on the config field, pi-ai maps
     *    `reasoning` on **every** api family it supports — OpenAI Responses
     *    (`reasoning.effort`), OpenAI Completions and its deepseek / openrouter
     *    / zai / together dialects (`reasoning_effort`), Google
     *    (`thinkingConfig.thinkingLevel`), and Anthropic
     *    (`thinking.budget_tokens`). This is not a Google-only knob.
     * 2. The level is a **request, not a guarantee**. pi-ai's
     *    `clampThinkingLevel` snaps it to the levels the resolved model
     *    actually declares, searching *upward* first — so `minimal` on a model
     *    whose floor is higher is silently raised, not lowered. Omitting the
     *    field is likewise not "provider default": pi-ai then explicitly
     *    *disables* reasoning on models that support it.
     */
    readonly thinking?: ThinkingLevel;
    /**
     * Sampling temperature for this agent's own model calls, `0`–`2` — the
     * `agent.yaml` twin of `mikro --temperature`. `undefined` means "not
     * declared", so the ambient config decides.
     *
     * Consumers apply it by writing `config.temperature`, the single field
     * `llmComplete` turns into pi-ai's `temperature` option (see `applyAgent` in
     * `src/mcp/server.ts`) — the same field mikro.yaml's top-level `temperature:`
     * writes, so an agent's declaration simply outranks the ambient one.
     *
     * Two caveats, both the same shape as `thinking:`'s:
     *
     * 1. `0` is a **meaningful** value (greedy decoding), not a synonym for
     *    unset. Every guard on this field is `!= null` / `!== undefined` and
     *    never truthiness.
     * 2. It is best-effort. pi-ai sends `temperature` on every api family and
     *    drops it on exactly one — `anthropic-messages` — either when a
     *    reasoning level is set or when the resolved model declares
     *    `compat.supportsTemperature: false`. The guard belongs to the api,
     *    not the model family: Claude reached via OpenRouter or Bedrock keeps
     *    its temperature regardless. A declared temperature is a request, not
     *    a guarantee.
     */
    readonly temperature?: number;
    readonly scope?: AgentScope;
    readonly budget?: AgentBudget;
    /** System-prompt assembly overrides. `undefined` means "not declared". */
    readonly prompt?: AgentPrompt;
    /**
     * Internal, undocumented: which runtime backend executes this agent's
     * turns (wish mikro-v2-prime-backend). Absent means `mikro` — the legacy
     * engine, which stays the default. Deliberately NOT part of the
     * documented `agent.yaml` schema: it is a gate/experiment selector that
     * may change without notice.
     *
     * - `mikro` — the legacy in-process engine (`rlmLoop`). The default.
     * - `prime` — one `prime-agent` subprocess per turn
     *   (`src/mcp/backends/prime.ts`).
     * - `prime-sdk` — the same agent driven in-process through prime's
     *   programmatic SDK (`src/mcp/backends/prime-sdk.ts`): no per-turn cold
     *   start, plus custom tools, structured output, custom providers, and
     *   sub-call depth, which the subprocess flag surface cannot express.
     */
    readonly backend?: "mikro" | "prime" | "prime-sdk";
    /** Preserved unrecognised keys — consumers layer their own schema. */
    readonly extras: Readonly<Record<string, unknown>>;
}
/**
 * Parse a raw YAML string into an `AgentSpec`. `dir` is the agent's
 * filesystem directory — used later by the tool loader to resolve
 * plugin file paths. Throws on schema violations with a precise
 * message identifying the offending key.
 */
export declare function parseAgentSpec(yamlText: string, dir: string): AgentSpec;
/**
 * Load + parse an agent directory's `agent.yaml`. Convenience wrapper
 * around `readFile` + `parseAgentSpec`. The returned `AgentSpec.dir`
 * is the absolute path of the supplied `agentDir` so downstream
 * plugin-path resolution has an anchor regardless of cwd.
 */
export declare function loadAgentSpec(agentDir: string): Promise<AgentSpec>;
/**
 * Resolve an agent-relative path to an absolute path. Exported so the
 * tool loader + consumers share a single resolution convention.
 */
export declare function resolveAgentPath(spec: AgentSpec, relative: string): string;
//# sourceMappingURL=agent-spec.d.ts.map