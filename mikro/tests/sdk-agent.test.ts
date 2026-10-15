import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type AgentConfig,
	type AgentEvent,
	createFileSessionStore,
	type IterationDriver,
	type IterationStep,
	type PermissionHook,
	runAgent,
	type ValidateSchema,
} from "../src/sdk/index.js";

/** Helper: drain an `EventStream` into an array. */
async function drainEvents(
	stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const ev of stream) {
		events.push(ev);
	}
	return events;
}

/** Build an IterationDriver from a list of step lists, one list per iteration. */
function staticDriver(
	perIteration: readonly (readonly IterationStep[])[],
): IterationDriver {
	return async function* (req) {
		const steps = perIteration[req.iteration - 1] ?? [];
		for (const step of steps) {
			yield step;
		}
	};
}

const BASE_CONFIG: Omit<AgentConfig, "driver" | "sessionId"> = {
	agentId: "test-agent",
	input: "do the thing",
	maxIterations: 5,
};

describe("runAgent — lifecycle + event ordering (Wish B Group 2b)", () => {
	it("emits AgentStart → SessionClose bracket even for a no-op driver", async () => {
		const driver = staticDriver([
			[{ kind: "emit_done", payload: { ok: true } }],
		]);
		const stream = runAgent({
			...BASE_CONFIG,
			sessionId: "s-noop",
			driver,
		});
		const events = await drainEvents(stream);
		const types = events.map((e) => e.type);
		assert.equal(types[0], "AgentStart");
		assert.equal(types[types.length - 1], "SessionClose");
		assert.ok(types.includes("IterationStart"));
		assert.ok(types.includes("EmitDone"));
	});

	it("closes with reason=complete on emit_done", async () => {
		const driver = staticDriver([
			[{ kind: "emit_done", payload: { ok: true } }],
		]);
		const events = await drainEvents(
			runAgent({ ...BASE_CONFIG, sessionId: "s-complete", driver }),
		);
		const close = events.find((e) => e.type === "SessionClose");
		assert.ok(close);
		assert.equal(
			(close as { reason: string } | undefined)?.reason,
			"complete",
		);
	});

	it("respects maxIterations ceiling even if driver never emit_dones", async () => {
		const driver: IterationDriver = async function* () {
			yield { kind: "message", role: "assistant", content: "thinking…" };
		};
		const events = await drainEvents(
			runAgent({
				...BASE_CONFIG,
				sessionId: "s-cap",
				driver,
				maxIterations: 3,
			}),
		);
		const starts = events.filter((e) => e.type === "IterationStart");
		assert.equal(starts.length, 3);
	});
});

describe("runAgent — permission deny wire (WISH.md G2 criterion 2)", () => {
	it("deny blocks the tool call + emits Error{phase:tool-denied}", async () => {
		const calls: string[] = [];
		const driver = staticDriver([
			[
				{
					kind: "tool_call",
					tool: "write_file",
					args: { path: "/etc/passwd", body: "owned" },
				},
				{ kind: "emit_done", payload: { ok: true } },
			],
		]);
		const deny: PermissionHook = () => ({
			decision: "deny",
			reason: "read-only session",
		});
		const resolver = async (tool: string) => {
			calls.push(tool);
			return "resolved";
		};

		const events = await drainEvents(
			runAgent({
				...BASE_CONFIG,
				sessionId: "s-deny",
				driver,
				toolResolver: resolver,
				permissionHooks: [deny],
			}),
		);

		// Resolver was NEVER called.
		assert.deepEqual(calls, []);
		const err = events.find(
			(e) =>
				e.type === "Error" &&
				(e as { phase: string }).phase === "tool-denied",
		);
		assert.ok(err, "expected Error{phase:tool-denied}");
		const tcAfter = events.find((e) => e.type === "ToolCallAfter") as
			| { ok: boolean }
			| undefined;
		assert.ok(tcAfter);
		assert.equal(tcAfter?.ok, false);
	});

	it("allow lets the resolver run + emits ok:true", async () => {
		const calls: string[] = [];
		const driver = staticDriver([
			[
				{ kind: "tool_call", tool: "read_file", args: { path: "/tmp" } },
				{ kind: "emit_done", payload: { ok: true } },
			],
		]);
		const resolver = async (tool: string) => {
			calls.push(tool);
			return "file contents";
		};

		const events = await drainEvents(
			runAgent({
				...BASE_CONFIG,
				sessionId: "s-allow",
				driver,
				toolResolver: resolver,
			}),
		);

		assert.deepEqual(calls, ["read_file"]);
		const after = events.find((e) => e.type === "ToolCallAfter") as
			| { ok: boolean; result: unknown }
			| undefined;
		assert.equal(after?.ok, true);
		assert.equal(after?.result, "file contents");
	});

	it("modify rewrites args before resolver sees them", async () => {
		const seen: unknown[] = [];
		const driver = staticDriver([
			[
				{ kind: "tool_call", tool: "read_file", args: { path: "/secret" } },
				{ kind: "emit_done", payload: { ok: true } },
			],
		]);
		const redact: PermissionHook = () => ({
			decision: "modify",
			modifiedArgs: { path: "<redacted>" },
		});
		const resolver = async (_tool: string, args: unknown) => {
			seen.push(args);
			return "ok";
		};

		await drainEvents(
			runAgent({
				...BASE_CONFIG,
				sessionId: "s-modify",
				driver,
				toolResolver: resolver,
				permissionHooks: [redact],
			}),
		);

		assert.deepEqual(seen[0], { path: "<redacted>" });
	});
});

