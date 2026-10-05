/**
 * LLM client wrapper using pi/ai.
 *
 * Provides completeSimple wrapper, batched calls, IPC request handling
 * from the Python REPL, and rlm_query child process spawning.
 */

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Message, UserMessage, AssistantMessage as PiAssistantMessage, SimpleStreamOptions, KnownProvider, TextContent } from "@earendil-works/pi-ai";
import {
  ensureStationModels,
  registerStationProvider,
  STATION_PROVIDER_ID,
} from "./station-provider.js";
import {
  ensureKhalModels,
  registerKhalProvider,
  KHAL_PROVIDER_ID,
} from "./khal-provider.js";
import {
  describeProviderHint,
  ensureCustomProviders,
  type CustomProviderConfig,
} from "./custom-providers.js";
import { spawn } from "node:child_process";
import { uuidv7 } from "./uuid.js";
import type { MikroConfig, ModelConfig, GeminiConfig } from "./config.js";
import type { LLMRequest } from "./ipc.js";
import type { Logger } from "./logger.js";
import type { PgStorage } from "./storage.js";
import { buildGeminiOnPayload, isGoogleProvider, type ThinkingLevel } from "./gemini.js";

/**
 * Shared pi-ai Models runtime. `builtinModels()` registers every built-in
 * provider once per process; provider auth resolution (env API keys such as
 * ANTHROPIC_API_KEY / GEMINI_API_KEY) replaces the old compat env-key
 * injection that the root `completeSimple`/`getModel` helpers provided.
 */
const models = builtinModels();
// Register the local Lemonade gateway as a first-class `station/<model>`
// provider at this resolution site (mirrored in src/sdk/rlm-driver.ts).
registerStationProvider(models);
// Same for the khal LiteLLM gateway (`khal/<model>`).
registerKhalProvider(models);

/** Token usage tracking. */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  llmCalls: number;
  /** Reasoning/thinking tokens (a subset of outputTokens), when the provider reports them. */
  reasoningTokens?: number;
}

/** Create a fresh usage tracker. */
export function createUsage(): UsageStats {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, llmCalls: 0, reasoningTokens: 0 };
}

/** Return a - b for usage accounting splits. */
export function usageDelta(a: UsageStats, b: UsageStats): UsageStats {
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
    totalCost: a.totalCost - b.totalCost,
    llmCalls: a.llmCalls - b.llmCalls,
    reasoningTokens: (a.reasoningTokens ?? 0) - (b.reasoningTokens ?? 0),
  };
}

export interface UsageBreakdown {
  root: UsageStats;
  child: UsageStats;
  total: UsageStats;
}

/** Gemini-specific call counts tracked across an RLM run. */
export interface GeminiCallCounts {
  webSearch: number;
  fetchUrl: number;
  generateImage: number;
  codeExecutionsServerSide: number;
  thoughtSignatures: number;
}

/** Create a fresh Gemini call counter. */
export function createGeminiCallCounts(): GeminiCallCounts {
  return { webSearch: 0, fetchUrl: 0, generateImage: 0, codeExecutionsServerSide: 0, thoughtSignatures: 0 };
}

/** Merge child usage into parent. */
export function mergeUsage(parent: UsageStats, child: UsageStats): void {
  parent.inputTokens += child.inputTokens;
  parent.outputTokens += child.outputTokens;
  parent.cacheReadTokens += child.cacheReadTokens;
  parent.cacheWriteTokens += child.cacheWriteTokens;
  parent.totalCost += child.totalCost;
  parent.llmCalls += child.llmCalls;
  parent.reasoningTokens = (parent.reasoningTokens ?? 0) + (child.reasoningTokens ?? 0);
}

/** Message format for the RLM loop. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Original pi/ai AssistantMessage — stored for multi-turn fidelity. */
  piMessage?: PiAssistantMessage;
}

/** Cache config passed through to pi/ai completeSimple. */
export interface CacheLLMConfig {
  enabled: boolean;
  retention: "short" | "long";
  sessionId: string;
}

/** Code execution result from Gemini (GROUP 5). */
export interface CodeExecutionResult {
  code: string;
  outcome: "OUTCOME_OK" | "OUTCOME_FAILED" | "OUTCOME_DEADLINE_EXCEEDED";
  output: string;
}

