# Example — brain-triage

Mirrors the `brain-triage` agent from the khal-os/brain repo (wish A
foundation) in miniature. Demonstrates a Python-plugin tool wired
into the SDK's tool registry, with the same folder shape brain's
real agents use.

```
examples/agents/brain-triage/
├── agent.yaml           # tools: [search_corpus], shape: single-step
├── SYSTEM.md            # role + output schema hint
├── tools/
│   └── search_corpus.py # stdin→JSON, stdout→JSON Python plugin
└── README.md            # you are here
```

## What's inside the plugin

A self-contained Python script with a 3-document fake corpus and a
naive token-overlap scorer — no external dependencies, no vault to
mount. Follow the SDK stdio-JSON protocol:

```python
args = json.load(sys.stdin)     # { query: "...", limit?: int }
# ...
json.dump(result, sys.stdout)   # { query, hits: [...] }
```

Run it standalone to verify (requires `python3`):

```bash
echo '{"query":"carol divorcio", "limit":2}' | python3 examples/agents/brain-triage/tools/search_corpus.py
```

## Wiring — hermetic

```ts
import { join } from "node:path";
import { sdk } from "mikro";

const dir = join(import.meta.dir, "..", "examples", "agents", "brain-triage");
const spec = await sdk.loadAgentSpec(dir);

const registry = sdk.createToolRegistry();
const py = await sdk.loadPythonPlugins(spec, registry, {
	timeoutMs: 15_000,
});
// py.loaded === ["search_corpus"]

const driver = async function* (req) {
	yield {
		kind: "tool_call",
		tool: "search_corpus",
		args: { query: req.history[0].content, limit: 1 },
	};
	yield {
		kind: "emit_done",
		payload: {
			query: req.history[0].content,
			best_match_id: "case-001",
			confidence: 0.82,
			reason: "top hit with highest token overlap",
		},
	};
};

for await (const ev of sdk.runAgent({
	agentId: "brain-triage",
	sessionId: `triage-${Date.now()}`,
	input: "carol divorcio",
	driver,
	toolRegistry: registry,
})) {
	console.log(ev.type);
}
```

## Cross-repo story

In the real brain repo (`khal-os/brain`), an equivalent agent lives at
`.agents/triage/` with `brain/python/brain_tools.py` providing the
real `search_corpus`, `read`, and `propose_yaml` tools. That runner
currently wraps the Python tools via its own CLI path; once brain
adopts the SDK directly, the agent folder can load through
`loadPythonPlugins` with zero change to the Python side. This example
proves the SDK's side of that contract in isolation.

## Smoke test

`tests/example-brain-triage.test.ts` runs the full loop with the real
Python subprocess + asserts:
- `search_corpus` resolves from `.py` (not shadowed by a TS/MJS miss).
- The tool call executes and returns a result shape matching
  `{ query, hits: Array<{ id, title, score, snippet }> }`.
- `SessionClose{reason:"complete"}` fires.

Test auto-skips when `python3` is unavailable, matching the broader
G3b behaviour.
