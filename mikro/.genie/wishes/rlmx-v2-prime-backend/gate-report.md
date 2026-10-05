# Gate Report — rlmx v2 RuntimeBackend parity/compatibility gate

Wish: `rlmx-v2-prime-backend` · Branch: `wish/rlmx-v2-prime-backend` · Gate model: `deepseek/deepseek-v4-flash` (Decision 7, amended 2026-08-14)

**Status: gate setup recorded — measurements pending.**

## Gate-setup decisions (recorded BEFORE any run — per WISH.md Group 3 prerequisite 3)

These are the decisions the wish requires at gate setup, never after seeing scores.

### D1. Task-root re-pointing (prerequisite 3)
The frozen suite's recorded roots — `/home/namastex/prod/brain` and `/home/namastex/workspace/repos/genie` — are Linux-host paths not present on this machine and not creatable here (no root access). **Decision, approved by Felipe ("do it", 2026-08-16):** re-point the roots to local checkouts of the same repositories:

| Frozen root | Re-pointed root | Repo identity | HEAD at setup |
|---|---|---|---|
| `/home/namastex/prod/brain` | `/Users/feliperosa/workspace/repos/brain` | `git.namastex.io/khal/brain.git` (origin), rsynced from `genie-cegonha:/home/genie/prod/brain` — same tree, same commit | `1c6c9ca` chore(release): publish latest binaries 2.21.0 |
| `/home/namastex/workspace/repos/genie` | `/Users/feliperosa/workspace/repos/genie` | `github.com/automagik-dev/genie.git` (origin) | `3a7e9ce74` docs(wish): record the approved WAL-heal rescope |

Drift disclosure (carried from `docs/parity-explore.md:63`): the suite was mined against live checkouts that have moved since. The agent's own citations (rubric criterion 2) resolve against the tree each leg actually reads — recorded per run as `rootGit` — so both legs are scored against identical trees and the comparison stays fair. Absolute quality vs the native ground-truth arm may drift; the ≥5/6 bar is applied per the frozen doc's arithmetic regardless. The task files themselves are untouched.

### D2. Legacy-leg credential (prerequisite 2, amended)
`DEEPSEEK_API_KEY` was not in the environment. **Decision:** provision from the operator's macOS keychain (`deepseek-api-key`) — the user's own DeepSeek credential, already used by their bench harness. Verified live against `https://api.deepseek.com/v1/chat/completions` (model `deepseek-v4-flash` answered correctly) before any gate run. The key is exported to gate runs via a 0600 env file only; it is never written into this report, git, or any log. Prime leg: prime-agent's own credential store (live `--provider deepseek` spawns succeeded on this machine 2026-08-14/16).