/** Response from a single LLM call. */
export interface LLMResponse {
  text: string;
  usage: UsageStats;
  /** Original pi/ai AssistantMessage for multi-turn conversation fidelity. */
  piMessage?: PiAssistantMessage;
  /** Provider-reported model that actually served the response (AssistantMessage.responseModel). */
  responseModel?: string;
  /** Count of thought signatures in response (GROUP 2: multi-turn quality tracking). */
  thoughtSignatureCount?: number;
  /** Code execution results from Gemini (GROUP 5). */
  codeExecutionResults?: CodeExecutionResult[];
}

export function normalizeOpenRouterDeveloperRole(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const maybePayload = payload as { messages?: Array<{ role?: string }> };
  if (!Array.isArray(maybePayload.messages)) return payload;
  return {
    ...(payload as Record<string, unknown>),
    messages: maybePayload.messages.map((message) => {
      if (message && message.role === "developer") {
        return { ...message, role: "system" };
      }
      return message;
    }),
  };
}

/**
 * Resolve a pi/ai model, trying the exact ID first, then stripping the date suffix.
 */
export function normalizeProviderModelId(provider: string, modelId: string): string {
  // OpenRouter model ids intentionally include the upstream provider prefix
  // (for example `deepseek/deepseek-v4-pro`), so never strip for OpenRouter.
  if (provider === "openrouter") return modelId;

  const prefix = `${provider}/`;
  if (modelId.startsWith(prefix)) {
    return modelId.slice(prefix.length);
  }
  return modelId;
}

export function formatModelRef(provider: string, modelId: string): string {
  return `${provider}/${normalizeProviderModelId(provider, modelId)}`;
}

/**
 * Resolve a pi-ai model for `<provider>/<modelId>`.
 *
 * `providers` are the config-declared providers riding on the model config;
 * they are registered on the shared runtime before lookup so a declared
 * `<id>/<model>` resolves exactly like a built-in. Exported so the MCP server
 * and `mikro doctor` can validate a pin without making a call.
 */
export function resolveModel(
  provider: string,
  modelId: string,
  providers?: readonly CustomProviderConfig[]
) {
  ensureCustomProviders(models, providers);
  const normalizedModelId = normalizeProviderModelId(provider, modelId);
  let model = models.getModel(provider, normalizedModelId);
  if (!model) {
    // Try stripping date suffix (e.g., "claude-sonnet-4-5-20250514" -> "claude-sonnet-4-5")
    const stripped = normalizedModelId.replace(/-\d{8}$/, "");
    if (stripped !== normalizedModelId) {
      model = models.getModel(provider, stripped);
    }
  }
  if (!model && provider === "kimi-coding" && modelId.startsWith("kimi-k2.6")) {
    // pi-ai 0.77.0's generated registry exposes Kimi's coding endpoint but has
    // not caught up with K2.6 under the `kimi-coding` provider. The endpoint
    // accepts K2.6 model IDs with the same Anthropic-compatible transport and
    // KIMI_API_KEY auth as `kimi-k2-thinking`, so clone that route rather than
    // falling back to Moonshot API credentials we do not have.
    const template = models.getModel("kimi-coding", "kimi-k2-thinking");
    if (template) {
      model = {
        ...template,
        id: modelId,
        name: "Kimi K2.6",
        input: ["text", "image"],
      } as typeof template;
    }
  }
  if (!model) {
    throw new Error(
      `Unknown model "${modelId}" for provider "${provider}". ` +
        describeProviderHint(providers, provider, models.getProvider(provider) !== undefined)
    );
  }
  return model;
}

/**
 * Check that a model config resolves, without calling anything. Returns the
 * failure message, or null when the pin is good.
 *
 * Station and khal carry dynamic catalogs that need a network round-trip to
 * fill; they are reported as resolvable here and checked at call time, as
 * before. Everything else — built-ins and config-declared providers — is
 * static and answers immediately.
 */
