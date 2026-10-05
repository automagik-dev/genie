# Example — research-agent

Research agent that demonstrates the SDK feature set:
- **Tool plugin loader** resolves `fetch-url` from `tools/`.
- **Permission hooks** block internal hosts before the fetch fires.
- **Validate primitive** enforces a structured output schema via
  `VALIDATE.md` with retry-once on malformed payloads.
- **Session checkpointing** persists history across iterations.

```
examples/agents/research-agent/
├── agent.yaml           # tools: [fetch-url]
├── SYSTEM.md            # agent role + instructions
├── VALIDATE.md          # JSON schema fence the validator enforces
├── tools/
│   └── fetch-url.mjs    # HTTP GET with strip-HTML pass
└── README.md            # you are here
```

## Wiring — hermetic

```ts
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { sdk } from "mikro";

const dir = join(import.meta.dir, "..", "examples", "agents", "research-agent");
const spec = await sdk.loadAgentSpec(dir);

const registry = sdk.createToolRegistry();
await sdk.loadPluginTools(spec, registry);

const validateMd = await readFile(join(dir, "VALIDATE.md"), "utf8");
const { schema, rawBlock } = sdk.parseValidateMd(validateMd);

// Canned driver for the smoke test (full flow, no LLM):
const driver = async function* (req) {
	if (req.iteration === 1) {
		yield {
			kind: "tool_call",
			tool: "fetch-url",
			args: { url: "https://example.com" },
		};
		yield {
			kind: "emit_done",
			payload: {
				summary: "Example.com is an IANA reserved domain.",
				citations: [
					{ url: "https://example.com", note: "Primary source" },
				],
			},
		};
	} else {
		yield {
			kind: "emit_done",
			payload: {
				summary: "insufficient evidence",
				citations: [],
			},
		};
	}
};

for await (const ev of sdk.runAgent({
	agentId: "research",
	sessionId: `research-${Date.now()}`,
	input: "What is example.com?",
	driver,
	toolRegistry: registry,
	validateSchema: schema ?? undefined,
	validateSchemaSource: rawBlock ?? undefined,
	permissionHooks: [
		// Block internal hosts — pair with fetch-url to demonstrate
		// permission-hook composition.
		(ctx) => {
			if (ctx.tool !== "fetch-url") return { decision: "allow" };
			const args = ctx.args as { url?: string } | null;
			const url = args?.url ?? "";
			if (
				/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
					url,
				)
			) {
				return { decision: "deny", reason: "internal host blocked" };
			}
			return { decision: "allow" };
		},
	],
})) {
	console.log(ev.type);
}
```

## Wiring — live LLM

Swap the canned driver for `sdk.rlmDriver`:

```ts
const driver = sdk.rlmDriver({
	model: { provider: "google", model: "gemini-2.5-flash" },
	system: await readFile(join(dir, "SYSTEM.md"), "utf8"),
});
```

Needs `GEMINI_API_KEY` in env.

## What the smoke test proves

See `tests/example-research-agent.test.ts`:

- `fetch-url` loads from `tools/` and returns a structured result.
- Validate accepts the good payload on iteration 1 → `EmitDone` fires
  + `SessionClose{reason:"complete"}`.
- The permission hook rejects a `localhost` fetch with the expected
  `Error{phase:"tool-denied"}` event.
- Bad payload (missing `citations`) triggers retry with a hint — the
  next iteration sees `req.retryHint`.
