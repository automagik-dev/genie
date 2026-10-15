// Run in a separate Node host: an unhandled stdin error must fail the parent test.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	makePythonPluginHandler,
	PythonPluginError,
	PythonPluginTimeoutError,
} from "../../src/sdk/python-plugin.js";

const root = await mkdtemp(join(tmpdir(), "python-host-"));
const controller = new AbortController();
const ctx = { tool: "probe", sessionId: "probe", iteration: 1, signal: controller.signal };
const largeArgs = { payload: "x".repeat(4 * 1024 * 1024) };
async function script(name: string, source: string): Promise<string> {
	const path = join(root, `${name}.py`);
	await writeFile(path, source);
	return path;
}
function noAbortListeners(signal = ctx.signal): void {
	assert.equal(getEventListeners(signal, "abort").length, 0);
}

try {
	const early = await script("early", 'import os, sys, time\nos.close(0)\ntime.sleep(0.05)\nsys.stderr.write("intentional early exit")\nsys.exit(7)\n');
	const echo = await script("echo", 'import json, sys\nargs = json.load(sys.stdin)\njson.dump({"length": len(args["payload"])}, sys.stdout)\n');
	for (let i = 0; i < 3; i++) {
		await assert.rejects(makePythonPluginHandler("early", early)(largeArgs, ctx), (error: unknown) => {
			assert.ok(error instanceof PythonPluginError);
			assert.equal(error.exitCode, 7);
			assert.equal(error.stderr, "intentional early exit");
			assert.match(error.message, /non-zero exit/);
			return true;
		});
		noAbortListeners();
		assert.deepEqual(await makePythonPluginHandler("echo", echo)(largeArgs, ctx), { length: largeArgs.payload.length });
		noAbortListeners();
	}
	console.log("early-exit: host survived 3 failures and 3 successful calls");

	const zero = await script("zero", 'import os, sys\nos.close(0)\nsys.stdout.write("{}")\n');
	await assert.rejects(makePythonPluginHandler("zero", zero)(largeArgs, ctx), (error: unknown) => {
		assert.ok(error instanceof PythonPluginError);
		assert.equal(error.exitCode, 0);
		assert.equal(error.stdout, "{}");
		assert.match(error.message, /stdin/);
		return true;
	});

	const invalid = await script("invalid", 'import sys\nsys.stdin.read()\nsys.stdout.write("not json")\n');
	await assert.rejects(makePythonPluginHandler("invalid", invalid)({}, ctx), /not valid JSON/);
	const nonzero = await script("nonzero", 'import sys\nsys.stdin.read()\nsys.stderr.write("ordinary failure")\nsys.exit(3)\n');
	await assert.rejects(makePythonPluginHandler("nonzero", nonzero)({}, ctx), (error: unknown) => {
		assert.ok(error instanceof PythonPluginError);
		assert.equal(error.exitCode, 3);
		assert.equal(error.stderr, "ordinary failure");
		return true;
	});

	const marker = join(root, "ready");
	const slow = await script("slow", `import os, time\nos.close(0)\nopen(${JSON.stringify(marker)}, "w").close()\ntime.sleep(60)\n`);
	await assert.rejects(makePythonPluginHandler("timeout", slow, { timeoutMs: 1000 })(largeArgs, ctx), PythonPluginTimeoutError);
	noAbortListeners();
	await rm(marker, { force: true });
	const abort = new AbortController();
	const pending = assert.rejects(makePythonPluginHandler("abort", slow, { timeoutMs: null })(largeArgs, { ...ctx, signal: abort.signal }), /aborted by caller/);
	try {
		const deadline = Date.now() + 15_000;
		while (!existsSync(marker)) {
			assert.ok(Date.now() < deadline, "Python did not reach stdin close");
			await delay(10);
		}
		// Give Node an event-loop turn to deliver the stdin error before aborting.
		await delay(20);
	} finally {
		abort.abort();
		await pending;
	}
	noAbortListeners(abort.signal);
	await assert.rejects(makePythonPluginHandler("pre-abort", slow, { timeoutMs: null })(largeArgs, { ...ctx, signal: abort.signal }), /aborted by caller/);
	noAbortListeners(abort.signal);

	await assert.rejects(makePythonPluginHandler("missing", echo, { pythonBin: join(root, "no-interpreter"), timeoutMs: null })(largeArgs, ctx), /spawn failed/);
	noAbortListeners();
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	await assert.rejects(makePythonPluginHandler("circular", echo, { timeoutMs: null })(circular, ctx), /stdin|serializ/i);
	noAbortListeners();
	assert.deepEqual(await makePythonPluginHandler("echo", echo)({ payload: "still alive" }, ctx), { length: 11 });
	noAbortListeners();
	console.log("protocol: success, nonzero, invalid JSON, stdin failure, timeout, abort, pre-abort, missing interpreter, serialization; no abort listeners retained");
} finally {
	await rm(root, { recursive: true, force: true });
}