export function checkModelConfig(modelConfig: ModelConfig): string | null {
  if (
    modelConfig.provider === STATION_PROVIDER_ID ||
    modelConfig.provider === KHAL_PROVIDER_ID
  ) {
    return null;
  }
  try {
    resolveModel(modelConfig.provider, modelConfig.model, modelConfig.providers);
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Per-call options accepted by `llmComplete`. */
export interface LlmCompleteOptions {
  maxTokens?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  logger?: Logger;
  iteration?: number;
  cacheConfig?: CacheLLMConfig;
  thinkingLevel?: ThinkingLevel | null;
  /**
   * Sampling temperature, `0`–`2`. `null`/absent means **unset**, and unset
   * leaves no `temperature` key on the pi-ai options at all — see
   * `buildPiOptions`. Validated at the config surfaces, not here.
   */
  temperature?: number | null;
  outputSchema?: Record<string, unknown> | null;
  geminiConfig?: GeminiConfig;
}

/**
 * Build the pi-ai options for one completion: the sampling and caching half,
 * before any provider payload hooks are attached.
 *
 * Split out of `llmComplete` so the exact object handed to pi-ai is assertable
 * without a network call — which matters most for the fields whose *absence* is
 * the contract. An unset knob must produce no key at all rather than an
 * explicit `undefined`/`null`, so that adding this plumbing left every existing
 * call byte-for-byte as it was.
 */
export function buildPiOptions(options?: LlmCompleteOptions): SimpleStreamOptions {
  // Build cache options for pi/ai when cache is enabled
  const cacheOpts = options?.cacheConfig?.enabled
    ? {
        cacheRetention: options.cacheConfig.retention,
        sessionId: options.cacheConfig.sessionId,
      }
    : {};

  const piOptions: SimpleStreamOptions = {
    maxTokens: options?.maxTokens ?? 16384,
    ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    signal: options?.signal,
    ...cacheOpts,
  };

  // Reasoning effort. Named `gemini.thinking-level` in config for historical
  // reasons, but pi-ai maps `reasoning` on every api family: OpenAI Responses
  // (`reasoning.effort`), OpenAI Completions and its deepseek/openrouter/zai
  // dialects (`reasoning_effort`), Google (`thinkingConfig.thinkingLevel`), and
  // Anthropic (`thinking.budget_tokens`). Leaving it unset does not mean
  // "provider default" either — pi-ai then explicitly disables reasoning on
  // models that support it. Whatever is set here is clamped to the resolved
  // model's supported levels, searching upward first, so a low request can come
  // back raised.
  if (options?.thinkingLevel) {
    piOptions.reasoning = options.thinkingLevel;
  }

  // Sampling temperature. pi-ai sends `temperature` on every one of its api
  // families; exactly one of them guards it. On `anthropic-messages` the field
  // is dropped when a reasoning level is set, and again when the resolved
  // model declares `compat.supportsTemperature: false`. The guard is a
  // property of the *api*, not of the model family: Claude reached through
  // OpenRouter (`openai-completions`) or Bedrock (`bedrock-converse-stream`)
  // keeps its temperature even with reasoning on. So a pinned temperature is
  // best-effort, and which way it goes depends on the transport.
  //
  // `!= null`, never truthiness: `0` is greedy decoding, the value a run most
  // likely pins *to*, and `if (options?.temperature)` would drop exactly it.
  // Conditional rather than `temperature: options?.temperature ?? undefined`,
  // because unset has to leave the key off the object entirely — an explicit
  // `undefined` would still serialize into some provider payloads as a present
  // key, and a `null` would go on the wire.
  if (options?.temperature != null) {
    piOptions.temperature = options.temperature;
  }

  return piOptions;
}

/**
 * Call pi/ai completeSimple with messages.
 * Tracks cost and time_ms per call. Optionally emits to a Logger.
 */
export async function llmComplete(
  messages: ChatMessage[],
  modelConfig: ModelConfig,
  options?: LlmCompleteOptions
): Promise<LLMResponse> {
  // The station catalog is dynamic: the gateway may serve ids that are not in
  // the static baseline. Apply the overlay before resolving so those resolve.
  if (modelConfig.provider === STATION_PROVIDER_ID) {
    await ensureStationModels(models);
  }
  // khal's catalog is *entirely* dynamic, so the same hook runs first here —
  // and throws naming KHAL_API_KEY when the key is missing, so a keyless run
  // never degrades into a misleading "unknown model" from an empty catalog.
  if (modelConfig.provider === KHAL_PROVIDER_ID) {
    await ensureKhalModels(models);
  }
  const model = resolveModel(modelConfig.provider, modelConfig.model, modelConfig.providers);
  const startTime = Date.now();

  const systemPrompt = messages.find((m) => m.role === "system")?.content;
  const piMessages: Message[] = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "user") {
        return {
          role: "user" as const,
          content: m.content,
          timestamp: Date.now(),
        } satisfies UserMessage;
      }
      // For assistant messages from our history, we store full PiAssistantMessage
      // objects. If we have a raw ChatMessage (string content), wrap minimally.
      if (m.piMessage) {
        return m.piMessage as PiAssistantMessage;
      }
      // Fallback: construct a minimal assistant message for the API.
      // This happens when we synthesize assistant messages (e.g., forced final).
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: m.content }],
        api: "anthropic-messages",
        provider: modelConfig.provider,
        model: modelConfig.model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      } satisfies PiAssistantMessage;
    });

  // Sampling, caching and reasoning options; the onPayload hook is attached below.
  const piOptions = buildPiOptions(options);

  const payloadHooks: Array<(payload: unknown, model: unknown) => unknown | Promise<unknown>> = [];

  // OpenRouter's OpenAI-compatible Chat Completions endpoint still rejects the
  // newer `developer` role for several non-OpenAI routes (including DeepSeek
  // V4 Flash). pi-ai may emit `developer` for reasoning models, so normalize
  // it back to `system` at the MIKRO boundary instead of letting the provider
  // fail with an empty/zero-token response.
  if (modelConfig.provider === "openrouter") {
    payloadHooks.push(normalizeOpenRouterDeveloperRole);
  }

  // Build onPayload hook for Gemini-specific features (media resolution, structured outputs, tools, etc.)
  if (isGoogleProvider(modelConfig.provider) && options?.geminiConfig) {
    const geminiOnPayload = buildGeminiOnPayload(
      options.geminiConfig,
      modelConfig.provider,
      options?.outputSchema
    );
    if (geminiOnPayload) {
      payloadHooks.push(geminiOnPayload as (payload: unknown, model: unknown) => unknown | Promise<unknown>);
    }
  }

  if (payloadHooks.length > 0) {
    piOptions.onPayload = async (payload: unknown, payloadModel: unknown) => {
      let next = payload;
      for (const hook of payloadHooks) {
        const result = await hook(next, payloadModel);
        if (result !== undefined) {
          next = result;
        }
      }
      return next;
    };
  }

  const response = await models.completeSimple(
    model,
    {
      systemPrompt,
      messages: piMessages,
    },
    piOptions
  );

  const timeMs = Date.now() - startTime;
  const inputTokens = response.usage?.input ?? 0;
  const outputTokens = response.usage?.output ?? 0;
  const cacheReadTokens = response.usage?.cacheRead ?? 0;
  const cacheWriteTokens = response.usage?.cacheWrite ?? 0;
  const reasoningTokens = response.usage?.reasoning ?? 0;
  const responseModel = response.responseModel;
  const usageRecord = response.usage as unknown as Record<string, unknown>;
  const cost = usageRecord?.cost != null
    ? (usageRecord.cost as Record<string, number>)?.total ?? 0
    : 0;

  // Single pass: extract text, count thought signatures, collect code execution results
  const textParts: string[] = [];
  let thoughtSignatureCount = 0;
  const codeExecutionResults: CodeExecutionResult[] = [];
  for (const block of response.content ?? []) {
    const b = block as unknown as Record<string, unknown>;
    if (b.type === "text") {
      textParts.push((block as TextContent).text);
    }
    if (b.thinkingSignature || b.textSignature) {
      thoughtSignatureCount++;
    }
    if (b.type === "executionResult") {
      codeExecutionResults.push({
        code: (b.code as string) ?? "",
        outcome: ((b.outcome as string) ?? "OUTCOME_FAILED") as CodeExecutionResult["outcome"],
        output: (b.output as string) ?? "",
      });
    }
  }
  const text = textParts.join("");

  // Emit to logger if provided
  if (options?.logger) {
    options.logger.llmCall({
      iteration: options.iteration ?? -1,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost,
      time_ms: timeMs,
      reasoning_tokens: reasoningTokens,
      response_model: responseModel,
    });
  }

  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalCost: cost,
      llmCalls: 1,
      reasoningTokens,
    },
    piMessage: response,
    responseModel,
    thoughtSignatureCount,
    codeExecutionResults: codeExecutionResults.length > 0 ? codeExecutionResults : undefined,
  };
}

