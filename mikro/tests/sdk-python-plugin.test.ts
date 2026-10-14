import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	type AgentSpec,
	createToolRegistry,
	InvalidPluginError,
	loadPythonPlugins,
	makePythonPluginHandler,
	PythonPluginError,
	PythonPluginTimeoutError,
} from "../src/sdk/index.js";
import { resolvePythonScript } from "../src/sdk/python-plugin.js";

function pythonAvailable(): boolean {
	try {
		execFileSync("python3", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		try {
			execFileSync("python", ["--version"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}
}

const HAVE_PYTHON = pythonAvailable();

async function writePyPlugin(
	dir: string,
	name: string,
	body: string,
): Promise<string> {
	const toolsDir = join(dir, "tools");
	await mkdir(toolsDir, { recursive: true });
	const path = join(toolsDir, `${name}.py`);
	await writeFile(path, body, "utf8");
	await chmod(path, 0o755);
	return path;
}

async function writeSchema(
	dir: string,
	name: string,
	contents: unknown,
): Promise<string> {
	const path = join(dir, "tools", `${name}.schema.json`);
	await writeFile(
		path,
		typeof contents === "string" ? contents : JSON.stringify(contents),
		"utf8",
	);
	return path;
}

function specFor(dir: string, tools: string[]): AgentSpec {
	return {
		dir,
		schemaVersion: 1,
		toolsApi: 1,
		shape: "single-step",
		tools,
		extras: {},
	} as AgentSpec;
}

const ctx = {
	tool: "t",
	sessionId: "s",
	iteration: 1,
	signal: new AbortController().signal,
};

describe("python plugin loader — discovery (G3b)", () => {
	let root = "";
	before(async () => {
		root = await mkdtemp(join(tmpdir(), "py-loader-"));
	});
	after(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("loads a .py plugin into the registry", async () => {
		const agentDir = join(root, "load");
		await writePyPlugin(
			agentDir,
			"echo",
			'import json, sys\nargs = json.load(sys.stdin)\njson.dump({"echoed": args}, sys.stdout)\n',
		);
		const registry = createToolRegistry();
		const result = await loadPythonPlugins(
			specFor(agentDir, ["echo"]),
			registry,
		);
		assert.deepEqual([...result.loaded], ["echo"]);
		assert.equal(result.missing.length, 0);
		assert.equal(registry.has("echo"), true);
		assert.equal(registry.describe("echo"), undefined);
	});

	it("attaches a validated sidecar schema to the registry", async () => {
		const agentDir = join(root, "schema");
		await writePyPlugin(agentDir, "echo", "import sys; sys.stdout.write('null')\n");
		const schema = {
			description: "Echo Python input",
			parameters: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
		};
		await writeSchema(agentDir, "echo", schema);

		const registry = createToolRegistry();
		await loadPythonPlugins(specFor(agentDir, ["echo"]), registry);
		assert.deepEqual(registry.describe("echo"), schema);
	});

	it("accepts empty schemas and nested parameter keys without a type", async () => {
		const agentDir = join(root, "valid-schema-shapes");
		await writePyPlugin(agentDir, "empty", "import sys; sys.stdout.write('null')\n");
		await writePyPlugin(agentDir, "nested", "import sys; sys.stdout.write('null')\n");
		await writeSchema(agentDir, "empty", {});
		const nested = { parameters: { properties: {}, required: [] } };
		await writeSchema(agentDir, "nested", nested);

		const registry = createToolRegistry();
		await loadPythonPlugins(specFor(agentDir, ["empty", "nested"]), registry);
		assert.deepEqual(registry.describe("empty"), {});
		assert.deepEqual(registry.describe("nested"), nested);
	});

	it("rejects malformed sidecar schemas with the path and reason", async () => {
		const cases: readonly [string, unknown, RegExp][] = [
			["invalid-json", "{", /not valid JSON/],
			["non-object", null, /plain object/],
			["unknown-key", { extra: true }, /unknown top-level key/],
			["description", { description: false }, /description must be a string/],
			["parameters", { parameters: "object" }, /parameters must be a plain object/],
			["parameter-type", { parameters: { type: "array" } }, /parameters\.type must be "object"/],
		];

		for (const [name, schema, reason] of cases) {
			const agentDir = join(root, `invalid-schema-${name}`);
			await writePyPlugin(agentDir, name, "import sys; sys.stdout.write('null')\n");
			const sidecarPath = await writeSchema(agentDir, name, schema);
			await assert.rejects(
				loadPythonPlugins(specFor(agentDir, [name]), createToolRegistry()),
				(err: unknown) => {
					assert.ok(err instanceof InvalidPluginError);
					assert.ok(err.message.includes(sidecarPath));
					assert.match(err.message, reason);
					return true;
				},
			);
		}
	});

	it("exports resolution limited to .py", async () => {
		const agentDir = join(root, "resolver");
		await mkdir(join(agentDir, "tools"), { recursive: true });
		await writeFile(join(agentDir, "tools", "javascript.mjs"), "export default () => null;\n", "utf8");
		assert.equal(await resolvePythonScript(agentDir, "javascript"), null);
		const pythonPath = await writePyPlugin(agentDir, "python", "pass\n");
		assert.equal(await resolvePythonScript(agentDir, "python"), pythonPath);
	});

	it("skips names already present in the registry (pre-registered wins)", async () => {
		const agentDir = join(root, "skip");
		await writePyPlugin(
			agentDir,
			"pre",
			'import json, sys\njson.dump({"from_py": True}, sys.stdout)\n',
		);
		const registry = createToolRegistry();
		registry.register("pre", async () => ({ from_pre: true }));
		const result = await loadPythonPlugins(
			specFor(agentDir, ["pre"]),
			registry,
		);
		assert.deepEqual([...result.skipped], ["pre"]);
		assert.equal(result.loaded.length, 0);
	});

	it("records missing tools in result.missing", async () => {
		const agentDir = join(root, "missing");
		await mkdir(join(agentDir, "tools"), { recursive: true });
		const registry = createToolRegistry();
		const result = await loadPythonPlugins(
			specFor(agentDir, ["nope"]),
			registry,
		);
		assert.deepEqual([...result.missing], ["nope"]);
	});

	it("reports loaded/skipped/missing breakdown across a mixed spec", async () => {
		const agentDir = join(root, "mixed");
		await writePyPlugin(agentDir, "a", "import sys; sys.stdout.write('null')\n");
		await writePyPlugin(agentDir, "c", "import sys; sys.stdout.write('null')\n");
		const registry = createToolRegistry();
		registry.register("b", async () => null);
		const result = await loadPythonPlugins(
			specFor(agentDir, ["a", "b", "c", "d"]),
			registry,
		);
		assert.deepEqual([...result.loaded], ["a", "c"]);
		assert.deepEqual([...result.skipped], ["b"]);
		assert.deepEqual([...result.missing], ["d"]);
	});
});

describe(
	"python plugin handler — subprocess protocol (G3b)",
	{ skip: !HAVE_PYTHON },
	() => {
		let root = "";
		before(async () => {
			root = await mkdtemp(join(tmpdir(), "py-handler-"));
		});
		after(async () => {
			if (root) await rm(root, { recursive: true, force: true });
		});

		it("passes JSON args through stdin + returns parsed stdout JSON", async () => {
			const script = await writePyPlugin(
				root,
				"double",
				'import json, sys\nargs = json.load(sys.stdin)\njson.dump({"result": args["x"] * 2}, sys.stdout)\n',
			);
			const handler = makePythonPluginHandler("double", script);
			const result = await handler({ x: 21 }, ctx);
			assert.deepEqual(result, { result: 42 });
		});

		it("surfaces non-zero exit as PythonPluginError with stderr", async () => {
			const script = await writePyPlugin(
				root,
				"crash",
				'import sys\nsys.stderr.write("boom")\nraise SystemExit(3)\n',
			);
			const handler = makePythonPluginHandler("crash", script);
			await assert.rejects(handler(null, ctx), (err: unknown) => {
				assert.ok(err instanceof PythonPluginError);
				const pe = err as PythonPluginError;
				assert.equal(pe.toolName, "crash");
				assert.equal(pe.exitCode, 3);
				assert.match(pe.stderr, /boom/);
				return true;
			});
		});

		it("wraps non-JSON stdout as PythonPluginError with full capture", async () => {
			const script = await writePyPlugin(
				root,
				"malformed",
				'import sys\nsys.stdout.write("not json")\n',
			);
			const handler = makePythonPluginHandler("malformed", script);
			await assert.rejects(handler({}, ctx), (err: unknown) => {
				assert.ok(err instanceof PythonPluginError);
				const pe = err as PythonPluginError;
				assert.equal(pe.exitCode, 0);
				assert.match(pe.stdout, /not json/);
				assert.match(pe.message, /not valid JSON/);
				return true;
			});
		});

		it("returns null for an empty stdout (plugin explicitly returns nothing)", async () => {
			const script = await writePyPlugin(root, "silent", "pass\n");
			const handler = makePythonPluginHandler("silent", script);
			const result = await handler({}, ctx);
			assert.equal(result, null);
		});

		it("respects timeoutMs + throws PythonPluginTimeoutError", async () => {
			const script = await writePyPlugin(
				root,
				"slow",
				"import time\ntime.sleep(5)\n",
			);
			const handler = makePythonPluginHandler("slow", script, {
				timeoutMs: 100,
			});
			await assert.rejects(handler({}, ctx), (err: unknown) => {
				assert.ok(err instanceof PythonPluginTimeoutError);
				assert.equal((err as PythonPluginTimeoutError).toolName, "slow");
				assert.equal((err as PythonPluginTimeoutError).timeoutMs, 100);
				return true;
			});
		});

		it("honours AbortController — aborts kill the subprocess", async () => {
			const script = await writePyPlugin(
				root,
				"wait",
				"import time\ntime.sleep(10)\n",
			);
			const ac = new AbortController();
			const handler = makePythonPluginHandler("wait", script);
			setTimeout(() => ac.abort(), 50);
			await assert.rejects(
				handler({}, { ...ctx, signal: ac.signal }),
				/aborted|killed/,
			);
		});

		it("forwards env when passed + isolates when env={}", async () => {
			const script = await writePyPlugin(
				root,
				"envread",
				'import json, os, sys\njson.dump({"v": os.environ.get("MIKRO_TEST_VAR", "<unset>")}, sys.stdout)\n',
			);
			const seen = await makePythonPluginHandler("envread", script, {
				env: { MIKRO_TEST_VAR: "hello", PATH: process.env.PATH ?? "" },
			})({}, ctx);
			assert.deepEqual(seen, { v: "hello" });
			const isolated = await makePythonPluginHandler("envread", script, {
				env: { PATH: process.env.PATH ?? "" },
			})({}, ctx);
			assert.deepEqual(isolated, { v: "<unset>" });
		});

		it("missing interpreter surfaces as PythonPluginError at call time", async () => {
			const script = await writePyPlugin(root, "any", "pass\n");
			const handler = makePythonPluginHandler("any", script, {
				pythonBin: "/path/to/definitely/not/a/real/python",
			});
			await assert.rejects(handler({}, ctx), (err: unknown) => {
				assert.ok(err instanceof PythonPluginError);
				return true;
			});
		});

		it("missing script file short-circuits with a clear error", async () => {
			const handler = makePythonPluginHandler(
				"ghost",
				join(root, "tools", "nope.py"),
			);
			await assert.rejects(handler({}, ctx), (err: unknown) => {
				assert.ok(err instanceof PythonPluginError);
				assert.match(
					(err as PythonPluginError).message,
					/script missing/,
				);
				return true;
			});
		});
	},
);
