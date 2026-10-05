import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type MikroConfig } from "../src/config.js";
import type { LoadedContext } from "../src/context.js";
import type { Microagent } from "../src/mcp/agents.js";
import type { BackendRequest } from "../src/mcp/backend.js";
import {
  LegacyMikroBackend,
  PLUGIN_TIMEOUT_MARGIN_MS,
} from "../src/mcp/backends/legacy.js";
import type { RLMResult } from "../src/output.js";
import { defaultReplTimeoutMs, REPL } from "../src/repl.js";
import { bridgeToolResolver, rlmLoop, type RLMOptions } from "../src/rlm.js";
import { parseAgentSpec } from "../src/sdk/agent-spec.js";
import { createEmitter } from "../src/sdk/emitter.js";
import type { AgentEvent } from "../src/sdk/events.js";
import { loadPythonPlugins } from "../src/sdk/python-plugin.js";
import {
  createToolRegistry,
  toolRegistryAsResolver,
} from "../src/sdk/tool-registry.js";

const execFileAsync = promisify(execFile);

type LoopCall = {
  readonly config: MikroConfig;
  readonly options: Partial<RLMOptions>;
};

function successfulResult(): RLMResult {
  return {
    answer: "ok",
    references: [],
    iterations: 1,
    model: "test/test",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCost: 0,
      llmCalls: 0,
    },
  };
}

function capturingLoop(calls: LoopCall[]): (
  query: string,
  context: LoadedContext | null,
  config: MikroConfig,
  options?: Partial<RLMOptions>
) => Promise<RLMResult> {
  return async (_query, _context, config, options = {}) => {
    calls.push({ config, options });
    options.emitter?.close();
    return successfulResult();
  };
}

function microagent(dir: string, tools: readonly string[]): Microagent {
  const spec = parseAgentSpec(`tools:\n${tools.map((name) => `  - ${name}`).join("\n")}\n`, dir);
  return {
    name: "declared-tools",
    toolName: "mikro_declared-tools",
    dir,
    spec,
    summary: "Declared tools fixture",
  };
}

async function request(dir: string): Promise<BackendRequest> {
  return {
    query: "test",
    context: null,
    config: await loadConfig(dir),
    cwd: dir,
  };
}