/**
 * Call pi/ai completeSimple for a single prompt (no conversation history).
 * Used for llm_query() sub-calls from the REPL.
 */
export async function llmCompleteSimple(
  prompt: string,
  modelConfig: ModelConfig,
  signal?: AbortSignal
): Promise<LLMResponse> {
  return llmComplete(
    [{ role: "user", content: prompt }],
    modelConfig,
    { signal }
  );
}

/**
 * Run multiple llm_query calls concurrently.
 */
export async function llmCompleteBatched(
  prompts: string[],
  modelConfig: ModelConfig,
  signal?: AbortSignal
): Promise<{ results: string[]; usage: UsageStats }> {
  const responses = await Promise.all(
    prompts.map((p) => llmCompleteSimple(p, modelConfig, signal))
  );

  const usage = createUsage();
  const results = responses.map((r) => {
    mergeUsage(usage, r.usage);
    return r.text;
  });

  return { results, usage };
}

/** Parsed child RLM process result. */
export interface RlmChildResult {
  answer: string;
  runId?: string;
  usage?: UsageStats;
  raw?: unknown;
}

export interface RlmChildInvocationOptions {
  output?: "json";
  /** `provider/model` (or bare model id) forwarded to the child as --model. */
  model?: string;
  maxIterations?: number;
  timeout?: number;
  maxDepth?: number;
  maxCost?: number | null;
  maxTokens?: number | null;
  logPath?: string | null;
  stats?: boolean;
  noSession?: boolean;
}

