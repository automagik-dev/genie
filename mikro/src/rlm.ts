/**
 * Core RLM iteration loop.
 *
 * Faithful implementation of the RLM algorithm:
 * - Prompt externalization (context as REPL variable, only metadata in messages)
 * - Python REPL with persistent namespace
 * - Iterative code generation + execution loop
 * - FINAL/FINAL_VAR termination detection
 * - Recursive sub-calls via llm_query/rlm_query
 */

import { randomUUID } from "node:crypto";
import type { MikroConfig, ToolDef, ValidateConfig } from "./config.js";
import type { LoadedContext, ContextItem } from "./context.js";
import { buildCachedSystemPrompt, computeContentHash, buildSessionId, estimateTokens } from "./cache.js";
import { appendStopProtocol, isStructuredOutputMode } from "./stop-protocol.js";
import { REPL } from "./repl.js";
import { PgStorage } from "./storage.js";
import { ObservabilityRecorder } from "./observe.js";
import {
  llmComplete,
  handleLLMRequest,
  createUsage,
  createGeminiCallCounts,
  mergeUsage,
  type ChatMessage,
  type UsageStats,
  type CacheLLMConfig,
  type GeminiCallCounts,
  type UsageBreakdown,
  formatModelRef,
} from "./llm.js";
import { LangfuseTraceRecorder } from "./langfuse.js";
import {
  extractCodeBlocks,
  detectFinal,
  formatIterationResult,
  type ExecutionResult,
} from "./parser.js";
import { emitStreamEvent, logVerbose, type RLMResult } from "./output.js";
import { BudgetTracker } from "./budget.js";
import { isGoogleProvider } from "./gemini.js";
import type { Logger } from "./logger.js";
import { createEmitter, type EmitterAndStream } from "./sdk/emitter.js";
import type { ToolResolver } from "./sdk/agent.js";
import { createRecursionBridge } from "./sdk/recursion-bridge.js";
import { createMetricsRecorder } from "./sdk/metrics.js";
import { makeEvent } from "./sdk/events.js";
import {
  MAX_VALIDATE_ATTEMPTS,
  RETRY_HINT_FINAL,
  buildOutputSchemaSection,
  buildRetryHint,
  shouldRetry,
  validateAgainstSchema,
  type ValidateResult,
} from "./sdk/validate.js";
import type {
  AgentStartEvent,
  EmitDoneEvent,
  ErrorEvent,
  IterationOutputEvent,
  IterationStartEvent,
  SessionCloseEvent,
  SessionOpenEvent,
  ToolCallAfterEvent,
  ToolCallBeforeEvent,
  ValidationEvent,
} from "./sdk/events.js";

// ── rlmLoop's two designed aborts ──────────────────────────────────────────
// rlmLoop throws on unexpected failures, but its two *designed* aborts return
// normally with the reason as the `answer`, so a caller that wants to tell an
// abort from a report has to test for them explicitly. These are the exact
// discriminators, exported so every caller keys off one value instead of
// re-deriving it from the prose: the CLI's exit code (`src/cli.ts`) and
// `mikro mcp`'s `isError` (`src/mcp/server.ts`) both read them. Sniffing the
// answer text cannot work — `answer` is the model's own final report, and one
// that opens with `Error: …` is a normal outcome, not a failure (quoting the
// failing line out of a log is what the `log-triage` recipe is for).
//
// Note the asymmetry: the empty-response abort is identified by `budgetHit`,
// the timeout by its answer, because the timeout path preserves whatever
// `budgetHit` the run had already accumulated (usually none).

/** `budgetHit` set by the consecutive-empty-response abort. */
export const EMPTY_RESPONSES_BUDGET_HIT = "empty_responses";

/** Exact `answer` returned by the wall-clock-timeout abort. */
export const TIMEOUT_ANSWER = "Error: RLM query timed out";

/** Options for the RLM loop. */
export interface RLMOptions {
  maxIterations: number;
  /** Provider-level output cap for each root iteration. */
  maxOutputTokens?: number;
  /** Provider transport retries per root iteration. Zero disables retries. */
  maxRetries?: number;
  timeout: number;
  verbose: boolean;
  output: "text" | "json" | "stream";
  cache: boolean;
  /** When true, route context through pgserve storage instead of REPL variable. */
  storageMode?: boolean;
  logger?: Logger;
  /**
   * Live SDK event bus (Wish B live-tui G2). Optional — pass a
   * `createEmitter()` the caller has ALREADY subscribed to so the run's
   * events (AgentStart / Iteration* / ToolCall* / Recurse / child-completion
   * / Session*) stream live from the first emission. When omitted, rlmLoop
   * creates its own internal emitter. This is the contractual seam the
   * headless subscriber and the mikro-acp adapter both consume — the run
   * closes the emitter when it finishes.
   */
  emitter?: EmitterAndStream;
  /** Declared-tool resolver exposed to Python through the REPL bridge. */
  tools?: ToolResolver;
}

/**
 * Add live SDK events and run-scoped cancellation to REPL tool dispatch.
 *
 * The REPL supplies its own signal to a ToolResolver. Declared plugins instead
 * receive the enclosing run's signal so the loop timeout can interrupt them.
 */
export function bridgeToolResolver(
  resolver: ToolResolver,
  emitter: EmitterAndStream,
  options: {
    readonly sessionId: string;
    readonly selfTag: {
      readonly correlationId?: string;
      readonly parentRunId?: string;
    };
    readonly signal: AbortSignal;
  }
): ToolResolver {
  return async (tool, args, _replSignal) => {
    emitter.emit(makeEvent<ToolCallBeforeEvent>("ToolCallBefore", {
      sessionId: options.sessionId,
      ...options.selfTag,
      iteration: 0,
      tool,
      args,
    }));
    const startMs = Date.now();
    try {
      const result = await resolver(tool, args, options.signal);
      emitter.emit(makeEvent<ToolCallAfterEvent>("ToolCallAfter", {
        sessionId: options.sessionId,
        ...options.selfTag,
        iteration: 0,
        tool,
        result,
        durationMs: Date.now() - startMs,
        ok: true,
      }));
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      emitter.emit(makeEvent<ToolCallAfterEvent>("ToolCallAfter", {
        sessionId: options.sessionId,
        ...options.selfTag,
        iteration: 0,
        tool,
        result: message,
        durationMs: Date.now() - startMs,
        ok: false,
      }));
      throw error;
    }
  };
}

