/**
 * Backend contract — the `RuntimeBackend` seam must be host-invisible.
 *
 * One harness drives every backend through the *real* server-side turn
 * pipeline (`runTurn` → cost footer → `sessionResult`) with the same request
 * and a stubbed engine, then asserts each backend's host-visible results are
 * equal:
 *
 *   1. the `structuredContent` `{answer, session_id}` envelope and its
 *      mirrored text block (same string, byte for byte, on both channels);
 *   2. the cost-footer field set — label, model, iterations, tokens in/out,
 *      cost, budget-hit presence, session id — parsed out of the text block;
 *   3. the `isError` classification, which must equal `isFailedRun`'s verdict
 *      on the backend's result;
 *   4. the progress-notification sequence.
 *
 * Deliberately NOT compared: tool schemas. `genericToolSchema` /
 * `agentToolSchema` / `toolOutputSchema` take no backend argument, so a
 * schema comparison passes by construction and can never fail — comparing
 * them would be theater.
 *
 * Two deliberate exclusions from byte equality:
 *
 *   - the elapsed-seconds footer field: wall-clock timing is a property of
 *     the machine, not of the backend, and two runs never take the same
 *     milliseconds. The field's *presence* and numeric shape are asserted on
 *     every record; its *value* is never compared across backends.
 *   - the heartbeat: the idle `working Ns` ticks are server-side (shared by
 *     every backend by construction, `src/mcp/server.ts`) and fire at 15s —
 *     the stub runs here finish in microseconds, so the compared sequences
 *     are the backend-driven messages, which is what can diverge.
 *
 * The legacy backend is registered twice, so the pairwise comparison has
 * real teeth from day one. Group 2 registers the prime backend too — fed its
 * own stub *engine* — and every assertion below becomes a live cross-backend
 * gate. The prime stub is an engine seam, not the stub binary: two scenarios
 * (empty-response abort, budget-truncated run) carry `budgetHit` reasons the
 * prime backend can only *produce*, not derive from a scripted JSONL stream,
 * so the binary-level spawn machinery stays in `tests/prime-backend.test.ts`
 * and this harness proves the host-visible surface alone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { parseCustomProviders } from "../src/custom-providers.js";
import { LegacyMikroBackend } from "../src/mcp/backends/legacy.js";
import { PiBackend } from "../src/mcp/backends/pi.js";
import { PrimeBackend, } from "../src/mcp/backends/prime.js";
import { EMIT_DONE_TOOL, PrimeSdkBackend, } from "../src/mcp/backends/prime-sdk.js";
import { EMPTY_RESPONSES_BUDGET_HIT, TIMEOUT_ANSWER } from "../src/rlm.js";
import { parseAgentSpec } from "../src/sdk/agent-spec.js";
import { parseValidateMd } from "../src/sdk/validate.js";
import { isFailedRun, runTurn, selectBackend, sessionResult, } from "../src/mcp/server.js";
const SESSION_ID = "sess_contract0000000";
/** Config whose fields the turn pipeline actually reads (model for the footer). */
const CONFIG = {
    // The gate model (wish decision 7, as amended): deepseek/deepseek-v4-flash.
    // The prime backend maps mikro's deepseek addressing to prime's native
    // deepseek provider verbatim; any other provider would be a loud failure,
    // which is not what this harness exists to compare.
    model: { provider: "deepseek", model: "deepseek-v4-flash", subCallModel: "deepseek-v4-flash" },
    budget: { maxCost: null, maxTokens: null, maxDepth: null },
    gemini: { thinkingLevel: null },
    contextConfig: {},
};
/** Footer cost formatting — pinned here so a format drift fails the contract. */
function formatCost(cost) {
    if (cost <= 0)
        return "$0.00";
    if (cost < 0.01)
        return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}
const USAGE = {
    inputTokens: 1_234,
    outputTokens: 567,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: 0.0123,
    llmCalls: 3,
};
const ev = (type) => ({ type });
function stubLoop(run) {
    const calls = [];
    const loop = async (query, context, _config, options = {}) => {
        calls.push({ query, context, options });
        for (const event of run.events)
            options.emitter?.emit(event);
        options.emitter?.close();
        return {
            answer: run.answer,
            references: [],
            usage: run.usage,
            iterations: run.iterations,
            model: "stub/stub-model",
            budgetHit: run.budgetHit,
        };
    };
    return { loop, calls };
}
function stubPrimeEngine(run, bareProgressMessages) {
    const calls = [];
    const engine = async (argv, emit, limits) => {
        calls.push({ argv, limits });
        for (const message of bareProgressMessages)
            emit(message);
        return {
            answer: run.answer,
            turns: run.iterations,
            budgetHit: run.budgetHit,
            usage: {
                inputTokens: run.usage.inputTokens,
                outputTokens: run.usage.outputTokens,
                totalCost: run.usage.totalCost,
            },
        };
    };
    return { engine, calls };
}
function stubPrimeSdkEngine(run, bareProgressMessages) {
    const calls = [];
    const engine = async (plan, emit, limits) => {
        calls.push({ plan, limits });
        for (const message of bareProgressMessages)
            emit(message);
        return {
            answer: run.answer,
            turns: run.iterations,
            budgetHit: run.budgetHit,
            usage: {
                inputTokens: run.usage.inputTokens,
                outputTokens: run.usage.outputTokens,
                totalCost: run.usage.totalCost,
            },
        };
    };
    return { engine, calls };
}
/** Backends emit bare messages; runTurn adds "label · ". Strip the prefix back off. */
function bareProgress(scenario) {
    return scenario.expectedProgress.map((m) => m.slice(m.indexOf(" · ") + 3));
}
/**
 * The backends under contract, each fed the SAME scripted scenario.
 *
 * The legacy backend is registered twice (two instances, one stub loop: any
 * per-instance state or nondeterminism fails) and the prime backend once,
 * fed the same `StubRun` through its engine seam. Every assertion in this
 * harness — envelope, footer fields, isError, progress — is therefore a live
 * cross-backend gate.
 */