/** Build bounded argv for a recursive child process. */
export function buildRlmChildArgs(prompt: string, options: RlmChildInvocationOptions = {}): string[] {
  const args = [prompt, "--output", options.output ?? "json"];
  if (options.stats) args.push("--stats");
  // Without --model the child re-derives its model from its own cwd config and
  // inherited HOME, which is how a parent's model pin used to be lost entirely.
  if (options.model) args.push("--model", options.model);
  if (options.maxIterations !== undefined) args.push("--max-iterations", String(options.maxIterations));
  if (options.timeout !== undefined) args.push("--timeout", String(options.timeout));
  if (options.maxDepth !== undefined) args.push("--max-depth", String(options.maxDepth));
  if (options.maxCost !== undefined && options.maxCost !== null) args.push("--max-cost", String(options.maxCost));
  if (options.maxTokens !== undefined && options.maxTokens !== null) args.push("--max-tokens", String(options.maxTokens));
  // Do not pass --log to children by default: child_start/child_end live in the parent log.
  if (options.noSession) args.push("--no-session");
  return args;
}

/** Build env inheritance for child process with explicit recursive ancestry. */
export function buildChildEnv(env: NodeJS.ProcessEnv, parentRunId: string, correlationId: string): NodeJS.ProcessEnv {
  const depth = Number.parseInt(env.MIKRO_RECURSION_DEPTH ?? "0", 10) || 0;
  return {
    ...env,
    MIKRO_PARENT_RUN_ID: parentRunId,
    MIKRO_CHILD_CORRELATION_ID: correlationId,
    MIKRO_RECURSION_DEPTH: String(depth + 1),
  };
}

/** Parse stdout from a child mikro --output json --stats run. */
export function parseRlmChildOutput(stdout: string): RlmChildResult {
  try {
    const result = JSON.parse(stdout) as Record<string, unknown>;
    const stats = result.stats as Record<string, unknown> | undefined;
    return {
      answer: typeof result.answer === "string" ? result.answer : stdout,
      runId: typeof stats?.run_id === "string" ? stats.run_id : undefined,
      usage: isUsageStats(result.usage) ? result.usage : undefined,
      raw: result,
    };
  } catch {
    return { answer: stdout.trim() || "Error: empty response from child mikro" };
  }
}

/** Last `maxChars` of a child's stderr, whitespace-collapsed, for error text. */
export function stderrTail(stderr: string, maxChars = 400): string {
  const collapsed = stderr.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `…${collapsed.slice(-maxChars)}`;
}

