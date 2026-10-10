# Handoff: split mikro's engine (RLM vs raw pi), benchmarked with genie's method

Publication copy: private host capture, telemetry, billing and run-activity observations are omitted below. The complete original remains machine-local; source SHA256 `8c8ee9e3ae2cd1daa6030afdf35e68400fc5c36a144724442767f5ce8bd7376b`.

Written 2026-10-04 by genie-af (Claude Code) for Felipe. Status: starting point for a brainstorm/wish, nothing implemented.

## The goal (owner's words, distilled)

- mikro uses the RLM loop for everything. RLM's real advantage is long-context work (a REPL over a corpus too large for the prompt).
- Split runs by engine: RLM where context is long, and **raw pi** (one plain pi agent turn, tools + structured output, no REPL protocol) as an **intentional, selectable option** in genie's workflows for simple tasks.
- Decide by benchmark, not by belief. The method now exists (below). Benchmark now.

## What is true today (verified 2026-10-04)

**Where things are**
- **Working checkout:** `/home/genie/workspace/repos/mikro`, branch `dev` at `62894e4`.
- **Installed copy:** `/home/genie/.mikro/mikro`, `main`, v1.260909.1, MIT, `automagik-dev/mikro`. Owner-only users.

**One engine runs every genie agent**
- The RLM loop: `rlmLoop` (`src/rlm.ts`), driven from `src/mcp/server.ts`. No genie agent sets `backend:`.
- `agent.yaml` `shape` (`src/sdk/agent-spec.ts:53`) only changes the RLM iteration count, not the engine:
  - `single-step` gives 1 iteration (`src/mcp/server.ts:510`);
  - `loop` and `recurse` keep the RLM protocol.

**The LLM call**
- **Path:** `llmComplete` → pi-ai `completeSimple` (`src/llm.ts:333,421`).
- **pi-ai version:** `@earendil-works/pi-ai` **0.80.10**, exact pin. Latest is 1.0.2; pi on this host uses 0.86.1.
- **Model:** `deepseek-api/deepseek-flash`, a custom provider in `~/.mikro/settings.json`, key via `~/.mikro/gate-env.sh`.

**The backend seam already exists** (`src/mcp/backend.ts`, wish `rlmx-v2-prime-backend`)
- `backend: mikro | prime | prime-sdk` is an internal, undocumented `agent.yaml` field (`src/sdk/agent-spec.ts:105-122`).
- The prime backends are pinned to prime-agent **0.8.1** (`src/mcp/backends/prime.ts:100`), while **0.9.5** is installed (`~/.local/bin/prime-agent`, config `~/.prime/agent`). As-is they would not load.

