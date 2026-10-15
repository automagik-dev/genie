# Recipe — `changelog`

Turns raw `git log` output into Keep a Changelog entries grouped under
`Added` / `Changed` / `Fixed` / `Security`.

```
examples/agents/changelog/
├── agent.yaml       # shape: loop, model: station/Qwen3.6-35B-A3B-MTP-GGUF, 6 iterations
├── SYSTEM.md        # the drafting rules
└── README.md        # you are here
```

## Install

```bash
cp -r examples/agents/changelog ~/.mikro/agents/changelog          # global
cp -r examples/agents/changelog <project>/.mikro/agents/changelog  # project
```

A host running `mikro mcp` then sees an `mikro_changelog` tool. Project agents
shadow global ones of the same name.

## Use

An `agent.yaml` recipe has no CLI entry point — `mikro "query"` runs the
ambient config, not an agent (`mikro --help`). A microagent is reached **as an
MCP tool**: run `mikro mcp` from your host and call `mikro_changelog`, pasting
the `git log --oneline <range>` output as the prompt. In-process, the SDK path
is `sdk.loadAgentSpec(dir)` + `runAgent(...)` — see
[`../hello-world/README.md`](../hello-world/README.md) for a worked example.

## What it is, and what it is not

It is a **formatting** agent. It reformats commit subjects into user-facing
bullets and drops the ones that are not user-visible. It cannot read the diff
those commits carry — the input is the log text you hand it, nothing else — so
a bullet is only as accurate as the commit subject it came from. `SYSTEM.md`
forbids inventing a change that is not in the input; it cannot forbid a commit
subject that was already wrong.

The model is `station/Qwen3.6-35B-A3B-MTP-GGUF` — local, keyless, $0 marginal
cost, and slow-ish. Any `khal/<model>` or cloud model works: change the
`model:` line, nothing else.

## Provenance

Copied verbatim from this host's `~/.mikro/agents/changelog/` on 2026-07-27
under wish `mikro-microagent-plugin` (B5). Both files are byte-identical to the
source:

| file | sha256 |
|---|---|
| `agent.yaml` | `6c9b9ac4aac34ef9dc196f13a26ca87daf09cabcab5140e58848830f9ab31a8a` |
| `SYSTEM.md` | `6deafc31f2512b066e096ab05fa199e0ab6c1b97d4a06f36288213e88a608048` |

The host copy dates from 2026-07-25 and has never been benchmarked — no parity
run, no smoke gate, no scored suite covers it. It is preserved here because it
was written and used, not because it was measured.

## Removing the host copy — a user step, not something mikro did

The archival that put this file here **did not delete anything under your
home directory**, and nothing in mikro will. If you want the global copy gone
now that the recipe is in the repo, that is your command to run:

```bash
rm -rf ~/.mikro/agents/changelog
```

Check first that nothing you rely on calls `mikro_changelog`, and note that the
repo copy is a recipe, not an installed agent: removing the host copy removes
the tool from every host session until you install it again from here.