/**
 * Classify a finished child mikro process into the answer the REPL caller sees.
 *
 * A child that cannot reach a model — wrong provider, missing key, empty
 * completion — still exits 0 and still prints `{"answer":""}`. Handing that
 * back as an ordinary result made a dead sub-call indistinguishable from a
 * real one: three recursive spawns in the round-1 parity sweep died this way
 * and nothing in the run recorded it. A zero exit with no answer is therefore
 * reported as an explicit `Error:` string, which is the same shape the REPL
 * already uses for handler throws and which the model can react to.
 *
 * Exit-code semantics of the child CLI itself are untouched — this is purely
 * how the parent reads the result.
 */
export function classifyRlmChildResult(
  code: number | null,
  stdout: string,
  stderr: string
): { result: RlmChildResult; isError: boolean; errorMessage?: string } {
  if (code !== 0) {
    const errorMessage = `Error: child mikro exited with code ${code}. ${stderr}`.trim();
    return { result: { answer: errorMessage }, isError: true, errorMessage };
  }

  const parsed = parseRlmChildOutput(stdout);
  const tail = stderrTail(stderr);
  const suffix = tail ? ` — ${tail}` : "";

  if (parsed.raw === undefined) {
    const errorMessage = `Error: rlm_query failed: child mikro exited 0 without parseable JSON output${suffix}`;
    return { result: { ...parsed, answer: errorMessage }, isError: true, errorMessage };
  }

  if (parsed.answer.trim() === "") {
    const errorMessage = `Error: rlm_query failed: child mikro exited 0 with an empty answer${suffix}`;
    return { result: { ...parsed, answer: errorMessage }, isError: true, errorMessage };
  }

  return { result: parsed, isError: false };
}

function isUsageStats(value: unknown): value is UsageStats {
  const v = value as Partial<UsageStats> | undefined;
  return !!v &&
    typeof v.inputTokens === "number" &&
    typeof v.outputTokens === "number" &&
    typeof v.cacheReadTokens === "number" &&
    typeof v.cacheWriteTokens === "number" &&
    typeof v.totalCost === "number" &&
    typeof v.llmCalls === "number";
}

/**
 * Spawn a child mikro process for rlm_query() recursive sub-calls.
 * The child inherits the parent's cwd (and thus .md configs).
 */
export async function rlmQuery(
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
  options: RlmChildInvocationOptions & {
    logger?: Logger;
    parentRunId?: string;
    onChildStart?: (data: { correlationId: string; prompt: string; depth: number }) => string | undefined;
    onChildEnd?: (data: { spanId?: string; correlationId?: string; depth?: number; result: RlmChildResult; durationMs: number; isError?: boolean; errorMessage?: string }) => void;
  } = {}
): Promise<RlmChildResult> {
  return new Promise<RlmChildResult>((resolve) => {
    const correlationId = uuidv7();
    const parentRunId = options.parentRunId ?? process.env.MIKRO_PARENT_RUN_ID ?? "root";
    const depth = (Number.parseInt(process.env.MIKRO_RECURSION_DEPTH ?? "0", 10) || 0) + 1;
    const currentDepth = Number.parseInt(process.env.MIKRO_RECURSION_DEPTH ?? "0", 10) || 0;
    if (options.maxDepth !== undefined && currentDepth >= options.maxDepth) {
      const error = `Error: max recursive rlm_query depth ${options.maxDepth} reached`;
      const result: RlmChildResult = { answer: error };
      options.logger?.childStart({
        child_correlation_id: correlationId,
        prompt_preview: prompt.slice(0, 200),
        depth,
      });
      options.logger?.childEnd({
        child_correlation_id: correlationId,
        child_run_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
        llm_calls: 0,
        time_ms: 0,
        is_error: true,
        error_message: error,
      });
      resolve(result);
      return;
    }

    options.logger?.childStart({
      child_correlation_id: correlationId,
      prompt_preview: prompt.slice(0, 200),
      depth,
    });
    const spanId = options.onChildStart?.({ correlationId, prompt, depth });
    const startMs = Date.now();
    const child = spawn(
      process.execPath,
      [process.argv[1], ...buildRlmChildArgs(prompt, { ...options, output: "json", stats: true, noSession: true })],
      {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(process.env, parentRunId, correlationId),
      }
    );

    const terminateChildTree = (): void => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
    };

    if (signal) {
      signal.addEventListener("abort", terminateChildTree, {
        once: true,
      });
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - startMs;
      const { result, isError, errorMessage } = classifyRlmChildResult(code, stdout, stderr);
      options.logger?.childEnd({
        child_correlation_id: correlationId,
        child_run_id: result.runId ?? null,
        input_tokens: result.usage?.inputTokens ?? 0,
        output_tokens: result.usage?.outputTokens ?? 0,
        cost: result.usage?.totalCost ?? 0,
        llm_calls: result.usage?.llmCalls ?? 0,
        time_ms: durationMs,
        ...(isError ? { is_error: true, error_message: errorMessage } : {}),
      });
      options.onChildEnd?.({
        spanId,
        correlationId,
        depth,
        result,
        durationMs,
        ...(isError ? { isError: true, errorMessage } : {}),
      });
      resolve(result);
    });

    child.on("error", (err) => {
      const durationMs = Date.now() - startMs;
      const errorMessage = `Error: failed to spawn child mikro: ${err.message}`;
      const result: RlmChildResult = { answer: errorMessage };
      options.logger?.childEnd({
        child_correlation_id: correlationId,
        child_run_id: null,
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
        llm_calls: 0,
        time_ms: durationMs,
        is_error: true,
        error_message: errorMessage,
      });
      options.onChildEnd?.({ spanId, correlationId, depth, result, durationMs, isError: true, errorMessage });
      resolve(result);
    });
  });
}

