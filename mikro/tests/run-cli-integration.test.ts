import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scaffold } from "../src/scaffold.js";
import { parseToolsMd } from "../src/config.js";
import { REPL } from "../src/repl.js";

const execFileAsync = promisify(execFile);

describe("run_cli integration", () => {
  it("scaffolded project inherits a direct run_cli example", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mikro-cli-scaffold-"));
    try {
      await scaffold(dir, "default");
      const tools = await readFile(join(dir, ".mikro", "TOOLS.md"), "utf-8");
      assert.ok(parseToolsMd(tools).some((t) => t.code.includes("run_cli")));
      assert.doesNotMatch(tools, /rtk/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("doctor ignores legacy always mode and does not probe RTK", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mikro-doctor-"));
    try {
      await mkdir(join(dir, ".mikro"));
      await writeFile(join(dir, ".mikro", "mikro.yaml"), "rtk:\n  enabled: always\n");
      await writeFile(join(dir, "rtk"), "#!/bin/sh\necho probed > probe-marker\nexit 1\n", { mode: 0o755 });
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };
      // Doctor checks presence only; these inert keys prevent unrelated warnings.
      for (const key of ["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY"]) {
        env[key] = "test-placeholder";
      }
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        fileURLToPath(new URL("../src/cli.js", import.meta.url)), "doctor",
      ], { cwd: dir, env, timeout: 15_000 });
      assert.match(stdout, /LLM providers:/);
      assert.match(stdout, /Config:/);
      assert.doesNotMatch(stdout + stderr, /rtk/i);
      await assert.rejects(readFile(join(dir, "probe-marker")), { code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("executes directly even with RTK on PATH and the old mode enabled", async (ctx) => {
    try {
      await execFileAsync("python3", ["--version"], { timeout: 2_000 });
    } catch {
      ctx.skip("python3 not available");
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "mikro-run-cli-"));
    const originalPath = process.env.PATH;
    const originalMode = process.env._MIKRO_RTK_MODE;
    const repl = new REPL();
    try {
      // If automatic routing returns, this shim makes the failure observable.
      await writeFile(join(dir, "rtk"), "#!/bin/sh\necho unexpected-wrapper\nexit 99\n", { mode: 0o755 });
      process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
      process.env._MIKRO_RTK_MODE = "on";
      await repl.start({ toolsLevel: "standard" });
      const result = await repl.execute(`import json, sys
r = run_cli(sys.executable, "-c", "import sys; print(sys.stdin.read(), end=''); print(sys.argv[1], file=sys.stderr); sys.exit(7)", "literal ; $(echo injected)", input="hello\\n")
print(json.dumps(r))`);
      assert.equal(result.error, undefined, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        returncode: 7,
        stdout: "hello\n",
        stderr: "literal ; $(echo injected)\n",
      });
    } finally {
      await repl.stop();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalMode === undefined) delete process.env._MIKRO_RTK_MODE;
      else process.env._MIKRO_RTK_MODE = originalMode;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