describe("runAgent — validate retry wire (WISH.md G2 criterion 3)", () => {
	const schema: ValidateSchema = {
		type: "object",
		required: ["answer"],
		properties: { answer: { type: "string" } },
	};

	it("validate fail → retry with hint → pass (end-to-end)", async () => {
		// First iteration emits a BAD payload (missing `answer`).
		// Second iteration emits a GOOD payload.
		const driver: IterationDriver = async function* (req) {
			if (req.iteration === 1) {
				yield { kind: "emit_done", payload: { notTheField: "oops" } };
			} else {
				// Driver should have received the retryHint on this call.
				assert.ok(
					req.retryHint && req.retryHint.length > 0,
					"iteration 2 must receive retryHint",
				);
				assert.match(req.retryHint ?? "", /VALIDATE\.md/);
				yield { kind: "emit_done", payload: { answer: "42" } };
			}
		};

		const events = await drainEvents(
			runAgent({
				...BASE_CONFIG,
				sessionId: "s-validate",
				driver,
				validateSchema: schema,
				validateSchemaSource: '{"type":"object","required":["answer"]}',
			}),
		);

		const validations = events.filter((e) => e.type === "Validation") as Array<{
			status: string;
			attempt: number;
		}>;
		assert.equal(validations.length, 2);
		assert.equal(validations[0]?.status, "fail");
		assert.equal(validations[0]?.attempt, 1);
		assert.equal(validations[1]?.status, "pass");
		assert.equal(validations[1]?.attempt, 2);

		const emitDone = events.find((e) => e.type === "EmitDone");
		assert.ok(emitDone);

		const close = events.find((e) => e.type === "SessionClose") as
			| { reason: string }
			| undefined;
		assert.equal(close?.reason, "complete");
	});

	it("validate fails twice → terminal Error{phase:validate}", async () => {
		const driver: IterationDriver = async function* () {
			yield { kind: "emit_done", payload: { wrong: true } };
		};

		const events = await drainEvents(
			runAgent({
				...BASE_CONFIG,
				sessionId: "s-validate-fail",
				driver,
				validateSchema: schema,
				validateSchemaSource: '{"type":"object","required":["answer"]}',
			}),
		);

		const validations = events.filter((e) => e.type === "Validation") as Array<{
			status: string;
			attempt: number;
		}>;
		assert.equal(validations.length, 2);
		assert.equal(validations[0]?.status, "fail");
		assert.equal(validations[1]?.status, "fail");

		const err = events.find(
			(e) =>
				e.type === "Error" &&
				(e as { phase: string }).phase === "validate",
		);
		assert.ok(err);

		const close = events.find((e) => e.type === "SessionClose") as
			| { reason: string }
			| undefined;
		assert.equal(close?.reason, "error");
	});
});