/**
 * Run multiple rlm_query calls concurrently (max 4).
 */
export async function rlmQueryBatched(
  prompts: string[],
  cwd: string,
  signal?: AbortSignal,
  options: RlmChildInvocationOptions & {
    logger?: Logger;
    parentRunId?: string;
    onChildStart?: (data: { correlationId: string; prompt: string; depth: number }) => string | undefined;
    onChildEnd?: (data: { spanId?: string; correlationId?: string; depth?: number; result: RlmChildResult; durationMs: number; isError?: boolean; errorMessage?: string }) => void;
  } = {}
): Promise<RlmChildResult[]> {
  const MAX_CONCURRENT = 4;
  const results: RlmChildResult[] = new Array(prompts.length);

  for (let i = 0; i < prompts.length; i += MAX_CONCURRENT) {
    const batch = prompts.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(
      batch.map((p) => rlmQuery(p, cwd, signal, options))
    );
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
  }

  return results;
}

/**
 * Resolve the `provider/model` a recursive child should run on.
 *
 * `rlm_query(p, model="X")` used to be a silent no-op: the Python side put the
 * kwarg on the wire and the handler never read it. It is honoured the same way
 * `llm_query` honours its own `model=` — the provider comes from the parent's
 * config, only the model id is swappable.
 *
 * With no kwarg the child is pinned to the parent's *primary* model rather
 * than its sub-call model: a child is a full mikro run, not a single
 * completion, and the sub-call model is chosen to be a cheap one-shot.
 */
export function resolveChildModelRef(config: MikroConfig, requestedModel?: string): string {
  return formatModelRef(config.model.provider, requestedModel || config.model.model);
}

/**
 * Handle an LLM IPC request from the Python REPL.
 * Routes to the appropriate handler based on request_type.
 * When geminiCounts is provided, increments Gemini-specific call counters.
 */