function backendsFor(loop, primeEngine, primeSdkEngine) {
    return [
        { name: "legacy#1", backend: new LegacyMikroBackend({ loop }) },
        { name: "legacy#2", backend: new LegacyMikroBackend({ loop }) },
        { name: "prime", backend: new PrimeBackend({ engine: primeEngine }) },
        { name: "prime-sdk", backend: new PrimeSdkBackend({ engine: primeSdkEngine }) },
    ];
}
async function drive(backend, scenario) {
    const progress = [];
    const outcome = await runTurn(backend, scenario.agent, CONFIG, scenario.label, scenario.query, SESSION_ID, scenario.contextPath, "/tmp/mikro-backend-contract", (message) => progress.push(message), scenario.maxIterations);
    await drain(progress, scenario.expectedProgress.length);
    return { outcome, result: sessionResult(outcome.text, SESSION_ID, outcome.failed), progress };
}
/** Give the backend's async event-translation loop bounded time to drain. */
async function drain(progress, expected) {
    const deadline = Date.now() + 5_000;
    while (progress.length < expected && Date.now() < deadline) {
        await new Promise((r) => setImmediate(r));
    }
}
const FOOTER_RE = /^mikro · (?<label>[^·]+?) · (?<model>[^·]+?) · (?<iterations>\d+) iterations? · (?<input>[\d,]+) in \/ (?<output>[\d,]+) out · (?<cost>\$[\d.]+) · (?<seconds>\d+(?:\.\d+)?)s(?: · budget hit: (?<budget>[^·]+?))? · session (?<session>\S+)$/;
function parseFooter(footer) {
    const m = FOOTER_RE.exec(footer);
    const g = m?.groups;
    assert.ok(g, `not a cost footer: ${JSON.stringify(footer)}`);
    return {
        label: g.label,
        model: g.model,
        iterations: Number(g.iterations),
        inputTokens: Number(g.input.replace(/,/g, "")),
        outputTokens: Number(g.output.replace(/,/g, "")),
        cost: g.cost,
        seconds: Number(g.seconds),
        budgetHit: g.budget ?? null,
        sessionId: g.session,
    };
}
const SEPARATOR = "\n\n---\n";
function splitText(text) {
    const idx = text.indexOf(SEPARATOR);
    assert.notEqual(idx, -1, `text has no answer/footer separator: ${JSON.stringify(text)}`);
    assert.equal(text.indexOf(SEPARATOR, idx + 1), -1, `more than one answer/footer separator: ${JSON.stringify(text)}`);
    return { answer: text.slice(0, idx), footer: text.slice(idx + SEPARATOR.length) };
}
/** Footer fields compared across backends. Seconds is excluded on purpose:
 *  wall-clock elapsed time is a property of the machine, not of the backend. */
function footerFields(o) {
    const parsed = parseFooter(splitText(o.outcome.text).footer);
    return {
        label: parsed.label,
        model: parsed.model,
        iterations: parsed.iterations,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cost: parsed.cost,
        budgetHit: parsed.budgetHit,
        sessionId: parsed.sessionId,
    };
}
/** The host-visible contract a single record must satisfy. */
function assertHostContract(observed, scenario, tag) {
    const { outcome, result, progress } = observed;
    // 1. The structuredContent envelope is exactly {answer, session_id}, and
    //    `answer` is the same string as the text block, byte for byte.
    const block = result.content[0];
    assert.ok(block && block.type === "text", `${tag}: first content block must be text`);
    assert.equal(block.text, outcome.text, `${tag}: text block must carry the turn text`);
    assert.deepEqual(result.structuredContent, { answer: outcome.text, session_id: SESSION_ID }, `${tag}: envelope must be exactly {answer, session_id}, mirrored from the text block`);
    // 2. The text block is the raw answer plus one cost footer, and the footer
    //    carries the stub's numbers.
    const { answer, footer } = splitText(outcome.text);
    assert.equal(answer, outcome.answer, `${tag}: text block must open with the raw answer`);
    assert.equal(outcome.answer, scenario.stub.answer, `${tag}: answer passed through verbatim`);
    const parsed = parseFooter(footer);
    assert.equal(parsed.label, scenario.label, `${tag}: footer label`);
    assert.equal(parsed.model, `${CONFIG.model.provider}/${CONFIG.model.model}`, `${tag}: footer model must render the config the run used`);
    assert.equal(parsed.iterations, scenario.stub.iterations, `${tag}: footer iterations`);
    assert.equal(parsed.inputTokens, scenario.stub.usage.inputTokens, `${tag}: tokens in`);
    assert.equal(parsed.outputTokens, scenario.stub.usage.outputTokens, `${tag}: tokens out`);
    assert.equal(parsed.cost, formatCost(scenario.stub.usage.totalCost), `${tag}: cost`);
    assert.equal(parsed.budgetHit, scenario.stub.budgetHit, `${tag}: budget-hit field`);
    assert.equal(parsed.sessionId, SESSION_ID, `${tag}: session id`);
    assert.ok(Number.isFinite(parsed.seconds) && parsed.seconds >= 0, `${tag}: seconds present`);
    // 3. isError is exactly isFailedRun's classification of the result.
    assert.equal(outcome.failed, scenario.isError, `${tag}: failed flag`);
    assert.equal(result.isError, scenario.isError, `${tag}: isError`);
    assert.equal(outcome.failed, isFailedRun({ answer: outcome.answer, budgetHit: scenario.stub.budgetHit }), `${tag}: isError must be isFailedRun's verdict, nothing else`);
    // 4. The progress sequence is the stub's events translated, label-prefixed.
    assert.deepEqual(progress, scenario.expectedProgress, `${tag}: progress sequence`);
}
/** Engine forwarding — the legacy stub's recorded `rlmLoop` options. */
function assertLegacyForwarding(calls, scenario, tag) {
    assert.ok(calls.length > 0, `${tag}: the engine stub was never called`);
    for (const call of calls) {
        assert.equal(call.query, scenario.query, `${tag}: query forwarded`);
        if (scenario.contextPath === undefined) {
            assert.equal(call.context, null, `${tag}: no context path → null context forwarded`);
        }
        else {
            assert.ok(call.context !== null, `${tag}: a loaded context must reach the engine`);
            assert.equal(call.context?.type, "list", `${tag}: a directory context loads as a list`);
        }
        assert.equal(call.options.output, "json", `${tag}: output must stay "json" (stdout discipline)`);
        assert.ok(call.options.emitter, `${tag}: run must receive the subscribed emitter`);
        assert.equal(call.options.maxIterations, scenario.maxIterations, `${tag}: the spec's iteration cap must reach the engine`);
    }
}
/** True when `seq` appears in `argv` as a contiguous run, in order. */
function hasArgs(argv, seq) {
    outer: for (let i = 0; i <= argv.length - seq.length; i += 1) {
        for (let j = 0; j < seq.length; j += 1) {
            if (argv[i + j] !== seq[j])
                continue outer;
        }
        return true;
    }
    return false;
}
/**
 * Prime forwarding — the prime stub's recorded spawn call: the argv the
 * backend assembled and the limits it derived from the spec and config.
 * (The real spawn/parse/kill machinery is covered in
 * `tests/prime-backend.test.ts` against a stub binary.)
 */