### D3. Station/Lemonade gateway (prerequisite 1) — substitution
No station/Lemonade gateway is running on this host (checked 127.0.0.1:8080 and ollama). **Decision:** under the deepseek re-pin no scored leg touches a station-pinned model, so the gateway's scored-load requirement is met by elimination. The station-pinned shipped agents remain legacy-only and excluded from the quality comparison (Scope OUT), as planned. Consequence for the validation command: `scripts/smoke-explore.mjs`'s gating arm defaults to `station/Brain-35B`, so the gate runs it with `RLMX_SMOKE_MODEL=deepseek/deepseek-v4-flash` (+ `DEEPSEEK_API_KEY`) — the arm exercises the explore recipe through the legacy backend on the gate model, which is what this gate measures. The khal arm is skipped (no `KHAL_API_KEY`; reported-not-gated by the script's own design).

### D4. Binary and thresholds (as recorded in WISH.md, verified at setup)
- Prime leg binary: `prime-agent` pinned **`0.7.2`** — exact version recorded from `prime-agent --version` in the run section below. Version check enforced by the backend itself.
- Pooled-RPC trigger thresholds at gate setup: prime P50 wall-clock ≥ 1.5× legacy P50, or median spawn/cold-start overhead > 2s per turn (wall-clock limb fires only with cold-start corroboration). Retunable only by a decision recorded here before any numbers are read — this section is that record; it stands as written.
- Gate model pin: `deepseek/deepseek-v4-flash` on both legs; resolved-model pre-flight asserts this per leg before any scored task.

### D5. Hermeticity
Prime leg spawns with `-nc -ne -ns -np` (no host context files/extensions/skills/prompt templates) — reproducibility per the WISH AC. Legacy leg: `RLMX_AGENTS_DIR` pointed at the gate-only directory alone, replacing default discovery roots.

---

## Gate-execution decisions (recorded by the gate engineer BEFORE any scored task — 2026-08-16)

The setup section above (D1–D5, commit 66f08a2) is preserved byte-for-byte as
the record of pre-run decisions. The following decisions were taken at gate
execution start, before any model call, and are recorded here rather than in
the setup section so that the setup section remains exactly as committed.
The header status line above ("Status: gate setup recorded — measurements
pending.") sits inside that byte-preserved setup record (lines 1–36) and is
left as recorded; the gate has run to completion — measurements below,
verdict at the bottom.

### D6. Task-root `.rlmx/` configs excluded via mirror cwds (both legs)

Discovered at execution time, before any run: all three trees involved in this
gate ship a `.rlmx/` config directory at their root — the two re-pointed task
roots (brain and genie each carry `rlmx.yaml` + `SYSTEM.md` + `CRITERIA.md` +
`TOOLS.md`) and this repo itself. Because `rlmx mcp --dir <root>` makes the
task root the server cwd, `loadConfig(cwd)` (`src/config.ts:594`) loads that
`.rlmx/`, and:

1. The genie and rlmx `TOOLS.md` files each parse one custom REPL tool
   (`run_cli_example (demonstrates RTK auto-prefix)` — verified with
   `parseToolsMd` at gate setup; the brain one parses none). Prime's landed
   Group 2 backend rejects `config.tools` loudly (`assertSupportedConfig`,
   `src/mcp/backends/prime.ts`), so the prime leg would throw before running
   any genie-rooted task (tasks 2, 5, 6).
2. The roots' ambient configs pin `google/gemini-3.1-flash-lite-preview` and
   carry per-root `CRITERIA.md` content — root-specific ambient state that
   differs between the two checkouts and muddles config parity between legs.

**Decision:** the gate runs **both legs** from a scratch **mirror cwd** per
root — a directory of symlinks to every top-level entry of the re-pointed
checkout **except `.rlmx`** (built by `gate-agents/run-gate.mjs mirror` under
`gate-agents/.work/mirrors/`, gitignored). Consequences, symmetric across
legs: `loadConfig` finds no config, so both legs run on identical default
config; the REPL reads the real tree through the mirror (same bytes, same
commits — `.git` is symlinked too, so each run's `rootGit` is recorded from
the checkout itself); citations are scored against the mirror tree (the tree
the leg actually read — recorded as `root`/`rootOverride` in each run and
score JSON). The frozen task files are untouched; nothing is written into the
re-pointed checkouts (one disclosed caveat: a mirror symlink is not a write
barrier — the frozen r1–r15 rounds ran against the live checkouts with the
same exposure). The exclusion list is exactly one entry: `.rlmx`.

### D7. Run-clock corrections, both legs (recorded before the re-run; first legacy pass preserved as evidence)

The first legacy pass over the frozen suite ran at harness defaults and
produced two environment artifacts, not recipe outcomes: (a) task 1 died on
rlmLoop's 30s REPL-execution watchdog (`RLMX_REPL_TIMEOUT_MS` default) while
the agent was fanning out recursive spawns at iteration 3 — the harness's own
header names this a caller-owned environment correction (`parity/run-task.mjs`
records `replTimeoutMs` per run for exactly this reason); (b) all six run
JSONs lost `rootGit.head` to a `git status` failure on symlinked checkout
paths (a harness `gitState` bug, fixed to isolate head from status). That pass
is preserved under `runs/gate-v2-legacy/first-attempt-defaults/` as evidence
and is not scored.

**Decision:** the scored legs run with `RLMX_REPL_TIMEOUT_MS=120000`
(legacy-only knob — prime has no REPL-execution cap; disclosed per run in
`provenance.replTimeoutMs`) and `RLMX_MCP_RUN_TIMEOUT_MS=600000` on **both**
legs (the harness's caller-owned wall-clock correction, recorded per run as
`provenance.runTimeoutMs`; a single long task — legacy task 2 completed at
301s wall, i.e. against the 300s default — must not turn the quality
comparison into a wall-clock rail test; the deadline behavior itself is
measured separately by the forced-abort exercise).

### D8. Mirror freshness per task (recorded before the re-runs; contaminated runs preserved as evidence)

The D6 mirror caught a real write: during the first legacy pass, the explore
agent scaffolded `.rlmx/` in its own cwd via `rlmx init` (the brain mirror's
`.rlmx/` carries mtime 15:32, mid-first-pass; the four files match the
default `rlmx init` template byte sizes). Two consequences, both environment
artifacts: (a) every later task on the brain mirror loaded that scaffolded
config — the legacy re-run's brain tasks ran with one ambient REPL tool and
template criteria appended, and the prime leg's brain tasks (1, 3, 4) failed
loudly at 0.9s on `assertSupportedConfig` (custom REPL tools); (b) the write
landed in the gitignored mirror, **not** in the user's checkout — both
checkouts were verified clean after the runs (git status; the genie
checkout's pre-existing modifications — 16 modified files plus 1 untracked at
final verification, mtimes Aug 13–15 — all predate the Aug 16 gate).

**Decision:** `run-gate.mjs` rebuilds each task's mirror fresh before the run
(delete + re-link, symlinks only), and each task is scored inline against the
exact mirror state it read, before the next rebuild. The contaminated records
are preserved under `runs/contaminated-evidence/` as evidence — the legacy
second-pass records (`task-{1,3,4}.json`, the scaffolded-config runs, moved
out of `runs/gate-v2-legacy/` when the final re-runs replaced those files) and
the prime failure records (`prime-task-{1,3,4}.json`, the
`assertSupportedConfig` failures, 0.6–0.9s, restored from git history commit
`e9fca38` after the final re-runs replaced the originals under
`runs/gate-v2-prime/`; provenance notes in
`runs/contaminated-evidence/README.md`); the scored set re-runs those six
tasks (legacy 1/3/4 + prime 1/3/4) with fresh mirrors, everything else
identical.

### D9. Scoring root — the re-pointed checkout; the legacy task-1 inline-score FAIL (decision recorded before the re-runs; outcome annotated after the fact)

**Decision:** final scoring resolves rubric citations against the re-pointed
checkout root, not the run's scratch mirror: `run-gate.mjs` invokes
`parity/score-task.mjs` with `--root <checkout>` (the D1 map), and every score
JSON records the resolution root as `root` / `rootOverride` (with the frozen
root preserved as `rootFrozen`) — e.g. `runs/gate-v2-legacy/task-1.score.json`
records `root` / `rootOverride` = `/Users/feliperosa/workspace/repos/brain`
and `rootFrozen` = `/home/namastex/prod/brain`. Rationale: the mirror aliases
the checkout 1:1 at run start, but the agent mutates its cwd mid-run — the
legacy task-1 re-run proved it (below) — so the mirror is not a stable
resolution root; the rubric's task root is the checkout, which is the tree the
run actually reads through the mirror (same bytes, same commits).

**The legacy task-1 inline-score FAIL (the mirror is not a stable root):**
during the legacy re-run, task 1 was scored inline right after the run and
returned `c2 FAIL audio.ts:17 (missing-file); image.ts:18 (missing-file)` /
`c3 FAIL` (recorded in `runs/manifest-legacy.json`, task 1 `scoreOutput`):
the agent had deleted mirror entries (`src/`, `tests/`, … symlinks) mid-run,
so the mirror-tree walk could no longer reach
`src/lib/processors/audio.ts` / `image.ts`. **Final re-score against the
checkout** (`runs/score-outputs-legacy.json`,
`runs/gate-v2-legacy/task-1.score.json`): c2 PASS, c3 PASS, 25 citations.
Both citations resolve in the checkout: `audio.ts:17` →
`src/lib/processors/audio.ts:17` and `image.ts:18` →
`src/lib/processors/image.ts:18`, each line being
`const TOOLS_DIR = process.env.GENIE_TOOLS_DIR ?? "/home/genie/tools";` —
exactly the answer's claim ("Tools directory: `GENIE_TOOLS_DIR` env or
default `/home/genie/tools` (audio.ts:17, image.ts:18)"). **The final PASS is
the scored outcome.**

---

## Measurements

| # | Metric | Legacy (`backend: rlmx`) | Prime (`backend: prime`) |
|---|---|---|---|
| 1 | Prime binary version (verbatim) | — | `0.7.2` |
| 2 | Resolved model per leg (pre-flight) | `deepseek/deepseek-v4-flash` (footer) | `deepseek-v4-flash` + `--provider deepseek` (spawn argv) |
| 3 | Task 1–6 quality (rubric) | 1 PASS, 5 FAIL (c1; c2/c3 all PASS) | 0 PASS, 6 FAIL (c1; c2/c3 vacuously PASS) |
| 4 | Suite pass count (≥5/6 = bar) | **1/6 — FAIL** | **0/6 — FAIL** |
| 5 | Cost per task + total | $0.0069 / $0.0300 / $0.0400 / $0.0051 / $0.0100 / $0.0075 = **$0.0995** | $0.0012 / $0.0081 / $0.0011 / $0.0003 / $0.0100 / $0.0003 = **$0.0210** |
| 6 | Tokens per task (in/out) | totals **336,974 / 120,718** | totals **91,192 / 24,485** |
| 7 | Wall-clock per task + P50 | 61.1 / 230 / 458.8 / 62.4 / 79 / 85.4s → **P50 82.2s** | 5.4 / 170.1 / 6.1 / 6.3 / 123 / 5.6s → **P50 6.2s** (confounded — see Row 7) |
| 8 | Cold-start / spawn overhead (median) | **75ms** (callTool → "iteration 1") | **942ms** (callTool → "iteration 1", incl. subprocess spawn) |
| 9 | Concurrency: parallel distinct-cwd runs | no leakage; both slots ok | no leakage; slot B stopped after the starter block (documented pattern) |
| 10 | Forced aborts: deadline + ceiling + cap | deadline → empty success-classified answer (gate finding); ceiling → `budget hit: max-cost` ✓; cap → graceful, no note ✓ | deadline → `TIMEOUT_ANSWER`, `isError` ✓; ceiling → `budget hit: max-cost` ✓; cap → `budget hit: max-iterations` note (documented deviation) |
| 11 | Pooled-RPC trigger evaluation | — | does **not** fire (P50 0.075× legacy, confounded; cold-start 942ms < 2s) |

Every number below carries the command that produced it. Runs were produced
with `node gate-agents/run-gate.mjs scored <leg>` (which invokes
`.genie/wishes/rlmx-explore-offload/parity/run-task.mjs` with the recorded
`--root`/`--recipe`/`--out-dir` arguments and `RLMX_AGENTS_DIR` pointed at the
gate directory) and re-derived with `node gate-agents/summarize.mjs runs`
(rows 5–8 and 11 are verbatim from that command over the final scored records
under `runs/gate-v2-<leg>/` — the contaminated first records are preserved
separately under `runs/contaminated-evidence/` and are not scored).
Serving path for every cost/latency/token number: **both legs target
`https://api.deepseek.com`** — legacy via pi-ai's bundled deepseek provider
(`node_modules/@earendil-works/pi-ai/dist/providers/deepseek.js:9` →
`baseUrl: "https://api.deepseek.com"`), authenticating with `DEEPSEEK_API_KEY`
(sourced from the 0600 env file, value never recorded); prime via
prime-agent's bundled deepseek provider (`--provider deepseek`),
authenticating with prime-agent's own credential store.

### Row 1 — prime binary version (verbatim `prime-agent --version`)

```text
0.7.2
```

Enforced by the backend itself (`assertPinnedVersion`, `src/mcp/backends/prime.ts`);
every prime run's wrapper log shows one `--version` pin probe per server.

### Row 2 — resolved model per leg (pre-flight, before any scored task)

```text
node gate-agents/run-gate.mjs probe legacy   # footer:
rlmx · agent=explore · deepseek/deepseek-v4-flash · 5 iterations · 5,956 in / 738 out · $0.0011 · 10.2s

node gate-agents/run-gate.mjs probe prime    # spawn argv (bin/prime-argv-log.sh):
--mode json -p --no-session --cwd <rlmx mirror> -nc -ne -ns -np
--provider deepseek --model deepseek-v4-flash --append-system-prompt …
```

Legacy: footer's `provider/model` = **`deepseek/deepseek-v4-flash`** ✓. Prime:
spawn argv's `--model` = **`deepseek-v4-flash`** with `--provider deepseek` ✓,
plus `-nc -ne -ns -np` and `--append-system-prompt` (no `--system-prompt`)
asserted from the same argv. Both probes exited cleanly (`client.close()` +
`process.exit`, 120s failsafe). No mismatch → comparison proceeded.

### Row 3 — task-by-task quality (frozen rubric; mechanical c2/c3 via `parity/score-task.mjs`, c1 judged in `gate-agents/c1-judgements.md`)

| Task | Legacy c1 | Legacy c2 | Legacy c3 | Legacy verdict | Prime c1 | Prime c2 | Prime c3 | Prime verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | FAIL (2/14) | PASS (25 cites) | PASS | **FAIL** | FAIL (0/14) | PASS (0 cites) | PASS | **FAIL** |
| 2 | PASS (9/10 generous; 8/10 strict) | PASS (22 cites) | PASS | **PASS** | FAIL (0/10) | PASS (0 cites) | PASS | **FAIL** |
| 3 | FAIL (6/11) | PASS (26 cites) | PASS | **FAIL** | FAIL (0/11) | PASS (0 cites) | PASS | **FAIL** |
| 4 | FAIL (4/12) | PASS (25 cites) | PASS | **FAIL** | FAIL (0/12) | PASS (0 cites) | PASS | **FAIL** |
| 5 | FAIL (0/5) | PASS (0 cites) | PASS | **FAIL** | FAIL (0/5) | PASS (0 cites) | PASS | **FAIL** |
| 6 | FAIL (4/8) | PASS (5 cites) | PASS | **FAIL** | FAIL (0/8) | PASS (0 cites) | PASS | **FAIL** |

`node gate-agents/run-gate.mjs score <leg>` produced the c2/c3 columns
(resolution root = the re-pointed checkout, recorded per score JSON as
`root`/`rootOverride`; see D9). Prime's answers are the explore SYSTEM.md
starter block only (tasks 1, 3, 4, 6 — one turn, then stop) or the cap-kill
error string (tasks 2, 5) — the unported explore protocol does not execute
against prime's turn model; the runs themselves are non-throwing (`isError`
false throughout, cap-kills classified `budget hit: max-iterations`).

### Row 4 — suite pass count (bar: ≥5 of 6)

Legacy: **1/6** (generous column; 0/6 strict — disclosed in
`c1-judgements.md`). Prime: **0/6**. Neither leg clears the frozen bar, and
prime's pass count is below legacy's on the identical model.

### Row 5 — cost per task + total (`node gate-agents/summarize.mjs runs`, from each run's footer `$x`)

| Task | Legacy | Prime |
|---|---|---|
| 1 | $0.0069 | $0.0012 |
| 2 | $0.0300 | $0.0081 |
| 3 | $0.0400 | $0.0011 |
| 4 | $0.0051 | $0.0003 |
| 5 | $0.0100 | $0.0100 |
| 6 | $0.0075 | $0.0003 |
| **Total** | **$0.0995** | **$0.0210** |

Serving path: api.deepseek.com on both legs (see above).

### Row 6 — tokens per task (in/out, same footers)

| Task | Legacy in/out | Prime in/out |
|---|---|---|
| 1 | 31,192 / 3,799 | 7,081 / 578 |
| 2 | 120,259 / 26,919 | 24,997 / 12,247 |
| 3 | 87,226 / 73,087 | 6,315 / 691 |
| 4 | 20,687 / 4,266 | 426 / 716 |
| 5 | 48,372 / 5,263 | 51,843 / 9,680 |
| 6 | 29,238 / 7,384 | 530 / 573 |
| **Total** | **336,974 / 120,718** | **91,192 / 24,485** |

Prime's one-turn input counts (426–530) are implausibly small for the
appended role + question — prime's per-completion usage evidently excludes
the base prompt; reported as measured.

### Row 7 — wall-clock latency per task + P50 (run JSON `wallSeconds`)

| Task | Legacy | Prime |
|---|---|---|
| 1 | 61.1s | 5.4s |
| 2 | 230s | 170.1s |
| 3 | 458.8s | 6.1s |
| 4 | 62.4s | 6.3s |
| 5 | 79s | 123s |
| 6 | 85.4s | 5.6s |
| **P50** | **82.2s** | **6.2s** |

Serving path: api.deepseek.com on both legs. Prime's P50 is lower because 4 of
its 6 runs stop after one turn without executing the workload — the wall-clock
delta measures workload non-execution, not backend speed (see the pooled-RPC
evaluation below).

### Row 8 — cold-start / spawn overhead (median; run JSON `firstProgressMs` =
callTool → first progress, both backends' first progress is the pre-model
"iteration 1" signal)