**Prior engine decisions** (both kept mikro's engine)

| Date | Record | Result | Caveat |
|---|---|---|---|
| 2026-08-16 | `.genie/wishes/rlmx-v2-prime-backend/gate-report.md` | **FAIL**: mikro 1/6, prime 0/6 on the explore suite | Prime failed mostly because agents kept mikro's `FINAL(` / REPL protocol, which collides with prime's own turn model |
| 2026-09-02 | `.genie/evidence/prime-runtime-benchmark/SELECTION.md` | mikro 4/9 solved, prime-sdk 1/9 (faster and cheaper per attempt but lower quality); kept mikro | Chose **DeepSeek V4 Pro direct** for future experiments, but genie agents still run **flash** |

## Production evidence: what is failing and why

Sources:
- `/home/genie/workspace/repos/mikro/.genie/brainstorms/mikro-engine-split/evidence/mikro-eval/` (560 runs, per agent)
- `/home/genie/workspace/repos/mikro/.genie/brainstorms/mikro-engine-split/evidence/mikro-diag/FINDINGS.txt` (root causes, file:line)

Copied here from the session scratchpad.

| Agent | Real ok rate | Bench ok rate | Notes |
|---|---|---|---|
| wish-context | **0.66** (n=123) | 0.95 | 53% retried; **$2.18 of $5.26 spent on failed runs** |
| review-prep | 0.93 (n=84) | 1.00 | |
| issue-triage | 0.90 | | |

All 269 real attempts used the same model and mikro version. Failures do not track model, provider, version or concurrency. They are engine bugs:

1. **Citation gate (85).**
   - 79% of wish-context attempts hit the 16-iteration cap. The forced final answer (`rlm.ts:1235`) is one call, schema-checked, with no retry, and it cites bare names or files that don't exist yet.
   - 45 of the 85 come from one brain/sheets wish creating a new module.
   - genie's gate refuses `NEW:` under an untracked directory (`genie/scripts/mikro/call.ts:306-314`).
2. **"Empty LLM response" (18) is really HTTP errors.**
   - pi-ai returns `stopReason:"error"` plus `errorMessage`, and `llm.ts:421-480` ignores both.
   - `maxRetries` is never set (pi-ai defaults to 0).
   - `rlm.ts:917-936` reports these as "context too long".
3. **No/bad JSON (13).** `FINAL(answer)` meant a variable, and `parser.ts:12,69` takes the literal text.
4. **30 s timeout (7).** It is per REPL block (`MIKRO_REPL_TIMEOUT_MS`, `repl.ts:102-107`), and when it fires it kills the whole run (`rlm.ts:984`) instead of returning the error to the model.

**Why the bench lies:** `genie mikro fixtures --from-commits` skips commits naming paths HEAD no longer has, so it never tests new-file work, which is exactly where production fails.

## The method you now have (all in genie dev, merged 2026-10-04)

**Per-run ledger**
- `genie wish report <runId> --append --variant <name>`
- Writes `~/.genie/metrics/wish-runs.jsonl` rows, v3: stage tokens and time, the outcome (verdict, repairs, gate), and **`outcome.offloads[]` with mikro cost per stage**.
- **A/B summary:** `genie wish report --summary` gives `ship`, `meanRepairs` and `meanOffloadUsd` per workflow × variant.

**Lifecycle capture**
- `genie metrics enable`, then `genie metrics export [--since 7d] [--phoenix --endpoint <url> --project <name> --save]`.
- Per card transition: time, tokens from the runtime's own session log, and an **`offload` bucket from mikro's run ledgers**.
- Unknown is always null, never 0.

**mikro's own loop**
- `genie mikro fixtures --from-commits <range> --agent <a>`
- `genie mikro bench <agent> [--reps n] [--tag round=N] [--write-evidence]`
- `genie mikro coach <agent>`
- Run ledger: `<repo>/.mikro/runs/<agent>.jsonl`, one row per attempt, with a priced footer.

**Phoenix (optional, off until configured)**
- `MIKRO_PHOENIX_PROJECT=<name> PHOENIX_ENDPOINT=<url>` for mikro spans.
- Lab instance: `http://127.0.0.1:6006`, no auth.

## Proposed design: engine as an explicit choice

Make the engine a documented `agent.yaml` field, chosen per agent (and overridable per call), instead of the hidden `backend:` experiment selector.

| Engine | What runs | Fits |
|---|---|---|
| `rlm` (today's default) | REPL loop, `FINAL` protocol, iterations | Long context: corpora, many files, exploration that doesn't fit one prompt |
| **`pi`** (new) | **One raw pi agent turn**: system prompt, read-only tools (read/grep/glob/git), **structured output via a schema'd final tool** (`emit_done`-style, the way prime-sdk does it), pi-ai retries on | Bounded tasks: review-prep, issue-triage, facts-backed wish-context |
| `prime-sdk` (existing, experimental) | prime 0.9.5 in-process | A third arm to measure. Re-pin 0.8.1 → 0.9.5 first. |

**Open choices for the `pi` engine:**
1. Call pi-ai directly, plus a minimal tool loop inside mikro. Small, and fully ours.
2. Embed `@earendil-works/pi-coding-agent` (upstream pi 0.86.x). Gets its tool loop, retries and compaction for free; a dependency to track.

Recommendation: (2) if its SDK can run read-only with no TUI; otherwise (1).

**Constraints to keep:**
- The host-visible MCP contract is unchanged: `structuredContent {answer, session_id}`, the cost-footer field set, the `isError` classification and progress notifications. The existing `tests/backend-contract.test.ts` harness already compares backends this way.
- Every engine writes the same run-ledger row, so genie's accounting needs no change.
- genie's citation gate (`call.ts`) still verifies every answer, whatever the engine.

## Benchmark plan (pre-register before reading numbers)

1. **Fixtures that look like production:**
   - `genie mikro fixtures --from-commits` on genie AND brain.
   - Add **new-file fixtures**: commits that create files, with the verifier scoring the declared NEW paths.
   - Freeze the set.
2. **Arms, same model and same fixtures:**
   - `rlm`, unpatched (today's baseline);
   - `rlm` with patches 1–3 below;
   - `pi`;
   - optionally `prime-sdk` 0.9.5.
   - **Model:** today's `deepseek-flash`, plus one run on V4 Pro direct (the 09-02 selection).
3. **Metrics per arm:**
   - ok rate;
   - citation precision and recall (the existing verifier);
   - failure categories;
   - p50/p90 latency;
   - cost per call and **cost per verified success**;
   - share of runs at the iteration cap (rlm only).
4. **Repetitions:** at least 3 per fixture. Report variance; the 2026-10-04 council found a run-to-run CV of about 75% on wish runs, so small samples mislead.
5. **Rule, decided now:** a cheaper or faster engine wins only at equal or better verified-success rate. Same rule as the owner's model-routing evaluations.
6. **In genie's real workflow:**
   - Run `/wish` on the same small objectives with `variant=offload-rlm` vs `offload-pi` (and `offload-off` as control).
   - Compare `genie wish report --summary`: SHIP rate, meanRepairs, stage tokens, meanOffloadUsd.

## Patches to the RLM engine, in priority order (independent of the split)

1. **Surface provider errors and turn on retries.** `llm.ts`: act on `stopReason === "error"` and `"length"`; set `maxRetries` ≈ 3. Expect "empty response" → 0, and the real HTTP error in the ledger.
2. **REPL timeout back to the model.** `rlm.ts:984`: catch the timeout and return it as that block's error. Optionally `MIKRO_REPL_TIMEOUT_MS=60000` from genie's `call.ts`.
3. **`FINAL(var)` is a variable.** Treat a bare REPL-variable name as `FINAL_VAR`; reject `...`.
4. **Stop living on the forced final answer.** Raise `max_iterations` (16 → ~24) or make the cap a validated, retryable REPL turn.
5. **genie side** (`scripts/mikro/call.ts`): accept `NEW:` under a new directory whose nearest tracked ancestor exists; repo-relative paths in the prompts.
6. **Dependencies:** pi-ai 0.80.10 → ≥0.86 (built-in `deepseek-flash`, retry fixes), then drop the custom provider. Read the changelogs to 1.0.2 first.

## Owner decisions already taken (2026-10-04)

- **Monorepo:** mikro moves into genie (git subtree, history kept, own folder, own CI job, NOT bundled into `dist/genie.js`, genie's frozen 8-member payload untouched). One maintainer, one session, one PR. A submodule was rejected.
- **Manual first:** every loop step is manually triggerable and dogfooded before any scheduling.
- **Configuration:**
  - Nothing hardcoded: no endpoint, project or credential defaults.
  - Off until configured.
  - Instrumentation adds no LLM action.

## Suggested next commands

```bash
cd /home/genie/workspace/repos/mikro            # dev @ 62894e4
genie mikro bench wish-context --reps 3 --tag round=baseline-2026-10-04   # from a genie checkout; record the baseline first
# then: /brainstorm mikro-engine-split   (seed: this file + mikro-diag/FINDINGS.txt + mikro-eval/)
```

Related records:
- genie memory `genie-perfect-circle-vision`;
- `genie/.genie/brainstorms/genie-bench/{LIFECYCLE-CAPTURE,COORDINATION}.md` (machine-local);
- genie PRs #3116–#3124.

## Engine-split coordination (genie-af → mikro owner term_fc67b4c5, 2026-10-04 23:10Z)

**Ownership**
- genie-af owns nothing in mikro.
- The dirty `CHANGELOG.md`, `bin/install-state.mjs`, `scripts/install.sh`, `src/cli.ts`, `dist/*` and install tests in `/home/genie/workspace/repos/mikro` are **not genie-af's**. Treat them as someone else's unfinished work: don't commit them.
- On the genie side, genie-af shipped #3116–#3124 to dev. Released as v6.261004.15, which is the installed version (`genie --version`).
  - Frozen there: capture/export/`wish report` v3 / offload accounting.
- There is no newer engine plan; this file is the latest.

**genie-side items the engine split needs** (not started; the mikro owner may own them, or ask genie-af)
1. NEW citations: `genie/scripts/mikro/call.ts:306-314` refuses `NEW:` under an untracked directory. Proposal: accept it when the nearest tracked ancestor exists.
2. Fixtures: `genie mikro fixtures --from-commits` skips commits naming paths HEAD no longer has (`scripts/mikro/fixtures*.ts`), so no new-file fixture can exist. It needs a NEW-path verifier mode.
3. Per-call engine selection:
   - `genie mikro call` passes its tail to `scripts/mikro/call.ts` as typed, so an `--engine` flag needs only call.ts to forward it to mikro, with no genie CLI change.
   - The two `/wish` offload command lines that would carry it are `.claude/workflows/wish.js:972` (scout) and `:1143` (review).
   - Label A/B runs with `genie wish report --append --variant offload-<engine>`; offload cost per stage is already recorded.

**Baseline discipline:** freeze concurrent-run policy and preserve all attempts; do not infer runtime activity from this publication copy.

**Runtime reproducibility and safety**
- **Binary provenance.** Pin and hash the executable checkout for each arm. Do not run `install:local` mid-benchmark or replace the production binary.
- **Dirty checkout.** Do not install from or commit an operator's unfinished installer/CLI work.
- **Host conditions.** Keep machine-specific load/disk facts privately with measurement provenance; use disposable scratch space with adequate capacity. Serialize Genie full gates under the existing host lock.
- **Capture.** Preserve the operator's existing capture choice. Lifecycle commands may emit events when enabled; neither enable/disable capture nor publish its actual activation state as part of this change.
- **Telemetry.** Keep Phoenix off unless an endpoint and a distinct project were explicitly sanctioned. Do not publish unrelated telemetry-project activity or mutate host-wide configuration.
- **Credentials and spend.** Use protected credential references; never publish key values, shared billing observations or operational rotation notes.
- **Prime.** Preserve existing experimental version checks. A mismatched installed binary is not a scored replacement and does not authorize re-pinning.
- **Ledger retention.** Store experiment records outside ephemeral executor worktrees so teardown cannot erase accounting evidence.