function assertPrimeForwarding(calls, scenario, tag) {
    assert.ok(calls.length > 0, `${tag}: the prime engine was never called`);
    for (const call of calls) {
        const { argv } = call;
        assert.ok(hasArgs(argv, ["--mode", "json", "-p"]), `${tag}: json mode, print-and-exit`);
        assert.ok(argv.includes("--no-session"), `${tag}: --no-session`);
        assert.ok(hasArgs(argv, ["--cwd", "/tmp/mikro-backend-contract"]), `${tag}: the server's cwd must reach prime's --cwd`);
        for (const flag of ["-nc", "-ne", "-ns", "-np"]) {
            assert.ok(argv.includes(flag), `${tag}: host isolation flag ${flag}`);
        }
        assert.ok(argv.includes("--append-system-prompt"), `${tag}: the microagent role must be appended to prime's base prompt`);
        assert.ok(!argv.includes("--system-prompt"), `${tag}: prime's base RLM prompt must never be replaced`);
        assert.ok(hasArgs(argv, ["--provider", "deepseek", "--model", "deepseek-v4-flash"]), `${tag}: the gate model maps to prime's native deepseek provider, bare id`);
        const contextArgs = argv.filter((a) => a.startsWith("@"));
        if (scenario.contextPath === undefined) {
            assert.equal(contextArgs.length, 0, `${tag}: no context path → no @file args`);
        }
        else {
            assert.ok(contextArgs.length > 0, `${tag}: a loaded context must reach prime as @file args`);
            assert.ok(contextArgs.every((a) => a.startsWith("@/")), `${tag}: every @file arg must be the single @<abs path> form, got: ${argv.join(" ")}`);
        }
        assert.equal(argv.at(-2), "--", `${tag}: -- separator before the message`);
        assert.equal(argv.at(-1), scenario.query, `${tag}: query forwarded as the message`);
        assert.equal(call.limits.maxCost, null, `${tag}: null budget maxCost → null cost ceiling`);
        assert.equal(call.limits.maxTokens, null, `${tag}: null budget maxTokens → null token ceiling`);
        assert.equal(call.limits.maxTurns, scenario.maxIterations ?? null, `${tag}: the spec's iteration cap must reach the engine as the turn ceiling`);
        assert.ok(Number.isFinite(call.limits.deadlineMs) && call.limits.deadlineMs > 0, `${tag}: an mikro-owned wall-clock deadline is always set`);
    }
}
/**
 * Prime SDK forwarding — the plan the in-process backend assembled and the
 * limits it derived. The mirror of `assertPrimeForwarding`: same scenario,
 * same derived limits, but the mapping target is a session plan rather than
 * an argv line.
 */