const DEFAULT_OPTIONS: RLMOptions = {
  maxIterations: 30,
  timeout: 300_000,
  verbose: false,
  output: "text",
  cache: false,
};

// isStructuredOutputMode moved to `src/stop-protocol.ts` — the append logic
// needs the same predicate (structured mode never parses FINAL, so the
// protocol must not be taught there).

/**
 * Build the system prompt from config, tools, criteria, and context metadata.
 */
export function buildSystemPrompt(
  config: MikroConfig,
  _context: LoadedContext | null,
  storageRecordCount?: number
): string {
  // Use SYSTEM.md content or paper default (from scaffold)
  let system = config.system ?? "";

  // Inject custom tools section from TOOLS.md
  const customToolsSection = buildCustomToolsSection(config.tools);
  if (system.includes("{custom_tools_section}")) {
    system = system.replace("{custom_tools_section}", customToolsSection);
  } else if (customToolsSection) {
    system += "\n\n" + customToolsSection;
  }

  // Teach the termination protocol unless the pack already does (or opted out).
  // Must precede the criteria block: the criteria text says "when providing
  // your FINAL answer", which only means something once FINAL is defined.
  system = appendStopProtocol(system, config);

  // Append CRITERIA.md content if present
  if (config.criteria) {
    system +=
      "\n\n## Output Criteria\n\nWhen providing your FINAL answer, follow these criteria:\n" +
      config.criteria;
  }

  // Disclose the pack's VALIDATE.md contract. LAST of the three appends on
  // purpose: `appendStopProtocol` decides from `config.system` alone and has
  // already run, so the literal `FINAL(` examples below cannot suppress the
  // stop-protocol section (`src/stop-protocol.ts` — do not reorder).
  // Skipped in structured-output mode for the same reason the stop protocol
  // is: that path finalizes provider-constrained schema JSON and never parses
  // FINAL(), so instructing `FINAL(<compact JSON>)` would fight the schema.
  if (config.validate && !isStructuredOutputMode(config)) {
    system += "\n\n" + buildOutputSchemaSection(config.validate.rawBlock);
  }

  // Append storage mode instructions when context is in PostgreSQL
  if (storageRecordCount !== undefined) {
    system +=
      `\n\n## Context Storage\n\n` +
      `Context is stored in PostgreSQL (~${storageRecordCount.toLocaleString()} records). Use these tools to query it:\n` +
      `- pg_search("pattern") — full-text search\n` +
      `- pg_slice(start, end) — get lines by range\n` +
      `- pg_time("HH:MM", "HH:MM") — filter by timestamp\n` +
      `- pg_count() — total records\n` +
      `- pg_query("SQL") — raw SQL (read-only)\n` +
      `Do NOT try to access the \`context\` variable directly — it is not loaded in memory.`;
  }

  return system;
}

/**
 * Build the custom tools section from TOOLS.md definitions.
 */
function buildCustomToolsSection(tools: ToolDef[]): string {
  if (tools.length === 0) return "";

  const lines = [
    "\nYou also have access to these additional custom REPL functions:",
  ];

  for (const tool of tools) {
    // Extract docstring from the code if present
    const docMatch = tool.code.match(/"""([\s\S]*?)"""|'''([\s\S]*?)'''/);
    const doc = docMatch ? (docMatch[1] || docMatch[2]).trim() : "";

    lines.push(`- \`${tool.name}()\`${doc ? `: ${doc}` : ""}`);
  }

  return lines.join("\n");
}

/**
 * Build the context metadata string that goes in the message history.
 * The actual context data is externalized into the REPL as the `context` variable.
 */
function buildContextMetadata(context: LoadedContext | null): string {
  if (!context) {
    return "No context was provided for this query. You can still use the REPL to reason and compute.";
  }
  return context.metadata;
}

/**
 * Build the user prompt for a given iteration.
 * Iteration 0 has a safeguard to prevent premature FINAL.
 */
function buildUserPrompt(
  query: string,
  iteration: number,
  contextMetadata: string
): string {
  if (iteration === 0) {
    const safeguard =
      "You have not interacted with the REPL environment or seen your prompt / context yet. " +
      "Your next action should be to look through and figure out how to answer the prompt, " +
      "so don't just provide a final answer yet.\n\n";
    return `${safeguard}${contextMetadata}\n\nQuery: ${query}`;
  }

  return (
    "The history before is your previous interactions with the REPL environment. " +
    `Continue working towards answering the query. If you have enough information, provide your final answer using FINAL().\n\nQuery: ${query}`
  );
}

/**
 * Prepare the context for REPL injection.
 * For list contexts, build the context as a list of dicts with path and content.
 */
function prepareReplContext(
  context: LoadedContext | null
): string | Array<{ path: string; content: string }> | undefined {
  if (!context) return undefined;

  if (context.type === "list") {
    const items = context.content as ContextItem[];
    return items.map((item) => ({ path: item.path, content: item.content }));
  }

  return context.content as string;
}

// ── VALIDATE.md enforcement on the FINAL channel ───────────────────────────
//
// `src/sdk/validate.ts` owns the schema check, the retry policy and the hint
// text. What lives here is everything specific to *this* surface: FINAL
// captures a raw string, not a parsed value, and this loop's terminal policy
// is fail-OPEN — a payload that never conforms is still returned, flagged
// `validation_failed`, because the downstream consumer (a committee gate)
// wants the payload and decides for itself. That is a deliberate divergence
// from `runAgent`'s fail-closed `ValidationFailed` error; both policies reuse
// the same primitives and each is pinned by its own tests.

