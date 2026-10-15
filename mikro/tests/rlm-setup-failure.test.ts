import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import type { LoadedContext } from "../src/context.js";
import type { Logger } from "../src/logger.js";
import { rlmLoop } from "../src/rlm.js";
import type { AgentEvent } from "../src/sdk/events.js";
import { createEmitter } from "../src/sdk/index.js";

/**
 * Gap 1 regression (Wish B live-tui G2 fixer).
 *
 * A throw in rlmLoop's SETUP region — the storage start/ingest, prompt build
 * and cache hashing that run BEFORE the main run loop's `try` — must still
 * close a caller-supplied emitter. Otherwise the headless subscriber / the
 * mikro-acp adapter, which subscribe BEFORE the run starts, would `for await`
 * forever because no SessionClose is emitted and emitter.close() never runs.
 */
describe("rlmLoop — setup-region failure closes a caller-supplied emitter", () => {
	it("emits Error + SessionClose and closes the emitter when setup throws", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mikro-gap1-"));
		const config = await loadConfig(dir); // defaults — no infra needed

		const emitter = createEmitter();

		// Subscribe BEFORE the run starts (the seam the fix protects).
		const seen: string[] = [];
		let iteratorReturned = false;
		const consumer = (async () => {
			for await (const ev of emitter as AsyncIterable<AgentEvent>) {
				seen.push(ev.type);
			}
			// Reached only if the emitter was actually closed.
			iteratorReturned = true;
		})();

		// Force a deterministic throw INSIDE the guarded setup region: the
		// cache path calls logger.cacheInit() before the main `try`. No
		// network / pgserve needed.
		const throwingLogger = {
			runId: "gap1",
			cacheInit() {
				throw new Error("BOOM setup failure (simulated)");
			},
		} as unknown as Logger;
		const context: LoadedContext = {
			type: "string",
			content: "hello",
			metadata: "",
		};

		await assert.rejects(
			rlmLoop("q", context, config, {
				emitter,
				cache: true,
				logger: throwingLogger,
			}),
			/BOOM setup failure/,
		);

		// The consumer must terminate — pre-fix it would hang forever.
		const outcome = await Promise.race([
			consumer.then(() => "finished" as const),
			new Promise<"hung">((r) => setTimeout(() => r("hung"), 2000)),
		]);

		assert.equal(outcome, "finished", "subscriber for-await must return");
		assert.equal(iteratorReturned, true);
		assert.equal(emitter.closed, true);
		assert.ok(seen.includes("AgentStart"), "opening event delivered");
		assert.ok(seen.includes("Error"), "setup failure surfaced as Error event");
		assert.ok(
			seen.includes("SessionClose"),
			"SessionClose emitted so consumers can finalize",
		);
	});
});
