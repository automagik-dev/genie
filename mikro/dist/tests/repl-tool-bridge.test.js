import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { REPL } from "../src/repl.js";
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
            const child = repl.process;
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
            const process = repl.process;
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