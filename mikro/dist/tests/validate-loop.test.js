/**
 * VALIDATE.md enforcement on the FINAL channel (`rlmLoop`).
 *
 * The defect these tests pin: `src/sdk/validate.ts` shipped the schema check,
 * the retry policy and the hint text, and `runAgent()` wired them for the SDK
 * surface — but the core loop, which serves the CLI *and* the default MCP
 * backend, never validated anything. A pack's `VALIDATE.md` was inert there
 * and the first FINAL won, conforming or not.
 *
 * Local HTTP provider fixtures drive the actual Python/LLM boundary below.
 * They guard final schema checks, missing-variable feedback, model-call caps,
 * timeout recovery and failure usage without real external model inference.
 */
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { LLMCompletionError } from "../src/llm.js";
import { parseCustomProviders } from "../src/custom-providers.js";
import { createEmitter } from "../src/sdk/emitter.js";
import { LegacyMikroBackend } from "../src/mcp/backends/legacy.js";
import { runTurn } from "../src/mcp/server.js";
import { BackendRunError } from "../src/mcp/backend.js";
import { appendValidationRetryTurn, decideValidatedFinal, normalizeFinalPayload, rlmLoop, RLMRunError, TIMEOUT_ANSWER, validateFinalAnswer, } from "../src/rlm.js";
import { MAX_VALIDATE_ATTEMPTS } from "../src/sdk/validate.js";
// ─── Fixtures ────────────────────────────────────────────
/** The upstream shape: a verdict enum the committee gate reads. */
const VERDICT = {
    schema: {
        type: "object",
        required: ["verdict"],
        properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
    },
    rawBlock: '{ "type": "object", "required": ["verdict"], "properties": { "verdict": { "type": "string", "enum": ["pass", "fail"] } } }',
};
function makeConfig(overrides = {}) {
    return {
        system: null,
        tools: [],
        criteria: null,
        model: { provider: "google", model: "gemini-3.1-flash-lite-preview" },
        configDir: "/tmp",
        budget: { maxCost: null, maxTokens: null, maxDepth: null },
        contextConfig: { extensions: [".md"], exclude: ["node_modules"] },
        toolsLevel: "core",
        cache: { enabled: false, strategy: "full", retention: "long" },
        gemini: {
            thinkingLevel: null,
            googleSearch: false,
            urlContext: false,
            codeExecution: false,
            computerUse: false,
            mapsGrounding: false,
            fileSearch: false,
            mediaResolution: null,
        },
        output: { schema: null },
        storage: {
            enabled: "auto",
            mode: "persistent",
            dataDir: "~/.mikro/data",
            port: 0,
            chunkSize: null,
            chunkUtilization: 0.6,
            charsPerToken: 4,
        },
        prompt: { appendStopProtocol: true },
        validate: null,
        providers: [],
        configSource: "yaml",
        ...overrides,
    };
}
/** A gate with the defaults a mid-run retry-capable site would supply. */
function gate(overrides = {}) {
    return {
        validate: VERDICT,
        attempt: 1,
        retryCapable: true,
        roomForRetry: true,
        ...overrides,
    };
}
const CONFORMING = '{"verdict": "pass"}';
const WRONG_SHAPE = '{"verdict": "maybe"}';
/** Exercise the public loop against real OpenAI-compatible HTTP packets. */
async function withLoopProvider(replies, run) {
    const requests = [];
    const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req)
            body += chunk;
        requests.push(body);
        const reply = replies[requests.length - 1] ?? "unexpected extra completion";
        const packet = typeof reply === "string" ? { text: reply } : reply;
        const usage = packet.usage === undefined
            ? { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
            : packet.usage;
        packet.onRequest?.();
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({
            id: "loop-fixture", object: "chat.completion.chunk", model: "loop-control",
            choices: [{ index: 0, delta: { role: "assistant", content: packet.text }, finish_reason: packet.finish ?? "stop" }],
            ...(usage === null ? {} : { usage }),
        })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("loop fixture needs a TCP address");
    const providers = parseCustomProviders({ "rlm-fixture": {
            "base-url": `http://127.0.0.1:${address.port}/v1`,
            "api-key-env": "MIKRO_RLM_LOOP_FIXTURE_KEY",
            models: { control: { cost: { input: 1, output: 2 } } },
        } }, "loop fixture");
    process.env.MIKRO_RLM_LOOP_FIXTURE_KEY = "fixture-only";
    const config = makeConfig({
        model: { provider: "rlm-fixture", model: "control", providers },
        providers,
    });
    try {
        await run(config, requests);
    }
    finally {
        delete process.env.MIKRO_RLM_LOOP_FIXTURE_KEY;
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}
// ─── Normalization (Decision 5) ──────────────────────────
describe("FINAL payload normalization", () => {
    it("trims surrounding whitespace", () => {
        assert.equal(normalizeFinalPayload(`  ${CONFORMING}\n`), CONFORMING);
    });
    it("unwraps a json code fence", () => {
        assert.equal(normalizeFinalPayload(`\`\`\`json\n${CONFORMING}\n\`\`\``), CONFORMING);
    });
    it("unwraps a bare code fence", () => {
        assert.equal(normalizeFinalPayload(`\`\`\`\n${CONFORMING}\n\`\`\``), CONFORMING);
    });
    it("leaves an unfenced payload alone", () => {
        assert.equal(normalizeFinalPayload(CONFORMING), CONFORMING);
    });
    it("a fenced conforming payload validates rather than burning an attempt", () => {
        assert.equal(validateFinalAnswer(`\`\`\`json\n${CONFORMING}\n\`\`\``, VERDICT).ok, true);
    });
    it("reports unparsable text as an ordinary shape failure", () => {
        // The systematic case: FINAL_VAR of a Python dict, whose str() repr uses
        // single quotes and is not JSON.
        const result = validateFinalAnswer("{'verdict': 'pass'}", VERDICT);
        assert.equal(result.ok, false);
        assert.deepEqual([...result.errors], [
            "<root>: expected JSON matching the VALIDATE.md schema, got unparsable text",
        ]);
        assert.equal(result.schemaSource, VERDICT.rawBlock);
    });
    it("reports a shape miss with the field-level error", () => {
        const result = validateFinalAnswer(WRONG_SHAPE, VERDICT);
        assert.equal(result.ok, false);
        assert.match(result.errors[0] ?? "", /verdict: value not in enum/);
    });
});
// ─── The validate / retry / flag policy ──────────────────
describe("decideValidatedFinal", () => {
    it("a conforming FINAL finalizes untouched", () => {
        const decision = decideValidatedFinal(CONFORMING, gate());
        assert.equal(decision.kind, "finalize");
        assert.equal(decision.kind === "finalize" && decision.validationFailed, false);
    });
    it("a pack with no VALIDATE.md is never checked and never flagged", () => {
        const decision = decideValidatedFinal("not json at all", gate({ validate: null }));
        assert.equal(decision.kind, "finalize");
        assert.equal(decision.kind === "finalize" && decision.validationFailed, false);
    });
    it("the first failure buys one retry, carrying the FINAL-surface hint", () => {
        const decision = decideValidatedFinal(WRONG_SHAPE, gate({ attempt: 1 }));
        assert.equal(decision.kind, "retry");
        if (decision.kind !== "retry")
            return;
        assert.match(decision.hint, /^Your previous FINAL answer did not match VALIDATE\.md:/);
        assert.ok(!decision.hint.includes("emit_done"));
        assert.ok(decision.hint.includes("verdict: value not in enum"));
        assert.ok(decision.hint.includes(VERDICT.rawBlock));
        assert.ok(decision.hint.includes("FINAL(<compact single-line JSON>)"));
    });
    it("a corrected payload on the retry turn finalizes clean", () => {
        const decision = decideValidatedFinal(CONFORMING, gate({ attempt: 2 }));
        assert.equal(decision.kind, "finalize");
        assert.equal(decision.kind === "finalize" && decision.validationFailed, false);
    });
    it("the second failure is terminal: flagged, not retried", () => {
        const decision = decideValidatedFinal(WRONG_SHAPE, gate({ attempt: MAX_VALIDATE_ATTEMPTS }));
        assert.equal(decision.kind, "finalize");
        assert.equal(decision.kind === "finalize" && decision.validationFailed, true);
    });
    /**
     * The room check mirrors the loop's own top-of-loop tests. Without it a
     * "retry" granted on the last iteration, past the budget, or after the
     * wall-clock abort must not produce an extra model completion.
     */
    it("never retries when there is no room for another iteration", () => {
        const decision = decideValidatedFinal(WRONG_SHAPE, gate({ roomForRetry: false }));
        assert.equal(decision.kind, "finalize");
        assert.equal(decision.kind === "finalize" && decision.validationFailed, true);
    });
    it("a terminal-only candidate validates and flags but never retries", () => {
        const decision = decideValidatedFinal(WRONG_SHAPE, gate({ retryCapable: false, attempt: 1, roomForRetry: true }));
        assert.equal(decision.kind, "finalize");
        assert.equal(decision.kind === "finalize" && decision.validationFailed, true);
    });
    it("a terminal-only conforming answer remains unflagged", () => {
        const decision = decideValidatedFinal(CONFORMING, gate({ retryCapable: false }));
        assert.equal(decision.kind, "finalize");
        assert.equal(decision.kind === "finalize" && decision.validationFailed, false);
    });
});
// ─── The retry's user turn ───────────────────────────────
describe("appendValidationRetryTurn", () => {
    const HINT = "Your previous FINAL answer did not match VALIDATE.md:\n  - boom";
    it("pushes a hint turn after the assistant turn (the no-code FINAL case)", () => {
        // The dominant retry shape: the model answered with FINAL and wrote no
        // REPL code, so the loop suppressed its "you didn't write any REPL code"
        // nudge and the history ends on the assistant turn.
        const messages = [
            { role: "system", content: "sys" },
            { role: "user", content: "q" },
            { role: "assistant", content: "FINAL({})" },
        ];
        appendValidationRetryTurn(messages, HINT);
        assert.equal(messages.length, 4);
        assert.equal(messages[3].role, "user");
        assert.equal(messages[3].content, HINT);
    });
    it("merges into a trailing user turn instead of stacking two (the REPL case)", () => {
        // When code ran, `formatIterationResult` already claimed this turn's user
        // message; the hint rides on the end of it so the history stays strictly
        // alternating — a shape some providers reject outright.
        const messages = [
            { role: "assistant", content: "```repl\nemit(x)\n```" },
            { role: "user", content: "Execution result: {}" },
        ];
        appendValidationRetryTurn(messages, HINT);
        assert.equal(messages.length, 2);
        assert.equal(messages[1].content, `Execution result: {}\n\n${HINT}`);
        assert.ok(messages[1].content.endsWith(HINT), "the hint must land last");
    });
    it("never produces two consecutive user turns", () => {
        const messages = [
            { role: "system", content: "sys" },
            { role: "user", content: "q" },
            { role: "assistant", content: "a" },
            { role: "user", content: "exec" },
        ];
        appendValidationRetryTurn(messages, HINT);
        for (let i = 1; i < messages.length; i++) {
            assert.ok(!(messages[i].role === "user" && messages[i - 1].role === "user"), `consecutive user turns at ${i}`);
        }
    });
});
describe("rlmLoop final and failure transitions", () => {
    it("resolves bare FINAL variables, keeps quoted values literal, and does not evaluate expressions", async () => {
        for (const [response, expected] of [
            ["FINAL(saved)", "stored answer"],
            ['FINAL("saved")', "saved"],
            ["FINAL(saved.upper())", "saved.upper()"],
        ]) {
            await withLoopProvider(["```repl\nsaved = 'stored answer'\n```", response], async (config, requests) => {
                const result = await rlmLoop("fixture", null, config, { maxIterations: 2, maxRetries: 0, output: "json" });
                assert.equal(result.answer, expected);
                assert.equal(result.iterations, 2);
                assert.equal(requests.length, 2);
            });
        }
    });
    it("repairs missing variables and ellipsis instead of returning them as answers", async () => {
        await withLoopProvider(["FINAL(missing)", "FINAL(...)", 'FINAL("complete answer")'], async (config, requests) => {
            const result = await rlmLoop("fixture", null, config, { maxIterations: 3, maxRetries: 0, output: "json" });
            assert.equal(result.answer, "complete answer");
            assert.equal(result.iterations, 3);
            assert.equal(requests.length, 3);
            assert.ok(requests[1].includes("not found"));
            assert.ok(requests[2].includes("ellipsis"));
        });
    });
    it("reserves the last call for a validated final and records its usage inside maxIterations", async () => {
        await withLoopProvider(["```repl\nprint('observed')\n```", CONFORMING], async (config, requests) => {
            config.validate = VERDICT;
            const result = await rlmLoop("fixture", null, config, { maxIterations: 2, maxRetries: 0, maxOutputTokens: 128 });
            assert.equal(result.answer, CONFORMING);
            assert.equal(result.validation_failed, undefined);
            assert.equal(result.iterations, 2);
            assert.equal(result.usage.llmCalls, 2);
            assert.equal(result.usage.inputTokens, 22);
            assert.equal(requests.length, 2);
            assert.ok(requests[1].includes("last model turn"));
            assert.ok(requests.every((body) => /"max_(?:completion_)?tokens":128/.test(body)));
        });
    });
    it("uses at most the remaining declared turn for schema repair, including structured output", async () => {
        await withLoopProvider([WRONG_SHAPE, CONFORMING], async (config, requests) => {
            config.output.schema = VERDICT.schema;
            config.validate = VERDICT;
            const result = await rlmLoop("fixture", null, config, { maxIterations: 2, maxRetries: 0 });
            assert.equal(result.validation_failed, undefined);
            assert.equal(result.answer, CONFORMING);
            assert.equal(requests.length, 2);
        });
        await withLoopProvider([WRONG_SHAPE], async (config, requests) => {
            config.output.schema = VERDICT.schema;
            const result = await rlmLoop("fixture", null, config, { maxIterations: 1, maxRetries: 0 });
            assert.equal(result.validation_failed, true);
            assert.equal(result.iterations, 1);
            assert.equal(requests.length, 1);
        });
    });
    it("enforces VALIDATE.md as well as output.schema without a bypass", async () => {
        await withLoopProvider([WRONG_SHAPE, CONFORMING], async (config, requests) => {
            config.output.schema = { type: "object" };
            config.validate = VERDICT;
            const result = await rlmLoop("fixture", null, config, { maxIterations: 2, maxRetries: 0 });
            assert.equal(result.validation_failed, undefined);
            assert.equal(result.answer, CONFORMING);
            assert.equal(requests.length, 2);
        });
    });
    it("never adds a forced completion after iteration, cost, or token exhaustion", async () => {
        for (const [limit, allowance, expectedCalls] of [
            ["iteration", null, 1], ["cost", 0.000001, 1], ["tokens", 1, 1],
            ["cost", 0, 0], ["tokens", 0, 0],
        ]) {
            await withLoopProvider(["```repl\nprint('not final')\n```"], async (config, requests) => {
                if (limit === "cost")
                    config.budget.maxCost = allowance;
                if (limit === "tokens")
                    config.budget.maxTokens = allowance;
                await assert.rejects(rlmLoop("fixture", null, config, { maxIterations: limit === "iteration" ? 1 : 5, maxRetries: 0 }), (error) => {
                    assert.ok(error instanceof RLMRunError);
                    assert.match(error.message, limit === "iteration" ? /maxIterations exhausted/ : /max-(?:cost|tokens) exhausted/);
                    assert.equal(error.iterations, expectedCalls);
                    assert.equal(error.budgetHit, limit === "iteration" ? null : `max-${limit}`);
                    assert.equal(error.usageComplete, false);
                    if (expectedCalls === 0) {
                        assert.equal(error.usage, undefined, "no observed call must not manufacture a zero receipt");
                    }
                    else {
                        assert.ok(error.usage);
                        assert.equal(error.usage.inputTokens, 11);
                        assert.equal(error.usage.outputTokens, 7);
                        assert.equal(error.usage.llmCalls, 1);
                        assert.ok(Math.abs(error.usage.totalCost - 0.000025) < 1e-12);
                    }
                    return true;
                });
                assert.equal(requests.length, expectedCalls);
            });
        }
    });
    it("keeps direct IPC usage once and charges it to the shared token budget", async () => {
        const replies = [
            '```repl\nprint(llm_query("bounded subcall"))\n```',
            "subcall answer",
            'FINAL("complete")',
        ];
        await withLoopProvider(replies, async (config, requests) => {
            const result = await rlmLoop("fixture", null, config, { maxIterations: 2, maxRetries: 0 });
            assert.equal(result.answer, "complete");
            assert.equal(result.iterations, 2);
            assert.equal(result.usage.llmCalls, 3);
            assert.equal(result.usage.inputTokens, 33);
            assert.equal(result.usage.outputTokens, 21);
            assert.equal(requests.length, 3);
        });
        await withLoopProvider(replies, async (config, requests) => {
            config.budget.maxTokens = 35;
            await assert.rejects(rlmLoop("fixture", null, config, { maxIterations: 2, maxRetries: 0 }), (error) => {
                assert.ok(error instanceof RLMRunError);
                assert.match(error.message, /max-tokens exhausted/);
                assert.equal(error.iterations, 1, "IPC calls do not inflate root model-turn count");
                assert.equal(error.budgetHit, "max-tokens");
                assert.equal(error.usageComplete, false);
                assert.ok(error.usage);
                assert.equal(error.usage.inputTokens, 22);
                assert.equal(error.usage.outputTokens, 14);
                assert.equal(error.usage.llmCalls, 2);
                assert.ok(Math.abs(error.usage.totalCost - 0.00005) < 1e-12);
                return true;
            });
            assert.equal(requests.length, 2, "the IPC completion spends the remaining shared budget");
        });
    });
    it("preserves cap-failure root and IPC subtotals through the actual legacy turn failure boundary", async () => {
        await withLoopProvider([
            '```repl\nprint(llm_query("bounded subcall"))\n```',
            "subcall answer",
        ], async (config, requests) => {
            const outcome = await runTurn(new LegacyMikroBackend(), undefined, config, "receipt-fixture", "fixture", "receipt-session", undefined, config.configDir, undefined, 1);
            assert.equal(outcome.failed, true);
            assert.match(outcome.answer, /failed: RLM maxIterations exhausted/);
            assert.equal(requests.length, 2, "no completion may follow the failed bounded finalization");
            assert.match(outcome.text, /usage coverage: partial; unreported totals unknown/);
            const line = outcome.text.split("\n").find((text) => text.startsWith("observed_usage: "));
            assert.ok(line, "the existing failure footer must retain the actual observed receipt");
            const observed = JSON.parse(line.slice("observed_usage: ".length));
            assert.ok(typeof observed === "object" && observed !== null && !Array.isArray(observed));
            // Checked JSON records; each receipt field remains unknown until asserted.
            const receipt = observed;
            assert.equal(receipt.coverage, "partial");
            assert.equal(receipt.iterations, 1);
            assert.equal(receipt.totals, null);
            assert.ok(typeof receipt.subtotal === "object" && receipt.subtotal !== null && !Array.isArray(receipt.subtotal));
            const subtotal = receipt.subtotal;
            assert.equal(subtotal.inputTokens, 22);
            assert.equal(subtotal.outputTokens, 14);
            assert.ok(typeof subtotal.totalCost === "number");
            assert.ok(Math.abs(subtotal.totalCost - 0.00005) < 1e-12);
        });
        await withLoopProvider([], async (config, requests) => {
            config.budget.maxTokens = 0;
            const outcome = await runTurn(new LegacyMikroBackend(), undefined, config, "receipt-fixture", "fixture", "receipt-session", undefined, config.configDir, undefined, 1);
            assert.equal(outcome.failed, true);
            assert.match(outcome.answer, /failed: RLM max-tokens exhausted[\s\S]*0 model turns/);
            assert.equal(requests.length, 0);
            assert.equal(outcome.text, outcome.answer, "without observed calls, no zero-valued receipt/footer may be manufactured");
        });
    });
    it("carries cumulative observed root failure usage once, keeping missing receipts unknown and no successful final", async () => {
        for (const [prior, failedUsage, inputTokens, outputTokens, llmCalls, rootTurns] of [
            [[], { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, 11, 7, 1, 1],
            [["still working"], { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 }, 24, 12, 2, 2],
            [['```repl\nprint(llm_query("prior IPC"))\n```', "IPC observation"],
                { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 }, 35, 19, 3, 2],
            [["still working"], null, 11, 7, 1, 2],
            [[], null, undefined, undefined, 0, 1],
        ]) {
            await withLoopProvider([...prior, { text: "partial", finish: "length", usage: failedUsage }], async (config, requests) => {
                const emitter = createEmitter();
                const events = [];
                const drain = (async () => { for await (const event of emitter)
                    events.push(event); })();
                await assert.rejects(rlmLoop("fixture", null, config, {
                    maxIterations: rootTurns, maxRetries: 0, emitter,
                }), (error) => {
                    assert.ok(error instanceof RLMRunError);
                    assert.match(error.message, /length/);
                    assert.ok(error.cause instanceof LLMCompletionError);
                    assert.equal(error.cause.stopReason, "length");
                    assert.equal(error.iterations, rootTurns);
                    assert.equal(error.usageComplete, false);
                    assert.equal(error.usage?.inputTokens, inputTokens);
                    assert.equal(error.usage?.outputTokens, outputTokens);
                    if (inputTokens !== undefined && outputTokens !== undefined) {
                        assert.ok(error.usage);
                        assert.equal(error.usage.llmCalls, llmCalls);
                        assert.ok(Math.abs(error.usage.totalCost - (inputTokens + outputTokens * 2) / 1_000_000) < 1e-12);
                        const snapshot = error.usage;
                        assert.throws(() => { snapshot.inputTokens = -1; }, TypeError, "published subtotal is immutable");
                    }
                    else {
                        assert.equal(error.usage, undefined, "an unreported failure cannot fabricate a zero receipt");
                    }
                    return true;
                });
                await drain;
                assert.equal(requests.length, prior.length + 1);
                const failures = events.filter((event) => event.type === "Error");
                assert.equal(failures.length, 1);
                const failure = failures[0];
                assert.ok(failure.type === "Error");
                assert.equal(failure.error.stopReason, "length");
                assert.equal(failure.error.usage?.inputTokens, inputTokens);
                assert.equal(failure.error.usage?.outputTokens, outputTokens);
                assert.equal(failure.error.usage?.llmCalls, llmCalls === 0 ? undefined : llmCalls);
                assert.equal(events.some((event) => event.type === "EmitDone"), false);
            });
        }
    });
    it("maps actual cancellation to a partial legacy failure receipt, never complete or fabricated zero usage", async () => {
        for (const stage of ["after-observed", "first-dispatch", "pre-aborted"]) {
            const controller = new AbortController();
            if (stage === "pre-aborted")
                controller.abort();
            const replies = stage === "after-observed" ? ["still working"] : [];
            replies.push({ text: "unreported cancelled response", usage: null, onRequest: () => controller.abort() });
            await withLoopProvider(replies, async (config, requests) => {
                const progress = [];
                await assert.rejects(new LegacyMikroBackend().run(undefined, {
                    query: "fixture", context: null, config, cwd: config.configDir,
                    maxIterations: 2, maxRetries: 0, signal: controller.signal,
                }, (message) => { progress.push(message); }), (error) => {
                    assert.ok(error instanceof BackendRunError);
                    assert.equal(error.message, TIMEOUT_ANSWER);
                    if (stage === "after-observed") {
                        assert.ok(error.receipt);
                        assert.equal(error.receipt.iterations, 2);
                        assert.equal(error.receipt.usageComplete, false);
                        assert.equal(error.receipt.usage.inputTokens, 11);
                        assert.equal(error.receipt.usage.outputTokens, 7);
                        assert.ok(Math.abs(error.receipt.usage.totalCost - 0.000025) < 1e-12);
                        assert.ok(progress.includes("iteration 2"));
                    }
                    else {
                        assert.equal(error.receipt, undefined, "no observations means no numeric receipt");
                    }
                    return true;
                });
                assert.equal(requests.length, stage === "after-observed" ? 2 : stage === "first-dispatch" ? 1 : 0);
            });
        }
    });
    it("restores the next allowed turn after a Python timeout, pairing events and never replaying its side effect", async () => {
        const dir = await mkdtemp(join(tmpdir(), "mikro-rlm-timeout-"));
        const marker = join(dir, "marker");
        const previous = process.env.MIKRO_REPL_TIMEOUT_MS;
        process.env.MIKRO_REPL_TIMEOUT_MS = "100";
        try {
            await withLoopProvider([
                "```repl\nsaved = 'lost'\n```",
                `\`\`\`repl\nimport time\nwith open(${JSON.stringify(marker)}, "a") as f:\n    f.write("once\\n")\n    f.flush()\ntime.sleep(5)\n\`\`\``,
                '```repl\nprint(context)\nprint(echo(value="restored"))\nprint("saved" in dir())\n```',
                'FINAL("complete")',
            ], async (config, requests) => {
                config.tools = [{ name: "echo", code: 'def echo(**kwargs):\n    return call_tool("echo", kwargs)' }];
                const emitter = createEmitter();
                const events = [];
                const drain = (async () => { for await (const event of emitter)
                    events.push(event); })();
                const result = await rlmLoop("fixture", {
                    type: "string", content: "original context", metadata: "fixture context",
                }, config, {
                    maxIterations: 4, maxRetries: 0, emitter,
                    tools: async (_tool, args) => args,
                });
                await drain;
                assert.equal(result.answer, "complete");
                assert.equal(requests.length, 4);
                assert.ok(requests[2].includes("user-created variables were lost"));
                assert.ok(requests[3].includes("original context"));
                assert.ok(requests[3].includes("restored"));
                assert.ok(requests[3].includes("False"));
                assert.equal(await readFile(marker, "utf8"), "once\n");
                const before = events.filter((event) => event.type === "ToolCallBefore");
                const after = events.filter((event) => event.type === "ToolCallAfter");
                assert.equal(before.length, after.length);
                assert.ok(after.some((event) => event.type === "ToolCallAfter" && !event.ok));
            });
        }
        finally {
            if (previous === undefined)
                delete process.env.MIKRO_REPL_TIMEOUT_MS;
            else
                process.env.MIKRO_REPL_TIMEOUT_MS = previous;
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("returns the existing timeout failure on caller cancellation with no model retry", async () => {
        await withLoopProvider(["not called"], async (config, requests) => {
            const controller = new AbortController();
            controller.abort();
            const result = await rlmLoop("fixture", null, config, {
                maxIterations: 2, maxRetries: 0, signal: controller.signal,
            });
            assert.equal(result.answer, TIMEOUT_ANSWER);
            assert.equal(result.iterations, 0);
            assert.equal(requests.length, 0);
        });
    });
});
//# sourceMappingURL=validate-loop.test.js.map