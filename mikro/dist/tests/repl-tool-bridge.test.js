import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { REPL, REPLTimeoutError } from "../src/repl.js";
import { createToolRegistry, toolRegistryAsResolver, } from "../src/sdk/index.js";
const execFileAsync = promisify(execFile);
const echoStub = `def echo(**kwargs):
    return call_tool("echo", kwargs)`;
async function hasPython() {
    try {
        await execFileAsync("python3", ["--version"], { timeout: 2_000 });
        return true;
    }
    catch {
        return false;
    }
}
function assertRuntimeError(result, text) {
    assert.match(result.error ?? result.stderr, /RuntimeError/);
    assert.match(result.error ?? result.stderr, text);
}
async function assertAlive(repl) {
    const followUp = await repl.execute('print("still-alive")');
    assert.equal(followUp.error, undefined, followUp.stderr);
    assert.match(followUp.stdout, /still-alive/);
    assert.equal(repl.isRunning(), true);
}
describe("REPL tool bridge", () => {
    let pythonAvailable = false;
    before(async () => {
        pythonAvailable = await hasPython();
    });
    for (const [name, code, error] of [
        ["web-search", "def web-search(**kwargs):\n    return kwargs", /SyntaxError/],
        ["broken", 'raise RuntimeError("tool setup failed")', /RuntimeError: tool setup failed/],
    ]) {
        it(`rejects failed installation of ${name} and stops the partial REPL`, async (ctx) => {
            if (!pythonAvailable)
                return ctx.skip("python3 not on PATH");
            const repl = new REPL();
            try {
                await assert.rejects(repl.start({ tools: { echo: echoStub, [name]: code } }), (err) => {
                    assert.ok(err.message.includes(`Failed to install REPL tool "${name}"`));
                    assert.match(err.message, error);
                    return true;
                });
                assert.equal(repl.isRunning(), false);
                await assert.rejects(repl.execute("echo(x=1)"), /REPL not started/);
                repl.onToolRequest(async (_tool, args) => args);
                await repl.start({ tools: { echo: echoStub } });
                const result = await repl.execute('import json\nprint(json.dumps(echo(x=1)))');
                assert.equal(result.error, undefined, result.stderr);
                assert.deepEqual(JSON.parse(result.stdout.trim()), { x: 1 });
            }
            finally {
                await repl.stop();
            }
        });
    }
    it("accepts successful tool blocks that write diagnostics to stderr", async (ctx) => {
        if (!pythonAvailable)
            return ctx.skip("python3 not on PATH");
        const repl = new REPL();
        repl.onToolRequest(async (_tool, args) => args);
        try {
            await repl.start({ tools: {
                    "Echo tool": `import sys\nprint("setup diagnostic", file=sys.stderr)\n${echoStub}`,
                } });
            const result = await repl.execute('import json\nprint(json.dumps(echo(x=1)))');
            assert.equal(result.error, undefined, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout.trim()), { x: 1 });
        }
        finally {
            await repl.stop();
        }
    });
    it("rejects a failed reinstall during crash recovery and stops the replacement process", async (ctx) => {
        if (!pythonAvailable)
            return ctx.skip("python3 not on PATH");
        const dir = await mkdtemp(join(tmpdir(), "mikro-repl-reinstall-"));
        const marker = join(dir, "fail-reinstall");
        const repl = new REPL();
        try {
            await repl.start({ tools: {
                    echo: `import os\nif os.path.exists(${JSON.stringify(marker)}):\n    raise RuntimeError("reinstall failed")\n${echoStub}`,
                } });
            await writeFile(marker, "fail\n");
            const handle = repl;
            const child = handle.process;
            const exited = new Promise((resolve) => child.once("exit", () => resolve()));
            child.kill("SIGKILL");
            await exited;
            await assert.rejects(repl.execute("echo(x=1)"), /REPL subprocess crashed and recovery failed[\s\S]*Failed to install REPL tool "echo"[\s\S]*RuntimeError: reinstall failed/);
            assert.equal(repl.isRunning(), false);
            await assert.rejects(repl.execute("echo(x=2)"), /REPL not started/);
        }
        finally {
            await repl.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("JSON-round-trips results and retains the handler after recovery", async (ctx) => {
        if (!pythonAvailable) {
            ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
            return;
        }
        const repl = new REPL();
        repl.onToolRequest(async (_tool, args, signal) => {
            assert.equal(signal.aborted, false);
            return args;
        });
        try {
            await repl.start({ tools: { echo: echoStub } });
            const first = await repl.execute('import json\nprint(json.dumps(echo(x=1)))');
            assert.equal(first.error, undefined, first.stderr);
            assert.deepEqual(JSON.parse(first.stdout.trim()), { x: 1 });
            const handle = repl;
            const process = handle.process;
            const exited = new Promise((resolve) => process.once("exit", () => resolve()));
            process.kill("SIGKILL");
            await exited;
            const recovered = await repl.execute('import json\nprint(json.dumps(echo(x=2)))');
            assert.equal(recovered.error, undefined, recovered.stderr);
            assert.deepEqual(JSON.parse(recovered.stdout.trim()), { x: 2 });
            assert.equal(repl.isRunning(), true);
        }
        finally {
            await repl.stop();
        }
    });
    it("turns bridge failures into RuntimeError and stays alive", async (ctx) => {
        if (!pythonAvailable) {
            ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
            return;
        }
        const repl = new REPL();
        try {
            await repl.start({ tools: { echo: echoStub } });
            repl.onToolRequest(async () => {
                throw "plain handler rejection";
            });
            assertRuntimeError(await repl.execute("echo(x=1)"), /plain handler rejection/);
            await assertAlive(repl);
            repl.onToolRequest(async () => 1n);
            assertRuntimeError(await repl.execute("echo(x=1)"), /BigInt|serializ/);
            await assertAlive(repl);
            const registry = createToolRegistry();
            repl.onToolRequest(toolRegistryAsResolver(registry));
            assertRuntimeError(await repl.execute("echo(x=1)"), /unknown tool.*echo/i);
            await assertAlive(repl);
            repl.onToolRequest(async (_tool, args) => args);
            const writable = repl;
            const send = writable._send.bind(repl);
            let failNextResponse = true;
            writable._send = (message) => {
                if (message.type === "tool_response" && failNextResponse) {
                    failNextResponse = false;
                    throw new Error("synthetic send failure");
                }
                send(message);
            };
            assertRuntimeError(await repl.execute("echo(x=1)"), /synthetic send failure/);
            writable._send = send;
            await assertAlive(repl);
        }
        finally {
            await repl.stop();
        }
    });
    it("recovers a timed-out block without replay, restores original inputs, and loses user variables", async (ctx) => {
        if (!pythonAvailable)
            return ctx.skip("python3 not on PATH");
        const dir = await mkdtemp(join(tmpdir(), "mikro-repl-timeout-"));
        const marker = join(dir, "marker");
        const context = { answer: "original" };
        const tools = { echo: echoStub };
        const repl = new REPL();
        repl.onToolRequest(async (_tool, args) => args);
        try {
            await repl.start({ context, tools });
            await repl.execute("saved = 'user-state'");
            context.answer = "caller-mutated";
            tools.echo = 'raise RuntimeError("mutated tool")';
            await assert.rejects(repl.execute(`import time\nwith open(${JSON.stringify(marker)}, "a") as f:\n    f.write("once\\n")\n    f.flush()\ntime.sleep(5)`, 100), (error) => {
                assert.ok(error instanceof REPLTimeoutError);
                assert.equal(error.timeoutMs, 100);
                assert.match(error.message, /user-created variables were lost/);
                assert.match(error.message, /not replayed/);
                return true;
            });
            const next = await repl.execute('import json\nprint(context["answer"])\nprint(json.dumps(echo(value="restored")))\nprint("saved" in dir())');
            assert.equal(next.error, undefined, next.stderr);
            assert.deepEqual(next.stdout.trim().split("\n"), ["original", '{"value": "restored"}', "False"]);
            assert.equal(await readFile(marker, "utf8"), "once\n");
            assert.equal(repl.isRunning(), true);
        }
        finally {
            await repl.stop();
            await repl.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
    for (const action of ["stop", "replace"]) {
        it(`does not resurrect a retired timeout generation after explicit ${action}`, async (ctx) => {
            if (!pythonAvailable)
                return ctx.skip("python3 not on PATH");
            const dir = await mkdtemp(join(tmpdir(), "mikro-repl-retired-"));
            const startups = join(dir, "startups");
            const block = join(dir, "block");
            const startup = `with open(${JSON.stringify(startups)}, "a") as f:\n    f.write("started\\n")`;
            const repl = new REPL();
            let control;
            let entered;
            const controlled = new Promise((resolve) => { entered = resolve; });
            try {
                await repl.start({ context: "original", tools: { startup } });
                const child = repl.process;
                // This listener precedes the retirement waiter's exit listener. The
                // real child is detached, but recovery cannot continue until we return.
                child.once("exit", () => {
                    control = action === "stop" ? repl.stop() : repl.start({
                        context: "new-owner",
                        tools: { startup },
                    });
                    entered();
                });
                // Exercise the platform timeout and actual Python exit; event ordering,
                // not a guessed sleep, controls the shutdown/replacement race.
                const execution = assert.rejects(repl.execute(`import time\nwith open(${JSON.stringify(block)}, "a") as f:\n    f.write("once\\n")\n    f.flush()\ntime.sleep(30)`, 100), (error) => {
                    assert.ok(error instanceof Error);
                    assert.match(error.message, /lifecycle cancelled/);
                    assert.equal(error instanceof REPLTimeoutError, false, "cancelled recovery must not claim a restart");
                    return true;
                });
                await controlled;
                assert.ok(control);
                await control;
                await execution;
                assert.equal(await readFile(block, "utf8"), "once\n", "timed-out code was never replayed");
                assert.equal(await readFile(startups, "utf8"), action === "stop" ? "started\n" : "started\nstarted\n");
                if (action === "stop") {
                    assert.equal(repl.isRunning(), false);
                    await assert.rejects(repl.execute("print('stopped')"), /REPL not started/);
                }
                else {
                    const next = await repl.execute("print(context)");
                    assert.equal(next.error, undefined, next.stderr);
                    assert.equal(next.stdout.trim(), "new-owner");
                    assert.equal(repl.isRunning(), true, "stale recovery must not tear down the explicit replacement");
                }
            }
            finally {
                await repl.stop();
                await rm(dir, { recursive: true, force: true });
            }
        });
    }
    it("cancels an explicit start waiting for the previous Python child to exit", async (ctx) => {
        if (!pythonAvailable)
            return ctx.skip("python3 not on PATH");
        const dir = await mkdtemp(join(tmpdir(), "mikro-repl-start-stop-"));
        const marker = join(dir, "startups");
        const startup = `with open(${JSON.stringify(marker)}, "a") as f:\n    f.write("started\\n")`;
        const repl = new REPL();
        try {
            await repl.start({ tools: { startup } });
            // start() synchronously detaches the old child before its first wait.
            const starting = assert.rejects(repl.start({ context: "must-not-start", tools: { startup } }), /lifecycle cancelled/);
            await repl.stop();
            await starting;
            assert.equal(await readFile(marker, "utf8"), "started\n");
            assert.equal(repl.isRunning(), false);
            await assert.rejects(repl.execute("print(context)"), /REPL not started/);
        }
        finally {
            await repl.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("does not let a superseded asynchronous startup tear down a newer owner", async (ctx) => {
        if (!pythonAvailable)
            return ctx.skip("python3 not on PATH");
        const repl = new REPL();
        let entered;
        const installing = new Promise((resolve) => { entered = resolve; });
        let release;
        const blocked = new Promise((resolve) => { release = resolve; });
        let oldSignal;
        repl.onToolRequest(async (_tool, args, signal) => {
            oldSignal = signal;
            entered();
            await blocked;
            return args;
        });
        try {
            const oldStart = assert.rejects(repl.start({
                context: "old-owner",
                tools: { gate: 'call_tool("startup_gate", {})' },
            }), /lifecycle cancelled/);
            await installing;
            const newStart = repl.start({ context: "new-owner" });
            await oldStart;
            await newStart;
            assert.equal(oldSignal?.aborted, true);
            release();
            const next = await repl.execute("print(context)");
            assert.equal(next.error, undefined, next.stderr);
            assert.equal(next.stdout.trim(), "new-owner");
            assert.equal(repl.isRunning(), true);
        }
        finally {
            release();
            await repl.stop();
        }
    });
    for (const bridge of ["llm", "tool"]) {
        it(`discards a late ${bridge} response after timeout instead of sending it to the replacement`, async (ctx) => {
            if (!pythonAvailable)
                return ctx.skip("python3 not on PATH");
            const repl = new REPL();
            let release;
            let started;
            let finished;
            const entered = new Promise((resolve) => { started = resolve; });
            const blocked = new Promise((resolve) => { release = resolve; });
            const completed = new Promise((resolve) => { finished = resolve; });
            let oldSignal;
            let calls = 0;
            const delayed = async (signal) => {
                calls++;
                if (calls === 1) {
                    oldSignal = signal;
                    started();
                    await blocked; // Simulate a handler that ignores cancellation.
                    finished();
                    return "stale";
                }
                assert.equal(signal.aborted, false);
                return "fresh";
            };
            repl.onLLMRequest(async (_request, signal) => [await delayed(signal)]);
            repl.onToolRequest(async (_tool, _args, signal) => delayed(signal));
            const code = bridge === "llm" ? 'print(llm_query("fixture"))' : 'print(echo(value="fixture"))';
            try {
                await repl.start({ context: "restored", tools: { echo: echoStub } });
                const timed = assert.rejects(repl.execute(code, 300), REPLTimeoutError);
                await entered;
                await timed;
                assert.equal(oldSignal?.aborted, true);
                // Keep a replacement command active while the old response arrives.
                const next = repl.execute('import time\ntime.sleep(0.2)\nprint(context)');
                release();
                await completed;
                const result = await next;
                assert.equal(result.error, undefined, result.stderr);
                assert.equal(result.stdout.trim(), "restored");
                const fresh = await repl.execute(code);
                assert.equal(fresh.error, undefined, fresh.stderr);
                assert.equal(fresh.stdout.trim(), "fresh");
                assert.equal(calls, 2);
            }
            finally {
                release();
                await repl.stop();
            }
        });
    }
    it("treats a failed timeout restart as terminal and leaves no replacement child", async (ctx) => {
        if (!pythonAvailable)
            return ctx.skip("python3 not on PATH");
        const dir = await mkdtemp(join(tmpdir(), "mikro-repl-timeout-restart-"));
        const marker = join(dir, "fail-reinstall");
        const repl = new REPL();
        try {
            await repl.start({ tools: {
                    echo: `import os\nif os.path.exists(${JSON.stringify(marker)}):\n    raise RuntimeError("restart denied")\n${echoStub}`,
                } });
            await writeFile(marker, "fail");
            await assert.rejects(repl.execute("import time\ntime.sleep(5)", 100), /timeout recovery failed[\s\S]*restart denied/);
            assert.equal(repl.isRunning(), false);
            await assert.rejects(repl.execute("print('not restarted')"), /REPL not started/);
        }
        finally {
            await repl.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
    it("cancels an outstanding bridge at the run deadline without restarting or waiting for the handler", async (ctx) => {
        if (!pythonAvailable)
            return ctx.skip("python3 not on PATH");
        const controller = new AbortController();
        const repl = new REPL();
        let entered;
        let release;
        const started = new Promise((resolve) => { entered = resolve; });
        const blocked = new Promise((resolve) => { release = resolve; });
        let calls = 0;
        repl.onToolRequest(async () => { calls++; entered(); await blocked; return "late"; });
        try {
            await repl.start({ tools: { echo: echoStub }, signal: controller.signal });
            const result = assert.rejects(repl.execute("echo()", 5_000), /fixture deadline/);
            await started;
            controller.abort(new Error("fixture deadline"));
            await result;
            await repl.stop();
            assert.equal(repl.isRunning(), false);
            assert.equal(calls, 1);
            await assert.rejects(repl.execute("echo()"), /fixture deadline/);
        }
        finally {
            release();
            await repl.stop();
        }
    });
    it("returns RuntimeError when no handler is registered and remains alive", async (ctx) => {
        if (!pythonAvailable) {
            ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
            return;
        }
        const repl = new REPL();
        try {
            await repl.start({ tools: { echo: echoStub } });
            assertRuntimeError(await repl.execute("echo(x=1)"), /No tool handler configured/);
            await assertAlive(repl);
        }
        finally {
            await repl.stop();
        }
    });
});
//# sourceMappingURL=repl-tool-bridge.test.js.map