Legacy: 79 / 85 / 63 / 70 / 74 / 76 ms → **median 75ms** (in-process
engine start). Prime: 834 / 1025 / 857 / 859 / 1246 / 1361 ms → **median
942ms** (server dispatch + prime-agent subprocess spawn + startup). MCP server
ready (connect → tools/list): legacy median 440.5ms, prime median 284ms
(`serverReadyMs`).

### Row 9 — concurrency (parallel invocations, distinct cwds; `node gate-agents/exercises.mjs concurrency <leg>`)

- **Legacy** — two servers in parallel: slot A = gate explore in scratch cwd A
  (`MARKER_ALPHA.txt`), slot B = shipped `hello-world` (verbatim copy; its
  bare model resolves to the ambient config pinned to deepseek by slot B's own
  scratch `.rlmx/rlmx.yaml`). A: ok, named `MARKER_ALPHA` + its own cwd
  (`cwd-alpha`), no mention of B's marker; B: ok, greeted
  (`Hello, rlmx-v2 gate concurrency exercise!`, $0.0001, 4.7s), no mention of
  either marker. No workspace/path leakage.
- **Prime** — two servers in parallel, both gate explore (no second shipped
  agent is prime-reachable: prime 0.7.2 exposes only deepseek +
  prime-inference providers, and the demo agents declare bare model ids +
  spec tools), distinct cwds (`MARKER_GAMMA.txt` / `MARKER_DELTA.txt`). Slot A
  (6 turns): named `MARKER_GAMMA` + its own cwd + content, no mention of
  DELTA. Slot B (1 turn): starter-block stop — the documented protocol
  pattern — and no mention of GAMMA. No workspace/path leakage in either
  direction.
