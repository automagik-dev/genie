import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.js";
import { parseCustomProviders } from "../src/custom-providers.js";
import { LLMCompletionError } from "../src/llm.js";
import { PiBackend } from "../src/mcp/backends/pi.js";
import { BackendRunError } from "../src/mcp/backend.js";
import { parseAgentSpec } from "../src/sdk/agent-spec.js";
import { parseValidateMd } from "../src/sdk/validate.js";
const runFile = promisify(execFile);
function record(value) {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return Object.fromEntries(Object.entries(value));
}
/** Actual OpenAI-compatible packets go through the installed Pi provider and agent tool loop. */
async function fixture(turns, onRequest) {
    const root = await mkdtemp(join(tmpdir(), "mikro-pi-"));
    const bodies = [];
    const server = createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req)
            text += chunk;
        bodies.push(JSON.parse(text));
        const index = bodies.length - 1;
        const turn = turns[index];
        onRequest?.(index);
        if (!turn) {
            res.writeHead(500);
            res.end("unexpected request");
            return;
        }
        if (turn.httpError) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "fixture provider refused" } }));
            return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (turn.hang) {
            res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
            return;
        }
        const delta = turn.tools ? { role: "assistant", tool_calls: turn.tools.map((tool, index) => ({ index, id: `tool-${bodies.length}-${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) } : { role: "assistant", content: turn.text ?? "not a final" };
        res.end(`data: ${JSON.stringify({ id: `fixture-${bodies.length}`, choices: [{ index: 0, delta, finish_reason: turn.finish ?? (turn.tools ? "tool_calls" : "stop") }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("fixture needs TCP address");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const keyEnv = "MIKRO_PI_FIXTURE_KEY";
    const previousKey = process.env[keyEnv];
    process.env[keyEnv] = "fixture-only-key";
    const base = await loadConfig(root);
    const config = {
        ...base, system: "Explicit test role", criteria: null, tools: [], validate: null,
        output: { schema: null }, budget: { maxCost: null, maxTokens: null, maxDepth: null },
        gemini: { ...base.gemini, thinkingLevel: null },
        model: { provider: "pi-fixture", model: "control", providers: parseCustomProviders({ "pi-fixture": { "base-url": baseUrl, "api-key-env": keyEnv, models: { control: { cost: { input: 1, output: 2 } } } } }, "test fixture") },
    };
    return {
        root, config, bodies, baseUrl, keyEnv,
        request(overrides = {}) { return { cwd: root, query: "Answer from scoped files", context: null, config, maxRetries: 0, ...overrides }; },
        agent(yaml = "engine: pi\nshape: loop\n") { return { name: "fixture", toolName: "mikro_fixture", dir: root, summary: "fixture", spec: parseAgentSpec(yaml, root) }; },
        async close() {
            if (previousKey === undefined)
                delete process.env[keyEnv];
            else
                process.env[keyEnv] = previousKey;
            server.closeAllConnections();
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await rm(root, { recursive: true, force: true });
        },
    };
}
const final = (answer) => ({ name: "emit_done", args: { answer } });
describe("Pi SDK backend consumer behavior", () => {
    it("reads with actual scoped tools, accepts only the first final, stops after a mixed batch, and loads no ambient instructions/extensions", async () => {
        const local = await fixture([
            { tools: [{ name: "read", args: { path: "evidence.txt" } }, { name: "bash", args: { command: "touch shell-ran" } }, { name: "write", args: { path: "mutation.txt", content: "must not write" } }] },
            { tools: [{ name: "read", args: { path: "evidence.txt" } }, final("accepted"), final("replacement must not win")] },
        ]);
        try {
            await writeFile(join(local.root, "evidence.txt"), "source evidence\n");
            await writeFile(join(local.root, "AGENTS.md"), "AMBIENT-INSTRUCTION-CANARY");
            await mkdir(join(local.root, ".pi", "extensions"), { recursive: true });
            const marker = join(local.root, "ambient-ran");
            await writeFile(join(local.root, ".pi", "extensions", "hostile.js"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
            const progress = [];
            const result = await new PiBackend().run(local.agent(), local.request(), (message) => progress.push(message));
            assert.equal(result.answer, "accepted");
            assert.equal(result.iterations, 2);
            assert.equal(local.bodies.length, 2, "no hidden completion after final");
            assert.equal(result.usage.inputTokens, 22);
            assert.equal(result.usage.outputTokens, 14);
            assert.ok(Math.abs(result.usage.totalCost - 0.00005) < 1e-12);
            assert.ok(progress.includes("iteration 2") && progress.includes("tool read"));
            assert.match(JSON.stringify(local.bodies[1]), /source evidence/);
            assert.doesNotMatch(JSON.stringify(local.bodies), /AMBIENT-INSTRUCTION-CANARY/);
            await assert.rejects(access(marker), /ENOENT/);
            await assert.rejects(access(join(local.root, "shell-ran")), /ENOENT/);
            await assert.rejects(access(join(local.root, "mutation.txt")), /ENOENT/);
            const tools = record(local.bodies[0]).tools;
            assert.ok(Array.isArray(tools));
            assert.deepEqual(tools.map((tool) => record(record(tool).function).name).sort(), ["emit_done", "git", "glob", "grep", "read"]);
        }
        finally {
            await local.close();
        }
    });
    it("uses output schema precedence while enforcing the independent VALIDATE schema in the remaining normal turn", async () => {
        const local = await fixture([{ tools: [final("ok")] }, { tools: [{ name: "emit_done", args: { answer: "ok", citation: 1 } }] }]);
        try {
            const parsed = parseValidateMd('```json\n{"type":"object","properties":{"citation":{"type":"integer"}},"required":["citation"]}\n```');
            assert.ok(parsed.schema && parsed.rawBlock !== null);
            const config = { ...local.config, output: { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }, validate: { schema: parsed.schema, rawBlock: parsed.rawBlock } };
            const result = await new PiBackend().run(local.agent(), local.request({ config, maxIterations: 2 }), () => { });
            assert.equal(result.answer, '```json\n{\n  "answer": "ok",\n  "citation": 1\n}\n```');
            assert.match(JSON.stringify(local.bodies[1]), /missing required/);
            assert.equal(local.bodies.length, 2);
        }
        finally {
            await local.close();
        }
    });
    it("enforces VALIDATE-only contracts and rejects contradictory schema declarations before a request", async () => {
        const local = await fixture([{ tools: [{ name: "emit_done", args: { owner: "team" } }] }]);
        try {
            const parsed = parseValidateMd('```json\n{"type":"object","properties":{"owner":{"type":"string"}},"required":["owner"]}\n```');
            assert.ok(parsed.schema && parsed.rawBlock !== null);
            const validate = { schema: parsed.schema, rawBlock: parsed.rawBlock };
            const result = await new PiBackend().run(local.agent(), local.request({ config: { ...local.config, validate } }), () => { });
            assert.match(result.answer, /"owner": "team"/);
            await assert.rejects(new PiBackend().run(local.agent(), local.request({ config: { ...local.config, validate, output: { schema: { type: "object", properties: { owner: { type: "integer" } }, required: ["owner"] } } } }), () => { }), /schemas conflict/);
            assert.equal(local.bodies.length, 1);
        }
        finally {
            await local.close();
        }
    });
    for (const turn of [{ text: "A plausible paragraph must not become a final" }, { tools: [{ name: "emit_done", args: { answer: 42 } }] }]) {
        it(`fails meaningfully for ${turn.tools ? "invalid final arguments" : "absent final"} rather than copying prose`, async () => {
            const local = await fixture([turn]);
            try {
                await assert.rejects(new PiBackend().run(local.agent(), local.request({ maxIterations: 1 }), () => { }), turn.tools ? /no accepted emit_done final.*invalid emit_done/ : /no accepted emit_done final/);
                assert.equal(local.bodies.length, 1);
            }
            finally {
                await local.close();
            }
        });
    }
    for (const ceiling of ["maxCost", "maxTokens"]) {
        it(`rejects an already exhausted ${ceiling} budget before provider work`, async () => {
            const local = await fixture([{ tools: [final("must not be billed")] }]);
            try {
                const config = {
                    ...local.config,
                    budget: { ...local.config.budget, [ceiling]: 0 },
                };
                await assert.rejects(new PiBackend().run(local.agent(), local.request({ config }), () => { }));
                assert.equal(local.bodies.length, 0, "an exhausted budget cannot authorize the first model request");
            }
            finally {
                await local.close();
            }
        });
    }
    it("rejects a truncated final and preserves billed provider failure usage once", async () => {
        const local = await fixture([{ tools: [{ name: "read", args: { path: "evidence.txt" } }] }, { tools: [final("truncated")], finish: "length" }]);
        try {
            await writeFile(join(local.root, "evidence.txt"), "evidence");
            await assert.rejects(new PiBackend().run(local.agent(), local.request(), () => { }), (error) => {
                assert.ok(error instanceof BackendRunError);
                assert.ok(error.cause instanceof LLMCompletionError);
                assert.equal(error.cause.stopReason, "length");
                assert.equal(error.receipt?.usage.inputTokens, 22);
                assert.equal(error.receipt?.usage.outputTokens, 14);
                assert.equal(error.receipt?.iterations, 2);
                return true;
            });
            assert.equal(local.bodies.length, 2);
        }
        finally {
            await local.close();
        }
    });
    it("preserves prior billed usage on an unreported HTTP failure without agent-level retries", async () => {
        const local = await fixture([{ tools: [{ name: "glob", args: { pattern: "*.txt" } }] }, { httpError: true }]);
        try {
            await assert.rejects(new PiBackend().run(local.agent(), local.request(), () => { }), (error) => {
                assert.ok(error instanceof BackendRunError);
                assert.ok(error.cause instanceof LLMCompletionError);
                assert.equal(error.cause.stopReason, "error");
                assert.equal(error.receipt?.usage.inputTokens, 11);
                assert.equal(error.receipt?.usageComplete, false);
                return true;
            });
            assert.equal(local.bodies.length, 2);
        }
        finally {
            await local.close();
        }
    });
    for (const budget of ["max-iterations", "max-tokens", "max-cost"]) {
        it(`stops after the response that reaches ${budget} with no out-of-budget finalization`, async () => {
            const local = await fixture([{ tools: [{ name: "glob", args: { pattern: "*.txt" } }] }]);
            try {
                const config = { ...local.config, budget: { maxCost: budget === "max-cost" ? 0.000001 : null, maxTokens: budget === "max-tokens" ? 18 : null, maxDepth: null } };
                await assert.rejects(new PiBackend().run(local.agent(), local.request({ config, maxIterations: budget === "max-iterations" ? 1 : 4 }), () => { }), new RegExp(budget));
                assert.equal(local.bodies.length, 1);
            }
            finally {
                await local.close();
            }
        });
    }
    it("cancels an in-flight real SDK request, retains prior usage, and settles without another request", async () => {
        const abort = new AbortController();
        const local = await fixture([{ tools: [{ name: "glob", args: { pattern: "*.txt" } }] }, { hang: true }], (index) => { if (index === 1)
            queueMicrotask(() => abort.abort()); });
        try {
            await assert.rejects(new PiBackend().run(local.agent(), local.request({ signal: abort.signal }), () => { }), (error) => {
                assert.ok(error instanceof BackendRunError);
                assert.ok(error.cause instanceof LLMCompletionError);
                assert.equal(error.cause.stopReason, "aborted");
                assert.equal(error.receipt?.usage.inputTokens, 11);
                return true;
            });
            assert.equal(local.bodies.length, 2);
        }
        finally {
            await local.close();
        }
    });
    it("expires a genuinely blocked provider request on the platform deadline and disposes the session", async () => {
        // A real timer is intentional here: this integration case owns the wall-clock
        // AbortController/HTTP boundary, not a scheduler unit with a guessed sleep.
        const local = await fixture([{ hang: true }]);
        const previous = process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
        process.env.MIKRO_MCP_RUN_TIMEOUT_MS = "25";
        try {
            await assert.rejects(new PiBackend().run(local.agent(), local.request(), () => { }), (error) => {
                assert.ok(error instanceof BackendRunError);
                assert.ok(error.cause instanceof LLMCompletionError);
                assert.equal(error.cause.stopReason, "aborted");
                assert.match(error.message, /deadline exceeded/);
                return true;
            });
            assert.ok(local.bodies.length <= 1, "deadline must not schedule a retry or recovery turn");
        }
        finally {
            if (previous === undefined)
                delete process.env.MIKRO_MCP_RUN_TIMEOUT_MS;
            else
                process.env.MIKRO_MCP_RUN_TIMEOUT_MS = previous;
            await local.close();
        }
    });
    it("denies incompatible plugins, write scopes and malformed read scopes before inference", async () => {
        const local = await fixture([]);
        try {
            for (const yaml of ["engine: pi\ntools: [shell_plugin]", "engine: pi\nscope:\n  writes: [src/**]"]) {
                await assert.rejects(new PiBackend().run(local.agent(yaml), local.request(), () => { }), /cannot load|read-only/);
            }
            assert.throws(() => local.agent("engine: pi\nscope:\n  reads: false"), /scope.reads/);
            await assert.rejects(new PiBackend().run(local.agent(), local.request({ config: { ...local.config, gemini: { ...local.config.gemini, codeExecution: true } } }), () => { }), /provider-hosted tools/);
            assert.equal(local.bodies.length, 0);
        }
        finally {
            await local.close();
        }
    });
});
describe("Pi pricing and compatible model pins", () => {
    it("rejects absent custom pricing before billing while accepting declared free pricing and a date-suffixed pin", async () => {
        const local = await fixture([{ tools: [final("declared free")] }]);
        try {
            const providers = parseCustomProviders({
                "pi-fixture": { "base-url": local.baseUrl, "api-key-env": local.keyEnv, models: {
                        unknown: {}, empty: { cost: {} }, inputOnly: { cost: { input: 1 } }, outputOnly: { cost: { output: 1 } },
                        free: { cost: { input: 0, output: 0, "cache-read": 0, "cache-write": 0 } },
                    } },
            }, "pricing fixture");
            const config = { ...local.config, budget: { ...local.config.budget, maxCost: 0.3 }, model: { ...local.config.model, providers, model: "unknown" } };
            for (const model of ["unknown", "empty", "inputOnly", "outputOnly"]) {
                await assert.rejects(new PiBackend().run(local.agent(), local.request({
                    config: { ...config, model: { ...config.model, model } },
                }), () => { }), /requires declared pricing.*unknown, not free/);
                assert.equal(local.bodies.length, 0, "an absent charged rate cannot authorize a priced request");
            }
            const result = await new PiBackend().run(local.agent(), local.request({
                config: { ...config, model: { ...config.model, model: "free-20261005" } },
            }), () => { });
            assert.equal(result.answer, "declared free");
            assert.equal(result.usage.totalCost, 0);
            assert.equal(result.usage.inputTokens, 11);
            assert.equal(local.bodies.length, 1);
            assert.equal(record(local.bodies[0]).model, "free", "shared compatibility resolution selects the catalog wire id");
        }
        finally {
            await local.close();
        }
    });
});
describe("Pi scoped filesystem and git at the real SDK boundary", () => {
    it("denies root/symlink/secret/narrow-scope escapes in read and excludes them from glob/grep", async () => {
        const outside = await mkdtemp(join(tmpdir(), "mikro-pi-outside-"));
        const local = await fixture([
            { tools: [{ name: "read", args: { path: join(outside, "leak.txt") } }, { name: "read", args: { path: "allowed/leak.txt" } }, { name: "read", args: { path: ".env" } }, { name: "read", args: { path: "other.txt" } }] },
            { tools: [{ name: "glob", args: { pattern: "**/*.txt" } }, { name: "grep", args: { text: "CANARY" } }] },
            { tools: [final("scope checks complete")] },
        ]);
        try {
            await mkdir(join(local.root, "allowed"));
            await writeFile(join(outside, "leak.txt"), "EXTERNAL-SECRET-CANARY");
            await symlink(join(outside, "leak.txt"), join(local.root, "allowed", "leak.txt"));
            await writeFile(join(local.root, ".env"), "ENV-SECRET-CANARY");
            await writeFile(join(local.root, "other.txt"), "NARROW-SCOPE-CANARY");
            await writeFile(join(local.root, "allowed", "ok.txt"), "SAFE-CANARY");
            await new PiBackend().run(local.agent("engine: pi\nshape: loop\nscope:\n  reads: [allowed/**]"), local.request(), () => { });
            const toolFeedback = JSON.stringify(record(local.bodies[2]).messages);
            assert.match(toolFeedback, /scope denied/);
            assert.match(toolFeedback, /SAFE-CANARY/);
            assert.doesNotMatch(toolFeedback, /EXTERNAL-SECRET-CANARY|ENV-SECRET-CANARY|NARROW-SCOPE-CANARY/);
            assert.match(toolFeedback, /allowed\/ok.txt/);
        }
        finally {
            await local.close();
            await rm(outside, { recursive: true, force: true });
        }
    });
    it("permits an explicitly supplied context root but never treats its escaped symlink as authorized", async () => {
        const context = await mkdtemp(join(tmpdir(), "mikro-pi-context-"));
        const external = await mkdtemp(join(tmpdir(), "mikro-pi-external-"));
        const local = await fixture([{ tools: [{ name: "read", args: { path: join(context, "ok.txt") } }, { name: "read", args: { path: join(context, "escape.txt") } }] }, { tools: [final("context complete")] }]);
        try {
            await writeFile(join(context, "ok.txt"), "AUTHORIZED-CONTEXT");
            await writeFile(join(external, "secret.txt"), "EXTERNAL-CONTEXT-CANARY");
            await symlink(join(external, "secret.txt"), join(context, "escape.txt"));
            await new PiBackend().run(local.agent(), local.request({ contextRoot: context }), () => { });
            const feedback = JSON.stringify(record(local.bodies[1]).messages);
            assert.match(feedback, /AUTHORIZED-CONTEXT/);
            assert.match(feedback, /scope denied/);
            assert.doesNotMatch(feedback, /EXTERNAL-CONTEXT-CANARY/);
        }
        finally {
            await local.close();
            await rm(context, { recursive: true, force: true });
            await rm(external, { recursive: true, force: true });
        }
    });
    it("disables repository diff/textconv/clean/process/fsmonitor/pager/hooks and ignores injected config env while denying mutation and directory pathspecs", async () => {
        const local = await fixture([
            { tools: ["status", "log", "show", "diff", "ls-files"].map((operation) => ({ name: "git", args: { operation, paths: ["safe.txt"] } })) },
            { tools: [{ name: "git", args: { operation: "reset", paths: ["safe.txt"] } }, { name: "git", args: { operation: "diff", paths: ["."] } }] },
            { tools: [final("git complete")] },
        ]);
        const old = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0, external: process.env.GIT_EXTERNAL_DIFF };
        try {
            const env = { PATH: "/usr/bin:/bin", HOME: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
            const git = async (...args) => runFile("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: local.root, env });
            await git("init");
            await writeFile(join(local.root, "safe.txt"), "before\n");
            await git("add", "safe.txt");
            await git("commit", "-m", "fixture root");
            await writeFile(join(local.root, "safe.txt"), "after\n");
            const marker = join(local.root, "helper-executed");
            const helper = join(local.root, "hostile-helper");
            await writeFile(helper, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
            await writeFile(join(local.root, ".gitattributes"), "*.txt diff=evil filter=evil\n");
            for (const key of ["diff.external", "diff.evil.textconv", "filter.evil.clean", "filter.evil.smudge", "filter.evil.process", "core.fsmonitor", "core.pager"])
                await git("config", key, helper);
            await git("config", "filter.evil.required", "true");
            await git("config", "core.hooksPath", local.root);
            process.env.GIT_CONFIG_COUNT = "1";
            process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
            process.env.GIT_CONFIG_VALUE_0 = helper;
            process.env.GIT_EXTERNAL_DIFF = helper;
            await new PiBackend().run(local.agent(), local.request(), () => { });
            await assert.rejects(access(marker), /ENOENT/);
            assert.equal(await readFile(join(local.root, "safe.txt"), "utf8"), "after\n");
            const feedback = JSON.stringify(record(local.bodies[2]).messages);
            assert.match(feedback, /before/);
            assert.match(feedback, /after/);
            assert.match(feedback, /individual allowed files|not in enum|Invalid arguments|validation/i);
        }
        finally {
            for (const [key, value] of Object.entries({ GIT_CONFIG_COUNT: old.count, GIT_CONFIG_KEY_0: old.key, GIT_CONFIG_VALUE_0: old.value, GIT_EXTERNAL_DIFF: old.external })) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
            await local.close();
        }
    });
    for (const credentialKind of ["provider", "standalone-juice"]) {
        it(`keeps ${credentialKind} credential paths and realpaths out of all tool feedback even when explicitly supplied as context`, async () => {
            const local = await fixture([
                { tools: [
                        { name: "read", args: { path: "project-auth.txt" } }, { name: "read", args: { path: "alias.txt" } },
                        { name: "git", args: { operation: "show", paths: ["project-auth.txt"] } },
                        { name: "git", args: { operation: "show", paths: ["alias.txt"] } },
                        { name: "glob", args: { pattern: "*.txt" } }, { name: "grep", args: { text: "CREDENTIAL-CANARY" } },
                    ] },
                { tools: [final("credential boundary checked")] },
            ]);
            try {
                await writeFile(join(local.root, "project-auth.txt"), "ARBITRARY-CREDENTIAL-CANARY");
                await symlink(join(local.root, "project-auth.txt"), join(local.root, "alias.txt"));
                const env = { PATH: "/usr/bin:/bin", HOME: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
                const git = (...args) => runFile("/usr/bin/git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: local.root, env });
                await git("init");
                await git("add", "project-auth.txt");
                await git("commit", "-m", "credential fixture");
                const providers = local.config.model.providers;
                assert.ok(providers?.[0]);
                const protectedProvider = { ...providers[0], id: "protected", apiKeyFile: join(local.root, "alias.txt") };
                const config = credentialKind === "provider"
                    ? { ...local.config, model: { ...local.config.model, providers: [...providers, protectedProvider] } }
                    : { ...local.config, juice: {
                            origin: local.baseUrl, project: "local", keyAlias: "local", keyEpoch: "fixture",
                            keyFile: join(local.root, "alias.txt"),
                        } };
                await new PiBackend().run(local.agent(), local.request({
                    config, contextRoot: join(local.root, "project-auth.txt"),
                    context: { type: "string", content: "ARBITRARY-CREDENTIAL-CANARY", metadata: "explicit file" },
                }), () => { });
                const messages = record(local.bodies[1]).messages;
                assert.ok(Array.isArray(messages));
                const feedback = JSON.stringify(messages.map(record).filter((message) => message.role === "tool"));
                assert.match(feedback, /scope denied/);
                assert.doesNotMatch(feedback, /ARBITRARY-CREDENTIAL-CANARY|project-auth\.txt|alias\.txt/);
                assert.doesNotMatch(JSON.stringify(messages), /ARBITRARY-CREDENTIAL-CANARY/);
                assert.equal(local.bodies.length, 2);
            }
            finally {
                await local.close();
            }
        });
    }
    it("reads the explicit hidden facts snapshot but denies neighboring hidden files", async () => {
        const local = await fixture([
            { tools: [
                    { name: "read", args: { path: ".mikro/runs/facts-local.md" } },
                    { name: "read", args: { path: ".mikro/runs/neighbor.md" } },
                    { name: "grep", args: { text: "FACTS" } }, { name: "glob", args: { pattern: ".mikro/runs/*.md" } },
                ] },
            { tools: [final("facts boundary checked")] },
            { tools: [{ name: "read", args: { path: ".env" } }] },
            { tools: [final("hidden basename still denied")] },
        ]);
        try {
            await mkdir(join(local.root, ".mikro", "runs"), { recursive: true });
            const contextRoot = join(local.root, ".mikro", "runs", "facts-local.md");
            await writeFile(contextRoot, "FACTS-FILE-CHANGED-AFTER-HANDOFF");
            await writeFile(join(local.root, ".mikro", "runs", "neighbor.md"), "FACTS-HIDDEN-NEIGHBOR-CANARY");
            await new PiBackend().run(local.agent(), local.request({
                contextRoot, context: { type: "string", content: "TRUSTED-FACTS-SNAPSHOT", metadata: "explicit facts" },
            }), () => { });
            const feedback = JSON.stringify(record(local.bodies[1]).messages);
            assert.match(feedback, /TRUSTED-FACTS-SNAPSHOT/);
            assert.match(feedback, /\.mikro\/runs\/facts-local\.md/);
            assert.match(feedback, /scope denied/);
            assert.doesNotMatch(feedback, /FACTS-HIDDEN-NEIGHBOR-CANARY|FACTS-FILE-CHANGED-AFTER-HANDOFF/);
            await writeFile(join(local.root, ".env"), "ENV-CREDENTIAL-CANARY");
            await new PiBackend().run(local.agent(), local.request({
                contextRoot: join(local.root, ".env"),
                context: { type: "string", content: "ENV-CREDENTIAL-CANARY", metadata: "explicit file" },
            }), () => { });
            const hiddenFeedback = JSON.stringify(record(local.bodies[3]).messages);
            assert.match(hiddenFeedback, /scope denied/);
            assert.doesNotMatch(hiddenFeedback, /ENV-CREDENTIAL-CANARY/);
        }
        finally {
            await local.close();
        }
    });
    for (const nested of [false, true]) {
        it(`pins git worktree despite core.worktree redirection from ${nested ? "a nested" : "the root"} cwd`, async () => {
            const outside = await mkdtemp(join(tmpdir(), "mikro-pi-git-outside-"));
            const local = await fixture([
                { tools: [{ name: "git", args: { operation: "diff", paths: ["safe.txt"] } }] },
                { tools: [final("git boundary checked")] },
            ]);
            try {
                const env = { PATH: "/usr/bin:/bin", HOME: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
                const git = (...args) => runFile("/usr/bin/git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: local.root, env });
                await git("init");
                const cwd = nested ? join(local.root, "authorized") : local.root;
                await mkdir(cwd, { recursive: true });
                await writeFile(join(cwd, "safe.txt"), "tracked authorized baseline\n");
                if (nested)
                    await writeFile(join(local.root, "safe.txt"), "PARENT-SCOPE-CANARY\n");
                await git("add", nested ? "authorized/safe.txt" : "safe.txt");
                await git("commit", "-m", "worktree fixture");
                await writeFile(join(cwd, "safe.txt"), "AUTHORIZED-WORKTREE-CHANGE\n");
                await mkdir(join(outside, "authorized"), { recursive: true });
                await writeFile(join(outside, "safe.txt"), "OUTSIDE-WORKTREE-CANARY\n");
                await writeFile(join(outside, "authorized", "safe.txt"), "OUTSIDE-WORKTREE-CANARY\n");
                await git("config", "core.worktree", outside);
                await new PiBackend().run(local.agent(), local.request({ cwd }), () => { });
                const feedback = JSON.stringify(record(local.bodies[1]).messages);
                assert.match(feedback, /AUTHORIZED-WORKTREE-CHANGE/);
                assert.doesNotMatch(feedback, /OUTSIDE-WORKTREE-CANARY|PARENT-SCOPE-CANARY/);
            }
            finally {
                await local.close();
                await rm(outside, { recursive: true, force: true });
            }
        });
    }
});
describe("compiled MCP engine and outward contract", () => {
    it("executes RLM default and Pi default/override/generic calls, rejects obsolete/invalid selection without billing, and preserves history, envelope, priced footer and progress", async () => {
        const local = await fixture([{ text: 'FINAL("RLM default")' }, { tools: [final("Pi first")] }, { tools: [final("Pi resumed")] }, { tools: [final("Override accepted")] }, { tools: [final("Generic Pi")] }]);
        let client;
        let transport;
        try {
            const agents = join(local.root, "agents");
            await mkdir(join(agents, "pi"), { recursive: true });
            await mkdir(join(agents, "override"), { recursive: true });
            await mkdir(join(local.root, ".mikro"), { recursive: true });
            await writeFile(join(agents, "pi", "agent.yaml"), "engine: pi\nshape: loop\n");
            await writeFile(join(agents, "override", "agent.yaml"), "engine: rlm\nshape: loop\ntools: [read]\n");
            await writeFile(join(local.root, ".mikro", "mikro.yaml"), `model:\n  provider: pi-fixture\n  model: control\nproviders:\n  pi-fixture:\n    base-url: ${local.baseUrl}\n    api-key-env: ${local.keyEnv}\n    models:\n      control:\n        cost: {input: 1, output: 2}\n`);
            const env = {};
            for (const [name, value] of Object.entries(process.env))
                if (value !== undefined)
                    env[name] = value;
            env.MIKRO_AGENTS_DIR = agents;
            env.MIKRO_MCP_RUN_TIMEOUT_MS = "30000";
            transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "mcp", "--dir", local.root], env, stderr: "pipe" });
            client = new Client({ name: "pi-contract-fixture", version: "1" });
            await client.connect(transport);
            const list = await client.listTools();
            assert.ok(list.tools.find((tool) => tool.name === "mikro_override")?.description?.startsWith("UNAVAILABLE"));
            for (const args of [{ engine: "" }, { engine: null }, { engine: 42 }, { engine: "mikro" }, { engine: "constructor" }, { backend: "pi" }]) {
                const result = await client.callTool({ name: "mikro_query", arguments: { prompt: "must not bill", ...args } });
                assert.equal(result.isError, true);
                const structured = record(result.structuredContent);
                assert.equal(typeof structured.session_id, "string");
                assert.match(String(structured.answer), /engine must be|obsolete backend/);
                assert.ok(Array.isArray(result.content));
                assert.equal(record(result.content[0]).text, structured.answer);
            }
            assert.equal(local.bodies.length, 0);
            const defaultRlm = await client.callTool({ name: "mikro_query", arguments: { prompt: "default RLM" } });
            assert.equal(defaultRlm.isError, false);
            assert.match(String(record(defaultRlm.structuredContent).answer), /RLM default/);
            const progress = [];
            const first = await client.callTool({ name: "mikro_pi", arguments: { prompt: "first question" } }, undefined, { onprogress: (event) => { if (event.message)
                    progress.push(event.message); } });
            const structured = record(first.structuredContent);
            assert.equal(typeof structured.session_id, "string");
            assert.match(String(structured.answer), /Pi first[\s\S]*11 in \/ 7 out[\s\S]*\$[\s\S]*session /);
            assert.ok(Array.isArray(first.content));
            assert.equal(record(first.content[0]).text, structured.answer);
            assert.ok(progress.some((message) => /iteration 1/.test(message)));
            const resumed = await client.callTool({ name: "mikro_pi", arguments: { prompt: "second question", session_id: structured.session_id } });
            assert.equal(record(resumed.structuredContent).session_id, structured.session_id);
            assert.match(JSON.stringify(local.bodies[2]), /first question/);
            assert.match(JSON.stringify(local.bodies[2]), /Pi first/);
            const refused = await client.callTool({ name: "mikro_override", arguments: { prompt: "default fails before bill" } });
            assert.equal(refused.isError, true);
            assert.equal(local.bodies.length, 3);
            const overridden = await client.callTool({ name: "mikro_override", arguments: { prompt: "override stale discovery", engine: "pi" } });
            assert.match(String(record(overridden.structuredContent).answer), /Override accepted/);
            const generic = await client.callTool({ name: "mikro_query", arguments: { prompt: "generic Pi", engine: "pi" } });
            assert.match(String(record(generic.structuredContent).answer), /Generic Pi/);
            assert.equal(local.bodies.length, 5);
        }
        finally {
            await client?.close();
            await transport?.close();
            await local.close();
        }
    });
    it("preserves paid failed-attempt receipts through compiled MCP and the actual host footer parser, without inventing unknown totals", async () => {
        const local = await fixture([
            { text: "not a final" }, { tools: [{ name: "emit_done", args: { answer: 42 } }] },
            { tools: [final("truncated")], finish: "length" },
            { tools: [{ name: "glob", args: { pattern: "*.md" } }] },
            { tools: [{ name: "glob", args: { pattern: "*.md" } }] }, { httpError: true },
            { text: "truncated RLM response", finish: "length" },
            { httpError: true },
            { httpError: true },
            { tools: [
                    { name: "read", args: { path: ".mikro/runs/facts-local.md" } },
                    { name: "read", args: { path: ".mikro/runs/neighbor.md" } },
                ] }, { tools: [final("facts checked")] },
        ]);
        let client;
        let transport;
        try {
            const agents = join(local.root, "agents");
            await mkdir(join(local.root, ".mikro"), { recursive: true });
            for (const [name, yaml] of [
                ["pi", "engine: pi\nshape: single-step\n"],
                ["ceiling", "engine: pi\nshape: loop\nbudget:\n  maxCost: 0.001\n"],
                ["loop", "engine: pi\nshape: loop\nbudget:\n  maxIterations: 2\n"],
            ]) {
                await mkdir(join(agents, name), { recursive: true });
                await writeFile(join(agents, name, "agent.yaml"), yaml);
            }
            await writeFile(join(local.root, ".mikro", "mikro.yaml"), `model:\n  provider: pi-fixture\n  model: control\nproviders:\n  pi-fixture:\n    base-url: ${local.baseUrl}\n    api-key-env: ${local.keyEnv}\n    models:\n      control:\n        cost: {input: 100, output: 200.0001}\n`);
            const env = {
                PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: local.root, GENIE_HOME: local.root,
                MIKRO_AGENTS_DIR: agents, [local.keyEnv]: "fixture-only-key", MIKRO_MCP_RUN_TIMEOUT_MS: "30000",
            };
            transport = new StdioClientTransport({ command: process.execPath, args: [
                    fileURLToPath(new URL("../src/cli.js", import.meta.url)), "mcp", "--dir", local.root,
                ], env, stderr: "pipe" });
            client = new Client({ name: "paid-failure-fixture", version: "1" });
            await client.connect(transport);
            const parser = fileURLToPath(new URL("../../../scripts/mikro/call.ts", import.meta.url));
            const parseProgram = `import {parseFooter} from ${JSON.stringify(parser)}; console.log(JSON.stringify(parseFooter(Bun.argv.at(-1))));`;
            for (const [name, diagnostic, partial, engine] of [
                ["mikro_pi", "no accepted emit_done", false, "pi"], ["mikro_pi", "invalid emit_done", false, "pi"],
                ["mikro_pi", "length", false, "pi"], ["mikro_ceiling", "max-cost", false, "pi"],
                ["mikro_loop", "error", true, "pi"], ["mikro_query", "length", true, "rlm"],
            ]) {
                const result = await client.callTool({ name, arguments: { prompt: `exercise ${diagnostic}`, engine } });
                assert.equal(result.isError, true, "a receipt must not mask a failed turn as success");
                const structured = record(result.structuredContent);
                assert.equal(typeof structured.session_id, "string");
                assert.equal(typeof structured.answer, "string");
                const raw = String(structured.answer);
                assert.match(raw, new RegExp(diagnostic));
                assert.ok(Array.isArray(result.content));
                assert.equal(record(result.content[0]).text, raw);
                const parsed = JSON.parse((await runFile("bun", ["--eval", parseProgram, raw], { env })).stdout);
                if (partial) {
                    assert.equal(parsed, null, "a partial subtotal must not enter the frozen complete-run ledger");
                    assert.match(raw, /usage coverage: partial; unreported totals unknown/);
                    const metadata = record(JSON.parse(raw.split("\nobserved_usage: ")[1]));
                    assert.equal(metadata.coverage, "partial");
                    assert.equal(metadata.totals, null);
                    const subtotal = record(metadata.subtotal);
                    assert.equal(subtotal.inputTokens, 11);
                    assert.equal(subtotal.outputTokens, 7);
                    assert.ok(Math.abs(Number(subtotal.totalCost) - 0.0025000007) < 1e-15, "raw observed cost retains precision lost by a formatted footer");
                    if (engine === "rlm")
                        assert.equal(metadata.iterations, 1, "last-operation progress is retained, not a run-total claim");
                }
                else {
                    const footer = record(parsed);
                    assert.equal(footer.tokensIn, 11, "the observed complete receipt is not lost or counted twice");
                    assert.equal(footer.tokensOut, 7);
                    assert.equal(footer.cost, 0.0025);
                    assert.doesNotMatch(raw, /usage coverage: partial|observed_usage:/);
                }
            }
            for (const [name, engine] of [["mikro_pi", "pi"], ["mikro_query", "rlm"]]) {
                const unknown = await client.callTool({ name, arguments: { prompt: "first response has no receipt", engine } });
                assert.equal(unknown.isError, true);
                const raw = String(record(unknown.structuredContent).answer);
                const parsed = JSON.parse((await runFile("bun", ["--eval", parseProgram, raw], { env })).stdout);
                assert.equal(parsed, null, "an unreported failure cannot acquire a fabricated zero footer");
            }
            assert.equal(local.bodies.length, 9);
            await mkdir(join(local.root, ".mikro", "runs"), { recursive: true });
            await writeFile(join(local.root, ".mikro", "runs", "facts-local.md"), "MCP-EXPLICIT-FACTS");
            await writeFile(join(local.root, ".mikro", "runs", "neighbor.md"), "MCP-HIDDEN-NEIGHBOR-CANARY");
            const facts = await client.callTool({ name: "mikro_loop", arguments: {
                    prompt: "read the explicit facts", context: ".mikro/runs/facts-local.md",
                } });
            assert.equal(facts.isError, false);
            const feedback = JSON.stringify(record(local.bodies[10]).messages);
            assert.match(feedback, /MCP-EXPLICIT-FACTS/);
            assert.match(feedback, /scope denied/);
            assert.doesNotMatch(feedback, /MCP-HIDDEN-NEIGHBOR-CANARY/);
            assert.equal(local.bodies.length, 11);
        }
        finally {
            await client?.close();
            await transport?.close();
            await local.close();
        }
    });
});
//# sourceMappingURL=pi-backend.test.js.map