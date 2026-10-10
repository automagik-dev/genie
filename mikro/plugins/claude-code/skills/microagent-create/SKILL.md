---
name: microagent-create
description: "PROPOSE-ONLY — mine this host's recent Claude Code transcripts for work that keeps recurring and keeps returning bulk into context, rank those families by the context they burn, and write ONE draft mikro microagent into `.mikro/agents/<name>.proposed/` (agent.yaml + SYSTEM.md + EVIDENCE.md) for the user to approve. Read this skill when the user asks to create, propose, draft or suggest an mikro microagent, asks what is worth offloading, asks where their tokens are going and wants an agent for it, or runs /mikro:microagent-create. It never activates anything: `.proposed` is a reserved suffix that mikro discovery skips, so a draft is neither listed nor callable until the USER renames the directory. Do not use it to edit an existing agent, to run an agent, or to answer a question about a codebase (that is `mikro_explore-r`)."
---

# Proposing an mikro microagent from real usage

## The contract, first

**You measure, you draft, you stop.** The draft goes into
`.mikro/agents/<name>.proposed/` and nowhere else. You do not rename it, you do
not copy it somewhere it would load, and you do not offer to. The rename is the
user's, and it is the entire approval step.

The boundary is mechanical, not a promise: `discoverAgents` skips any directory
whose name ends `.proposed`, case-insensitively
(`src/mcp/agents.ts` — `isProposedDir`, applied in the discovery loop). Because
`tools/call` dispatches from the same scan that builds `tools/list`
(`src/mcp/server.ts:252`, `src/mcp/server.ts:771`), a draft is *neither listed
nor callable*; calling it by its would-be name answers `Unknown tool:
mikro_<name>_proposed`. Renaming publishes it on the next request, without a
reconnect. `tests/mcp-agents.test.ts` pins all of that.

Two consequences worth stating to the user:

- `.proposed` is **reserved**. An agent legitimately named `foo.proposed` would
  be permanently invisible. The skip's error surface is silence by design, so
  say so rather than letting them find out.
- Nothing you write is live. Do not describe the draft as "installed",
  "created", or "ready to use". It is a proposal on disk.

## Step 1 — measure, do not read

Run the bundled scanner. Do **not** open transcripts yourself: on an active
host they are ~100 MB a day, and reading them into this session to find out
what is filling this session would be the joke telling itself.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/microagent-create/scan-transcripts.mjs" --hours 24
```

It streams `~/.claude/projects/**/*.jsonl` and returns about a page: every tool
call bucketed into an offload family, ranked by the context that family's
results returned. Useful flags: `--hours N` (widen a quiet window),
`--min-calls N` (default 5), `--project <substring>`, `--json`, and
`--explain <family> --examples N` for the per-call drill-down with
`transcript:line` references.

The scanner prints two kinds of number and labels them. **Keep the labels.**

| Kind | What it is | How to write it |
|---|---|---|
| MEASURED | read verbatim from each assistant turn's `usage` block — the API's own counts | plain: `8,157,789 output tokens` |
| ESTIMATED | tool-result characters (exact) divided by 4 (a convention) | always with `~`: `~210,180 tok` |

Token-optimizer session data (`~/.claude/token-optimizer/quality-cache-*.json`)
is folded in when present and skipped when absent. It corroborates; it is not
the ranking.

## Step 2 — choose one candidate, and be able to defend it

A family at the top of the table is **not** automatically a candidate. Take the
highest-burn family that clears all five:

1. **Offloadable** — the scanner marks these `*`. Read-only work whose entire
   product is a written answer. Anything that writes, installs, deploys or runs
   a build is out, and stays out even when the same command also greps.
2. **Not already covered.** `repo-exploration` will usually top the table and
   is `explore-r`'s class — proposing it again proposes a duplicate. Check
   `.mikro/agents/`, `.agents/` and `~/.mikro/agents/` before choosing.
3. **Repeatable.** It recurs across sessions and projects, not once in one
   burst. Read `sess`, `proj` and `calls/sess` in the table, not just the total.
4. **Self-contained.** A question can be asked in one prompt and answered
   without a follow-up. The agent runs to completion and cannot ask you
   anything mid-run, so work that needs a conversation is not this.
5. **Bulk in, summary out.** High `med ch/call` is the tell: the family returns
   large payloads whose value to the session is a few lines of conclusion.

If nothing clears the bar, **propose nothing** and say why. A weak proposal
costs the user a review and teaches them to ignore the next one.

Pick exactly one. One defensible draft beats three speculative ones.

## Step 3 — write the draft

Create `.mikro/agents/<name>.proposed/` in the workspace root (the project the
user is in — the directory `mikro mcp` was started with via `--dir`). Three
files, all three required.

### `agent.yaml`

```yaml
schema_version: 1
tools_api: 1

