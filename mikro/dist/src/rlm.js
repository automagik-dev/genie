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
import { buildCachedSystemPrompt, computeContentHash, buildSessionId, estimateTokens } from "./cache.js";
import { appendStopProtocol, isStructuredOutputMode } from "./stop-protocol.js";
import { REPL, REPLTimeoutError } from "./repl.js";
import { PgStorage } from "./storage.js";
import { ObservabilityRecorder } from "./observe.js";
import { llmComplete, LLMCompletionError, handleLLMRequest, createUsage, createGeminiCallCounts, mergeUsage, formatModelRef, } from "./llm.js";
import { LangfuseTraceRecorder } from "./langfuse.js";
import { extractCodeBlocks, detectFinal, formatIterationResult, } from "./parser.js";
import { emitStreamEvent, logVerbose } from "./output.js";
import { BudgetTracker } from "./budget.js";
import { isGoogleProvider } from "./gemini.js";
import { createEmitter } from "./sdk/emitter.js";
import { createRecursionBridge } from "./sdk/recursion-bridge.js";
import { createMetricsRecorder } from "./sdk/metrics.js";
import { makeEvent } from "./sdk/events.js";
import { MAX_VALIDATE_ATTEMPTS, RETRY_HINT_FINAL, buildOutputSchemaSection, buildRetryHint, shouldRetry, validateAgainstSchema, } from "./sdk/validate.js";
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
/** Terminal run failure carrying observed cumulative subtotals, not inferred totals. */
export class RLMRunError extends Error {
    iterations;
    budgetHit;
    usage;
    usageComplete = false;
    constructor(message, iterations, budgetHit, usage, options) {
        super(message, options);
        this.iterations = iterations;
        this.budgetHit = budgetHit;
        this.name = "RLMRunError";
        // Outstanding IPC can settle after failure; this receipt must remain the
        // subtotal observed at the terminal transition, never a mutable accumulator.
        if (usage)
            this.usage = Object.freeze({ ...usage });
    }
}
/**
 * Add live SDK events and run-scoped cancellation to REPL tool dispatch.
 *
 * Declared plugins receive combined generation and run cancellation, so a
 * timed-out block cannot keep a bridge dispatch alive in the replacement.
 */
