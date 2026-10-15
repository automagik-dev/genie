# Recipe — `log-triage`

Reads long, noisy machine output — build logs, test runs, CI output, stack
traces — and returns the failure, its `file:line`, the cause, and how much
noise it skipped. Use it instead of pasting a multi-thousand-line log inline.

```
examples/agents/log-triage/
├── agent.yaml       # shape: loop, model: station/Qwen3.6-35B-A3B-MTP-GGUF, 6 iterations
├── SYSTEM.md        # the fixed four-field answer shape
└── README.md        # you are here
```

## Install

```bash
cp -r examples/agents/log-triage ~/.mikro/agents/log-triage          # global
cp -r examples/agents/log-triage <project>/.mikro/agents/log-triage  # project
```

A host running `mikro mcp` then sees an `mikro_log-triage` tool.

## Use

An `agent.yaml` recipe has no CLI entry point — `mikro "query"` runs the ambient
config, not an agent (`mikro --help`). A microagent is reached **as an MCP
tool**: run `mikro mcp` from your host and call `mikro_log-triage` with the log
text as the prompt. In-process, the SDK path is `sdk.loadAgentSpec(dir)` +
`runAgent(...)` — see [`../hello-world/README.md`](../hello-world/README.md)
for a worked example.

The answer shape is fixed by `SYSTEM.md`: **Failure** / **Location** /
**Cause** / **Noise skipped**, nothing else.

## What it is, and what it is not

The value is the *token* saving, not a diagnosis: a 4,000-line CI log costs a
premium host model real money to read and costs $0 here. The two rules that
carry the weight are "the first error is often not the real one — prefer the
earliest error that explains the later ones" and "never invent a file or line
number; if the log does not contain one, say so".

Neither rule is verified by anything. There is **no gate on this recipe** — no
parity run, no smoke test, no scored suite — so treat its `Location:` line as
a pointer to check, not a fact to act on. That is the same standard the
measured recipes are held to (`docs/parity-explore.md` gates on whether a
citation *resolves*, and this one is never checked).

The model is `station/Qwen3.6-35B-A3B-MTP-GGUF` — local, keyless, $0 marginal
cost. Change the `model:` line for any other provider.

## Provenance

Copied verbatim from this host's `~/.mikro/agents/log-triage/` on 2026-07-27
under wish `mikro-microagent-plugin` (B5). Both files are byte-identical to the
source:

| file | sha256 |
|---|---|
| `agent.yaml` | `996c36364a461b8e25ed3a9de65491b43baa669e15b88ae757af9e5292a8b318` |
| `SYSTEM.md` | `64985150e6912a06d3b12007043d69b37f77b2e4851850e3be7385f617041fb9` |

The host copy dates from 2026-07-25.

## Removing the host copy — a user step, not something mikro did

The archival that put this file here **did not delete anything under your home
directory**, and nothing in mikro will. If you want the global copy gone now
that the recipe is in the repo:

```bash
rm -rf ~/.mikro/agents/log-triage
```

Removing the host copy removes `mikro_log-triage` from every host session until
you install it again from here.