- Records: `runs/exercises/concurrency-<leg>.json` with per-slot assertions.

### Row 10 — forced aborts (`node gate-agents/exercises.mjs abort-* <leg>`, records under `runs/exercises/`)

**Deadline breach (RLMX_MCP_RUN_TIMEOUT_MS, mid-run):**
- Prime — 3s and 4s attempts: killed mid-run → answer
  `Error: RLM query timed out`, `isError: true`, 0 iterations, $0.00 —
  exactly the Group 2 designed classification (`isFailedRun` → failed run). ✓
- Legacy — 3s / 4s / 20s attempts: the wall-clock expiry does **not** surface
  as `TIMEOUT_ANSWER` on the real path. At 20s the run was provably mid-run
  (7 iterations, 4,041 in / 1,652 out) and the host received an **empty
  answer** (`"\n"`) with `isError: false`, a normal footer (7 iterations,
  $0.0011), and no budget note: pi-ai's completion layer swallows the abort
  into an empty response, and the forced-final path completes it as a success.
  The Group 1 contract test's `TIMEOUT_ANSWER` assertion (stub-based) does not
  hold on the real model path. **Gate finding, legacy-side** — recorded, not
  corrected.

The saved records' `mechanism` fields state the timeout that produced each
record: legacy `RLMX_MCP_RUN_TIMEOUT_MS=20000` (matching the committed driver
and the 20.0s footer) and prime `RLMX_MCP_RUN_TIMEOUT_MS=3000` (matching the
3.0s footer); the earlier 3s/4s attempts on both legs are intermediate and
prose-only — the saved records are the authoritative ones.