function assertPrimeSdkForwarding(calls, scenario, tag) {
    assert.ok(calls.length > 0, `${tag}: the prime-sdk engine was never called`);
    for (const call of calls) {
        const { plan } = call;
        assert.equal(plan.cwd, "/tmp/mikro-backend-contract", `${tag}: the server's cwd must reach the plan`);
        assert.equal(plan.query, scenario.query, `${tag}: query forwarded as the prompt`);
        assert.equal(plan.provider, "deepseek", `${tag}: mikro provider passes through unremapped`);
        assert.equal(plan.modelId, "deepseek-v4-flash", `${tag}: mikro model id passes through bare`);
        assert.equal(plan.modelsJson, null, `${tag}: deepseek is a prime built-in — no generated models.json`);
        assert.ok(plan.appendSystemPrompt.length > 0, `${tag}: the microagent role must be appended to prime's base prompt`);
        assert.equal(plan.tools[0]?.name, EMIT_DONE_TOOL, `${tag}: every run must offer the emit_done answer channel first`);
        if (scenario.contextPath === undefined) {
            assert.equal(plan.contextSnapshots.length, 0, `${tag}: no context path → no snapshots`);
        }
        else {
            assert.ok(plan.contextSnapshots.length > 0, `${tag}: a loaded context must reach the plan as snapshots`);
            assert.ok(plan.contextSnapshots.every((s) => s.path.startsWith(plan.scratchDir)), `${tag}: every snapshot must live inside the run's scratch dir`);
        }
        assert.equal(call.limits.maxCost, null, `${tag}: null budget maxCost → null cost ceiling`);
        assert.equal(call.limits.maxTokens, null, `${tag}: null budget maxTokens → null token ceiling`);
        assert.equal(call.limits.maxTurns, scenario.maxIterations ?? null, `${tag}: the spec's iteration cap must reach the engine as the turn ceiling`);
        assert.ok(Number.isFinite(call.limits.deadlineMs) && call.limits.deadlineMs > 0, `${tag}: an mikro-owned wall-clock deadline is always set`);
    }
}
const SECONDS_RE = / · \d+(?:\.\d+)?s ·/;
/** Cross-backend equality: every compared dimension must match. */
function assertRecordsEqual(a, b, tag) {
    assert.equal(a.outcome.answer, b.outcome.answer, `${tag}: answers diverged`);
    assert.equal(a.outcome.text.replace(SECONDS_RE, " · <elapsed>s ·"), b.outcome.text.replace(SECONDS_RE, " · <elapsed>s ·"), `${tag}: text blocks diverged (modulo the elapsed-seconds field)`);
    assert.deepEqual(footerFields(a), footerFields(b), `${tag}: footer field set diverged`);
    assert.equal(a.result.isError, b.result.isError, `${tag}: isError diverged`);
    assert.deepEqual(a.result.structuredContent?.session_id, b.result.structuredContent?.session_id, `${tag}: envelope session diverged`);
    assert.deepEqual(a.progress, b.progress, `${tag}: progress sequences diverged`);
}
// ── Scenarios ────────────────────────────────────────────────────────────
const GENERIC_QUERY = "Where are the two call sites of rlmLoop?";
const SCENARIOS = [
    {
        name: "loop run with recursion (generic mikro_query shape)",
        agent: undefined,
        label: "query",
        query: GENERIC_QUERY,
        stub: {
            answer: "Two call sites: src/a.ts:10 and src/b.ts:20.",
            iterations: 2,
            budgetHit: null,
            usage: USAGE,
            events: [ev("IterationStart"), ev("IterationStart"), ev("Recurse")],
        },
        expectedProgress: [
            "query · iteration 1",
            "query · iteration 2",
            "query · iteration 2 · 1 recursive spawn",
        ],
        isError: false,
    },
    {
        name: "agent turn forwards the spec's iteration cap",
        agent: fakeAgent(undefined),
        label: "agent=triage",
        query: "Classify this: nginx 502 storm.",
        maxIterations: 3,
        stub: {
            answer: "triage: P1, owner=platform.",
            iterations: 3,
            budgetHit: null,
            usage: USAGE,
            events: [ev("IterationStart"), ev("IterationStart"), ev("IterationStart")],
        },
        expectedProgress: [
            "agent=triage · iteration 1",
            "agent=triage · iteration 2",
            "agent=triage · iteration 3",
        ],
        isError: false,
    },
    {
        name: "empty-response abort is a failed run with the abort reason as the answer",
        agent: undefined,
        label: "query",
        query: GENERIC_QUERY,
        stub: {
            answer: "Error: aborted after 3 consecutive empty LLM responses. Context may exceed API token limits.",
            iterations: 3,
            budgetHit: EMPTY_RESPONSES_BUDGET_HIT,
            usage: USAGE,
            events: [ev("IterationStart")],
        },
        expectedProgress: ["query · iteration 1"],
        isError: true,
    },
    {
        name: "budget-truncated run stays a success with the budget field in the footer",
        agent: undefined,
        label: "query",
        query: GENERIC_QUERY,
        stub: {
            answer: "The call sites are src/a.ts:10 and src/b.ts:20 (report shortened).",
            iterations: 4,
            budgetHit: "max-cost",
            usage: USAGE,
            events: [ev("IterationStart")],
        },
        expectedProgress: ["query · iteration 1"],
        isError: false,
    },
];
function fakeAgent(engine) {
    return {
        name: "triage",
        toolName: "mikro_triage",
        dir: "/tmp/triage",
        summary: "triage agent",
        spec: {
            dir: "/tmp/triage",
            schemaVersion: 1,
            toolsApi: 1,
            shape: "loop",
            tools: [],
            extras: {},
            ...(engine === undefined ? {} : { engine }),
        },
    };
}
/** Drive one scenario through every backend and assert the full contract. */
async function runScenario(scenario) {
    const legacy = stubLoop(scenario.stub);
    const prime = stubPrimeEngine(scenario.stub, bareProgress(scenario));
    const primeSdk = stubPrimeSdkEngine(scenario.stub, bareProgress(scenario));
    const backends = backendsFor(legacy.loop, prime.engine, primeSdk.engine);
    assert.ok(backends.length > 1, "the comparison needs at least two backends to mean anything");
    const observed = [];
    for (const { name, backend } of backends) {
        const record = await drive(backend, scenario);
        observed.push(record);
        assertHostContract(record, scenario, `${scenario.name} [${name}]`);
        if (name === "prime") {
            assertPrimeForwarding(prime.calls, scenario, `${scenario.name} [${name}]`);
        }
        else if (name === "prime-sdk") {
            assertPrimeSdkForwarding(primeSdk.calls, scenario, `${scenario.name} [${name}]`);
        }
        else {
            assertLegacyForwarding(legacy.calls, scenario, `${scenario.name} [${name}]`);
        }
    }
    // The actual contract: what the host sees must not depend on the backend.
    for (let i = 1; i < observed.length; i++) {
        assertRecordsEqual(observed[0], observed[i], `${scenario.name} [${backends[0].name} vs ${backends[i].name}]`);
    }
}
describe("backend contract — one harness, both backends", () => {
    for (const scenario of SCENARIOS) {
        it(`"${scenario.name}" is host-identical across every backend`, () => runScenario(scenario));
    }
    it("forwards a loaded directory context as @<abs path> args to prime", async () => {
        // The prime forwarding assertions must see the corrected argv: when a
        // context exists, every context file reaches the spawn line as one
        // `@<abs path>` arg (a plain path would become a message and spawn a
        // garbage turn). The legacy engine, meanwhile, must receive the loaded
        // context itself — the same files, through its own seam.
        const dir = await mkdtemp(join(tmpdir(), "mikro-contract-ctx-"));
        try {
            await writeFile(join(dir, "note.md"), "Call sites: src/c.ts:42 and src/d.ts:7.\n");
            const scenario = {
                name: "directory context forwarding",
                agent: undefined,
                label: "query",
                query: GENERIC_QUERY,
                contextPath: dir,
                stub: {
                    answer: "Two call sites: src/c.ts:42 and src/d.ts:7.",
                    iterations: 1,
                    budgetHit: null,
                    usage: USAGE,
                    events: [ev("IterationStart")],
                },
                expectedProgress: ["query · iteration 1"],
                isError: false,
            };
            await runScenario(scenario);
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
describe("backend selection", () => {
    it("defaults an agent with no engine field to RLM", () => {
        assert.ok(selectBackend(fakeAgent(undefined)) instanceof LegacyMikroBackend);
    });
    it("honors an explicit engine: rlm", () => {
        assert.ok(selectBackend(fakeAgent("rlm")) instanceof LegacyMikroBackend);
    });
    it("defaults generic query to RLM and honors explicit per-call overrides", () => {
        assert.ok(selectBackend(undefined) instanceof LegacyMikroBackend);
        assert.ok(selectBackend(undefined, "pi") instanceof PiBackend);
        assert.ok(selectBackend(fakeAgent("prime-sdk"), "rlm") instanceof LegacyMikroBackend);
        assert.ok(selectBackend(fakeAgent("rlm"), "pi") instanceof PiBackend);
    });
    it("selects Prime for engine: prime", async () => {
        // The prime backend's constructor pins the binary version, so the
        // selection test drives it with a version-only stub — the test suite
        // must not require the real prime-agent install.
        const dir = await mkdtemp(join(tmpdir(), "mikro-contract-prime-"));
        try {
            const shim = join(dir, "prime-agent");
            await writeFile(shim, "#!/usr/bin/env node\n" +
                "if (process.argv.includes('--version')) { process.stderr.write('0.8.1'); process.exit(0); }\n" +
                "process.exit(1);\n", "utf-8");
            await chmod(shim, 0o755);
            const previous = process.env.MIKRO_PRIME_BINARY_PATH;
            try {
                process.env.MIKRO_PRIME_BINARY_PATH = shim;
                assert.ok(selectBackend(fakeAgent("prime")) instanceof PrimeBackend);
            }
            finally {
                if (previous === undefined)
                    delete process.env.MIKRO_PRIME_BINARY_PATH;
                else
                    process.env.MIKRO_PRIME_BINARY_PATH = previous;
            }
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("selects Prime SDK for engine: prime-sdk", () => {
        // Unlike PrimeBackend, this constructor touches nothing: package
        // resolution, the version pin, and the dynamic import all live behind
        // the memoized loader, so selection works on a machine with no
        // prime-agent installed. That is the property under test.
        const previous = process.env.MIKRO_PRIME_AGENT_ROOT;
        try {
            delete process.env.MIKRO_PRIME_AGENT_ROOT;
            assert.ok(selectBackend(fakeAgent("prime-sdk")) instanceof PrimeSdkBackend);
        }
        finally {
            if (previous !== undefined)
                process.env.MIKRO_PRIME_AGENT_ROOT = previous;
        }
    });
    it("rejects forged, unknown, empty and non-string explicit selectors", () => {
        for (const value of ["constructor", "pulp", "", null, false, 0, {}]) {
            assert.throws(() => selectBackend(undefined, value), /engine must be one of/);
        }
        assert.throws(() => selectBackend(fakeAgent("constructor")), /engine must be one of/);
    });
});
describe("public agent.yaml engine selector", () => {
    const DIR = "/tmp/fake-agent";
    it("accepts all public engines and omits a default from the parsed spec", () => {
        for (const engine of ["rlm", "pi", "prime", "prime-sdk"]) {
            const spec = parseAgentSpec(`engine: ${engine}\n`, DIR);
            assert.equal(spec.engine, engine);
            assert.deepEqual(spec.extras, {});
        }
        assert.equal(parseAgentSpec("shape: loop\n", DIR).engine, undefined);
    });
    it("rejects obsolete backend and malformed engines before execution", () => {
        for (const yaml of ["backend: mikro", "backend: prime", "backend: null", "backend: 42"]) {
            assert.throws(() => parseAgentSpec(yaml, DIR), /obsolete backend field/);
        }
        for (const value of ["prim", "primesdk", "mikro", '\"\"', "null", "false", "42", "[]", "{}"]) {
            assert.throws(() => parseAgentSpec(`engine: ${value}`, DIR), /engine must be one of/);
        }
    });
});
describe("the cross-backend comparator can fail", () => {
    // One legitimate record per scenario dimension, corrupted one field at a
    // time: the comparator must flag every dimension the contract covers.
    // (During development a deliberately divergent *backend* was also run
    // through the harness and the suite failed as expected — see the report.)
    it("flags a divergence in any compared dimension", async () => {
        const stub = {
            answer: "Two call sites: src/a.ts:10 and src/b.ts:20.",
            iterations: 2,
            budgetHit: null,
            usage: USAGE,
            events: [ev("IterationStart")],
        };
        const { loop } = stubLoop(stub);
        const scenario = {
            name: "comparator",
            agent: undefined,
            label: "query",
            query: GENERIC_QUERY,
            stub,
            expectedProgress: ["query · iteration 1"],
            isError: false,
        };
        const base = await drive(new LegacyMikroBackend({ loop }), scenario);
        const corruptions = [
            {
                name: "answer",
                mutate: (o) => ({ ...o, outcome: { ...o.outcome, answer: "A different answer." } }),
            },
            {
                name: "text block (footer cost)",
                mutate: (o) => ({
                    ...o,
                    outcome: { ...o.outcome, text: o.outcome.text.replace("$0.01", "$0.02") },
                }),
            },
            {
                name: "isError",
                mutate: (o) => ({ ...o, result: { ...o.result, isError: !o.result.isError } }),
            },
            {
                name: "progress sequence",
                mutate: (o) => ({ ...o, progress: o.progress.slice(0, -1) }),
            },
            {
                name: "envelope session",
                mutate: (o) => ({
                    ...o,
                    result: {
                        ...o.result,
                        structuredContent: { ...o.result.structuredContent, session_id: "sess_other" },
                    },
                }),
            },
        ];
        for (const { name, mutate } of corruptions) {
            const corrupted = mutate(cloneObserved(base));
            assert.throws(() => assertRecordsEqual(base, corrupted, "comparator"), `a divergence in ${name} must fail the comparison`);
        }
        // A clean copy must pass — the comparator is strict, not broken.
        assertRecordsEqual(base, cloneObserved(base), "comparator");
    });
});
function cloneObserved(o) {
    return {
        outcome: { ...o.outcome },
        result: {
            content: [...o.result.content],
            structuredContent: { ...o.result.structuredContent },
            isError: o.result.isError,
        },
        progress: [...o.progress],
    };
}
describe("legacy timeout override", () => {
    it("forwards MIKRO_MCP_RUN_TIMEOUT_MS to the engine, and leaves it alone when unset", async () => {
        const stub = {
            answer: "done",
            iterations: 1,
            budgetHit: null,
            usage: USAGE,
            events: [ev("IterationStart")],
        };
        const { loop, calls } = stubLoop(stub);
        const scenario = {
            name: "timeout",
            agent: undefined,
            label: "query",
            query: GENERIC_QUERY,
            stub,
            expectedProgress: ["query · iteration 1"],
            isError: false,
        };
        const previous = process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
        try {
            delete process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
            await drive(new LegacyMikroBackend({ loop }), scenario);
            assert.equal(calls[0]?.options.timeout, undefined, "no env → no timeout override");
            process.env.MIKRO_MCP_RUN_TIMEOUT_MS = "123456";
            await drive(new LegacyMikroBackend({ loop }), scenario);
            assert.equal(calls[1]?.options.timeout, 123456, "env override must reach the engine");
        }
        finally {
            if (previous === undefined)
                delete process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
            else
                process.env.MIKRO_MCP_RUN_TIMEOUT_MS = previous;
        }
    });
});
/** Real local provider packets exercise Legacy, RLM, Python and the MCP receiver. */
async function terminalReceiptFixture(packets) {
    const root = await mkdtemp(join(tmpdir(), "mikro-terminal-receipt-"));
    const base = await loadConfig(root);
    const controller = new AbortController();
    let requests = 0;
    const server = createServer(async (request, response) => {
        for await (const _chunk of request) { }
        const packet = packets[requests++];
        if (packet === "cancel") {
            controller.abort(new Error("local cancellation during an unreported operation"));
            response.destroy();
            return;
        }
        if (packet === "error") {
            response.writeHead(400, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: { message: "local child provider failed" } }));
            return;
        }
        if (!packet) {
            response.writeHead(400);
            response.end("unexpected model request");
            return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({
            id: `receipt-${requests}`,
            object: "chat.completion.chunk",
            model: "control",
            choices: [{
                    index: 0,
                    delta: { role: "assistant", content: packet.text },
                    finish_reason: packet.finish ?? "stop",
                }],
            usage: {
                prompt_tokens: packet.inputTokens,
                completion_tokens: packet.outputTokens,
                total_tokens: packet.inputTokens + packet.outputTokens,
            },
        })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const keyEnv = "MIKRO_BACKEND_RECEIPT_FIXTURE_KEY";
    const previousKey = process.env[keyEnv];
    process.env[keyEnv] = "fixture-only-not-a-credential";
    const config = {
        ...base,
        system: null,
        criteria: null,
        tools: [],
        toolsLevel: "core",
        validate: null,
        output: { schema: null },
        budget: { maxCost: null, maxTokens: null, maxDepth: 0 },
        cache: { ...base.cache, enabled: false },
        storage: { ...base.storage, enabled: "never" },
        gemini: { ...base.gemini, thinkingLevel: null },
        model: {
            provider: "receipt-fixture",
            model: "control",
            providers: parseCustomProviders({
                "receipt-fixture": {
                    "base-url": `http://127.0.0.1:${address.port}/v1`,
                    "api-key-env": keyEnv,
                    models: { control: { cost: { input: 1, output: 2 } } },
                },
            }, "terminal receipt fixture"),
        },
    };
    return {
        root,
        config,
        controller,
        get requests() { return requests; },
        async close() {
            if (previousKey === undefined)
                delete process.env[keyEnv];
            else
                process.env[keyEnv] = previousKey;
            server.closeAllConnections();
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
            await rm(root, { recursive: true, force: true });
        },
    };
}
/** Narrow parsed external JSON without asserting a fabricated receipt shape. */
function receiptRecord(value) {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return value;
}
function assertPartialReceipt(outcome, inputTokens, outputTokens, iterations, failed = true) {
    assert.equal(outcome.failed, failed);
    assert.match(outcome.text, /usage coverage: partial; unreported totals unknown/);
    assert.doesNotMatch(outcome.text, / · [\d,]+ in \/ [\d,]+ out · \$/);
    const line = outcome.text.split("\n").find((part) => part.startsWith("observed_usage: "));
    assert.ok(line, "partial run must expose its actual observed subtotal");
    const parsed = JSON.parse(line.slice("observed_usage: ".length));
    const observed = receiptRecord(parsed);
    assert.deepEqual(Object.keys(observed).sort(), ["coverage", "iterations", "subtotal", "totals"]);
    assert.equal(observed.coverage, "partial");
    assert.equal(observed.iterations, iterations);
    assert.equal(observed.totals, null);
    const subtotal = receiptRecord(observed.subtotal);
    assert.deepEqual(Object.keys(subtotal).sort(), ["inputTokens", "outputTokens", "totalCost"]);
    assert.equal(subtotal.inputTokens, inputTokens);
    assert.equal(subtotal.outputTokens, outputTokens);
    assert.ok(typeof subtotal.totalCost === "number");
    assert.ok(Math.abs(subtotal.totalCost - (inputTokens + 2 * outputTokens) / 1_000_000) < 1e-12);
    const result = sessionResult(outcome.text, SESSION_ID, outcome.failed);
    assert.equal(result.isError === true, failed);
    assert.deepEqual(result.structuredContent, { answer: outcome.text, session_id: SESSION_ID });
    assert.deepEqual(result.content, [{ type: "text", text: outcome.text }]);
}
describe("real Legacy terminal accounting at the MCP receiving boundary", () => {
    for (const childError of [false, true]) {
        it(`preserves ${childError ? "partial" : "complete"} child usage through three genuinely empty root replies`, async () => {
            const local = await terminalReceiptFixture([
                { text: '```repl\nchild = llm_query("local child prompt")\n```', inputTokens: 11, outputTokens: 7 },
                childError ? "error" : { text: "known child answer", inputTokens: 11, outputTokens: 7 },
                { text: "", inputTokens: 11, outputTokens: 0, finish: "stop" },
                { text: "", inputTokens: 11, outputTokens: 0, finish: "stop" },
                { text: "", inputTokens: 11, outputTokens: 0, finish: "stop" },
            ]);
            try {
                const outcome = await runTurn(new LegacyMikroBackend(), undefined, local.config, "receipt-fixture", "Run the bounded child experiment", SESSION_ID, undefined, local.root, undefined, 5);
                assert.equal(local.requests, 5, "one child and four root calls, no forced completion outside the cap");
                assert.match(outcome.answer, /3 consecutive empty LLM responses/);
                assert.equal(outcome.failed, true);
                const result = sessionResult(outcome.text, SESSION_ID, outcome.failed);
                assert.equal(result.isError, true);
                assert.deepEqual(result.structuredContent, { answer: outcome.text, session_id: SESSION_ID });
                assert.deepEqual(result.content, [{ type: "text", text: outcome.text }]);
                // Execute the unchanged receiving host parser, not this harness's footer regex.
                const parser = fileURLToPath(new URL("../../../scripts/mikro/call.ts", import.meta.url));
                const program = `import { parseFooter } from ${JSON.stringify(parser)}; console.log(JSON.stringify(parseFooter(Bun.argv.at(-1))));`;
                const parsed = JSON.parse(execFileSync("bun", ["--eval", program, outcome.text], {
                    encoding: "utf8", timeout: 10_000,
                }));
                if (childError) {
                    assertPartialReceipt(outcome, 44, 7, 4);
                    assert.equal(parsed, null, "unknown child totals must not be accepted as a complete bill");
                }
                else {
                    assert.doesNotMatch(outcome.text, /usage coverage: partial|observed_usage/);
                    const footer = receiptRecord(parsed);
                    assert.equal(footer.iterations, 4);
                    assert.equal(footer.tokensIn, 55);
                    assert.equal(footer.tokensOut, 14);
                    assert.equal(footer.cost, 0.0001);
                    assert.equal(footer.budgetHit, "empty_responses");
                    assert.equal(footer.sessionId, SESSION_ID);
                }
            }
            finally {
                await local.close();
            }
        });
    }
    for (const batched of [false, true]) {
        for (const finish of ["stop", "length", "error"]) {
            it(`keeps ${batched ? "batched" : "single"} child ${finish} on the real Python/RLM/MCP failure channel`, async () => {
                const call = batched ? 'llm_query_batched(["first", "second"])' : 'llm_query("child prompt")';
                const code = `\`\`\`repl\nimport json\nchild = ${call}\nreceipt = json.dumps({"answer": ${batched ? '" | ".join(child)' : "child"}})\n\`\`\`\nFINAL(receipt)`;
                const childPacket = finish === "error" ? "error" : {
                    text: "child answer", inputTokens: 11, outputTokens: 7, finish,
                };
                const local = await terminalReceiptFixture([
                    { text: code, inputTokens: 11, outputTokens: 7 },
                    ...(batched ? [{ text: "child answer", inputTokens: 11, outputTokens: 7 }] : []),
                    childPacket,
                ]);
                try {
                    const config = {
                        ...local.config,
                        output: { schema: {
                                type: "object", required: ["answer"],
                                properties: { answer: { type: "string" } }, additionalProperties: false,
                            } },
                    };
                    const outcome = await runTurn(new LegacyMikroBackend(), undefined, config, "receipt-fixture", "Return the child answer", SESSION_ID, undefined, local.root, undefined, 1);
                    assert.equal(local.requests, batched ? 3 : 2, "no extra completion beyond the one root turn");
                    const result = sessionResult(outcome.text, SESSION_ID, outcome.failed);
                    assert.equal(outcome.failed, finish !== "stop");
                    assert.equal(result.isError === true, finish !== "stop");
                    assert.deepEqual(result.structuredContent, { answer: outcome.text, session_id: SESSION_ID });
                    if (finish === "stop") {
                        assert.deepEqual(JSON.parse(outcome.answer), {
                            answer: batched ? "child answer | child answer" : "child answer",
                        });
                        assert.match(outcome.text, batched ? / · 1 iteration · 33 in \/ 21 out · / : / · 1 iteration · 22 in \/ 14 out · /);
                    }
                    else {
                        assert.doesNotMatch(outcome.answer, /^\s*\{"answer":/);
                        const observedCalls = 1 + Number(batched) + Number(finish !== "error");
                        assertPartialReceipt(outcome, 11 * observedCalls, 7 * observedCalls, 1);
                    }
                }
                finally {
                    await local.close();
                }
            });
        }
    }
    for (const position of ["before", "caught", "text", "remaining"]) {
        it(`rejects a ${position} FINAL from the same execution/turn as a failed child`, async () => {
            const final = 'FINAL(json.dumps({"answer": "not a successful child"}))';
            const code = position === "before"
                ? `import json\n${final}\nllm_query("child")`
                : position === "caught"
                    ? `import json\ntry:\n    llm_query("child")\nexcept RuntimeError as error:\n    ${final}`
                    : 'llm_query("child")';
            const laterFinal = position === "text"
                ? '\nFINAL({"answer":"not a successful child"})'
                : position === "remaining" ? `\n\`\`\`repl\nimport json\n${final}\n\`\`\`` : "";
            const local = await terminalReceiptFixture([
                { text: `\`\`\`repl\n${code}\n\`\`\`${laterFinal}`,
                    inputTokens: 11, outputTokens: 7 },
                { text: "truncated child", inputTokens: 11, outputTokens: 7, finish: "length" },
            ]);
            try {
                const outcome = await runTurn(new LegacyMikroBackend(), undefined, local.config, "receipt-fixture", "Return a final", SESSION_ID, undefined, local.root, undefined, 1);
                assert.equal(local.requests, 2);
                assert.doesNotMatch(outcome.answer, /not a successful child/);
                assertPartialReceipt(outcome, 22, 14, 1);
            }
            finally {
                await local.close();
            }
        });
    }
    for (const finish of ["length", "error"]) {
        it(`allows repair of child ${finish} only on the next existing root turn`, async () => {
            const local = await terminalReceiptFixture([
                { text: '```repl\nchild = llm_query("child")\nFINAL(child)\n```', inputTokens: 11, outputTokens: 7 },
                finish === "error" ? "error" : { text: "truncated child", inputTokens: 11, outputTokens: 7, finish },
                { text: 'FINAL({"answer":"repaired"})', inputTokens: 11, outputTokens: 7 },
            ]);
            try {
                const config = {
                    ...local.config,
                    output: { schema: {
                            type: "object", required: ["answer"],
                            properties: { answer: { type: "string" } }, additionalProperties: false,
                        } },
                };
                const outcome = await runTurn(new LegacyMikroBackend(), undefined, config, "receipt-fixture", "Repair when needed", SESSION_ID, undefined, local.root, undefined, 2);
                assert.equal(local.requests, 3);
                assert.equal(outcome.answer, '{"answer":"repaired"}');
                assertPartialReceipt(outcome, finish === "length" ? 33 : 22, finish === "length" ? 21 : 14, 2, false);
            }
            finally {
                await local.close();
            }
        });
    }
    it("cancels a dispatched child without returning an ordinary child value or another completion", async () => {
        const local = await terminalReceiptFixture([
            { text: '```repl\nchild = llm_query("child")\nFINAL(child)\n```', inputTokens: 11, outputTokens: 7 },
            "cancel",
        ]);
        try {
            const outcome = await runTurn(new LegacyMikroBackend(), undefined, local.config, "receipt-fixture", "Cancel the child", SESSION_ID, undefined, local.root, undefined, 2, local.controller.signal);
            assert.equal(local.requests, 2);
            assert.equal(outcome.answer, TIMEOUT_ANSWER);
            assertPartialReceipt(outcome, 11, 7, 1);
        }
        finally {
            await local.close();
        }
    });
    it("preserves prior and failed provider receipts cumulatively exactly once", async () => {
        const local = await terminalReceiptFixture([
            { text: "```repl\nprint('continue')\n```", inputTokens: 11, outputTokens: 7 },
            { text: "", inputTokens: 13, outputTokens: 5, finish: "length" },
        ]);
        try {
            const outcome = await runTurn(new LegacyMikroBackend(), undefined, local.config, "receipt-fixture", "Continue then stop", SESSION_ID, undefined, local.root, undefined, 3, local.controller.signal);
            assert.equal(local.requests, 2, "no recovery model call after the failed packet");
            assert.match(outcome.answer, /LLM stopped with reason "length"/);
            assertPartialReceipt(outcome, 24, 12, 2);
        }
        finally {
            await local.close();
        }
    });
    it("keeps cancellation's exact answer and exposes only the observed prior subtotal", async () => {
        const local = await terminalReceiptFixture([
            { text: "```repl\nprint('continue')\n```", inputTokens: 11, outputTokens: 7 },
            "cancel",
        ]);
        try {
            const outcome = await runTurn(new LegacyMikroBackend(), undefined, local.config, "receipt-fixture", "Cancel during the second provider request", SESSION_ID, undefined, local.root, undefined, 3, local.controller.signal);
            assert.equal(local.requests, 2);
            assert.equal(outcome.answer, TIMEOUT_ANSWER);
            assert.equal(splitText(outcome.text).answer, TIMEOUT_ANSWER);
            assertPartialReceipt(outcome, 11, 7, 2);
        }
        finally {
            await local.close();
        }
    });
    for (const dispatched of [false, true]) {
        it(`does not invent a receipt when cancellation has no observations (${dispatched ? "dispatched" : "pre-aborted"})`, async () => {
            const local = await terminalReceiptFixture(dispatched ? ["cancel"] : []);
            try {
                if (!dispatched)
                    local.controller.abort(new Error("cancel before any observed provider operation"));
                const outcome = await runTurn(new LegacyMikroBackend(), undefined, local.config, "receipt-fixture", "Cancel without a reported receipt", SESSION_ID, undefined, local.root, undefined, 3, local.controller.signal);
                assert.equal(local.requests, dispatched ? 1 : 0);
                assert.equal(outcome.answer, TIMEOUT_ANSWER);
                assert.equal(outcome.text, TIMEOUT_ANSWER, "no fabricated zero-price or partial footer");
                assert.equal(outcome.failed, true);
                const result = sessionResult(outcome.text, SESSION_ID, outcome.failed);
                assert.equal(result.isError, true);
                assert.deepEqual(result.structuredContent, { answer: TIMEOUT_ANSWER, session_id: SESSION_ID });
                assert.deepEqual(result.content, [{ type: "text", text: TIMEOUT_ANSWER }]);
            }
            finally {
                await local.close();
            }
        });
    }
    for (const declaration of ["output", "VALIDATE"]) {
        it(`classifies an actual ${declaration} schema-invalid final as an error without replacing its answer`, async () => {
            const local = await terminalReceiptFixture([
                { text: 'FINAL({"wrong":true})', inputTokens: 11, outputTokens: 7 },
            ]);
            try {
                const schema = {
                    type: "object",
                    required: ["wanted"],
                    properties: { wanted: { type: "boolean" } },
                    additionalProperties: false,
                };
                const parsed = parseValidateMd(`\`\`\`json\n${JSON.stringify(schema)}\n\`\`\``);
                assert.ok(parsed.schema && parsed.rawBlock !== null);
                const config = declaration === "output"
                    ? { ...local.config, output: { schema } }
                    : { ...local.config, validate: { schema: parsed.schema, rawBlock: parsed.rawBlock } };
                const outcome = await runTurn(new LegacyMikroBackend(), undefined, config, "receipt-fixture", "Return a structured final", SESSION_ID, undefined, local.root, undefined, 1);
                assert.equal(local.requests, 1, "classification must not request another final");
                assert.equal(outcome.answer, '{"wrong":true}');
                const { answer, footer } = splitText(outcome.text);
                assert.equal(answer, outcome.answer);
                assert.match(footer, / · 1 iteration · 11 in \/ 7 out · /);
                assert.match(footer, / · validation_failed: true · session /);
                assert.equal(outcome.failed, true);
                const result = sessionResult(outcome.text, SESSION_ID, outcome.failed);
                assert.equal(result.isError, true);
                assert.deepEqual(result.structuredContent, { answer: outcome.text, session_id: SESSION_ID });
                assert.deepEqual(result.content, [{ type: "text", text: outcome.text }]);
            }
            finally {
                await local.close();
            }
        });
    }
    it("keeps a schema-conforming real final successful with its complete receipt", async () => {
        const local = await terminalReceiptFixture([
            { text: 'FINAL({"wanted":true})', inputTokens: 11, outputTokens: 7 },
        ]);
        try {
            const config = {
                ...local.config,
                output: {
                    schema: {
                        type: "object", required: ["wanted"],
                        properties: { wanted: { type: "boolean" } }, additionalProperties: false,
                    },
                },
            };
            const outcome = await runTurn(new LegacyMikroBackend(), undefined, config, "receipt-fixture", "Return a valid final", SESSION_ID, undefined, local.root, undefined, 1);
            assert.equal(local.requests, 1);
            assert.equal(outcome.answer, '{"wanted":true}');
            assert.equal(outcome.failed, false);
            assert.doesNotMatch(outcome.text, /validation_failed|usage coverage: partial|observed_usage/);
            const footer = parseFooter(splitText(outcome.text).footer);
            assert.equal(footer.inputTokens, 11);
            assert.equal(footer.outputTokens, 7);
            assert.equal(footer.iterations, 1);
            const result = sessionResult(outcome.text, SESSION_ID, outcome.failed);
            assert.equal(result.isError, false);
            assert.deepEqual(result.structuredContent, { answer: outcome.text, session_id: SESSION_ID });
        }
        finally {
            await local.close();
        }
    });
});
//# sourceMappingURL=backend-contract.test.js.map