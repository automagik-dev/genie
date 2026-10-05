/**
 * Prime backend behavior tests — the real spawn machinery against a stub
 * `prime-agent` binary.
 *
 * Every test injects a temp executable shim via `PrimeBackendOptions.binaryPath`
 * (never by mocking child_process). The shim is env-driven: it answers the
 * `--version` pin check, records its argv, emits scripted JSONL events
 * (happy runs, ceiling-breach runs), or hangs forever with a grandchild so a
 * kill test can prove the process TREE died, not just the direct child.
 *
 * Deliberately NOT covered here: the host-visible contract (footer, isError,
 * progress sequence) — that is `tests/backend-contract.test.ts`, which drives
 * every backend through the real server pipeline. This file owns the prime
 * engine's own behavior: argv assembly, event mapping, budget enforcement,
 * and the version pin.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DEFAULT_PRIME_DEADLINE_MS, EXPECTED_PRIME_VERSION, PrimeBackend, buildPrimeChildEnv, } from "../src/mcp/backends/prime.js";
import { TIMEOUT_ANSWER } from "../src/rlm.js";
import { isFailedRun } from "../src/mcp/server.js";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// ── Stub binary ───────────────────────────────────────────────────────────
//
// One env-driven node shim per test workspace. `--version` answers the pin
// check (stderr, like the real binary). Everything else is scripted via env:
// events are JSONL lines written synchronously (writeSync — process.exit
// would truncate buffered pipe writes), then the shim either exits or hangs
// with a never-ending grandchild so kill tests can assert the whole tree died.
const SHIM_BODY = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  const v = process.env.MIKRO_STUB_VERSION ?? "0.8.1";
  if (process.env.MIKRO_STUB_VERSION_STREAM === "stdout") fs.writeSync(1, v);
  else fs.writeSync(2, v);
  process.exit(0);
}
if (process.env.MIKRO_STUB_ARGV_FILE) {
  fs.writeFileSync(process.env.MIKRO_STUB_ARGV_FILE, JSON.stringify(argv));
}
if (process.env.MIKRO_STUB_SELF_PID_FILE) {
  fs.writeFileSync(process.env.MIKRO_STUB_SELF_PID_FILE, String(process.pid));
}
if (process.env.MIKRO_STUB_STDERR_LINE) {
  fs.writeSync(2, process.env.MIKRO_STUB_STDERR_LINE + "\\n");
}
if (process.env.MIKRO_STUB_STDERR_BYTES) {
  const bytes = Number(process.env.MIKRO_STUB_STDERR_BYTES);
  setInterval(() => { fs.writeSync(2, "x".repeat(bytes)); }, 20);
}
// Hang setup FIRST: a kill can land the moment the breaching event is
// written, and the grandchild + pid file must already exist for the
// tree-kill assertion to observe them.
if (process.env.MIKRO_STUB_HANG === "1") {
  const { spawn } = require("node:child_process");
  // No detached: the grandchild stays in the shim's process group, so the
  // backend's group kill must reach it — that is the tree-kill assertion.
  // A readiness marker from the grandchild proves both real startup and that
  // the parent drained more stderr than fits in a pipe before we spawned it.
  if (process.env.MIKRO_STUB_READY_FILE) {
    for (let i = 0; i < 64; i++) fs.writeSync(2, "x".repeat(65536));
  }
  const child = spawn(process.execPath, ["-e", \`
    if (process.env.MIKRO_STUB_READY_FILE) {
      require("node:fs").writeFileSync(process.env.MIKRO_STUB_READY_FILE, String(process.pid));
    }
    setInterval(()=>{},1e3);
  \`], { stdio: "ignore" });
  if (process.env.MIKRO_STUB_CHILD_PID_FILE) {
    fs.writeFileSync(process.env.MIKRO_STUB_CHILD_PID_FILE, String(child.pid));
  }
  setInterval(() => {}, 1e3);
}
const events = JSON.parse(process.env.MIKRO_STUB_EVENTS ?? "[]");
for (const e of events) fs.writeSync(1, JSON.stringify(e) + "\\n");
if (process.env.MIKRO_STUB_HANG !== "1") {
  process.exit(Number(process.env.MIKRO_STUB_EXIT ?? "0"));
}`;
async function scratch() {
    return mkdtemp(join(tmpdir(), "mikro-prime-test-"));
}
async function makeShim(dir) {
    const path = join(dir, "prime-agent");
    await writeFile(path, `#!/usr/bin/env node${SHIM_BODY}`, "utf-8");
    await chmod(path, 0o755);
    return path;
}
/** Real-spawn test backend; only the stub receives the harness control vars. */
async function makeSpawnBackend(dir) {
    return new PrimeBackend({
        binaryPath: await makeShim(dir),
        environment: (source) => source,
    });
}
/** Set process env for the duration of `fn`, restoring exactly afterward. */
async function withEnv(vars, fn) {
    const previous = new Map();
    for (const [key, value] of Object.entries(vars)) {
        previous.set(key, process.env[key]);
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
    try {
        return await fn();
    }
    finally {
        for (const [key, value] of previous) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
}
/** Poll until `pid` is unreachable — a dead descendant is the tree-kill proof. */
async function assertDead(pid, tag) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        }
        catch (err) {
            if (err.code === "ESRCH")
                return;
            throw err;
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`${tag}: process ${pid} survived the kill`);
}
function usageOf(u) {
    return {
        input: u.input,
        output: u.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: u.input + u.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.total },
    };
}
function assistantMessage(text, u) {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: usageOf(u),
        stopReason: "stop",
    };
}
const USER_MESSAGE = { role: "user", content: [{ type: "text", text: "stub task" }], timestamp: 0 };
const SESSION = {
    type: "session",
    version: 3,
    id: "stub-session",
    timestamp: new Date(0).toISOString(),
    cwd: "/stub",
    rlmDepth: 1,
};
const USAGE = { input: 1234, output: 567, total: 0.0123 };
/** One complete prime turn: user message, assistant message, tool calls, turn_end. */
function turnEvents(finalText, u, opts = {}) {
    const events = [
        { type: "turn_start" },
        { type: "message_start", message: USER_MESSAGE },
        { type: "message_end", message: USER_MESSAGE },
        { type: "message_start", message: assistantMessage("", u) },
    ];
    if (opts.partialText !== undefined) {
        events.push({ type: "message_update", message: assistantMessage(opts.partialText, u) });
    }
    for (const tool of opts.tools ?? []) {
        events.push({ type: "tool_execution_start", toolCallId: "call_1", toolName: tool, args: {} });
        events.push({ type: "tool_execution_update", toolCallId: "call_1", toolName: tool, partialResult: {} });
        events.push({ type: "tool_execution_end", toolCallId: "call_1", toolName: tool, result: {} });
    }
    events.push({ type: "message_end", message: assistantMessage(finalText, u) }, { type: "turn_end", message: assistantMessage(finalText, u), toolResults: [] });
    return events;
}
/** Session + agent_start + turns + agent_end (with the final message list). */
function fullRun(turnLists, finalText, finalUsage) {
    const events = [SESSION, { type: "agent_start" }];
    for (const turn of turnLists)
        events.push(...turn);
    events.push({
        type: "agent_end",
        messages: [USER_MESSAGE, assistantMessage(finalText, finalUsage)],
    });
    return events;
}
const HAPPY_EVENTS = JSON.stringify(fullRun([turnEvents("The call sites are A and B.", USAGE)], "The call sites are A and B.", USAGE));
// ── Request fixtures ──────────────────────────────────────────────────────
const CONFIG = {
    // The gate model (wish decision 7, as amended): deepseek/deepseek-v4-flash,
    // prime's native deepseek provider, bare id.
    model: { provider: "deepseek", model: "deepseek-v4-flash", subCallModel: "deepseek-v4-flash" },
    budget: { maxCost: null, maxTokens: null, maxDepth: null },
    gemini: { thinkingLevel: null },
    contextConfig: {},
    tools: [],
    output: { schema: null },
};
function fakeAgent() {
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
            backend: "prime",
        },
    };
}
function requestOf(over = {}) {
    return {
        query: "Find the two call sites.",
        context: null,
        config: CONFIG,
        cwd: "/tmp/mikro-prime-test",
        ...over,
    };
}
async function runOnce(backend, over = {}) {
    const progress = [];
    const result = await backend.run(fakeAgent(), requestOf(over), (m) => progress.push(m));
    return { result, progress };
}
/** Engine seam returning a fixed raw result — for limits/argv mapping tests. */
function recordingEngine(calls) {
    return async (argv, _emit, limits) => {
        calls.push({ argv, limits });
        return {
            answer: "stub answer",
            turns: 1,
            budgetHit: null,
            usage: { inputTokens: 1, outputTokens: 2, totalCost: 0.001 },
        };
    };
}
function assertHasArgs(argv, seq, tag) {
    outer: for (let i = 0; i <= argv.length - seq.length; i += 1) {
        for (let j = 0; j < seq.length; j += 1) {
            if (argv[i + j] !== seq[j])
                continue outer;
        }
        return;
    }
    assert.fail(`${tag}: argv must contain [${seq.join(" ")}] in order, got: ${argv.join(" ")}`);
}
// ── Version pin ───────────────────────────────────────────────────────────
describe("prime backend — version pin", () => {
    it("pins every Prime surface to 0.8.1", () => {
        assert.equal(EXPECTED_PRIME_VERSION, "0.8.1");
    });
    it("accepts the pinned prime-agent version", async () => {
        const dir = await scratch();
        try {
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: HAPPY_EVENTS }, async () => {
                const { result } = await runOnce(backend);
                assert.equal(result.answer, "The call sites are A and B.");
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("accepts the version on stdout as well as stderr", async () => {
        const dir = await scratch();
        try {
            await withEnv({ MIKRO_STUB_VERSION_STREAM: "stdout" }, async () => {
                assert.ok(new PrimeBackend({ binaryPath: await makeShim(dir) }));
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("fails fast with an actionable report when the binary is a different version", async () => {
        const dir = await scratch();
        try {
            await withEnv({ MIKRO_STUB_VERSION: "0.7.3" }, async () => {
                const binaryPath = await makeShim(dir);
                assert.throws(() => new PrimeBackend({ binaryPath }), (err) => {
                    assert.ok(err instanceof Error);
                    assert.match(err.message, /not the pinned prime-agent 0\.8\.1/);
                    assert.match(err.message, /"0\.7\.3"/);
                    assert.match(err.message, /prime-agent update/);
                    return true;
                });
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("fails fast with an actionable report when the binary is absent", async () => {
        const dir = await scratch();
        try {
            assert.throws(() => new PrimeBackend({ binaryPath: join(dir, "no-such-prime-agent") }), (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /cannot run/);
                assert.match(err.message, /install prime-agent 0\.8\.1/);
                return true;
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
// ── Argv assembly ─────────────────────────────────────────────────────────
describe("prime backend — argv assembly", () => {
    it("spawns the pinned binary with the full wish argv: json -p, isolation flags, cwd, appended role", async () => {
        const dir = await scratch();
        try {
            const argvFile = join(dir, "argv.json");
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: HAPPY_EVENTS, MIKRO_STUB_ARGV_FILE: argvFile }, async () => {
                await runOnce(backend, { config: { ...CONFIG, system: "SYSTEM-ROLE-CONTENT" } });
            });
            const argv = JSON.parse(await readFile(argvFile, "utf8"));
            assertHasArgs(argv, ["--mode", "json", "-p"], "mode");
            assert.ok(argv.includes("--no-session"), "session");
            assertHasArgs(argv, ["--cwd", "/tmp/mikro-prime-test"], "cwd");
            for (const flag of ["-nc", "-ne", "-ns", "-np"]) {
                assert.ok(argv.includes(flag), `isolation flag ${flag}`);
            }
            assertHasArgs(argv, ["--provider", "deepseek", "--model", "deepseek-v4-flash"], "model");
            assert.ok(argv.includes("--append-system-prompt"), "append flag");
            assert.ok(!argv.includes("--system-prompt"), "the base prompt must never be replaced");
            assert.ok(!argv.includes("--daemon-socket"), "the daemon socket must never be touched");
            assert.ok(!argv.some((a) => a.startsWith("@")), "no context → no @file args");
            assert.equal(argv.at(-2), "--", "separator");
            assert.equal(argv.at(-1), "Find the two call sites.", "message");
            const role = argv[argv.indexOf("--append-system-prompt") + 1];
            assert.match(role, /triage/, "role names the microagent");
            assert.ok(role.includes("SYSTEM-ROLE-CONTENT"), "role carries the agent's system content");
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("maps google directly through Prime 0.8.1", async () => {
        const calls = [];
        const backend = new PrimeBackend({ engine: recordingEngine(calls) });
        await runOnce(backend, {
            config: {
                ...CONFIG,
                model: { provider: "google", model: "gemini-2.5-flash-lite", subCallModel: "gemini-2.5-flash-lite" },
            },
        });
        assertHasArgs(calls[0].argv, ["--provider", "google", "--model", "gemini-2.5-flash-lite"], "lite model");
    });
    it("passes OpenRouter model aliases through without rewriting them", async () => {
        const calls = [];
        const backend = new PrimeBackend({ engine: recordingEngine(calls) });
        await runOnce(backend, {
            config: {
                ...CONFIG,
                model: {
                    provider: "openrouter",
                    model: "~deepseek/deepseek-v4-flash-latest",
                    subCallModel: "~deepseek/deepseek-v4-flash-latest",
                },
            },
        });
        assertHasArgs(calls[0].argv, ["--provider", "openrouter", "--model", "~deepseek/deepseek-v4-flash-latest"], "OpenRouter latest alias");
    });
    it("passes only the selected provider credential and forces telemetry off", () => {
        const source = {
            HOME: "/home/test",
            PATH: "/bin",
            GEMINI_API_KEY: "gemini-test",
            OPENROUTER_API_KEY: "openrouter-test",
            ZAI_API_KEY: "zai-test",
            AWS_SECRET_ACCESS_KEY: "must-not-leak",
            PRIME_AGENT_TELEMETRY: "1",
            DO_NOT_TRACK: "0",
        };
        const google = buildPrimeChildEnv(source, "google");
        assert.equal(google.HOME, "/home/test");
        assert.equal(google.GEMINI_API_KEY, "gemini-test");
        assert.equal(google.OPENROUTER_API_KEY, undefined);
        assert.equal(google.AWS_SECRET_ACCESS_KEY, undefined);
        assert.equal(google.PRIME_AGENT_TELEMETRY, "0");
        assert.equal(google.DO_NOT_TRACK, "1");
        const openrouter = buildPrimeChildEnv(source, "openrouter");
        assert.equal(openrouter.OPENROUTER_API_KEY, "openrouter-test");
        assert.equal(openrouter.GEMINI_API_KEY, undefined);
        const zai = buildPrimeChildEnv(source, "zai");
        assert.equal(zai.ZAI_API_KEY, "zai-test");
        assert.equal(zai.OPENROUTER_API_KEY, undefined);
    });
    it("passes mikro's deepseek models through verbatim", async () => {
        const calls = [];
        const backend = new PrimeBackend({ engine: recordingEngine(calls) });
        await runOnce(backend, {
            config: {
                ...CONFIG,
                model: { provider: "deepseek", model: "deepseek-v4-flash", subCallModel: "deepseek-v4-flash" },
            },
        });
        assertHasArgs(calls[0].argv, ["--provider", "deepseek", "--model", "deepseek-v4-flash"], "deepseek model");
    });
    it("preserves Prime 0.8.1 direct and configured provider mappings", async () => {
        for (const [provider, model] of [
            ["prime-inference", "qwen/qwen3.7-flash"],
            ["openai-codex", "gpt-5.6-sol"],
            ["zai", "glm-5.2"],
            ["khal", "deepseek-v4-flash"],
        ]) {
            const calls = [];
            const backend = new PrimeBackend({ engine: recordingEngine(calls) });
            await runOnce(backend, {
                config: {
                    ...CONFIG,
                    model: { provider, model, subCallModel: model },
                },
            });
            assertHasArgs(calls[0].argv, ["--provider", provider, "--model", model], provider);
        }
    });
    it("maps the declared thinking level onto prime's --thinking", async () => {
        const calls = [];
        const backend = new PrimeBackend({ engine: recordingEngine(calls) });
        await runOnce(backend, {
            config: { ...CONFIG, gemini: { ...CONFIG.gemini, thinkingLevel: "high" } },
        });
        assertHasArgs(calls[0].argv, ["--thinking", "high"], "thinking flag");
        const calls2 = [];
        const backend2 = new PrimeBackend({ engine: recordingEngine(calls2) });
        await runOnce(backend2);
        assert.ok(!calls2[0].argv.includes("--thinking"), "no declared level → no flag");
    });
    it("appends the microagent role (system + criteria) and never replaces the base prompt", async () => {
        const calls = [];
        const backend = new PrimeBackend({ engine: recordingEngine(calls) });
        await runOnce(backend, {
            config: { ...CONFIG, system: "SYSTEM-ROLE-CONTENT", criteria: "Cite every claim." },
        });
        const argv = calls[0].argv;
        assert.ok(argv.includes("--append-system-prompt"), "append flag");
        assert.ok(!argv.includes("--system-prompt"), "no replace flag");
        const role = argv[argv.indexOf("--append-system-prompt") + 1];
        assert.match(role, /"triage"/, "role names the agent");
        assert.ok(role.includes("SYSTEM-ROLE-CONTENT"), "role carries the system content");
        assert.ok(role.includes("Cite every claim."), "role carries the criteria");
    });
    it("maps loaded list context to @file args at the caller's original paths", async () => {
        const dir = await scratch();
        try {
            const ctxDir = join(dir, "ctx");
            await mkdir(join(ctxDir, "sub"), { recursive: true });
            await writeFile(join(ctxDir, "sub", "a.md"), "AAA");
            await writeFile(join(ctxDir, "evil.md"), "EVIL");
            const context = {
                type: "list",
                content: [
                    { path: "sub/a.md", content: "AAA" },
                    { path: "../evil.md", content: "EVIL" },
                ],
                metadata: "",
            };
            const argvFile = join(dir, "argv.json");
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: HAPPY_EVENTS, MIKRO_STUB_ARGV_FILE: argvFile }, async () => {
                await runOnce(backend, { context, contextRoot: ctxDir });
            });
            const argv = JSON.parse(await readFile(argvFile, "utf8"));
            assert.ok(argv.includes(`@${join(ctxDir, "sub", "a.md")}`), "context file forwarded as one @<abs path> arg");
            assert.ok(argv.includes(`@${join(ctxDir, "evil.md")}`), "dot segments sanitized, not escaped");
            assert.ok(!argv.some((a) => a.includes("..")), "no parent traversal in @file args");
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("maps a string context (single file) to one @file arg", async () => {
        const dir = await scratch();
        try {
            const ctxFile = join(dir, "log.txt");
            await writeFile(ctxFile, "LOG");
            const context = { type: "string", content: "LOG", metadata: "" };
            const argvFile = join(dir, "argv.json");
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: HAPPY_EVENTS, MIKRO_STUB_ARGV_FILE: argvFile }, async () => {
                await runOnce(backend, { context, contextRoot: ctxFile });
            });
            const argv = JSON.parse(await readFile(argvFile, "utf8"));
            assert.ok(argv.includes(`@${ctxFile}`), "string context forwarded as one @<abs path> arg");
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
// ── Loud failures — no silent degradation ─────────────────────────────────
describe("prime backend — loud failures", () => {
    const cases = [
        {
            name: "mikro model providers prime cannot address (station)",
            over: { config: { ...CONFIG, model: { provider: "station", model: "Qwen3.6-35B-A3B-MTP-GGUF", subCallModel: "Qwen3.6-35B-A3B-MTP-GGUF" } } },
            pattern: /station\/Qwen3\.6-35B-A3B-MTP-GGUF/,
        },
        {
            name: "custom REPL tools (TOOLS.md)",
            over: { config: { ...CONFIG, tools: [{ name: "greet", code: "def greet()" }] } },
            pattern: /TOOLS\.md/,
        },
        {
            name: "budget.max_depth",
            over: { config: { ...CONFIG, budget: { maxCost: null, maxTokens: null, maxDepth: 2 } } },
            pattern: /max_depth/,
        },
        {
            name: "a structured output schema",
            over: { config: { ...CONFIG, output: { schema: { type: "object" } } } },
            pattern: /output schema/,
        },
        {
            name: "gemini feature flags",
            over: { config: { ...CONFIG, gemini: { ...CONFIG.gemini, googleSearch: true } } },
            pattern: /google-search/,
        },
        {
            name: "a dict context",
            over: { context: { type: "dict", content: { a: "b" }, metadata: "" }, contextRoot: "/tmp/x" },
            pattern: /cannot be mapped/,
        },
        {
            name: "a context without a root path",
            over: { context: { type: "list", content: [{ path: "a.md", content: "A" }], metadata: "" }, contextRoot: undefined },
            pattern: /without a root path/,
        },
    ];
    for (const c of cases) {
        it(`rejects ${c.name} instead of degrading silently`, async () => {
            const backend = new PrimeBackend({ engine: recordingEngine([]) });
            await assert.rejects(() => runOnce(backend, c.over), (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, c.pattern);
                assert.match(err.message, /backend: mikro/, "the message must name the escape hatch");
                return true;
            });
        });
    }
    it("rejects a context file that no longer exists before any spawn, instead of letting prime exit(1) on a dead @file arg", async () => {
        const dir = await scratch();
        try {
            const calls = [];
            const context = {
                type: "list",
                content: [{ path: "gone.md", content: "GONE" }],
                metadata: "",
            };
            const backend = new PrimeBackend({ engine: recordingEngine(calls) });
            await assert.rejects(() => runOnce(backend, { context, contextRoot: dir }), (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /context file/);
                assert.ok(err.message.includes(join(dir, "gone.md")), `the error must name the missing file: ${err.message}`);
                assert.match(err.message, /does not exist/);
                assert.match(err.message, /backend: mikro/, "the message must name the escape hatch");
                return true;
            });
            assert.equal(calls.length, 0, "the existence check fires before the engine is ever invoked");
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
// ── Event mapping ─────────────────────────────────────────────────────────
describe("prime backend — event mapping", () => {
    it("extracts the final answer, usage, and turn count from a single-turn run", async () => {
        const dir = await scratch();
        try {
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: HAPPY_EVENTS }, async () => {
                const { result, progress } = await runOnce(backend);
                assert.equal(result.answer, "The call sites are A and B.");
                assert.equal(result.iterations, 1);
                assert.equal(result.budgetHit, null);
                assert.equal(result.usage.inputTokens, USAGE.input);
                assert.equal(result.usage.outputTokens, USAGE.output);
                assert.ok(Math.abs(result.usage.totalCost - USAGE.total) < 1e-12);
                assert.deepEqual(progress, ["iteration 1"]);
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("sums per-message usage across turns and counts turns as iterations", async () => {
        const dir = await scratch();
        try {
            const u1 = { input: 1000, output: 100, total: 0.1 };
            const u2 = { input: 200, output: 50, total: 0.05 };
            const events = fullRun([turnEvents("first report", u1), turnEvents("final report", u2)], "final report", u2);
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: JSON.stringify(events) }, async () => {
                const { result, progress } = await runOnce(backend);
                assert.equal(result.answer, "final report");
                assert.equal(result.iterations, 2);
                assert.equal(result.usage.inputTokens, 1200);
                assert.equal(result.usage.outputTokens, 150);
                assert.ok(Math.abs(result.usage.totalCost - 0.15) < 1e-12);
                assert.deepEqual(progress, ["iteration 1", "iteration 2"]);
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("translates tool_execution events into progress notifications", async () => {
        const dir = await scratch();
        try {
            const events = fullRun([turnEvents("done", USAGE, { tools: ["ipython"], partialText: "thinking…" })], "done", USAGE);
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: JSON.stringify(events) }, async () => {
                const { progress } = await runOnce(backend);
                assert.deepEqual(progress, ["iteration 1", "tool ipython"]);
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("resolves the final answer from agent_end when no turn_end is present", async () => {
        const dir = await scratch();
        try {
            const events = [
                SESSION,
                { type: "agent_start" },
                { type: "turn_start" },
                { type: "message_start", message: USER_MESSAGE },
                { type: "message_end", message: USER_MESSAGE },
                { type: "message_start", message: assistantMessage("", USAGE) },
                { type: "message_end", message: assistantMessage("direct answer", USAGE) },
                { type: "agent_end", messages: [USER_MESSAGE, assistantMessage("direct answer", USAGE)] },
            ];
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: JSON.stringify(events) }, async () => {
                const { result } = await runOnce(backend);
                assert.equal(result.answer, "direct answer");
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("fails the run (a throw) when the child exits without agent_end", async () => {
        const dir = await scratch();
        try {
            const events = [SESSION, { type: "agent_start" }, { type: "turn_start" }];
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: JSON.stringify(events) }, async () => {
                await assert.rejects(() => runOnce(backend), (err) => {
                    assert.ok(err instanceof Error);
                    assert.match(err.message, /exited before reporting agent_end/);
                    return true;
                });
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("surfaces the child's stderr when it exits non-zero", async () => {
        const dir = await scratch();
        try {
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: JSON.stringify([SESSION]), MIKRO_STUB_EXIT: "3", MIKRO_STUB_STDERR_LINE: "stub exploded" }, async () => {
                await assert.rejects(() => runOnce(backend), (err) => {
                    assert.ok(err instanceof Error);
                    assert.match(err.message, /exited before reporting agent_end/);
                    assert.match(err.message, /stub exploded/);
                    return true;
                });
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("turns Prime 0.8.1 model errors into a failed run instead of an empty success", async () => {
        const dir = await scratch();
        try {
            const failed = {
                role: "assistant",
                content: [],
                provider: "openrouter",
                model: "deepseek/deepseek-v4-flash",
                stopReason: "error",
                errorMessage: "401 Missing Authentication header",
                usage: usageOf({ input: 0, output: 0, total: 0 }),
            };
            const events = JSON.stringify([
                SESSION,
                { type: "agent_start" },
                { type: "turn_start" },
                { type: "message_end", message: failed },
                { type: "turn_end", message: failed, toolResults: [] },
                { type: "agent_end", messages: [USER_MESSAGE, failed] },
            ]);
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: events }, async () => {
                await assert.rejects(() => runOnce(backend), /model run failed \(openrouter\/deepseek\/deepseek-v4-flash\): 401 Missing Authentication header/);
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("rejects agent_end without final text instead of reporting a false success", async () => {
        const dir = await scratch();
        try {
            const empty = assistantMessage("", USAGE);
            const events = JSON.stringify([
                SESSION,
                { type: "agent_start" },
                { type: "turn_start" },
                { type: "message_end", message: empty },
                { type: "turn_end", message: empty, toolResults: [] },
                { type: "agent_end", messages: [USER_MESSAGE, empty] },
            ]);
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: events }, async () => {
                await assert.rejects(() => runOnce(backend), /without a final text answer/);
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
// ── Budget enforcement ────────────────────────────────────────────────────
describe("prime backend — budget enforcement", () => {
    it("kills the tree on a cost-ceiling breach and returns a non-throwing result with budgetHit", async () => {
        const dir = await scratch();
        try {
            const selfPidFile = join(dir, "self.pid");
            const childPidFile = join(dir, "child.pid");
            const events = [
                SESSION,
                { type: "agent_start" },
                ...turnEvents("first part", { input: 10, output: 10, total: 0.5 }),
                { type: "turn_start" },
                { type: "message_start", message: assistantMessage("", { input: 10, output: 10, total: 1.0 }) },
                { type: "message_update", message: assistantMessage("partial report", { input: 10, output: 10, total: 1.0 }) },
                { type: "message_end", message: assistantMessage("partial report", { input: 10, output: 10, total: 1.0 }) },
            ];
            const backend = await makeSpawnBackend(dir);
            await withEnv({
                MIKRO_STUB_EVENTS: JSON.stringify(events),
                MIKRO_STUB_HANG: "1",
                MIKRO_STUB_SELF_PID_FILE: selfPidFile,
                MIKRO_STUB_CHILD_PID_FILE: childPidFile,
            }, async () => {
                const { result } = await runOnce(backend, {
                    config: { ...CONFIG, budget: { maxCost: 1.5, maxTokens: null, maxDepth: null } },
                });
                assert.equal(result.budgetHit, "max-cost");
                assert.equal(result.answer, "partial report");
                assert.equal(result.iterations, 1);
                assert.equal(isFailedRun(result), false, "a ceiling breach is not a failed run");
            });
            // The tree, not just the direct child: the shim's grandchild must be dead.
            await assertDead(Number(await readFile(selfPidFile, "utf8")), "shim");
            await assertDead(Number(await readFile(childPidFile, "utf8")), "shim grandchild");
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("kills the tree on a token-ceiling breach (input+output, like BudgetTracker)", async () => {
        const dir = await scratch();
        try {
            const childPidFile = join(dir, "child.pid");
            const events = [
                SESSION,
                { type: "agent_start" },
                ...turnEvents("big report", { input: 600, output: 400, total: 0.01 }),
            ];
            const backend = await makeSpawnBackend(dir);
            await withEnv({
                MIKRO_STUB_EVENTS: JSON.stringify(events),
                MIKRO_STUB_HANG: "1",
                MIKRO_STUB_CHILD_PID_FILE: childPidFile,
            }, async () => {
                const { result } = await runOnce(backend, {
                    config: { ...CONFIG, budget: { maxCost: null, maxTokens: 1000, maxDepth: null } },
                });
                assert.equal(result.budgetHit, "max-tokens");
                assert.equal(result.answer, "big report");
                assert.equal(isFailedRun(result), false);
            });
            await assertDead(Number(await readFile(childPidFile, "utf8")), "shim grandchild");
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("names the breach in the answer when the ceiling fires before any model text", async () => {
        const dir = await scratch();
        try {
            const events = [
                SESSION,
                { type: "agent_start" },
                ...turnEvents("", { input: 10, output: 10, total: 5.0 }),
            ];
            const backend = await makeSpawnBackend(dir);
            await withEnv({ MIKRO_STUB_EVENTS: JSON.stringify(events) }, async () => {
                const { result } = await runOnce(backend, {
                    config: { ...CONFIG, budget: { maxCost: 2.0, maxTokens: null, maxDepth: null } },
                });
                assert.equal(result.budgetHit, "max-cost");
                assert.match(result.answer, /budget hit: max-cost before the model produced any output/);
                assert.equal(isFailedRun(result), false);
            });
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("kills the tree on the wall-clock deadline and returns the verbatim timeout answer", { timeout: 15_000 }, async (t) => {
        const dir = await scratch();
        const selfPidFile = join(dir, "self.pid");
        // Capture the real timer before mocking: readiness is bounded by real time,
        // independently of the production deadline that this test advances.
        const realSetTimeout = setTimeout;
        const realClearTimeout = clearTimeout;
        const pause = () => new Promise((resolve) => realSetTimeout(resolve, 10));
        let treeStopped = false;
        try {
            const childPidFile = join(dir, "child.pid");
            const backend = await makeSpawnBackend(dir);
            await withEnv({
                MIKRO_MCP_RUN_TIMEOUT_MS: "250",
                MIKRO_STUB_READY_FILE: join(dir, "ready.pid"),
                MIKRO_STUB_EVENTS: JSON.stringify([SESSION, { type: "agent_start" }]),
                MIKRO_STUB_HANG: "1",
                MIKRO_STUB_SELF_PID_FILE: selfPidFile,
                MIKRO_STUB_CHILD_PID_FILE: childPidFile,
                // The parent must keep draining stderr — a full pipe buffer would
                // block the child and stall the kill path.
                MIKRO_STUB_STDERR_BYTES: "65536",
            }, async () => {
                t.mock.timers.enable({ apis: ["setTimeout"] });
                let settled = false;
                const run = runOnce(backend).finally(() => { settled = true; });
                // Attach rejection handling while waiting for the independent fixture.
                void run.catch(() => { });
                const readyDeadline = Date.now() + 10_000;
                let readyPid;
                while (Date.now() < readyDeadline && !settled) {
                    try {
                        readyPid = Number(await readFile(join(dir, "ready.pid"), "utf8"));
                        if (readyPid > 0)
                            break;
                    }
                    catch (err) {
                        if (err.code !== "ENOENT")
                            throw err;
                    }
                    await pause();
                }
                assert.ok(readyPid, "real process tree must start and drain 4 MiB of stderr");
                const selfPid = Number(await readFile(selfPidFile, "utf8"));
                assert.equal(readyPid, Number(await readFile(childPidFile, "utf8")));
                assert.equal(settled, false);
                t.mock.timers.tick(249);
                await pause();
                assert.equal(settled, false, "the run must survive before its deadline");
                process.kill(selfPid, 0);
                process.kill(readyPid, 0);
                t.mock.timers.tick(1);
                // Keep a broken close/kill path bounded even while timers are mocked.
                let watchdog;
                const { result } = await Promise.race([
                    run,
                    new Promise((_, reject) => {
                        watchdog = realSetTimeout(() => reject(new Error("deadline did not settle the run")), 2_000);
                    }),
                ]).finally(() => { realClearTimeout(watchdog); });
                t.mock.timers.reset();
                assert.equal(result.answer, TIMEOUT_ANSWER);
                assert.equal(result.budgetHit, null);
                assert.equal(isFailedRun(result), true, "a deadline expiry is a failed run");
            });
            await assertDead(Number(await readFile(selfPidFile, "utf8")), "shim");
            await assertDead(Number(await readFile(childPidFile, "utf8")), "shim grandchild");
            treeStopped = true;
        }
        finally {
            t.mock.timers.reset();
            if (!treeStopped) {
                // A failed readiness assertion must not leave the hanging fixture alive.
                try {
                    const pid = Number(await readFile(selfPidFile, "utf8"));
                    if (Number.isSafeInteger(pid) && pid > 0)
                        process.kill(-pid, "SIGKILL");
                }
                catch (err) {
                    if (!["ENOENT", "ESRCH"].includes(err.code ?? ""))
                        throw err;
                }
            }
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("defaults the deadline to rlmLoop's 300s and honors MIKRO_MCP_RUN_TIMEOUT_MS", async () => {
        const calls = [];
        const backend = new PrimeBackend({ engine: recordingEngine(calls) });
        await withEnv({ MIKRO_MCP_RUN_TIMEOUT_MS: undefined }, async () => {
            await runOnce(backend);
            assert.equal(calls[0].limits.deadlineMs, DEFAULT_PRIME_DEADLINE_MS);
        });
        await withEnv({ MIKRO_MCP_RUN_TIMEOUT_MS: "123456" }, async () => {
            await runOnce(backend);
            assert.equal(calls[1].limits.deadlineMs, 123456);
        });
    });
    it("kills the run when it exceeds the spec's iteration cap, keeping the last turn's answer", async () => {
        const dir = await scratch();
        try {
            const childPidFile = join(dir, "child.pid");
            const events = [
                SESSION,
                { type: "agent_start" },
                ...turnEvents("first report", USAGE),
                { type: "turn_start" }, // the second turn would start → cap of 1 fires
            ];
            const backend = await makeSpawnBackend(dir);
            await withEnv({
                MIKRO_STUB_EVENTS: JSON.stringify(events),
                MIKRO_STUB_HANG: "1",
                MIKRO_STUB_CHILD_PID_FILE: childPidFile,
            }, async () => {
                const { result } = await runOnce(backend, { maxIterations: 1 });
                assert.equal(result.budgetHit, "max-iterations");
                assert.equal(result.answer, "first report");
                assert.equal(result.iterations, 1);
                assert.equal(isFailedRun(result), false, "an iteration cap is not a failed run");
            });
            await assertDead(Number(await readFile(childPidFile, "utf8")), "shim grandchild");
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("maps budget ceilings and the iteration cap into the engine limits", async () => {
        const calls = [];
        const backend = new PrimeBackend({ engine: recordingEngine(calls) });
        await runOnce(backend, {
            config: { ...CONFIG, budget: { maxCost: 2, maxTokens: 5000, maxDepth: null } },
            maxIterations: 3,
        });
        assert.equal(calls[0].limits.maxCost, 2);
        assert.equal(calls[0].limits.maxTokens, 5000);
        assert.equal(calls[0].limits.maxTurns, 3);
        const calls2 = [];
        const backend2 = new PrimeBackend({ engine: recordingEngine(calls2) });
        await runOnce(backend2);
        assert.equal(calls2[0].limits.maxCost, null);
        assert.equal(calls2[0].limits.maxTokens, null);
        assert.equal(calls2[0].limits.maxTurns, null);
    });
});
// ── No SDK integration ────────────────────────────────────────────────────
describe("prime backend — no SDK integration", () => {
    it("imports only node builtins and relative modules, and package.json has no prime-agent dependency", async () => {
        const source = await readFile(join(REPO_ROOT, "src", "mcp", "backends", "prime.ts"), "utf8");
        for (const line of source.split("\n")) {
            const m = /^\s*import\b.*?from\s+["']([^"']+)["']/.exec(line);
            if (!m)
                continue;
            assert.ok(m[1].startsWith("node:") || m[1].startsWith("."), `prime.ts must not import a third-party module: ${m[1]}`);
        }
        const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        assert.equal(deps["prime-agent"], undefined, "no prime-agent npm dependency");
        assert.equal(deps["@earendil-works/pi-coding-agent"], undefined, "no pi-coding-agent npm dependency");
    });
});
//# sourceMappingURL=prime-backend.test.js.map