**Cost-ceiling breach (budget `max_cost: 0.000001`, fixture agent):**
- Legacy: first real turn breaches → forced final, footer
  `… $0.0033 · 69.5s · budget hit: max-cost`, `isError: false` (non-throwing). ✓
- Prime: first assistant completion breaches → kill → footer
  `… $0.0002 · 4.9s · budget hit: max-cost`, `isError: false`. ✓
- Same host-visible classification on both legs: success + `budgetHit:
  max-cost`.

**Iteration-cap (budget `max_iterations: 2`, fixture) and the recorded
Group 2 deviation (reviewer MEDIUM-1):**
- Legacy at cap 2: ends gracefully after 2 iterations with **no** budget note
  (partial, honest answer). Prime at cap 2: the model's one-turn stop preempts
  the kill (no note). The side-by-side that does fire is in the scored leg at
  the gate agent's own cap (24): legacy tasks 3/5/6 end at 24 iterations with
  **no** note; prime tasks 2/5 are killed at the (cap+1)th turn and render
  `budget hit: max-iterations` in the footer — the documented deviation,
  observed live.

### Row 11 — pooled-RPC trigger evaluation (thresholds as recorded at setup)

Thresholds at gate setup: prime P50 wall-clock ≥ 1.5× legacy P50 (fires only
with cold-start corroboration), **or** median spawn/cold-start overhead > 2s
per turn (fires on its own). Measured: prime P50 wall = 6.2s vs legacy P50 =
82.2s (0.075× — far from firing, and confounded: 4 of 6 prime runs stop
before executing the workload, so wall-clock deltas measure workload
non-execution, not backend speed). Cold-start limb: prime median
callTool→first-progress = **942ms**, below the 2s threshold. **The pooled-RPC
trigger does NOT fire**; the pooling decision is explicitly deferred with
these numbers on record.