/**
 * Strip a FINAL payload down to the text `JSON.parse` should see: trim, then
 * unwrap one enclosing markdown fence.
 *
 * The fence strip exists because models fence JSON reflexively, and a fenced
 * payload is a *formatting* miss, not a shape miss — charging a validate
 * attempt for it would spend the retry budget on punctuation.
 */
export function normalizeFinalPayload(answer: string): string {
  const trimmed = answer.trim();
  const fenced = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Validate one FINAL payload against the pack's schema.
 *
 * Unparsable text is reported as an ordinary shape failure rather than a
 * thrown error, so it flows through the same retry path as a missing field —
 * and the synthetic message names the actual problem, which for this channel
 * is usually a `FINAL_VAR` of a Python dict (single-quoted `str()` repr).
 */
export function validateFinalAnswer(
  answer: string,
  validate: ValidateConfig
): ValidateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeFinalPayload(answer));
  } catch {
    return {
      ok: false,
      errors: [
        "<root>: expected JSON matching the VALIDATE.md schema, got unparsable text",
      ],
      schemaSource: validate.rawBlock,
    };
  }
  return validateAgainstSchema(parsed, validate.schema, validate.rawBlock);
}

/**
 * What the loop must do with a candidate final answer.
 *
 * Discriminated rather than answer-shaped: a wrapper that could only return
 * a string has no way to say "do not finalize, run one more iteration", and
 * the retry is the whole point.
 */
export type ValidationDecision =
  | {
      readonly kind: "finalize";
      /** True only when the schema was checked and the payload lost. */
      readonly validationFailed: boolean;
      readonly errors: readonly string[];
    }
  | { readonly kind: "retry"; readonly hint: string; readonly errors: readonly string[] };

/** Everything `decideValidatedFinal` needs, stated rather than closed over. */
export interface ValidationGate {
  /** The pack's contract, or null when it ships none (⇒ never flagged). */
  readonly validate: ValidateConfig | null;
  /** Validate attempts spent INCLUDING this one (1 on the first check). */
  readonly attempt: number;
  /** False at the forced-final site: validate and flag, but never retry. */
  readonly retryCapable: boolean;
  /**
   * True when another iteration is actually available — the caller mirrors
   * the loop's own top-of-loop tests (iteration budget, wall-clock abort,
   * cost/token budget) so a granted retry can never hang or silently become
   * the forced-final path.
   */
  readonly roomForRetry: boolean;
}

/**
 * The single place the validate/retry/flag policy is decided. Every finalize
 * site branches on the result; none of them re-derives it.
 */
export function decideValidatedFinal(
  answer: string,
  gate: ValidationGate
): ValidationDecision {
  if (!gate.validate) {
    return { kind: "finalize", validationFailed: false, errors: [] };
  }
  const result = validateFinalAnswer(answer, gate.validate);
  if (result.ok) {
    return { kind: "finalize", validationFailed: false, errors: [] };
  }
  if (gate.retryCapable && gate.roomForRetry && shouldRetry(result, gate.attempt)) {
    return {
      kind: "retry",
      hint: buildRetryHint(result, RETRY_HINT_FINAL),
      errors: result.errors,
    };
  }
  return { kind: "finalize", validationFailed: true, errors: result.errors };
}

/**
 * Give the granted retry its user turn.
 *
 * Merged into a trailing user message when there is one — exactly the move
 * the soft-limit nudge below makes — so the history stays strictly
 * alternating. The alternative, a second consecutive user message, is a
 * shape some providers reject outright.
 */
export function appendValidationRetryTurn(
  messages: ChatMessage[],
  hint: string
): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content += `\n\n${hint}`;
    return;
  }
  messages.push({ role: "user", content: hint });
}

/**
 * Main RLM loop entry point.
 */
