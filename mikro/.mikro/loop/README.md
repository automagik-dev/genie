# The colony — a self-improving microagent loop

Started 2026-08-16 on mikro v0.260817.1, from the user's `/goal` directive:
*"use mikro further, fixing your own harness in the process, making the mikro
workspace full of self-improving microagents that commit their state —
creating the first autonomous repo."*

## What it is

Every active agent under `.mikro/agents/` that carries a `TASK.md` is a
**colony member**. One cycle (`node .mikro/loop/run.mjs`) runs each member's
standing task through the real `mikro mcp` path, saves the full report to
`reports/cycle-NNN/<agent>.md`, appends a journal line to the member's
`STATE.md` and to the colony `STATE.md`, and commits everything under
`.mikro/` with a `chore(colony)` message. **The commits are the memory**: the
agents read their own and each other's committed reports on the next cycle —
readme-polish re-verifies its past findings, docs-drift rotates targets from
its own `Target:` lines, agent-coach audits whichever sibling reported most
recently.

The commits are also the fix for a real harness gap this dogfood found:
`mikro mcp` runs persist nothing (only the CLI path calls `saveSession` —
`src/cli.ts:486`), so without this runner an agent run has no durable trace.

## Members

| Agent | Standing task | Self-referential state |
|---|---|---|
| `readme-polish` | Audit README.md against the code | Re-verifies its own past findings; opens with `Previously reported:` CLOSED/OPEN |
| `docs-drift` | Audit one `docs/*.md` per cycle against source | Rotation computed from its own past reports' `Target:` lines |
| `agent-coach` | Audit one sibling's SYSTEM.md + latest report; re-resolve its citations; propose PATCH blocks | The self-improvement engine — its accepted patches change the prompts the next cycle runs on |

`git-historian.proposed` remains a proposal (user rename activates it, and a
`TASK.md` enrolls it).

## Boundaries — why this stays sane

1. **Agents are read-only.** Every SYSTEM.md forbids writes, and the model
   has no write tool. Agents produce reports; only the runner writes, and
   only under `.mikro/`.
2. **The runner commits only `.mikro/` paths.** It never touches `src/`,
   `docs/`, `README.md`, or anything shipped. Repo fixes that agent findings
   justify (like the LICENSE gap, closed in `ce829d4`) are made by the
   reviewing host in separate, non-colony commits.
3. **Prompt changes are reviewed.** agent-coach's PATCH blocks are committed
   as report text. Applying one to a SYSTEM.md is a host action after
   review, committed as `refactor(colony): apply coach patches …`. A
   self-improving prompt with no reviewer is a self-degrading prompt with
   extra steps — the review step *is* the improvement mechanism.
4. **Every run is railed** by each agent's `budget` (`max_cost: 0.50`,
   `max_iterations: 12`) and the runner's 560 s per-call timeout. A full
   cycle of three members costs on the order of $0.02.
5. **Withdrawal is a rename** — `mv .mikro/agents/<name>
   .mikro/agents/<name>.proposed` removes a member from discovery and from
   the loop instantly.

## Running

```bash
node .mikro/loop/run.mjs                 # one full cycle, commits state
node .mikro/loop/run.mjs --only agent-coach   # subset
node .mikro/loop/run.mjs --dry-run       # run + write reports, no commit
```

Requirements: `mikro` on PATH (install via `scripts/install.sh`), a model key
reachable per agent.yaml — this host folds `~/.mikro/gate-env.sh` in
automatically (`DEEPSEEK_API_KEY` for `deepseek/deepseek-v4-flash`).

## Growing the colony

New members arrive through `/mikro:microagent-create` (measured, propose-only,
`.proposed` until the user renames) or by direct user commission. Either way
a member needs the five-file shape: `agent.yaml`, `SYSTEM.md`, `EVIDENCE.md`
(honest about origin and what is not claimed), `TASK.md` (standing cycle
task), `STATE.md` (journal, runner-appended).