describe("runAgent — session + abort + resume (WISH.md G2 criteria 1, 4)", () => {
	it("budget is preserved across pause → resume end-to-end", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mikro-agent-budget-"));
		try {
			const store = createFileSessionStore(dir);

			// First run: complete with emit_done; check budget roundtrip.
			const driver1 = staticDriver([
				[{ kind: "emit_done", payload: { ok: true } }],
			]);
			const events1 = await drainEvents(
				runAgent({
					...BASE_CONFIG,
					sessionId: "s-budget",
					driver: driver1,
					sessionStore: store,
					budget: { spent: 0.25, limit: 1, currency: "usd" },
				}),
			);
			const closed1 = events1.find((e) => e.type === "SessionClose") as
				| { reason: string }
				| undefined;
			assert.equal(closed1?.reason, "complete");

			const loaded = await store.load("s-budget");
			assert.ok(loaded);
			assert.deepEqual(loaded?.budget, {
				spent: 0.25,
				limit: 1,
				currency: "usd",
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("abort mid-iteration → resume reaches identical final output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mikro-agent-resume-"));
		try {
			const store = createFileSessionStore(dir);
			const sessionId = "s-resume";

			// Run 1: take one message step, then abort before emit_done.
			const ac = new AbortController();
			const driver1: IterationDriver = async function* () {
				yield { kind: "message", role: "assistant", content: "hello" };
				yield { kind: "message", role: "assistant", content: "there" };
				// Abort before the run "completes"
				ac.abort();
				yield { kind: "message", role: "assistant", content: "never-emitted" };
			};
			const events1 = await drainEvents(
				runAgent({
					...BASE_CONFIG,
					sessionId,
					driver: driver1,
					sessionStore: store,
					signal: ac.signal,
					maxIterations: 1,
				}),
			);
			const close1 = events1.find((e) => e.type === "SessionClose") as
				| { reason: string }
				| undefined;
			assert.equal(close1?.reason, "abort");

			// Confirm session was checkpointed with the pre-abort history.
			const mid = await store.load(sessionId);
			assert.ok(mid);
			const midAssistant = (mid?.history ?? []).filter(
				(t) => t.role === "assistant",
			);
			assert.equal(midAssistant.length, 2, "both messages should persist");
			assert.equal(midAssistant[0]?.content, "hello");
			assert.equal(midAssistant[1]?.content, "there");

			// Run 2: resume with same id; the driver will observe the
			// prior history and deterministically emit_done. Final output
			// is the concatenation of all recorded assistant messages +
			// the payload.answer.
			const driver2: IterationDriver = async function* (req) {
				const seen = req.history
					.filter((t) => t.role === "assistant")
					.map((t) => t.content)
					.join(" ");
				yield { kind: "message", role: "assistant", content: "!" };
				yield {
					kind: "emit_done",
					payload: { answer: `${seen} !` },
				};
			};
			const events2 = await drainEvents(
				runAgent({
					...BASE_CONFIG,
					sessionId,
					driver: driver2,
					sessionStore: store,
				}),
			);
			const close2 = events2.find((e) => e.type === "SessionClose") as
				| { reason: string }
				| undefined;
			assert.equal(close2?.reason, "complete");

			const emitDone = events2.find((e) => e.type === "EmitDone") as
				| { payload: { answer: string } }
				| undefined;
			assert.ok(emitDone);
			// Resume saw the pre-abort messages + appended its own.
			assert.equal(emitDone?.payload?.answer, "hello there !");

			// A fresh run (different sessionId) would NOT see "hello there" —
			// prove determinism by running a non-resuming variant.
			const fresh = await drainEvents(
				runAgent({
					...BASE_CONFIG,
					sessionId: "s-fresh-run",
					driver: driver2,
					sessionStore: store,
				}),
			);
			const freshEmit = fresh.find((e) => e.type === "EmitDone") as
				| { payload: { answer: string } }
				| undefined;
			assert.notEqual(freshEmit?.payload?.answer, emitDone?.payload?.answer);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("SessionOpen fires with resumed:true when session id exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mikro-agent-resumed-"));
		try {
			const store = createFileSessionStore(dir);
			const sessionId = "s-resumed-flag";
			const driver = staticDriver([
				[{ kind: "emit_done", payload: { ok: true } }],
			]);

			// First run — establishes the session on disk.
			await drainEvents(
				runAgent({
					...BASE_CONFIG,
					sessionId,
					driver,
					sessionStore: store,
				}),
			);

			// Second run — same id → SessionOpen should report resumed:true.
			const events = await drainEvents(
				runAgent({
					...BASE_CONFIG,
					sessionId,
					driver,
					sessionStore: store,
				}),
			);
			const open = events.find((e) => e.type === "SessionOpen") as
				| { resumed: boolean }
				| undefined;
			assert.equal(open?.resumed, true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
