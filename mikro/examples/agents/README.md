# `examples/agents/` — the recipe tree

Every `agent.yaml` microagent this repository ships lives here, and nowhere
else. A directory in this tree is a **recipe**: copy it into a discovery root
and `mikro mcp` exposes it as a tool.

```bash
cp -r examples/agents/<name> ~/.mikro/agents/<name>          # global
cp -r examples/agents/<name> <project>/.mikro/agents/<name>  # project (the convention)
```

Discovery roots, in precedence order, are `<project>/.mikro/agents/`,
`<project>/.agents/`, then `~/.mikro/agents/` — project shadows global, and
`MIKRO_AGENTS_DIR` (colon-separated) replaces every root. Schema:
[`docs/agent-yaml-schema.md`](../../docs/agent-yaml-schema.md).

## The recipes

| recipe | what it does | `shape` | default model | gated by |
|---|---|---|---|---|
| [`explore/`](explore/) | answers a question about the repo the server runs in, with `file:line` citations | `loop` | `khal/deepseek-v4-flash` | `scripts/smoke-explore.mjs`; scored in `docs/parity-explore.md` round 1 |
| [`explore-r/`](explore-r/) | the same, partitioned across up to 4 concurrent recursive children | `recurse` | `khal/deepseek-v4-flash` | round-2 campaign — but the numbers are a **descendant's**, see below |
| [`codebase-qa/`](codebase-qa/) | factual Q&A over a directory you pass as `context`, 469-byte prompt | `loop` | `station/Qwen3.6-35B-A3B-MTP-GGUF` | spec only ¹ |
| [`changelog/`](changelog/) | `git log` output → Keep a Changelog entries | `loop` | `station/Qwen3.6-35B-A3B-MTP-GGUF` | spec only ¹ |
| [`log-triage/`](log-triage/) | long build/CI log → the failure, its `file:line`, the cause | `loop` | `station/Qwen3.6-35B-A3B-MTP-GGUF` | spec only ¹ |
| [`hello-world/`](hello-world/) | minimum viable agent: one TS tool, one iteration | `single-step` | — | `tests/example-hello-world.test.ts` |
| [`research-agent/`](research-agent/) | fetch-and-summarise with a permission chain | `loop` | — | `tests/example-research-agent.test.ts` |
| [`brain-triage/`](brain-triage/) | the Python-plugin pattern in minimal form | `single-step` | — | `tests/example-brain-triage.test.ts` |

¹ **"Spec only" is not a euphemism.** `tests/examples-agents-recipes.test.ts`
proves those three *load* — shape, model, `system:` and `budget` are pinned so
the archive cannot drift. **Nothing measures what they answer.** They have no
smoke test, no scored suite and no parity arm anywhere in this repository; they
are here because they were written and used, not because they were measured.
Each README says so in its own words.

**The `explore-r` caveat.** This directory holds the round-2 optimizer's
**gen-0** (`SYSTEM.md` sha256 `06c6ea94…`). The round-2 numbers — the
four-model matrix, the holdout, the frozen shot — were all produced by
**gen-1** (`02184f35…`), a mutated descendant that was never shipped back
here. Same `agent.yaml` (`20f8e018…`), different `SYSTEM.md`. Read
[`docs/worker-models.md`](../../docs/worker-models.md) before quoting any of
those numbers about this file.

## Where each of these came from

`explore/` and `explore-r/` were authored in-repo. `codebase-qa/`,
`changelog/` and `log-triage/` were **archived** on 2026-07-27 from this
host's `~/.mikro/agents/`, copied byte-for-byte (sha256 in each README) under
wish `mikro-microagent-plugin` (B5). `hello-world/`, `research-agent/` and
`brain-triage/` moved here from flat `examples/<name>/` directories in the
same change, so that one tree holds every recipe; their tests moved with them.

The archival **copies**. It does not delete: nothing in mikro removes a file
from your home directory, and this change did not. Each archived recipe's
README documents the `rm -rf ~/.mikro/agents/<name>` you may choose to run
yourself, and what you lose by running it.

## Config examples are elsewhere

[`examples/`](../) also holds `mikro.yaml` **config** examples —
`tauri-docs/`, `codebase-qa/`, `paper-review/`, `cag-*`, `gemini-*`. Those
configure a whole `mikro "query" --context …` run; they are not microagents and
do not go in a discovery root. Note the name collision: `examples/codebase-qa/`
(config) and `examples/agents/codebase-qa/` (microagent) are different
artifacts.

## Reserved directory names

A directory whose name ends in **`.proposed`** is reserved for an unapproved
draft — the shape `/microagent-create` writes so that a proposal is inert
until a human renames it. Do not name a shipped recipe `<name>.proposed`.