async function hasPython(): Promise<boolean> {
  try {
    await execFileAsync("python3", ["--version"], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

describe("LegacyMikroBackend declared tools", () => {
  let pythonAvailable = false;

  before(async () => {
    pythonAvailable = await hasPython();
  });

  it("loads sidecar-backed tools, appends a kwargs stub, and passes a resolver", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mikro-legacy-tools-"));
    try {
      await mkdir(join(dir, "tools"));
      await mkdir(join(dir, ".mikro"));
      await writeFile(join(dir, ".mikro", "mikro.yaml"), "{}\n");
      await writeFile(
        join(dir, ".mikro", "TOOLS.md"),
        "## ambient\n```python\ndef ambient():\n    return 'ambient'\n```\n",
      );
      await writeFile(
        join(dir, "tools", "echo.mjs"),
        "export default async (args) => args;\n",
      );
      await writeFile(
        join(dir, "tools", "echo.schema.json"),
        JSON.stringify({
          description: "Echo the supplied value.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        }),
      );

      const calls: LoopCall[] = [];
      const backend = new LegacyMikroBackend({ loop: capturingLoop(calls) });
      const baseRequest = await request(dir);
      await backend.run(microagent(dir, ["echo"]), baseRequest, () => {});

      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.notEqual(call.config, baseRequest.config, "the request config is not mutated");
      assert.deepEqual(baseRequest.config.tools.map((tool) => tool.name), ["ambient"]);
      assert.deepEqual(call.config.tools.map((tool) => tool.name), ["ambient", "echo"]);
      assert.match(call.config.tools[1]?.code ?? "", /^def echo\(\*\*kwargs\):/m);
      assert.match(call.config.tools[1]?.code ?? "", /Echo the supplied value\./);
      assert.match(call.config.tools[1]?.code ?? "", /Parameters: value\./);
      assert.match(call.config.tools[1]?.code ?? "", /call_tool\("echo", kwargs\)/);
      assert.equal(typeof call.options.tools, "function");
      assert.deepEqual(await call.options.tools?.("echo", { value: "hi" }, new AbortController().signal), {
        value: "hi",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes the floored REPL-relative timeout to the Python loader seam", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mikro-legacy-timeout-spy-"));
    const previous = process.env.MIKRO_REPL_TIMEOUT_MS;
    process.env.MIKRO_REPL_TIMEOUT_MS = "750";
    try {
      let observedTimeout: number | null | undefined;
      const calls: LoopCall[] = [];
      const backend = new LegacyMikroBackend({
        loop: capturingLoop(calls),
        loaders: {
          loadPluginTools: async () => ({ loaded: [], skipped: [], missing: ["echo"] }),
          loadPythonPlugins: async (_spec, registry, options = {}) => {
            observedTimeout = options.timeoutMs;
            registry.register("echo", async (args) => args);
            return { loaded: ["echo"], skipped: [], missing: [] };
          },
        },
      });

      await backend.run(microagent(dir, ["echo"]), await request(dir), () => {});

      const expected = Math.max(1, defaultReplTimeoutMs() - PLUGIN_TIMEOUT_MARGIN_MS);
      assert.equal(observedTimeout, expected);
      assert.ok((observedTimeout ?? 0) > 0);
      assert.equal(typeof calls[0]?.options.tools, "function");
      assert.match(
        calls[0]?.config.tools[0]?.code ?? "",
        /arguments undocumented — pass keyword arguments/,
      );
    } finally {
      if (previous === undefined) delete process.env.MIKRO_REPL_TIMEOUT_MS;
      else process.env.MIKRO_REPL_TIMEOUT_MS = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const [name, description, extension] of [
    ["echo_quote", 'Returns "OK"', "mjs"],
    ["echo_triple", 'Returns """OK"""', "py"],
    ["echo_slash", "Path C:\\tools\\", "mjs"],
    ["café", "Unicode café ☕\nSecond line\r\nThird line", "py"],
    ["match", "Control \u0000 characters", "mjs"],
    ["case", "Plain description.", "py"],
    ["type", "", "mjs"],
  ]) {
    it(`installs and executes ${name} with its sidecar docstring intact`, async (ctx) => {
      if (!pythonAvailable) return ctx.skip("python3 not on PATH");
      const dir = await mkdtemp(join(tmpdir(), "mikro-legacy-docstring-"));
      const repl = new REPL();
      try {
        await mkdir(join(dir, "tools"));
        await writeFile(
          join(dir, "tools", `${name}.${extension}`),
          extension === "py"
            ? "import json, sys\njson.dump(json.load(sys.stdin), sys.stdout)\n"
            : "export default async (args) => args;\n",
        );
        await writeFile(join(dir, "tools", `${name}.schema.json`), JSON.stringify({ description }));
        const calls: LoopCall[] = [];
        await new LegacyMikroBackend({ loop: capturingLoop(calls) }).run(
          microagent(dir, [name]), await request(dir), () => {},
        );
        const { config, options } = calls[0]!;
        assert.ok(options.tools);
        repl.onToolRequest(options.tools);
        await repl.start({ tools: Object.fromEntries(config.tools.map((tool) => [tool.name, tool.code])) });
        const result = await repl.execute(
          `import json\nprint(json.dumps([${name}.__doc__, ${name}(value="works")]))`,
        );
        assert.equal(result.error, undefined, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout.trim()), [
          description || "(arguments undocumented — pass keyword arguments)",
          { value: "works" },
        ]);
      } finally {
        await repl.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("turns a Python plugin timeout into RuntimeError and keeps the REPL alive", async (ctx) => {
    if (!pythonAvailable) {
      ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "mikro-legacy-python-timeout-"));
    const previous = process.env.MIKRO_REPL_TIMEOUT_MS;
    process.env.MIKRO_REPL_TIMEOUT_MS = "1500";
    const repl = new REPL();
    try {
      await mkdir(join(dir, "tools"));
      await writeFile(
        join(dir, "tools", "slow.py"),
        [
          "import json",
          "import sys",
          "import time",
          "json.load(sys.stdin)",
          "time.sleep(1)",
          'json.dump({"late": True}, sys.stdout)',
          "",
        ].join("\n"),
      );

      const calls: LoopCall[] = [];
      const agent = microagent(dir, ["slow"]);
      await new LegacyMikroBackend({ loop: capturingLoop(calls) }).run(
        agent,
        await request(dir),
        () => {},
      );
      const stub = calls[0]?.config.tools.find((tool) => tool.name === "slow")?.code;
      assert.ok(stub, "backend generated the slow tool stub");

      const registry = createToolRegistry();
      const timeoutMs = Math.max(1, defaultReplTimeoutMs() - PLUGIN_TIMEOUT_MARGIN_MS);
      await loadPythonPlugins(agent.spec, registry, { timeoutMs });
      repl.onToolRequest(toolRegistryAsResolver(registry));
      await repl.start({ tools: { slow: stub } });

      const timedOut = await repl.execute("slow(value=1)");
      assert.match(timedOut.error ?? timedOut.stderr, /RuntimeError/);
      assert.match(timedOut.error ?? timedOut.stderr, /timed out after 500ms/);
      const followUp = await repl.execute('print("still-alive")');
      assert.equal(followUp.error, undefined, followUp.stderr);
      assert.match(followUp.stdout, /still-alive/);
      assert.equal(repl.isRunning(), true);
    } finally {
      await repl.stop();
      if (previous === undefined) delete process.env.MIKRO_REPL_TIMEOUT_MS;
      else process.env.MIKRO_REPL_TIMEOUT_MS = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts the real loop and closes its emitter when a tool fails to install", async (ctx) => {
    if (!pythonAvailable) return ctx.skip("python3 not on PATH");
    const dir = await mkdtemp(join(tmpdir(), "mikro-legacy-install-failure-"));
    const emitter = createEmitter();
    const events: AgentEvent[] = [];
    const consumer = (async () => {
      for await (const event of emitter) events.push(event);
    })();
    try {
      const { config } = await request(dir);
      config.tools = [{ name: "broken", code: 'raise RuntimeError("installation failed")' }];
      config.model = { provider: "invalid-install-test", model: "never-called" };
      await assert.rejects(
        rlmLoop("test", null, config, { emitter, output: "json" }),
        /Failed to install REPL tool "broken"[\s\S]*RuntimeError: installation failed/,
      );
      assert.equal(emitter.closed, true);
      await consumer;
      assert.equal(events.some((event) => event.type === "IterationStart"), false);
      assert.ok(events.some((event) => event.type === "Error" && event.error.message.includes("installation failed")));
      assert.ok(events.some((event) => event.type === "SessionClose" && event.reason === "error"));
    } finally {
      emitter.close();
      await consumer;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits bridged tool events before execute settles and supplies the run signal", async (ctx) => {
    if (!pythonAvailable) {
      ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
      return;
    }

    const emitter = createEmitter();
    const emitted: AgentEvent[] = [];
    let executeSettled = false;
    const originalEmit = emitter.emit.bind(emitter);
    emitter.emit = (event) => {
      assert.equal(executeSettled, false, `${event.type} arrived after execute settled`);
      emitted.push(event);
      originalEmit(event);
    };

    const runAbort = new AbortController();
    runAbort.abort();
    let receivedSignal: AbortSignal | undefined;
    const resolver = bridgeToolResolver(
      async (_tool, args, signal) => {
        receivedSignal = signal;
        if ((args as { fail?: boolean }).fail) throw new Error("synthetic tool failure");
        return args;
      },
      emitter,
      {
        sessionId: "session-bridge",
        selfTag: { correlationId: "corr-bridge", parentRunId: "parent-bridge" },
        signal: runAbort.signal,
      },
    );

    const repl = new REPL();
    repl.onToolRequest(resolver);
    try {
      await repl.start({
        tools: {
          echo: 'def echo(**kwargs):\n    return call_tool("echo", kwargs)',
        },
      });

      const success = await repl.execute('print(echo(value="yes"))').then((result) => {
        executeSettled = true;
        return result;
      });
      assert.equal(success.error, undefined, success.stderr);
      assert.equal(receivedSignal, runAbort.signal);
      assert.equal(receivedSignal?.aborted, true);

      executeSettled = false;
      const failure = await repl.execute("echo(fail=True)").then((result) => {
        executeSettled = true;
        return result;
      });
      assert.match(failure.error ?? failure.stderr, /RuntimeError/);
      assert.match(failure.error ?? failure.stderr, /synthetic tool failure/);

      assert.deepEqual(
        emitted.map((event) => event.type),
        ["ToolCallBefore", "ToolCallAfter", "ToolCallBefore", "ToolCallAfter"],
      );
      for (const event of emitted) {
        assert.equal("sessionId" in event ? event.sessionId : undefined, "session-bridge");
        assert.equal(event.correlationId, "corr-bridge");
        assert.equal(event.parentRunId, "parent-bridge");
        if (event.type === "ToolCallBefore" || event.type === "ToolCallAfter") {
          assert.equal(event.iteration, 0);
          assert.equal(event.tool, "echo");
        }
      }
      assert.equal(emitted[1]?.type, "ToolCallAfter");
      if (emitted[1]?.type === "ToolCallAfter") assert.equal(emitted[1].ok, true);
      assert.equal(emitted[3]?.type, "ToolCallAfter");
      if (emitted[3]?.type === "ToolCallAfter") assert.equal(emitted[3].ok, false);
    } finally {
      await repl.stop();
      emitter.close();
    }
  });
});
