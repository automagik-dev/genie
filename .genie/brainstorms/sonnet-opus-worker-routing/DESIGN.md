# Design: Opus 5.5 / Sonnet 5.5 worker routing, per-model refine, and a wish run report

| Field | Value |
|-------|-------|
| **Slug** | `sonnet-opus-worker-routing` |
| **Date** | 2026-09-28 |

## Problem

The saved workflows run every agent on the session's model unless the caller pins one model for the whole run, so reading stages cost as much as reasoning stages. `refine` knows one Claude baseline (Fable 5.1) and cannot apply the Sonnet 5.5 guidance to a worker prompt. No wish run leaves a record of the tokens it spent or the time it took, so there is no average to improve against.

## Scope

### IN
- `refine --for claude --target sonnet|opus`, loading `prompts/claude.md` plus one overlay per target, each citing its official guide: [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5), [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5).
- A `TIERS` table in each of the 10 scripts in `.claude/workflows/` (`worker` → `'sonnet'`, `reasoner` → `'opus'`), and a tier on every `agent()` call. Per-stage `effort` stays as it is.
- Every `*Prompt()` builder refined through `refine --target <its tier's model>`. Schemas, injection fences, read-only and permission rules, and exact strings are left unchanged.
- `workfly`'s SPEC gains a required `tier` field on every agent, so a new workflow is routed from the start.
- `genie wish report <runId>`, which reads the run record the runtime already writes, plus a machine-local ledger with `--append` and `--summary`.
- The `wish` skill's Relay step runs `genie wish report <runId> --append`.
- One paired `wish` run (routed vs all-Opus) and one routed `research-sweep` run, recorded in the ledger and in the README's Measured runs.

### OUT
- Monetary cost and a pricing table; new Phoenix code. The ledger row carries `runId` and `sessionId`, which join to traces from the existing `backfill.ts`.
- The skills' native subagent dispatch; `xhigh` and `max` effort; Haiku or Fable as workers; any change to a stage's effort.

## Approach

Routing goes in a per-script table because saved workflows are self-contained single files. A shared module would have to be imported, and leaving the choice to the caller would make every caller know each stage's model. The report reads the runtime's own run record rather than re-pricing transcripts, which the operator declined, and the workflow cannot emit the metrics itself because the record is written after the script returns. The report sits under the existing `genie wish` group next to `lint`, so any repository whose `wish` skill runs the workflow can call it.

## Simplicity Case