### Failure rate (scored set)

`isError` runs: legacy 0/6, prime 0/6 — every run returned non-throwing,
including prime's two cap-kills (success-classified with a budget note) and
legacy's four cap-exhausted runs (success-classified, no note). Quality
failures above are rubric failures, not run failures.

### Gate-environment findings (recorded, not corrected)

1. **The agent mutates its working tree.** During the first legacy pass the
   explore agent scaffolded `.rlmx/` via `rlmx init` in its own cwd and later
   runs deleted mirror entries (`src/`, `tests/`, … symlinks — fingerprinted
   by the task-1 inline-score FAIL recorded in `runs/manifest-legacy.json`
   and D9; mirror mtimes observed at run time). The D6 mirror contained every
   write; both user checkouts were verified clean after all runs
   (`git status`; the genie checkout's pre-existing modifications — 16
   modified files plus 1 untracked at final verification, mtimes Aug 13–15 —
   all predate the Aug 16 gate). D8 (fresh mirror per task) and D9 (score
   against the re-pointed checkout) were recorded before the re-runs.
2. The pre-flight assertions (row 2) held on every leg, and each scored run
   records `rootGit` (brain `1c6c9ca`, genie `3a7e9ce74` — the D1 heads) with
   `replTimeoutMs: 120000` / `runTimeoutMs: 600000` per D7.