shape: loop
model: khal/deepseek-v4-flash

description: >-
  One sentence a host model can route on: what question this answers and what
  it returns. This becomes the MCP tool description.

system: SYSTEM.md

budget:
  max_iterations: 10
  max_cost: 0.50
```

Defaults, and why — they descend from `examples/agents/explore-r/agent.yaml`,
which carries the measurement in its own comments:

- **`shape: loop`.** Only `single-step` changes behaviour (it caps iterations at
  1); `loop` and `recurse` are identical at runtime. Choose `recurse` only if
  the draft actually fans out with `rlm_query_batched` — and if it does, it
  inherits explore-r's two install requirements (`MIKRO_REPL_TIMEOUT_MS=600000`
  and the child model pin), which you must then copy into the draft's comments
  rather than leave the user to discover.
- **`model: khal/deepseek-v4-flash`** is the project default on the cost
  ranking (`docs/worker-models.md`). `station/<model>` is the $0 offline
  alternative on this host. Do not pick a premium model for a first draft.
- **`max_iterations: 10`.** explore-r sets 14 for a path of 8 turns that
  includes a fan-out and three verification reads. A non-recursive agent has no
  fan-out, so 10 leaves comparable slack. Raise it if the draft must verify a
  lot; it is a rail, not a target.
- **`max_cost: 0.50`.** explore-r's 2.00 was sized for a worst case of one
  parent plus four children (~5 × $0.012). A single-agent draft is ~1/5 of
  that, so 0.50 keeps the same order of headroom. Tightening a rail starves the
  run silently — leave room.
- `max_depth` is **declarative only** and never reaches the runtime config.
  Include it if the intent is real, and say in a comment that it is inert.

### `SYSTEM.md`

The agent's prompt. Write it to the conventions the parity campaign actually
validated:

- State the one question shape it answers, and that it answers with references
  a reader can open (`path:line`, or a commit SHA, or both).
- **A verification step before the answer.** This is the highest-value part of
  the prompt by measurement: the report attributes the collapse in fabricated
  citations to the verification block — "fabrications fell sharply wherever it
  ran" (`docs/parity-explore.md:685`). Require the agent to re-open what it is
  about to cite and to drop anything that does not resolve.
- Forbid mutation explicitly. A read-only agent that can reach a shell must be
  told the shell is for reading.
- End with the `FINAL(` convention the runtime expects.

### `EVIDENCE.md`

The file that makes the proposal auditable. It must carry, at minimum:

- The scanner invocation and its **timestamp**. The window is rolling over live
  transcripts, so two runs minutes apart differ — pin the run you are quoting.
- The family's numbers **with their labels intact** (MEASURED vs `~`ESTIMATED),
  and the family's share of total returned context.
- At least three `transcript:line` references from `--explain`, with the
  verbatim commands, so a reviewer can open the burn rather than believe it.
- Why this family and not the one above it in the table.
- **What is not claimed.** See the next section — this is not optional.

## Step 4 — stop, and hand it over

Report: the candidate, its measured burn, where the three files are, and the
exact command that would activate it — for the user to run, not you:

```bash
mv .mikro/agents/<name>.proposed .mikro/agents/<name>
```

Then say what happens when they do: the tool appears as `mikro_<name>` on the
next request, live, with no restart and no reconnect. And that undoing it is
the same rename backwards.

## Honesty rules for anything you write into the draft

Wish decision 1, and the reason it exists: an earlier draft of this program's
own documents rounded its numbers up, and the review caught it. Every
user-facing number traces to a source with that source's own scoping.

- The scanner's burn numbers describe **what the family costs today**. They say
  nothing about how well a proposed agent would do the work. Do not write "this
  saves ~210k tokens" — write "this family returned ~210,180 estimated tokens
  of context in the window", which is what was measured.
- Do not inherit `explore-r`'s parity numbers into a new agent's claims. They
  belong to a specific agent, on a specific frozen suite, at a specific
  configuration. If you cite them as calibration, cite them whole:
  out-of-sample coverage **0.714** on the holdout against **0.853–0.912**
  in-sample (`docs/parity-explore.md:1046-1048`); **zero fabrications in the
  frozen configuration only** — earlier rounds fabricated, and the
  verification block is what fixed it (`docs/parity-explore.md:827-828`,
  `docs/parity-explore.md:426-427`, `docs/parity-explore.md:685`); premium-token
  reduction **1,077×** aggregate on that suite for **$0.22**
  (`docs/parity-explore.md:960-968`) — not "about 1000×"; and the frozen shot
  still **failed** its gate on facts, 0 of 6 tasks passing where 5 of 6 were
  required (`docs/parity-explore.md:977-989`).
- Never round up, and never drop the scope that a number came with.
- An unrun draft has no quality evidence at all. Say that in EVIDENCE.md.