- **Simplest complete design:** a constant table per script, two overlay files, one read-only verb over an existing JSON file, and one append-only JSONL ledger.
- **Added machinery:** `--target`, because the operator requires refinement specific to each model; the ledger, because averages must outlive a session directory.
- **Deferred until measured:** a Phoenix dataset of wish runs, once the ledger holds ≥ 20 rows; `xhigh` for reasoners, once a paired run shows a quality gain; retuned effort tiers, once the ledger shows a stage whose tier is wrong.
- **Complexity removed:** the pricing table, the shared routing module, a model allowlist, effort changes, and a tracked ledger file in every repository.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Model precedence is `gateModel`/`publishModel` (wish.js only, their own stages) > `args.model` (every stage) > `TIERS[tier].model`. | The control arm pins the whole run, and the static test and the scripts use the same order. |
| D2 | **worker (Sonnet 5.5):** readers, shards, characterizers, signals, locate, facts, plan:shard, verify:static, gate, publisher, report writers. **reasoner (Opus 5.5):** judges, synthesis and consolidate, design/spec, review, semantic and fidelity refuters, council lenses, and the wish executor and fix. | The guide puts long, hard work on Opus, and measured runs showed cheaper gate and publisher models lost no quality. |
| D3 | Each stage keeps its current `effort`; only its model changes. | `workfly.js:183` sets mechanical stages to low on purpose. Changing model and effort together would confound the measurement. |
| D4 | Scripts use the aliases `'sonnet'` and `'opus'`. The report records the resolved id from `workflowProgress[].model`. | The run record shows which 5.5 model actually ran, and the scripts survive the next release. |
| D5 | `refine --target sonnet\|opus` is valid only after `--for claude`. It loads `claude.md` plus that overlay; without `--target`, `claude.md` loads alone. Four SKILL.md clauses change: "Exactly two switches" (the two provider switches stay, plus one Claude-only target modifier), "Reject … model-name values" (except the two `--target` values), "Load only the selected provider guide" (plus the selected overlay), and the baseline row (Opus 5.5 as the default Claude baseline, Sonnet 5.5 and Opus 5.5 as target overlays). `Checked: 2026-09-28`. | Keeps the provider surface stable and adds the method for each model. |
| D6 | The Sonnet overlay carries these guide clauses and applies each where the stage shape fits: stop and report within scope; the verification paragraph for stages that change code; "Think the problem through before you answer." for stages that return a schema; no request to include reasoning in the answer; no "minimize tool calls" or "hold all findings". The Opus overlay carries the Opus 5.5 guide's clauses. | Every workflow agent returns a schema, so the guide's JSON-reasoning section applies. Asking for reasoning in the answer invites `reasoning_extraction` refusals. |
| D7 | Proof is one paired `wish` run plus one routed `research-sweep`. Total tokens decide: routing is accepted when the routed arm spends fewer tokens, reaches the same state, gets review SHIP, and its minutes are no more than 1.2× the control's. n is stated. | Tokens are the cost axis the operator tracks, and time must not regress. |
| D8 | The report uses only tokens and time from the run record. | The operator ruled out monetary cost and needless code. |
| D9 | The ledger row is `{runId, sessionId, repo, workflowName, variant, state, timestamp, durationMs, totalTokens, totalToolCalls, agentCount, stages[{label, model, tokens, toolCalls, durationMs}]}`, where `stages` holds the `workflowProgress` entries with `type == "workflow_agent"`. **Required** for `--append` (exit 2 if absent): `runId`, `workflowName`, `durationMs`, `totalTokens`, `agentCount`, `stages`. **Nullable:** `state` (from `result.state`; null when `result` is null or carries no state), `totalToolCalls`. `variant` comes from `--variant <name>`, default `unlabeled`. `--summary` groups by `workflowName` and `variant`, and prints n, mean tokens and mean minutes. For wish rows only it also prints the merge-ready rate, with a null state counted as not merge-ready. | Crashed runs stay in the ledger, so the rate is not flattered, and non-wish runs such as research-sweep can be appended. |
| D10 | The ledger is machine-local, at `<GENIE_HOME>/metrics/wish-runs.jsonl`, with a `repo` field (git toplevel basename). A `runId` already present is refused. | Like the mikro run-ledger rule, a repository that never opted in grows no tracked files. Averages span every repository on the host. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | The run-record format is internal to the runtime. | Medium | Read only the named fields, exit 2 when a required one is missing, and pin the format with a fixture. |
| R2 | Sonnet stops to check in, or skips verification, on the gate. | Medium | The overlay's carry-through and verification clauses; the gate still reads the exit code. |
| R3 | `.claude/workflows/*.js` is a trust-boundary path, and `wish.js` refuses its own file. | Medium | Deliver through a multi-group WISH.md under `/work`; the parity tests stay green. |
| R4 | A refine rewrite drops a schema field, a fence or a limit. | High | Parity tests, and a reviewer diff of every prompt for contract clauses. |
| R5 | n = 1 per arm is noisy. | Low | Report n, state the result as a direction, and keep accumulating ledger rows. |

## Success Criteria

- [ ] `refine --for claude --target sonnet @x.md` loads both files. `--target` without `--for claude`, a duplicate `--target`, or an unknown value is refused before any read. `Checked: 2026-09-28`, and both overlay URLs are cited.
- [ ] A static test fails on any `agent()` call in `.claude/workflows/*.js` that lacks a tier-derived `model`. It also asserts the D1 precedence for `wish.js`.
- [ ] `workfly`'s SPEC requires `tier ∈ {worker, reasoner}` on every agent.
- [ ] `genie wish report <runId>` prints totals and stage rows equal to a fixture record, and exits 2 on an unknown `runId` or a missing required field. A record with `result: null` appends with `state: null`. A second `--append` of the same `runId` is refused. `--summary` prints n, mean tokens and mean minutes for each workflow and variant, plus the merge-ready rate for wish rows.
- [ ] The `wish` skill's Relay step runs the verb, and its parity tests pass.
- [ ] The ledger and the README carry the paired `wish` run and the `research-sweep` run, with tokens and minutes per stage and the D7 reading.
- [ ] `bun run check` passes.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `9116cf65f972763cc7518e46908e79c38d0269f1cffee98c64f393e05d171c04`
- **Reviewer:** claude-opus-5-5-design-reviewer
- **Reviewed at:** 2026-09-28T20:31:01.000Z
<!-- genie-design-review:end -->