export async function handleLLMRequest(
  request: LLMRequest,
  config: MikroConfig,
  usage: UsageStats,
  signal?: AbortSignal,
  geminiCounts?: GeminiCallCounts,
  storage?: PgStorage,
  childUsage?: UsageStats,
  recursiveOptions: RlmChildInvocationOptions & {
    logger?: Logger;
    parentRunId?: string;
    onChildStart?: (data: { correlationId: string; prompt: string; depth: number }) => string | undefined;
    onChildEnd?: (data: { spanId?: string; correlationId?: string; depth?: number; result: RlmChildResult; durationMs: number; isError?: boolean; errorMessage?: string }) => void;
  } = {}
): Promise<string[]> {
  const subCallModel: ModelConfig = config.model.subCallModel
    ? { ...config.model, model: config.model.subCallModel }
    : config.model;

  switch (request.request_type) {
    case "llm_query": {
      const resp = await llmCompleteSimple(
        request.prompts[0],
        request.model ? { ...subCallModel, model: request.model } : subCallModel,
        signal
      );
      mergeUsage(usage, resp.usage);
      return [resp.text];
    }

    case "llm_query_batched": {
      const modelCfg = request.model
        ? { ...subCallModel, model: request.model }
        : subCallModel;
      const resp = await llmCompleteBatched(request.prompts, modelCfg, signal);
      mergeUsage(usage, resp.usage);
      return resp.results;
    }

    case "rlm_query": {
      const result = await rlmQuery(
        request.prompts[0],
        config.configDir,
        signal,
        { ...recursiveOptions, model: resolveChildModelRef(config, request.model) }
      );
      if (result.usage) {
        mergeUsage(usage, result.usage);
        if (childUsage) mergeUsage(childUsage, result.usage);
      }
      return [result.answer];
    }

    case "rlm_query_batched": {
      const results = await rlmQueryBatched(
        request.prompts,
        config.configDir,
        signal,
        { ...recursiveOptions, model: resolveChildModelRef(config, request.model) }
      );
      for (const result of results) {
        if (result.usage) {
          mergeUsage(usage, result.usage);
          if (childUsage) mergeUsage(childUsage, result.usage);
        }
      }
      return results.map((result) => result.answer);
    }

    case "web_search": {
      if (!isGoogleProvider(config.model.provider)) {
        return [
          `Error: web_search() requires provider: google. Current provider: ${config.model.provider}`,
        ];
      }
      if (geminiCounts) geminiCounts.webSearch++;
      const wsResp = await llmComplete(
        [{ role: "user", content: request.prompts[0] }],
        config.model,
        {
          signal,
          geminiConfig: { ...config.gemini, googleSearch: true },
        }
      );
      mergeUsage(usage, wsResp.usage);
      return [wsResp.text];
    }

    case "fetch_url": {
      if (!isGoogleProvider(config.model.provider)) {
        return [
          `Error: fetch_url() requires provider: google. Current provider: ${config.model.provider}`,
        ];
      }
      if (geminiCounts) geminiCounts.fetchUrl++;
      const fuResp = await llmComplete(
        [{ role: "user", content: `Fetch and return the content from: ${request.prompts[0]}` }],
        config.model,
        {
          signal,
          geminiConfig: { ...config.gemini, urlContext: true },
        }
      );
      mergeUsage(usage, fuResp.usage);
      return [fuResp.text];
    }

    case "generate_image": {
      if (!isGoogleProvider(config.model.provider)) {
        return [
          `Error: generate_image() requires provider: google. Current provider: ${config.model.provider}`,
        ];
      }
      if (geminiCounts) geminiCounts.generateImage++;
      // Image generation via Gemini: send prompt to model with image generation instruction.
      // The model returns a text description or URL depending on capabilities.
      const igResp = await llmComplete(
        [{ role: "user", content: `Generate an image based on this description: ${request.prompts[0]}` }],
        config.model,
        {
          signal,
          geminiConfig: config.gemini,
        }
      );
      mergeUsage(usage, igResp.usage);
      return [igResp.text];
    }

    case "pg_search": {
      if (!storage) return [`Error: storage not available`];
      const params = JSON.parse(request.prompts[0]);
      const rows = await storage.search(params.pattern, params.limit);
      return [JSON.stringify(rows)];
    }

    case "pg_slice": {
      if (!storage) return [`Error: storage not available`];
      const params = JSON.parse(request.prompts[0]);
      const rows = await storage.slice(params.start, params.end);
      return [JSON.stringify(rows)];
    }

    case "pg_time": {
      if (!storage) return [`Error: storage not available`];
      const params = JSON.parse(request.prompts[0]);
      const rows = await storage.timeRange(params.from, params.to);
      return [JSON.stringify(rows)];
    }

    case "pg_count": {
      if (!storage) return [`Error: storage not available`];
      const cnt = await storage.count();
      return [JSON.stringify({ count: cnt })];
    }

    case "pg_query": {
      if (!storage) return [`Error: storage not available`];
      const params = JSON.parse(request.prompts[0]);
      const rows = await storage.query(params.sql);
      return [JSON.stringify(rows)];
    }

    default:
      return request.prompts.map(
        () => `Error: unknown request type "${request.request_type}"`
      );
  }
}