export function bridgeToolResolver(resolver, emitter, options) {
    return async (tool, args, replSignal) => {
        const signal = AbortSignal.any([options.signal, replSignal]);
        emitter.emit(makeEvent("ToolCallBefore", {
            sessionId: options.sessionId,
            ...options.selfTag,
            iteration: 0,
            tool,
            args,
        }));
        const startMs = Date.now();
        let rejectAbort;
        const onAbort = () => rejectAbort?.(signal.reason);
        try {
            signal.throwIfAborted();
            const result = await Promise.race([
                resolver(tool, args, signal),
                new Promise((_resolve, reject) => {
                    rejectAbort = reject;
                    signal.addEventListener("abort", onAbort, { once: true });
                    if (signal.aborted)
                        onAbort();
                }),
            ]);
            emitter.emit(makeEvent("ToolCallAfter", {
                sessionId: options.sessionId,
                ...options.selfTag,
                iteration: 0,
                tool,
                result,
                durationMs: Date.now() - startMs,
                ok: true,
            }));
            return result;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            emitter.emit(makeEvent("ToolCallAfter", {
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
        finally {
            signal.removeEventListener("abort", onAbort);
        }
    };
}
const DEFAULT_OPTIONS = {
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
export function buildSystemPrompt(config, _context, storageRecordCount) {
    // Use SYSTEM.md content or paper default (from scaffold)
    let system = config.system ?? "";
    // Inject custom tools section from TOOLS.md
    const customToolsSection = buildCustomToolsSection(config.tools);
    if (system.includes("{custom_tools_section}")) {
        system = system.replace("{custom_tools_section}", customToolsSection);
    }
    else if (customToolsSection) {
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
function buildCustomToolsSection(tools) {
    if (tools.length === 0)
        return "";
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
function buildContextMetadata(context) {
    if (!context) {
        return "No context was provided for this query. You can still use the REPL to reason and compute.";
    }
    return context.metadata;
}
/**
 * Build the user prompt for a given iteration.
 * Iteration 0 has a safeguard to prevent premature FINAL.
 */
function buildUserPrompt(query, iteration, contextMetadata) {
    if (iteration === 0) {
        const safeguard = "You have not interacted with the REPL environment or seen your prompt / context yet. " +
            "Your next action should be to look through and figure out how to answer the prompt, " +
            "so don't just provide a final answer yet.\n\n";
        return `${safeguard}${contextMetadata}\n\nQuery: ${query}`;
    }
    return ("The history before is your previous interactions with the REPL environment. " +
        `Continue working towards answering the query. If you have enough information, provide your final answer using FINAL().\n\nQuery: ${query}`);
}
/**
 * Prepare the context for REPL injection.
 * For list contexts, build the context as a list of dicts with path and content.
 */
function prepareReplContext(context) {
    if (!context)
        return undefined;
    if (context.type === "list") {
        const items = context.content;
        return items.map((item) => ({ path: item.path, content: item.content }));
    }
    return context.content;
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
export function normalizeFinalPayload(answer) {
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
export function validateFinalAnswer(answer, validate) {
    let parsed;
    try {
        parsed = JSON.parse(normalizeFinalPayload(answer));
    }
    catch {
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
 * The single place the validate/retry/flag policy is decided. Every finalize
 * site branches on the result; none of them re-derives it.
 */
export function decideValidatedFinal(answer, gate) {
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
export function appendValidationRetryTurn(messages, hint) {
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
export async function rlmLoop(query, context, config, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const usage = createUsage();
    const childUsage = createUsage();
    const geminiCounts = createGeminiCallCounts();
    const budget = new BudgetTracker(config.budget);
    let recordedInputTokens = 0;
    let recordedOutputTokens = 0;
    let recordedCost = 0;
    // Root and IPC completions can settle across a timeout generation boundary.
    // Account each cumulative increment once, regardless of completion ordering.
    const recordBudgetUsage = () => {
        budget.record(usage.inputTokens - recordedInputTokens, usage.outputTokens - recordedOutputTokens, usage.totalCost - recordedCost);
        recordedInputTokens = usage.inputTokens;
        recordedOutputTokens = usage.outputTokens;
        recordedCost = usage.totalCost;
    };
    // ── Storage mode setup ──────────────────────────────────
    let storage;
    let recorder;
    let storageRecordCount;
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
    const closeEmitter = (reason) => {
        if (emitterClosed)
            return;
        emitterClosed = true;
        emitter.emit(makeEvent("SessionClose", {
            sessionId: selfCorrelationId,
            ...selfTag,
            reason,
        }));
        emitter.close();
    };
    emitter.emit(makeEvent("AgentStart", {
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
    emitter.emit(makeEvent("SessionOpen", {
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
    let systemPrompt;
    let contextMetadata;
    let cacheConfig;
    let abortController;
    let timeoutHandle;
    let removeCallerAbort;
    let actualIterations = 0;
    let rootFailure;
    let repl;
    try {
        if (!Number.isSafeInteger(opts.maxIterations) || opts.maxIterations < 1) {
            throw new Error("maxIterations must be a positive integer");
        }
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
            recorder.startSession(runId, query, `${config.model.provider}/${config.model.model}`, config.model.provider, undefined, config);
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
        const onCallerAbort = () => abortController.abort(opts.signal?.reason);
        opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
        removeCallerAbort = () => opts.signal?.removeEventListener("abort", onCallerAbort);
        if (opts.signal?.aborted)
            onCallerAbort();
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
    }
    catch (err) {
        if (timeoutHandle)
            clearTimeout(timeoutHandle);
        removeCallerAbort?.();
        if (recorder)
            recorder.recordError(err instanceof Error ? err.message : String(err));
        if (storage)
            await storage.stop().catch(() => { });
        emitter.emit(makeEvent("Error", {
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
        const toolsMap = {};
        for (const tool of config.tools) {
            toolsMap[tool.name] = tool.code;
        }
        await repl.start({
            context: replContext,
            tools: Object.keys(toolsMap).length > 0 ? toolsMap : undefined,
            loadGeminiBatteries: isGoogleProvider(config.model.provider) && (config.toolsLevel === "standard" || config.toolsLevel === "full"),
            loadPgBatteries: !!opts.storageMode,
            toolsLevel: config.toolsLevel,
            signal: abortController.signal,
        });
        // Set up LLM request handler for REPL IPC — pass storage for pg_* routes
        repl.onLLMRequest(async (request, generationSignal) => {
            const startMs = Date.now();
            const remainingChildBudget = buildRemainingChildBudget(config, budget);
            const results = await handleLLMRequest(request, config, usage, AbortSignal.any([abortController.signal, generationSignal]), geminiCounts, storage, childUsage, {
                logger: opts.logger,
                parentRunId: selfCorrelationId,
                maxIterations: opts.maxIterations,
                maxRetries: opts.maxRetries,
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
            }).finally(recordBudgetUsage);
            // Record sub-calls to observability
            if (recorder && request.request_type !== "llm_query" && request.request_type !== "llm_query_batched") {
                recorder.recordSubCall(0, // iteration not available here; will be approximate
                request.request_type, request.prompts[0]?.slice(0, 200) ?? "", Date.now() - startMs);
            }
            return results;
        });
        /** Cleanup timeout/REPL/storage and build the final result. */
        const finalize = async (answer, iterations, validationFailed = false) => {
            clearTimeout(timeoutHandle);
            removeCallerAbort?.();
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
                if (opts.verbose)
                    process.stderr.write(`mikro: Langfuse flush failed: ${err instanceof Error ? err.message : String(err)}\n`);
            });
            if (storage)
                await storage.stop();
            emitter.emit(makeEvent("EmitDone", {
                sessionId: selfCorrelationId,
                ...selfTag,
                payload: { answer, iterations },
            }));
            closeEmitter("complete");
            return buildResult(answer, usage, iterations, config, budget.getState().budgetHit, geminiCounts, repl.getGeminiBatteriesUsed(), buildUsageBreakdown(usage, childUsage), validationFailed);
        };
        // Every accepted final checks both output.schema and VALIDATE.md, if declared.
        const finalSchemas = [];
        if (config.output.schema) {
            finalSchemas.push({ schema: config.output.schema, rawBlock: JSON.stringify(config.output.schema) });
        }
        if (config.validate)
            finalSchemas.push(config.validate);
        let validateAttempts = 0;
        const finalizeWithValidation = (answer, iteration, mode) => {
            if (finalSchemas.length === 0) {
                return { kind: "finalize", validationFailed: false, errors: [] };
            }
            validateAttempts += 1;
            let decision = { kind: "finalize", validationFailed: false, errors: [] };
            for (const validate of finalSchemas) {
                decision = decideValidatedFinal(answer, {
                    validate,
                    attempt: validateAttempts,
                    retryCapable: mode === "retry-capable",
                    roomForRetry: iteration + 1 < opts.maxIterations &&
                        !abortController.signal.aborted &&
                        !budget.isExceeded(),
                });
                if (decision.kind === "retry" || decision.validationFailed)
                    break;
            }
            if (decision.kind === "finalize" && !decision.validationFailed)
                return decision;
            emitter.emit(makeEvent("Validation", {
                sessionId: selfCorrelationId,
                ...selfTag,
                status: "fail",
                attempt: validateAttempts,
                errors: decision.errors,
            }));
            if (opts.verbose) {
                logVerbose(iteration, decision.kind === "retry"
                    ? `FINAL payload failed VALIDATE.md (attempt ${validateAttempts}/${MAX_VALIDATE_ATTEMPTS}) — retrying with the schema hint`
                    : `FINAL payload failed VALIDATE.md (attempt ${validateAttempts}) — returning it flagged validation_failed`);
            }
            return decision;
        };
        // Build initial message history
        const messages = [
            { role: "system", content: systemPrompt },
            {
                role: "user",
                content: opts.maxIterations === 1 ? `${contextMetadata}\n\nQuery: ${query}` : buildUserPrompt(query, 0, contextMetadata),
            },
        ];
        recordBudgetUsage(); // Zero cost/token allowances are already exhausted.
        // Iteration loop
        let consecutiveEmpty = 0;
        let emptyAbort = false;
        for (let iteration = 0; iteration < opts.maxIterations; iteration++) {
            // Check timeout
            if (abortController.signal.aborted) {
                throw new Error("RLM query deadline or cancellation reached");
            }
            // Check budget
            if (budget.isExceeded()) {
                if (opts.verbose)
                    logVerbose(iteration, `budget exceeded: ${budget.getState().budgetHit}`);
                break;
            }
            actualIterations = iteration + 1;
            const finalTurn = iteration === opts.maxIterations - 1;
            if (finalTurn) {
                const finalInstruction = isStructuredOutputMode(config)
                    ? "Return complete JSON matching the declared schemas."
                    : "Use FINAL(<answer>) or FINAL_VAR(<existing variable>).";
                appendValidationRetryTurn(messages, "This is the last model turn within maxIterations. Provide your complete final answer NOW from the available context and observations. " +
                    finalInstruction + " Do not start more analysis or model/tool calls.");
            }
            // Repair feedback owns the next allowed turn; no later candidate from
            // this response may finalize once a retry has been requested.
            const retryState = { hint: null };
            /**
             * Route one candidate final answer through the VALIDATE.md gate.
             * Returns the result to return, or `null` when a retry was granted.
             */
            const settle = async (candidate, mode) => {
                const trimmed = candidate.trim();
                if (!trimmed || trimmed === "..." || trimmed === "…" || trimmed === "Ellipsis") {
                    retryState.hint = "FINAL requires a complete answer, not an empty value or ellipsis.";
                    return null;
                }
                abortController.signal.throwIfAborted();
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
            emitter.emit(makeEvent("IterationStart", {
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
            let response;
            try {
                response = await llmComplete(messages, config.model, {
                    maxTokens: opts.maxOutputTokens,
                    maxRetries: opts.maxRetries,
                    signal: abortController.signal,
                    cacheConfig,
                    thinkingLevel: config.gemini.thinkingLevel,
                    temperature: config.temperature,
                    outputSchema: config.output.schema,
                    geminiConfig: config.gemini,
                });
            }
            catch (error) {
                if (error instanceof LLMCompletionError) {
                    rootFailure = error;
                    if (error.usage) {
                        mergeUsage(usage, error.usage);
                        recordBudgetUsage();
                    }
                }
                throw error;
            }
            const llmDurationMs = Date.now() - llmStartMs;
            langfuse.rootGenerationEnd(generationId, {
                output: response.text,
                durationMs: llmDurationMs,
                usage: response.usage,
            });
            mergeUsage(usage, response.usage);
            recordBudgetUsage();
            abortController.signal.throwIfAborted();
            // Live metrics: accumulate this iteration's tokens + cost so the
            // IterationOutput snapshot carries per-node cost/tokens/latency.
            metrics.addTokens(response.usage.inputTokens, response.usage.outputTokens, response.usage.cacheReadTokens, response.usage.reasoningTokens);
            metrics.addCost(response.usage.totalCost);
            // Record LLM call to observability
            if (recorder) {
                recorder.recordLLMCall(iteration, { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cost: response.usage.totalCost }, `${config.model.provider}/${config.model.model}`, llmDurationMs);
            }
            // Track thought signatures for Gemini stats
            if (response.thoughtSignatureCount) {
                geminiCounts.thoughtSignatures += response.thoughtSignatureCount;
            }
            const responseText = response.text;
            if (opts.verbose) {
                logVerbose(iteration, `LLM responded (${responseText.length} chars, ${response.usage.inputTokens}+${response.usage.outputTokens} tokens)`);
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
                }
                else {
                    // Truly empty — no thinking, no text
                    consecutiveEmpty++;
                    process.stderr.write(`mikro [iter ${iteration}]: WARNING — LLM returned empty response. Possible context size limit.\n`);
                    if (consecutiveEmpty >= 3) {
                        emptyAbort = true;
                        break;
                    }
                }
            }
            else {
                consecutiveEmpty = 0;
            }
            // Extract code blocks
            const codeBlocks = extractCodeBlocks(responseText);
            // In structured output mode, treat the API response as the final answer (schema-enforced JSON)
            if (isStructuredOutputMode(config) && codeBlocks.length === 0) {
                if (opts.verbose) {
                    logVerbose(iteration, "structured output mode: response is final answer");
                }
                const settled = await settle(responseText, "retry-capable");
                if (settled)
                    return settled;
            }
            // Resolve text FINAL signals only after this turn's code has executed.
            const finalSignal = isStructuredOutputMode(config) ? null : detectFinal(responseText, codeBlocks);
            // Execute code blocks in REPL
            const executions = [];
            for (const block of codeBlocks) {
                if (budget.isExceeded())
                    break;
                if (opts.verbose) {
                    logVerbose(iteration, `executing code (${block.code.length} chars)`);
                }
                // Live event: the REPL execution is the parent loop's tool call.
                emitter.emit(makeEvent("ToolCallBefore", {
                    sessionId: selfCorrelationId,
                    ...selfTag,
                    iteration,
                    tool: "repl",
                    args: block.code,
                }));
                const execStartMs = Date.now();
                let execResult;
                let timedOut = false;
                try {
                    execResult = await repl.execute(block.code);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (error instanceof REPLTimeoutError && !abortController.signal.aborted) {
                        timedOut = true;
                        execResult = { type: "execute_result", stdout: "", stderr: "", variables: [], error: message };
                    }
                    else {
                        emitter.emit(makeEvent("ToolCallAfter", {
                            sessionId: selfCorrelationId, ...selfTag, iteration, tool: "repl",
                            result: message, durationMs: Date.now() - execStartMs, ok: false,
                        }));
                        throw error;
                    }
                }
                const execDurationMs = Date.now() - execStartMs;
                metrics.incrToolCalls();
                emitter.emit(makeEvent("ToolCallAfter", {
                    sessionId: selfCorrelationId,
                    ...selfTag,
                    iteration,
                    tool: "repl",
                    result: execResult.error ?? execResult.stdout,
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
                    recorder.recordReplExec(iteration, block.code, execResult.stdout, execResult.stderr ?? "", execDurationMs, !!execResult.error);
                }
                if (execResult.final) {
                    const settled = await settle(execResult.final.value, "retry-capable");
                    if (settled)
                        return settled;
                    // Retry granted: stop executing this turn's remaining blocks, but
                    // keep the `executions` collected so far — `formatIterationResult`
                    // below still shows the model what its code printed.
                    break;
                }
                if (timedOut) {
                    // Remaining blocks may depend on the lost namespace.
                    retryState.hint = execResult.error ?? "REPL timeout discarded all user-created variables; the block was not replayed.";
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
                if (finalSignal.type === "invalid") {
                    retryState.hint = finalSignal.value;
                }
                else if (finalSignal.type === "final") {
                    const settled = await settle(finalSignal.value, "retry-capable");
                    if (settled)
                        return settled;
                }
                else {
                    try {
                        const result = await repl.execute(`FINAL_VAR(${JSON.stringify(finalSignal.value)})`);
                        if (result.final) {
                            const settled = await settle(result.final.value, "retry-capable");
                            if (settled)
                                return settled;
                        }
                        else {
                            retryState.hint = result.error || result.stdout.trim() ||
                                `Variable ${JSON.stringify(finalSignal.value)} not found; create it before FINAL.`;
                        }
                    }
                    catch (error) {
                        if (!(error instanceof REPLTimeoutError) || abortController.signal.aborted)
                            throw error;
                        retryState.hint = error.message;
                    }
                }
            }
            else if (finalTurn && codeBlocks.length === 0 && retryState.hint === null && responseText.trim()) {
                const settled = await settle(responseText, "flag-only");
                if (settled)
                    return settled;
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
            }
            else if (retryState.hint === null) {
                // No code blocks — prompt the model to use the REPL. Suppressed when
                // a validation retry owns this turn: the model *did* answer (that is
                // precisely why it is being retried), so this nudge would be false
                // and would compete with the schema hint appended below.
                messages.push({
                    role: "user",
                    content: "You didn't write any REPL code in your last response. Please use ```repl``` code blocks to interact with the REPL environment and work towards answering the query.",
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
            emitter.emit(makeEvent("IterationOutput", {
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
            process.stderr.write(`mikro: 3 consecutive empty LLM responses — aborting. Context may exceed API limits.\n`);
            clearTimeout(timeoutHandle);
            removeCallerAbort?.();
            if (recorder)
                recorder.recordError(EMPTY_RESPONSES_BUDGET_HIT);
            await repl.stop();
            if (storage)
                await storage.stop();
            emitter.emit(makeEvent("Error", {
                sessionId: selfCorrelationId,
                ...selfTag,
                phase: "iteration",
                error: { name: "EmptyResponses", message: "aborted after 3 consecutive empty LLM responses" },
            }));
            closeEmitter("abort");
            return buildResult("Error: aborted after 3 consecutive empty LLM responses. Context may exceed API token limits.", usage, actualIterations, config, EMPTY_RESPONSES_BUDGET_HIT, geminiCounts, repl.getGeminiBatteriesUsed(), buildUsageBreakdown(usage, childUsage));
        }
        // No completion is allowed outside the model-turn cap or after cost/token
        // exhaustion. A run without a final remains a meaningful failure.
        const reason = budget.getState().budgetHit ?? "maxIterations";
        throw new RLMRunError(`RLM ${reason} exhausted without a complete final answer (${actualIterations} model turns)`, actualIterations, budget.getState().budgetHit, usage.llmCalls > 0 ? usage : undefined);
    }
    catch (err) {
        // The root failure packet has already been merged once. Preserve the
        // cumulative run observations, including earlier root and IPC calls, at
        // this terminal transition rather than exposing only the failed packet.
        const terminalError = err instanceof LLMCompletionError
            ? new RLMRunError(err.message, actualIterations, budget.getState().budgetHit, usage.llmCalls > 0 ? usage : undefined, { cause: err })
            : err;
        clearTimeout(timeoutHandle);
        removeCallerAbort?.();
        if (recorder)
            recorder.recordError(err instanceof Error ? err.message : String(err));
        await repl.stop().catch(() => { });
        if (storage)
            await storage.stop().catch(() => { });
        const aborted = (err instanceof Error && err.name === "AbortError") || abortController.signal.aborted;
        emitter.emit(makeEvent("Error", {
            sessionId: selfCorrelationId,
            ...selfTag,
            phase: aborted ? "timeout" : "error",
            error: {
                name: err instanceof Error ? err.name : "Error",
                message: err instanceof Error ? err.message : String(err),
                ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
                ...(rootFailure ? { stopReason: rootFailure.stopReason } : {}),
                ...(terminalError instanceof RLMRunError && terminalError.usage ? { usage: terminalError.usage } : {}),
            },
        }));
        closeEmitter(aborted ? "abort" : "error");
        if (aborted) {
            return buildResult(TIMEOUT_ANSWER, usage, actualIterations, config, budget.getState().budgetHit, geminiCounts, repl.getGeminiBatteriesUsed(), buildUsageBreakdown(usage, childUsage));
        }
        throw terminalError;
    }
}
function buildUsageBreakdown(total, child) {
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
function buildRemainingChildBudget(config, budget) {
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
function buildResult(answer, usage, iterations, config, budgetHit, geminiCounts, geminiBatteriesUsed, usageBreakdown, validationFailed) {
    // Extract file references from the answer (paths like docs/foo/bar.md)
    const refRegex = /(?:^|[\s(["'])([a-zA-Z0-9_./-]+\.(?:md|txt|py|ts|js|json))/gm;
    const refSet = new Set();
    let match;
    while ((match = refRegex.exec(answer)) !== null) {
        if (match[1])
            refSet.add(match[1]);
    }
    const references = [...refSet];
    const result = {
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
//# sourceMappingURL=rlm.js.map