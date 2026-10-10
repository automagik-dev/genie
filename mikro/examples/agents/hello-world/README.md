# Example — hello-world

The absolute minimum mikro agent: one TS tool, one iteration, one
greeting. Proof-of-life for the SDK plumbing.

```
examples/agents/hello-world/
├── agent.yaml           # declares the `greet` tool
├── SYSTEM.md            # system prompt pointer
├── tools/
│   └── greet.mjs        # the tool plugin (default export = async fn)
└── README.md            # you are here
```

## Running with a canned driver (hermetic)

```ts
import { join } from "node:path";
import { sdk } from "mikro";

const here = join(import.meta.dir, "..", "examples", "agents", "hello-world");

const spec = await sdk.loadAgentSpec(here);
const registry = sdk.createToolRegistry();
await sdk.loadPluginTools(spec, registry);

const driver = async function* (req) {
	yield {
		kind: "tool_call",
		tool: "greet",
		args: { name: req.history[0].content },
	};
	yield { kind: "emit_done", payload: { ok: true } };
};

for await (const ev of sdk.runAgent({
	agentId: "hello-world",
	sessionId: `hello-${Date.now()}`,
	input: "Stéfani",
	driver,
	toolRegistry: registry,
})) {
	console.log(ev.type, ev.timestamp);
}
```

The smoke test at `tests/example-hello-world.test.ts` exercises this
flow against the real plugin loader and asserts the tool fires with
the expected name.

## Running with a live LLM (opt-in)

Wrap `rlmDriver` instead of the canned async generator:

```ts
const driver = sdk.rlmDriver({
	model: { provider: "google", model: "gemini-2.5-flash" },
	system: await readFile(join(here, "SYSTEM.md"), "utf8"),
});
```

Needs a `GEMINI_API_KEY` or `GOOGLE_API_KEY` in env. Cost per run: a
fraction of a cent for a single-shot model turn.