export async function rlmLoop(
  query: string,
  context: LoadedContext | null,
  config: MikroConfig,
  options: Partial<RLMOptions> = {}
): Promise<RLMResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const usage = createUsage();
  const childUsage = createUsage();
  const geminiCounts = createGeminiCallCounts();
  const budget = new BudgetTracker(config.budget);

  // ── Storage mode setup ──────────────────────────────────
  let storage: PgStorage | undefined;
  let recorder: ObservabilityRecorder | undefined;
  let storageRecordCount: number | undefined;
  const runId = randomUUID();
  const langfuse = new LangfuseTraceRecorder();
  langfuse.startTrace({
    runId: opts.logger?.runId ?? runId,
    query,
    model: formatModelRef(config.model.provider, config.model.model),
    metadata: { storage_mode: !!opts.storageMode },
  });

  // ── Live SDK event bus (Wish B live-tui G2) ─────────────
  // Reuse a caller-supplied emitter when present (so a subscriber can be
  // attached BEFORE the run starts); otherwise spin up an internal one.
  // Emits are additive + synchronous — they never touch control flow.
  const emitter = opts.emitter ?? createEmitter();
  // This run's ancestry identity. When this process was itself spawned as
  // a recursive child, `buildChildEnv` stamped its correlation id + parent
  // run id into the environment; at the true root neither is set.
  const selfCorrelationId = process.env.MIKRO_CHILD_CORRELATION_ID ?? (opts.logger?.runId ?? runId);
  const selfParentRunId = process.env.MIKRO_PARENT_RUN_ID;
  const selfDepth = Number.parseInt(process.env.MIKRO_RECURSION_DEPTH ?? "0", 10) || 0;
  const metrics = createMetricsRecorder();
  let currentIteration = 0;
  const recursionBridge = createRecursionBridge({
    emitter,
    sessionId: selfCorrelationId,
    currentIteration: () => currentIteration,
  });
  /** Ancestry stamp shared by every event this run emits about itself. */
  const selfTag = { correlationId: selfCorrelationId, parentRunId: selfParentRunId };
  let emitterClosed = false;
  const closeEmitter = (reason: SessionCloseEvent["reason"]): void => {
    if (emitterClosed) return;
    emitterClosed = true;
    emitter.emit(makeEvent<SessionCloseEvent>("SessionClose", {
      sessionId: selfCorrelationId,
      ...selfTag,
      reason,
    }));
    emitter.close();
  };

  emitter.emit(makeEvent<AgentStartEvent>("AgentStart", {
    agentId: formatModelRef(config.model.provider, config.model.model),
    sessionId: selfCorrelationId,
    ...selfTag,
    config: {
      model: formatModelRef(config.model.provider, config.model.model),
      maxIterations: opts.maxIterations,
      storageMode: !!opts.storageMode,
      depth: selfDepth,
    },
  }));
  emitter.emit(makeEvent<SessionOpenEvent>("SessionOpen", {
    sessionId: selfCorrelationId,
    ...selfTag,
    resumed: false,
  }));

  // Setup region (storage start/ingest, prompt build, cache hashing, REPL
  // construction) runs BEFORE the main `try` below. A throw here — most
  // plausibly `storage.start()` when Postgres is unreachable, or context
  // ingestion — must NOT escape without closing the emitter: a caller that
  // supplied its own emitter (the headless + mikro-acp seam) is already
  // subscribed and its `for await` would hang forever with no SessionClose.
  // So we guard the setup: on failure emit an Error, close the emitter, then
  // propagate as before. These vars are assigned inside the guard and used by
  // the main loop below (definite-assignment via the always-throwing catch).
  let systemPrompt!: string;
  let contextMetadata!: string;
  let cacheConfig: CacheLLMConfig | undefined;
  let abortController!: AbortController;
  let timeoutHandle!: ReturnType<typeof setTimeout>;
  let repl!: REPL;

  try {
    if (opts.storageMode) {
      storage = new PgStorage();
      await storage.start(config.storage);

      // Ingest context into Postgres
      if (context) {
        storageRecordCount = await storage.ingest(context);
        if (opts.verbose) {
          process.stderr.write(`mikro: ingested ${storageRecordCount} records into pgserve storage\n`);
        }
      }

      // Set up observability recorder
      recorder = new ObservabilityRecorder(storage);
      recorder.startSession(
        runId,
        query,
        `${config.model.provider}/${config.model.model}`,
        config.model.provider,
        undefined,
        config as unknown as Record<string, unknown>
      );
    }

    // Build system prompt — cache mode embeds full context, storage mode adds pg_* tools, normal mode uses metadata only
    systemPrompt = opts.cache
      ? buildCachedSystemPrompt(config, context)
      : buildSystemPrompt(config, context, storageRecordCount);

    // In storage mode, override context metadata to describe storage
    contextMetadata = opts.storageMode && storageRecordCount !== undefined
      ? `Context is stored in PostgreSQL (~${storageRecordCount.toLocaleString()} records). Use pg_search(), pg_slice(), pg_time(), pg_count(), pg_query() to query it.`
      : buildContextMetadata(context);

    // Build cache config for LLM calls (passed through to pi/ai completeSimple)
    if (opts.cache && context) {
      const contentHash = computeContentHash(context);
      const sessionId = buildSessionId(config.cache.sessionPrefix, contentHash);
      cacheConfig = {
        enabled: true,
        retention: config.cache.retention,
        sessionId,
      };

      // Emit cache_init log event
      if (opts.logger) {
        opts.logger.cacheInit({
          contentHash,
          sessionId,
          estimatedTokens: estimateTokens(context),
        });
      }
    }

    // REPL first, then the timeout — so a throw during REPL construction
    // cannot leak a dangling timer (nothing after setTimeout can throw).
    repl = new REPL();
    abortController = new AbortController();
    if (opts.tools) {
      repl.onToolRequest(bridgeToolResolver(opts.tools, emitter, {
        sessionId: selfCorrelationId,
        selfTag,
        signal: abortController.signal,
      }));
    }
    timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, opts.timeout);
  } catch (err: unknown) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (recorder) recorder.recordError(err instanceof Error ? err.message : String(err));
    if (storage) await storage.stop().catch(() => {});
    emitter.emit(makeEvent<ErrorEvent>("Error", {
      sessionId: selfCorrelationId,
      ...selfTag,
      phase: "error",
      error: {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      },
    }));
    closeEmitter("error");
    throw err;
  }

  try {
    // Start REPL — in storage mode, skip raw context injection and load pg_batteries
    const replContext = opts.storageMode ? undefined : prepareReplContext(context);
    const toolsMap: Record<string, string> = {};
    for (const tool of config.tools) {
      toolsMap[tool.name] = tool.code;
    }

    await repl.start({
      context: replContext as string | string[] | Record<string, unknown>,
      tools: Object.keys(toolsMap).length > 0 ? toolsMap : undefined,
      loadGeminiBatteries: isGoogleProvider(config.model.provider) && (config.toolsLevel === "standard" || config.toolsLevel === "full"),
      loadPgBatteries: !!opts.storageMode,
      toolsLevel: config.toolsLevel,
    });

    // Set up LLM request handler for REPL IPC — pass storage for pg_* routes
    repl.onLLMRequest(async (request) => {
      const startMs = Date.now();
      const childUsageBefore = { ...childUsage };
      const remainingChildBudget = buildRemainingChildBudget(config, budget);
      const results = await handleLLMRequest(
        request,
        config,
        usage,
        abortController.signal,
        geminiCounts,
        storage,
        childUsage,
        {
          logger: opts.logger,
          parentRunId: selfCorrelationId,
          maxIterations: opts.maxIterations,
          timeout: opts.timeout,
          maxDepth: config.budget.maxDepth ?? 3,
          maxCost: remainingChildBudget.maxCost,
          maxTokens: remainingChildBudget.maxTokens,
          onChildStart: ({ correlationId, prompt, depth }) => {
            // Live event: emit the RecurseEvent for this spawn (G2 producer).
            recursionBridge.onChildStart({ correlationId, prompt, depth });
            return langfuse.childStart({
              parentRunId: opts.logger?.runId ?? runId,
              correlationId,
              prompt,
              depth,
            });
          },
          onChildEnd: ({ spanId, correlationId, depth, result, durationMs, isError, errorMessage }) => {
            // Live event: bridge the child result (usage / isError / durationMs)
            // into a child-completion node keyed by correlationId.
            recursionBridge.onChildEnd({ spanId, correlationId, depth, result, durationMs, isError, errorMessage });
            if (spanId) {
              langfuse.childEnd(spanId, {
                childRunId: result.runId,
                answerPreview: result.answer.slice(0, 1000),
                durationMs,
                usage: result.usage,
                isError,
                errorMessage,
              });
            }
          },
        }
      );
      const childUsageDelta = {
        inputTokens: childUsage.inputTokens - childUsageBefore.inputTokens,
        outputTokens: childUsage.outputTokens - childUsageBefore.outputTokens,
        cacheReadTokens: childUsage.cacheReadTokens - childUsageBefore.cacheReadTokens,
        cacheWriteTokens: childUsage.cacheWriteTokens - childUsageBefore.cacheWriteTokens,
        totalCost: childUsage.totalCost - childUsageBefore.totalCost,
        llmCalls: childUsage.llmCalls - childUsageBefore.llmCalls,
      };
      if (childUsageDelta.llmCalls > 0) {
        budget.record(childUsageDelta.inputTokens, childUsageDelta.outputTokens, childUsageDelta.totalCost);
      }
      // Record sub-calls to observability
      if (recorder && request.request_type !== "llm_query" && request.request_type !== "llm_query_batched") {
        recorder.recordSubCall(
          0, // iteration not available here; will be approximate
          request.request_type,
          request.prompts[0]?.slice(0, 200) ?? "",
          Date.now() - startMs
        );
      }
      return results;
    });

    /** Cleanup timeout/REPL/storage and build the final result. */
    const finalize = async (
      answer: string,
      iterations: number,
      validationFailed = false
    ): Promise<RLMResult> => {
      clearTimeout(timeoutHandle);
      // Record final observability event
      if (recorder) {
        recorder.recordFinal(answer, iterations, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cacheReadTokens,
          totalCost: usage.totalCost,
        });
      }
      await repl.stop();
      await langfuse.flush().catch((err) => {
        if (opts.verbose) process.stderr.write(`mikro: Langfuse flush failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
      if (storage) await storage.stop();
      emitter.emit(makeEvent<EmitDoneEvent>("EmitDone", {
        sessionId: selfCorrelationId,
        ...selfTag,
        payload: { answer, iterations },
      }));
      closeEmitter("complete");
      return buildResult(answer, usage, iterations, config, budget.getState().budgetHit, geminiCounts, repl.getGeminiBatteriesUsed(), buildUsageBreakdown(usage, childUsage), validationFailed);
    };

    // ── VALIDATE.md gate ──────────────────────────────────
    // One wrapper, seven finalize sites. Validation logic lives in
    // `decideValidatedFinal`; this closure supplies the run-scoped inputs
    // (attempt counter, remaining room) and owns the observability.
    let validateAttempts = 0;
    const finalizeWithValidation = (
      answer: string,
      iteration: number,
      mode: "retry-capable" | "flag-only"
    ): ValidationDecision => {
      if (!config.validate) {
        return { kind: "finalize", validationFailed: false, errors: [] };
      }
      validateAttempts += 1;
      const decision = decideValidatedFinal(answer, {
        validate: config.validate,
        attempt: validateAttempts,
        retryCapable: mode === "retry-capable",
        // The three tests the top of the loop would apply next. Checking them
        // here is what keeps a granted retry from degrading into the
        // forced-final path (or into an iteration that never runs).
        roomForRetry:
          iteration + 1 < opts.maxIterations &&
          !abortController.signal.aborted &&
          !budget.isExceeded(),
      });
      if (decision.kind === "finalize" && !decision.validationFailed) return decision;

      emitter.emit(makeEvent<ValidationEvent>("Validation", {
        sessionId: selfCorrelationId,
        ...selfTag,
        status: "fail",
        attempt: validateAttempts,
        errors: decision.errors,
      }));
      if (opts.verbose) {
        logVerbose(
          iteration,
          decision.kind === "retry"
            ? `FINAL payload failed VALIDATE.md (attempt ${validateAttempts}/${MAX_VALIDATE_ATTEMPTS}) — retrying with the schema hint`
            : `FINAL payload failed VALIDATE.md (attempt ${validateAttempts}) — returning it flagged validation_failed`
        );
      }
      return decision;
    };

    // Build initial message history
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: buildUserPrompt(query, 0, contextMetadata),
      },
    ];

    // Iteration loop
    let actualIterations = 0;
    let consecutiveEmpty = 0;
    let emptyAbort = false;
    for (let iteration = 0; iteration < opts.maxIterations; iteration++) {
      // Check timeout
      if (abortController.signal.aborted) {
        if (opts.verbose) logVerbose(iteration, "timeout reached");
        break;
      }

      // Check budget
      if (budget.isExceeded()) {
        if (opts.verbose) logVerbose(iteration, `budget exceeded: ${budget.getState().budgetHit}`);
        break;
      }
      actualIterations = iteration + 1;

      // Set when this iteration's FINAL lost its schema check and the wrapper
      // granted a retry. Nothing downstream may finalize once it is set; the
      // hint becomes this turn's user message at the very end of the body.
      // Held in an object rather than a `let`: the only write happens inside
      // the `settle` closure below, which makes tsc narrow every outer read
      // to `null` and type-check none of them. A property read is re-widened
      // at each site, so the comparisons downstream are actually checked.
      const retryState: { hint: string | null } = { hint: null };

      /**
       * Route one candidate final answer through the VALIDATE.md gate.
       * Returns the result to return, or `null` when a retry was granted.
       */
      const settle = async (
        candidate: string,
        mode: "retry-capable" | "flag-only"
      ): Promise<RLMResult | null> => {
        const decision = finalizeWithValidation(candidate, iteration, mode);
        if (decision.kind === "finalize") {
          return finalize(candidate, iteration + 1, decision.validationFailed);
        }
        retryState.hint = decision.hint;
        return null;
      };

      // Live event: mark the iteration + reset the per-iteration metrics
      // baseline (latency / tool-call count / token deltas).
      currentIteration = iteration;
      metrics.start(selfDepth, selfDepth - 1);
      emitter.emit(makeEvent<IterationStartEvent>("IterationStart", {
        sessionId: selfCorrelationId,
        ...selfTag,
        iteration,
      }));

      if (opts.verbose) {
        logVerbose(iteration, "calling LLM...");
      }

      // Call LLM
      const llmStartMs = Date.now();
      const generationId = langfuse.rootGenerationStart({
        name: `Model call — root iteration ${iteration + 1}`,
        input: messages,
        model: formatModelRef(config.model.provider, config.model.model),
        iteration,
      });
      const response = await llmComplete(messages, config.model, {
        maxTokens: opts.maxOutputTokens,
        maxRetries: opts.maxRetries,
        signal: abortController.signal,
        cacheConfig,
        thinkingLevel: config.gemini.thinkingLevel,
        temperature: config.temperature,
        outputSchema: config.output.schema,
        geminiConfig: config.gemini,
      });
      const llmDurationMs = Date.now() - llmStartMs;
      langfuse.rootGenerationEnd(generationId, {
        output: response.text,
        durationMs: llmDurationMs,
        usage: response.usage,
      });
      mergeUsage(usage, response.usage);
      budget.record(response.usage.inputTokens, response.usage.outputTokens, response.usage.totalCost);

      // Live metrics: accumulate this iteration's tokens + cost so the
      // IterationOutput snapshot carries per-node cost/tokens/latency.
      metrics.addTokens(
        response.usage.inputTokens,
        response.usage.outputTokens,
        response.usage.cacheReadTokens,
        response.usage.reasoningTokens,
      );
      metrics.addCost(response.usage.totalCost);

      // Record LLM call to observability
      if (recorder) {
        recorder.recordLLMCall(
          iteration,
          { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cost: response.usage.totalCost },
          `${config.model.provider}/${config.model.model}`,
          llmDurationMs
        );
      }

      // Track thought signatures for Gemini stats
      if (response.thoughtSignatureCount) {
        geminiCounts.thoughtSignatures += response.thoughtSignatureCount;
      }

      const responseText = response.text;

      if (opts.verbose) {
        logVerbose(
          iteration,
          `LLM responded (${responseText.length} chars, ${response.usage.inputTokens}+${response.usage.outputTokens} tokens)`
        );
      }

      // Check for empty LLM response (issue #14)
      // Thinking-only responses (output tokens > 0 but no visible text) are normal
      // for reasoning models warming up — don't count as empty.
      if (responseText.length === 0) {
        if (response.usage.outputTokens > 0) {
          // Thinking-only iteration — model is reasoning, not stuck
          consecutiveEmpty = 0;
          if (opts.verbose) {
            logVerbose(iteration, "thinking-only response (no visible text yet)");
          }
        } else {
          // Truly empty — no thinking, no text
          consecutiveEmpty++;
          process.stderr.write(
            `mikro [iter ${iteration}]: WARNING — LLM returned empty response. Possible context size limit.\n`
          );
          if (consecutiveEmpty >= 3) {
            emptyAbort = true;
            break;
          }
        }
      } else {
        consecutiveEmpty = 0;
      }

      // Extract code blocks
      const codeBlocks = extractCodeBlocks(responseText);

      // In structured output mode, treat the API response as the final answer (schema-enforced JSON)
      if (isStructuredOutputMode(config) && codeBlocks.length === 0) {
        if (opts.verbose) {
          logVerbose(iteration, "structured output mode: response is final answer");
        }
        return finalize(responseText, iteration + 1);
      }

      // Check for FINAL signal in the text (outside code blocks)
      const finalSignal = detectFinal(responseText, codeBlocks);

      if (finalSignal && codeBlocks.length === 0) {
        const candidate =
          finalSignal.type === "final"
            ? finalSignal.value
            // FINAL_VAR without code — get variable value before stopping REPL
            : (await getVariableFromRepl(repl, finalSignal.value)) ?? finalSignal.value;
        const settled = await settle(candidate, "retry-capable");
        if (settled) return settled;
        // Otherwise a retry was granted: fall through with no code blocks to
        // execute, so the iteration ends at the hint injection below.
      }

      // Execute code blocks in REPL
      const executions: ExecutionResult[] = [];

      for (const block of codeBlocks) {
        if (opts.verbose) {
          logVerbose(iteration, `executing code (${block.code.length} chars)`);
        }

        // Live event: the REPL execution is the parent loop's tool call.
        emitter.emit(makeEvent<ToolCallBeforeEvent>("ToolCallBefore", {
          sessionId: selfCorrelationId,
          ...selfTag,
          iteration,
          tool: "repl",
          args: block.code,
        }));
        const execStartMs = Date.now();
        const execResult = await repl.execute(block.code);
        const execDurationMs = Date.now() - execStartMs;
        metrics.incrToolCalls();
        emitter.emit(makeEvent<ToolCallAfterEvent>("ToolCallAfter", {
          sessionId: selfCorrelationId,
          ...selfTag,
          iteration,
          tool: "repl",
          result: execResult.stdout,
          durationMs: execDurationMs,
          ok: !execResult.error,
        }));

        executions.push({
          code: block.code,
          stdout: execResult.stdout,
          stderr: execResult.stderr ?? "",
          variables: execResult.variables,
          error: execResult.error,
        });

        // Record REPL execution to observability
        if (recorder) {
          recorder.recordReplExec(
            iteration, block.code, execResult.stdout, execResult.stderr ?? "",
            execDurationMs, !!execResult.error
          );
        }

        if (execResult.final) {
          const settled = await settle(execResult.final.value, "retry-capable");
          if (settled) return settled;
          // Retry granted: stop executing this turn's remaining blocks, but
          // keep the `executions` collected so far — `formatIterationResult`
          // below still shows the model what its code printed.
          break;
        }
      }

      // Handle server-side code execution results from Gemini (GROUP 5)
      // These are executed by Gemini's code_execution tool and returned in the response
      if (response.codeExecutionResults && response.codeExecutionResults.length > 0) {
        geminiCounts.codeExecutionsServerSide += response.codeExecutionResults.length;
        if (opts.verbose) {
          logVerbose(iteration, `received ${response.codeExecutionResults.length} server-side execution results`);
        }

        // Treat server execution results as execution results for the conversation
        for (const result of response.codeExecutionResults) {
          executions.push({
            code: result.code,
            stdout: result.output,
            stderr: result.outcome === "OUTCOME_OK" ? "" : `Execution failed: ${result.outcome}`,
            variables: [],
            error: result.outcome === "OUTCOME_OK" ? undefined : `${result.outcome}`,
          });
        }
      }

      // Handle FINAL signal detected in text, after code execution.
      // Skipped when the in-REPL emit above already lost its schema check —
      // that payload is the one being retried, and re-reading it here would
      // charge a second validate attempt for the same answer.
      if (finalSignal && retryState.hint === null) {
        if (finalSignal.type === "final") {
          const settled = await settle(finalSignal.value, "retry-capable");
          if (settled) return settled;
        } else {
          // FINAL_VAR — variable should now exist after code execution
          const varExec = await repl.execute(
            `__final_val = str(${finalSignal.value}) if '${finalSignal.value}' in dir() else "Variable '${finalSignal.value}' not found"`
          );
          if (varExec.final) {
            const settled = await settle(varExec.final.value, "retry-capable");
            if (settled) return settled;
          } else {
            const getResult = await repl.execute(
              `FINAL_VAR("${finalSignal.value}")`
            );
            if (getResult.final) {
              const settled = await settle(getResult.final.value, "retry-capable");
              if (settled) return settled;
            }
          }
        }
      }

      // Format execution results and append to history
      const formattedResult = formatIterationResult(executions);

      // Append assistant message (with full pi/ai message for multi-turn)
      messages.push({
        role: "assistant",
        content: responseText,
        piMessage: response.piMessage,
      });

      // Append execution result as user message
      if (executions.length > 0) {
        messages.push({
          role: "user",
          content: formattedResult,
        });
      } else if (retryState.hint === null) {
        // No code blocks — prompt the model to use the REPL. Suppressed when
        // a validation retry owns this turn: the model *did* answer (that is
        // precisely why it is being retried), so this nudge would be false
        // and would compete with the schema hint appended below.
        messages.push({
          role: "user",
          content:
            "You didn't write any REPL code in your last response. Please use ```repl``` code blocks to interact with the REPL environment and work towards answering the query.",
        });
      }

      // Soft iteration limit: nudge LLM to wrap up when approaching max
      const remaining = opts.maxIterations - iteration - 1;
      if (opts.maxIterations >= 5 && remaining <= 2 && remaining > 0) {
        if (opts.verbose) {
          logVerbose(iteration, `soft limit: ${remaining} iteration(s) remaining, nudging LLM to wrap up`);
        }
        const nudge = remaining === 2
          ? "\n\nNote: You have 2 iterations remaining. Start wrapping up your analysis and prepare your final answer."
          : "\n\nNote: This is your LAST iteration. Provide your final answer NOW using FINAL().";
        // Append nudge to the last user message
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === "user") {
          lastMsg.content += nudge;
        }
      }

      // Emit stream event if in stream mode
      if (opts.output === "stream") {
        emitStreamEvent({
          type: "iteration",
          iteration,
          code: codeBlocks.map((b) => b.code).join("\n\n"),
          stdout: executions.map((e) => e.stdout).join("\n"),
        });
      }

      // Live event: per-iteration output + node metrics. The terminal
      // iteration returns via finalize() (carried by EmitDone), so this
      // fires only for iterations that continue the loop.
      emitter.emit(makeEvent<IterationOutputEvent>("IterationOutput", {
        sessionId: selfCorrelationId,
        ...selfTag,
        iteration,
        output: responseText.slice(0, 2000),
        responseModel: response.responseModel,
        metrics: metrics.snapshot(),
      }));

      // The validation retry's user turn, injected at the END of the body
      // rather than via an early `continue`: the stream event and the
      // IterationOutput node above must still fire, and they mean exactly
      // "an iteration that continues the loop" — which a retry is.
      if (retryState.hint !== null) {
        appendValidationRetryTurn(messages, retryState.hint);
      }

    }

    // Loop exited — check reason and handle accordingly
    if (emptyAbort) {
      // Aborted due to consecutive empty responses (issue #14)
      process.stderr.write(
        `mikro: 3 consecutive empty LLM responses — aborting. Context may exceed API limits.\n`
      );
      clearTimeout(timeoutHandle);
      if (recorder) recorder.recordError(EMPTY_RESPONSES_BUDGET_HIT);
      await repl.stop();
      if (storage) await storage.stop();

      emitter.emit(makeEvent<ErrorEvent>("Error", {
        sessionId: selfCorrelationId,
        ...selfTag,
        phase: "iteration",
        error: { name: "EmptyResponses", message: "aborted after 3 consecutive empty LLM responses" },
      }));
      closeEmitter("abort");

      return buildResult(
        "Error: aborted after 3 consecutive empty LLM responses. Context may exceed API token limits.",
        usage,
        actualIterations,
        config,
        EMPTY_RESPONSES_BUDGET_HIT,
        geminiCounts,
        repl.getGeminiBatteriesUsed(),
        buildUsageBreakdown(usage, childUsage)
      );
    }

    // Force a final answer for normal loop exit
    if (opts.verbose) {
      const reason = budget.isExceeded() ? "budget exceeded" : abortController.signal.aborted ? "timeout" : "max iterations reached";
      logVerbose(actualIterations, `${reason}, forcing final answer`);
    }

    const forcedResult = await forceFinalAnswer(messages, config, usage, abortController.signal, cacheConfig, langfuse, actualIterations);
    // Flag-only: the budget that would pay for a retry is exactly what ran
    // out to get here, so this payload is validated and flagged, never
    // retried. Consumers disambiguate exhaustion from a shape miss with the
    // `budgetHit` / `iterations` fields, which are unaffected.
    const forcedDecision = finalizeWithValidation(forcedResult, actualIterations, "flag-only");
    return finalize(
      forcedResult,
      actualIterations,
      forcedDecision.kind === "finalize" && forcedDecision.validationFailed
    );
  } catch (err: unknown) {
    clearTimeout(timeoutHandle);
    if (recorder) recorder.recordError(err instanceof Error ? err.message : String(err));
    await repl.stop().catch(() => {});
    if (storage) await storage.stop().catch(() => {});

    const aborted = (err instanceof Error && err.name === "AbortError") || abortController.signal.aborted;
    emitter.emit(makeEvent<ErrorEvent>("Error", {
      sessionId: selfCorrelationId,
      ...selfTag,
      phase: aborted ? "timeout" : "error",
      error: {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      },
    }));
    closeEmitter(aborted ? "abort" : "error");

    if (aborted) {
      return buildResult(
        TIMEOUT_ANSWER,
        usage,
        0,
        config,
        budget.getState().budgetHit,
        geminiCounts,
        repl.getGeminiBatteriesUsed(),
        buildUsageBreakdown(usage, childUsage)
      );
    }

    throw err;
  }
}

/**
 * Force the LLM to produce a final answer when max iterations are reached.
 */
async function forceFinalAnswer(
  messages: ChatMessage[],
  config: MikroConfig,
  usage: UsageStats,
  signal?: AbortSignal,
  cacheConfig?: CacheLLMConfig,
  langfuse?: LangfuseTraceRecorder,
  iteration = 0
): Promise<string> {
  const forceMessages: ChatMessage[] = [
    ...messages,
    {
      role: "user",
      content:
        "You have reached the maximum number of iterations. Please provide your best final answer NOW based on what you've learned so far. Respond with just the answer, no FINAL() wrapper needed.",
    },
  ];

  const generationId = langfuse?.rootGenerationStart({
    name: "Model call — forced final answer",
    input: forceMessages,
    model: formatModelRef(config.model.provider, config.model.model),
    iteration,
  });
  const llmStartMs = Date.now();
  const response = await llmComplete(forceMessages, config.model, {
    signal,
    cacheConfig,
    thinkingLevel: config.gemini.thinkingLevel,
    temperature: config.temperature,
    outputSchema: config.output.schema,
    geminiConfig: config.gemini,
  });
  if (generationId) {
    langfuse?.rootGenerationEnd(generationId, {
      output: response.text,
      durationMs: Date.now() - llmStartMs,
      usage: response.usage,
    });
  }
  mergeUsage(usage, response.usage);
  return response.text;
}

/**
 * Try to get a variable value from the REPL (if still running).
 */
async function getVariableFromRepl(
  repl: REPL,
  varName: string
): Promise<string | null> {
  if (!repl.isRunning()) return null;
  try {
    const result = await repl.execute(`FINAL_VAR("${varName}")`);
    return result.final?.value ?? null;
  } catch {
    return null;
  }
}

function buildUsageBreakdown(total: UsageStats, child: UsageStats): UsageBreakdown {
  return {
    root: {
      inputTokens: total.inputTokens - child.inputTokens,
      outputTokens: total.outputTokens - child.outputTokens,
      cacheReadTokens: total.cacheReadTokens - child.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens - child.cacheWriteTokens,
      totalCost: total.totalCost - child.totalCost,
      llmCalls: total.llmCalls - child.llmCalls,
    },
    child: { ...child },
    total: { ...total },
  };
}

/** Return remaining global budget to hand down to recursive child processes. */
function buildRemainingChildBudget(config: MikroConfig, budget: BudgetTracker): {
  maxCost: number | null;
  maxTokens: number | null;
} {
  const state = budget.getState();
  return {
    maxCost: config.budget.maxCost === null
      ? null
      : Math.max(0, config.budget.maxCost - state.totalCost),
    maxTokens: config.budget.maxTokens === null
      ? null
      : Math.max(0, config.budget.maxTokens - state.totalInputTokens - state.totalOutputTokens),
  };
}

/**
 * Build the final RLMResult.
 */
function buildResult(
  answer: string,
  usage: UsageStats,
  iterations: number,
  config: MikroConfig,
  budgetHit?: string | null,
  geminiCounts?: GeminiCallCounts,
  geminiBatteriesUsed?: string[],
  usageBreakdown?: UsageBreakdown,
  validationFailed?: boolean
): RLMResult {
  // Extract file references from the answer (paths like docs/foo/bar.md)
  const refRegex = /(?:^|[\s(["'])([a-zA-Z0-9_./-]+\.(?:md|txt|py|ts|js|json))/gm;
  const refSet = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = refRegex.exec(answer)) !== null) {
    if (match[1]) refSet.add(match[1]);
  }
  const references = [...refSet];

  const result: RLMResult = {
    answer,
    references,
    usage,
    iterations,
    model: formatModelRef(config.model.provider, config.model.model),
    budgetHit: budgetHit ?? null,
  };

  if (geminiCounts) {
    result.geminiCounts = geminiCounts;
  }
  if (usageBreakdown) {
    result.usageBreakdown = usageBreakdown;
  }
  if (geminiBatteriesUsed && geminiBatteriesUsed.length > 0) {
    result.geminiBatteriesUsed = geminiBatteriesUsed;
  }
  // Set only when true, like the fields above: absent means "no schema was
  // declared, or the answer matched it", and a consumer testing truthiness
  // gets the same answer either way.
  if (validationFailed) {
    result.validation_failed = true;
  }

  return result;
}
