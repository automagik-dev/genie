# Recipe — `codebase-qa`

Answers a factual question about a directory of code or docs passed as
context, citing `path/to/file.ts:line` for every claim.

```
examples/agents/codebase-qa/
├── agent.yaml       # shape: loop, model: station/Qwen3.6-35B-A3B-MTP-GGUF, 8 iterations
├── SYSTEM.md        # the citation contract, 4 rules, 469 bytes
└── README.md        # you are here
```

> Not to be confused with [`examples/codebase-qa/`](../../codebase-qa/), which
> is an `mikro.yaml` **config** example (a whole-project setup for `mikro
> "query" --context ./src/`). This directory is an `agent.yaml`
> **microagent** — a different artifact with a different install path.

## Install

```bash
cp -r examples/agents/codebase-qa ~/.mikro/agents/codebase-qa          # global
cp -r examples/agents/codebase-qa <project>/.mikro/agents/codebase-qa  # project
```

A host running `mikro mcp` then sees an `mikro_codebase-qa` tool.

## Use

An `agent.yaml` recipe has no CLI entry point — `mikro "query"` runs the ambient
config, not an agent (`mikro --help`). A microagent is reached **as an MCP
tool**: run `mikro mcp` from your host and call `mikro_codebase-qa` with the
question as `prompt` and the directory as `context` (every agent tool takes
both — `src/mcp/server.ts`, `CONTEXT_PROPERTY`; `context` is resolved relative
to the server's working directory). In-process, the SDK path is
`sdk.loadAgentSpec(dir)` + `runAgent(...)` — see
[`../hello-world/README.md`](../hello-world/README.md) for a worked example.

## Why this one is archived rather than deleted

`explore` and `explore-r` cover the same question class — "where/how is X done
here" — with a longer prompt, a REPL search discipline and, in `explore-r`, a
recursive fan-out. It is tempting to write that they *replace* this recipe.
**They do not, on the evidence.**

The explore parity gate ran that class of recipe against native Claude Code
Explore on six mined tasks and **failed both rounds**: round 1 scored 0 of 6
tasks against a bar of 5 of 6 across the whole `deepseek-v4-flash` →
`mimo-v2.5` → `kimi-code` → `claude-haiku` escalation ladder, and round 2's
recursive shot scored **0 of 6** again — criteria 2 and 3 (citations resolve,
nothing fabricated) passed on all six, criterion 1 (fact coverage) passed on
none (`docs/parity-explore.md`, *Gate arithmetic*). No measurement anywhere in
this repository compares `explore-r` to `codebase-qa` on anything. "explore-r
replaces codebase-qa" is positioning; the demonstrated result is that the
replacement candidate does not clear the bar the incumbent was never held to
either.

So this recipe is kept, in full, as a recipe. If you want the smallest
citation-disciplined Q&A prompt that exists here — 469 bytes, four rules, one
model line — it is this one, and it is 45× shorter than `explore-r`'s
`SYSTEM.md`.

Pick by shape of the job, not by a ranking that was never established:

| | `codebase-qa` | [`explore`](../explore/) | [`explore-r`](../explore-r/) |
|---|---|---|---|
| Input | a directory you pass as `context` | the repository the server's `--dir` points at | same |
| `SYSTEM.md` | 469 B | 17,874 B | 21,459 B |
| `budget.max_iterations` | 8 | 24 | 14 |
| Sub-agents | none | none | up to 4 concurrent recursive children |
| Measured by | nothing | `docs/parity-explore.md` round 1 (gate FAIL) | round 2 measured a **descendant**, not this file — see below |
| Default model | `station/…` (local, $0) | `khal/deepseek-v4-flash` | `khal/deepseek-v4-flash` |

The last row needs saying plainly: the shipped `examples/agents/explore-r/`
is the round-2 optimizer's **gen-0** (`SYSTEM.md` sha256 `06c6ea94…`,
byte-identical to `parity/round2/optimizer/gens/gen-0/recipe/`). Every round-2
number — the four-model matrix, the holdout, the frozen shot — was produced by
**gen-1** (`02184f35…`), a mutated descendant that was never shipped back into
`examples/`. The two share an `agent.yaml` (`20f8e018…`) and differ in
`SYSTEM.md`. So "explore-r scored X" is a statement about gen-1, and this
directory is not it.

## Provenance

Copied verbatim from this host's `~/.mikro/agents/codebase-qa/` on 2026-07-27
under wish `mikro-microagent-plugin` (B5). Both files are byte-identical to the
source:

| file | sha256 |
|---|---|
| `agent.yaml` | `7ce6a37db53bc14b8b0d8023fa3a57515062439b939d7d2201869564fbc1307f` |
| `SYSTEM.md` | `dd79b6e88f777f1146473bbad82ad00ef82f18325460572debba793d3d2e3fc2` |

The host copy dates from 2026-07-25.

## Removing the host copy — a user step, not something mikro did

The archival that put this file here **did not delete anything under your home
directory**, and nothing in mikro will. Given the section above, think twice:
removing `~/.mikro/agents/codebase-qa/` costs you a working tool on the strength
of a replacement claim that no run in this repository supports. If you still
want it gone, that is your command:

```bash
rm -rf ~/.mikro/agents/codebase-qa
```

Removing the host copy removes `mikro_codebase-qa` from every host session until
you install it again from here.