## Verdict

**`Verdict: FAIL`**

The parity/compatibility gate fails on answer quality, on both legs:

- Neither backend clears the frozen suite bar: legacy passes 1/6 tasks (0/6
  under the strict reading — both columns disclosed in
  `gate-agents/c1-judgements.md`), prime passes 0/6, against the bar of ≥5/6.
- Prime's per-task pass count (0) is below legacy's (0–1) on the identical
  model, so "meet or exceed legacy answer quality" is not met. The prime leg
  does not execute the explore recipe at all: four of six runs stop after the
  starter block and two are killed at the turn cap with no report — the
  unported `SYSTEM.md` protocol (rlmx-iteration rules, `FINAL(`) collides
  with prime's autonomous-turn model. Cost, tokens, latency, cold-start,
  concurrency, and abort measurements are recorded above; the host-visible
  envelope (answer + footer + `isError` + progress) is host-identical across
  backends on every run, including the aborts.
- Additional gate findings: legacy's real-path deadline breach surfaces as a
  success-classified empty answer (no `TIMEOUT_ANSWER`), and prime's
  iteration-cap kill renders the documented `budget hit: max-iterations`
  note where legacy ends gracefully without one (reviewer MEDIUM-1,
  demonstrated live).

**Fallback decision (per the wish's risk table — written down, not implied):**
the legacy engine **stays the default backend**; no deletion happens, and the
follow-up deletion wish is not unblocked. Prime remains available as the
second backend behind the internal `backend: prime` field, but it is not the
gate-passing engine: it failed the parity gate on the workload that the gate
was designed around. Option A (drop rlmx) is not pursued — it was conditioned
on prime meeting or exceeding legacy quality on this suite, which is the
opposite of what was measured. Re-evaluation would require the out-of-scope
work this wish explicitly deferred: porting the explore prompts to
prime-agent's ipython/`rlm()` protocol (or an equivalent prime-native
loop-shaped recipe), after which this gate can be re-run on the same frozen
suite. Pooled `--mode rpc` remains deferred (thresholds not met, row 11).

