# Group 4 evidence — bench consolidation + archival (B2 amended + B5)

Host: this machine (Ryzen AI station, AMD Ryzen AI 9 HX 470, 89 GB), `~/prod/rlmx`
on `wish/rlmx-microagent-plugin`, 2026-07-27 UTC. rlmx HEAD at start `8c1b2e3`.

No secret appears in this file or in any file this group wrote. `KHAL_API_KEY`
was exported in the shell only, and was used **once** — a read-only
`/v1/model/info` catalog fetch to source the pricing table. **No khal run was
executed by this group**; the station arm is keyless and costs $0.

Frozen paths were not touched. `git status` at the end of this group shows no
entry under `.genie/wishes/rlmx-explore-offload/tasks/` or
`.genie/wishes/rlmx-explore-offload/parity/runs/` — verified in §6.

---

## 1. Archival (B5) — copy, then verify, and never remove

### 1.1 What was on the host

```
$ ls ~/.rlmx/agents/
changelog/  codebase-qa/  log-triage/
```

Each is `agent.yaml` + `SYSTEM.md`, mtime 2026-07-25, all three declaring
`shape: loop` and `model: station/Qwen3.6-35B-A3B-MTP-GGUF`.

### 1.2 Copy, byte-verified

```
$ for a in changelog codebase-qa log-triage; do
    mkdir -p examples/agents/$a
    cp -p ~/.rlmx/agents/$a/agent.yaml ~/.rlmx/agents/$a/SYSTEM.md examples/agents/$a/
  done
$ sha256sum ~/.rlmx/agents/*/{agent.yaml,SYSTEM.md} examples/agents/{changelog,codebase-qa,log-triage}/{agent.yaml,SYSTEM.md}
```

| recipe | file | sha256 | host == repo |
|---|---|---|---|
| `changelog` | `agent.yaml` | `6c9b9ac4aac34ef9dc196f13a26ca87daf09cabcab5140e58848830f9ab31a8a` | yes |
| `changelog` | `SYSTEM.md` | `6deafc31f2512b066e096ab05fa199e0ab6c1b97d4a06f36288213e88a608048` | yes |
| `codebase-qa` | `agent.yaml` | `7ce6a37db53bc14b8b0d8023fa3a57515062439b939d7d2201869564fbc1307f` | yes |
| `codebase-qa` | `SYSTEM.md` | `dd79b6e88f777f1146473bbad82ad00ef82f18325460572debba793d3d2e3fc2` | yes |
| `log-triage` | `agent.yaml` | `996c36364a461b8e25ed3a9de65491b43baa669e15b88ae757af9e5292a8b318` | yes |
| `log-triage` | `SYSTEM.md` | `64985150e6912a06d3b12007043d69b37f77b2e4851850e3be7385f617041fb9` | yes |

`diff -q` reports no difference on all six files.

### 1.3 Verified to load via `loadAgentSpec` — verbatim

```
$ node --input-type=module -e '
const { loadAgentSpec } = await import("./dist/src/sdk/index.js");
for (const n of ["changelog","codebase-qa","log-triage"]) {
  const s = await loadAgentSpec("examples/agents/"+n);
  console.log(JSON.stringify({dir:…,shape:s.shape,model:s.model,systemPath:s.systemPath,budget:s.budget,…}));
}'
{"dir":"examples/agents/changelog","shape":"loop","model":"station/Qwen3.6-35B-A3B-MTP-GGUF","systemPath":"SYSTEM.md","budget":{"maxIterations":6},"schemaVersion":1,"toolsApi":1,"tools":[],"description":"Turns raw git log output into Keep-a-Changelog entries group..."}
{"dir":"examples/agents/codebase-qa","shape":"loop","model":"station/Qwen3.6-35B-A3B-MTP-GGUF","systemPath":"SYSTEM.md","budget":{"maxIterations":8},"schemaVersion":1,"toolsApi":1,"tools":[],"description":"Answers a factual question about a directory of code or docs..."}
{"dir":"examples/agents/log-triage","shape":"loop","model":"station/Qwen3.6-35B-A3B-MTP-GGUF","systemPath":"SYSTEM.md","budget":{"maxIterations":6},"schemaVersion":1,"toolsApi":1,"tools":[],"description":"Extracts the actual failure from a long build/test/CI log an..."}
```

That one-shot proof is now a standing regression:
`tests/examples-agents-recipes.test.ts` enumerates **every** directory under
`examples/agents/` from the filesystem, loads each through `loadAgentSpec`, and
pins the three archived recipes to the shape, model, `system:` and
`budget.max_iterations` they were archived with.

### 1.4 Host removal — documented, never performed

`~/.rlmx/agents/` is **unchanged**. Nothing in this group deleted, moved or
rewrote a file under the user's home directory. Each archived recipe's README
carries a *Removing the host copy — a user step, not something rlmx did*
section with the exact `rm -rf ~/.rlmx/agents/<name>` and what it costs. The
`codebase-qa` README argues **against** running it, on the ground that the
replacement claim is unsupported (§1.6).

Post-condition check is in §6.

### 1.5 Flat entries migrated

`git mv` (rename-detected, history preserved):

```
R  examples/brain-triage/{README.md,SYSTEM.md,agent.yaml,tools/search_corpus.py}
     -> examples/agents/brain-triage/…
R  examples/hello-world/{README.md,SYSTEM.md,agent.yaml,tools/greet.mjs}
     -> examples/agents/hello-world/…
R  examples/research-agent/{README.md,SYSTEM.md,VALIDATE.md,agent.yaml,tools/fetch-url.mjs}
     -> examples/agents/research-agent/…
```

Every in-repo reference to the old flat paths was rewritten in the same change:
the three `EXAMPLE_DIR` constants in `tests/example-*.test.ts`, the self-paths
inside the three moved READMEs, `docs/tool-authoring.md`, and the root
`README.md`. Residual check in §6.

The `rlmx.yaml` **config** examples (`tauri-docs/`, `codebase-qa/`,
`paper-review/`, `cag-*`, `gemini-*`) stayed flat: they are not `agent.yaml`
recipes and do not belong in a discovery root. `examples/README.md` now leads
with that distinction, including the `codebase-qa` name collision
(`examples/codebase-qa/` config vs `examples/agents/codebase-qa/` microagent).

### 1.6 Why `codebase-qa` was archived rather than dropped

Wish scope IN, and plan-review B-3. The claim "`explore-r` replaces
`codebase-qa`" is **positioning, not a demonstrated result**:

- The explore parity gate scored **0 of 6 tasks** against a bar of 5 of 6, in
  **both** rounds (`docs/parity-explore.md`, *Gate arithmetic*: criteria 2 and 3
  pass on all six, criterion 1 on none).
- **No measurement anywhere in this repository compares the two recipes** on
  anything.

Deleting a working tool on an unsupported premise is exactly the
"unrecoverable deletion on a falsified premise" the plan review refused. The
recipe is preserved in full, and its README states the comparison honestly
instead of asserting a winner.

---

## 2. Bench consolidation (B2 amended) — `docs/worker-models.md`

Written to be a *consolidation*, not a new measurement: every cell in the
matrix table is copied from a committed record under
`parity/round2/optimizer/matrix/<arm>/summary.json`, with the corrections from
`parity/round2/optimizer/matrix/README.md` applied in place.

### 2.1 Numbers, and where each comes from

| claim in `docs/worker-models.md` | source |
|---|---|
| flash 29–31/34 (published 32, withdrawn) | `matrix/README.md`, *The flash arm's 32/34 does not reproduce* |
| qwen 28/34, pro 25/34, glm 20/34 | each arm's `summary.json` → `totals.factsFound` |
| $/round 0.15 / 2.82 / 1.30 / 1.95 | each arm's `summary.json` → `totals.costUsd` |
| pro and glm `$` undercounted | `matrix/README.md` footnote ¹ — verified: `runs/task-5.json` (pro) and `runs/task-6.json` (glm) carry no cost footer |
| runsOk 6/6, 6/6, 5/6, 5/6 | `summary.json` → `totals.runsOk` |
| citations 109/109, 64/64, 65/65, 101/101 | `summary.json` → `totals.citations` / `citationsResolved` |
| cost ranking 8.7× / 13× / 18.8× per round; 10× / 19× / 19.5× per fact | `matrix/README.md`, *What the matrix decides* |
| ±3-fact run-to-run spread; generations `[28, 29, 28, 29]` | `matrix/README.md`, *Why n = 1 is the binding constraint*; per-generation `summary.json` (gen-0 28, gen-1 29, gen-2 28, gen-3 29) |
| run dates (UTC) | each `round.json` → `startedAt` / `finishedAt` |
| holdout 0.714 vs 0.853–0.912 in-sample | `docs/parity-explore.md:1047-1048`; `optimizer/holdout/README.md` (`fitness=0.7143`) |
| 215 citations, zero fabricated, frozen configuration only | `docs/parity-explore.md:827-828`; earlier rounds fabricated `:426-427`; verification block `:685` |
| 1,077× / 530×–1,835× / $0.22 | `docs/parity-explore.md:960-970` |
| round 1's 921× / $0.14, different configuration | `docs/parity-explore.md:554-562` |
| four generations evaluated, a fifth rejected | `docs/parity-explore.md:1049-1055`; `optimizer/gens/gen-4/README.md` (**REJECTED**) |
| recursion product fixes = commit `6ec4822` | `git show --stat 6ec4822` — *fix(recursion): child model pinning, `rlm_query` model arg, loud child failure* |
| shipped `examples/agents/explore-r/` is gen-0, not the measured gen-1 | `sha256sum`: shipped `SYSTEM.md` `06c6ea94…` == `gens/gen-0/recipe/SYSTEM.md`; every round-2 number ran `02184f35…` |

### 2.2 Per-arm pricing

Read live from the khal LiteLLM gateway on 2026-07-27 — the same day every arm
ran — via a read-only `GET /v1/model/info`:

```
khal/deepseek-v4-flash | in/tok=1e-7      | out/tok=2e-7      | $0.10 / $0.20 per Mtok | ctx=1,048,576
khal/glm-5.2           | in/tok=1e-6      | out/tok=4e-6      | $1.00 / $4.00 per Mtok | ctx=1,048,576
khal/deepseek-v4-pro   | in/tok=1.3e-6    | out/tok=2.6e-6    | $1.30 / $2.60 per Mtok | ctx=1,048,576
khal/qwen3.7-max       | in/tok=2.5e-6    | out/tok=7.5e-6    | $2.50 / $7.50 per Mtok | ctx=256,000
```

`station/*` is `$0.00` by construction, not by measurement:
`src/station-provider.ts` declares `cost: { input: 0, output: 0, cacheRead: 0,
cacheWrite: 0 }` because a keyless local gateway bills nothing. The flash row
matches the fixture pinned by `tests/khal-provider.test.ts`.

**Deliberately not published:** a per-arm token total derived by summing the run
records' footers. Those sums do not reconcile with the recorded `costUsd` (flash
841,504 in / 115,749 out at catalog price is $0.107 against a recorded $0.15),
so the footer's token counts and its dollar figure are not the same accounting.
The recorded `costUsd` is the committed number and is what the table quotes; the
reconciliation gap is stated here and not explained, because nothing in this
group measured the cause.

---

## 3. Station arm (B2 amended) — model selection

The wish says *"the station model from the live gateway that best fits the
train harness."* The harness is `run-train-round.mjs` driving the recursive
`explore-r` recipe, whose binding constraint is **generation throughput**: the
parent's `rlm_query_batched` blocks its Python REPL until every child exits,
and the whole wave has to finish inside `RLMX_REPL_TIMEOUT_MS=600000` or the
run returns nothing at all. One parent plus up to four children is five streams
on one local gateway. So the selection is: *the fastest-generating model on
this host that rlmx resolves as a first-class `station/<id>`.*

### 3.1 The candidates, from the live gateway

`GET /api/v1/models` on 2026-07-27 advertises 24 ids. Excluding the non-chat
recipes the provider itself filters (`embeddings`, `reranking`,
`transcription`, `tts`, `image`, `edit` — `src/station-provider.ts`
`NON_CHAT_LABELS`), the chat-capable candidates in the 26B–35B class are
`Brain-35B`, `Qwen3.6-35B-A3B-MTP-GGUF`, `qwen3.6-moe-35b-a3b-FLM`,
`Gemma-4-26B-A4B-it-GGUF`, and `LMX-Omni-52B-Halo` (a collection).

### 3.2 Measured throughput on this exact host

`~/workspace/minipc-llm-benchmarks/RESULTS.md`, measured 2026-07-19/20 against
this same Lemonade 11.0.0 on port 13305, `tg` = best of 2 × 256-token runs,
`pp` = one ~29K-token uncached prompt:

| path | gen tok/s | prefill tok/s | GTT GiB |
|---|---|---|---|
| **`Qwen3.6-35B-A3B` +MTP, iGPU Vulkan** | **25.4** | 228.9 | 29.9 |
| `Qwen3.6-35B-A3B`, iGPU Vulkan (no MTP) | 21.3 | 242.9 | 26.9 |
| `Gemma-4-26B-A4B` (MoE, 4B active) | 18.7 | 302.9 | 23.6 |
| `qwen3.6-moe-35b-a3b-FLM`, **NPU** | 11.4 | 201.4 | — |

The MTP GGUF is the fastest generation path on this box by 19% over the
non-MTP build and **2.2×** over the NPU build of the same weights. Since
generation, not prefill, is what a 14-iteration fan-out spends its clock on,
that is the number that decides.

### 3.3 Two candidates ruled out by what happened today

- **`Brain-35B` — excluded on feasibility, observed.** It is
  `scripts/smoke-explore.mjs`'s default station model, so it was tried first. A
  single chat completion request to it **wedged the gateway's model loader for
  about 31 minutes**. Timeline, from the polling log kept at the time:

  | UTC | observation |
  |---|---|
  | 16:47:02–16:52:01 | `model_loaded: qwen3.5-2b-FLM`, `status: ready` (the NPU model that had just answered a probe in **1.1 s**) |
  | 16:52:26 | `model_loaded: null`, `all_models_loaded: []` — the 2 B was evicted and nothing replaced it |
  | 17:10:07 | a completion request **for the 2 B** returns nothing in 45 s |
  | ~17:12 | `POST /api/v1/unload` → `"All models unloaded successfully"`; a following 90 s completion still returns nothing |
  | 17:17 | `POST /api/v1/load {"model_name":"qwen3.5-2b-FLM"}` blocks for 115 s |
  | 17:19:58 | second `unload`, then an explicit `load` of the 2 B |
  | 17:23:33 | health shows a model loaded again |
  | 17:23:44 | 2 B completion returns in **1.667 s** — service restored |

  Throughout the whole window `GET /api/v1/health` returned `status: ok`,
  which is why `lemond-health.timer` never restarted the service: its probe is
  exactly that endpoint (`systemctl cat lemond-health.service`). System memory
  never grew, so the weights never reached memory. Its gateway recipe pins
  `ctx_size: 262144` and, unlike `Qwen3.6-35B-A3B-MTP-GGUF`, does **not** pin
  `llamacpp_backend: vulkan` — verified against `GET /api/v1/models`. *Not
  diagnosed further*: one wedge on one host is a reason to pick another model,
  not a bug report, and this group had no root access to investigate the
  service (`sudo -n` → "interactive authentication is required"; nothing was
  restarted).
- **`qwen3.6-moe-35b-a3b-FLM` — not selected.** Already 2.2× slower at
  generation in the benchmark above, and a live probe started 17:24Z had still
  not produced a token when it was abandoned at 17:31Z. The NPU path's real
  advantage — leaving the iGPU free — is worth nothing to a bench that has the
  box to itself.

### 3.4 First choice, and what it did: `Qwen3.6-35B-A3B-MTP-GGUF`

On the evidence in §3.2–§3.3 this was the pick, for four reasons in order of
weight:

1. **Fastest measured generation on this host** (25.4 tok/s) — the constraint
   that decides whether a fan-out finishes inside the 600 s REPL wall.
2. **A static baseline in `src/station-provider.ts`**, carrying the tuned
   `qwen-gguf` compat (`reasoning: true` + `thinkingFormat:
   "qwen-chat-template"`). It does not depend on the dynamic overlay
   classifying it correctly — and the provider's own docstring records that
   without that format the 35B "dumps everything into `reasoning_content` and
   never emits a `content` delta", i.e. parses as EMPTY.
3. **It is the model this repo's own microagents ship with** — all three
   archived recipes (`changelog`, `codebase-qa`, `log-triage`) declare exactly
   `station/Qwen3.6-35B-A3B-MTP-GGUF`.
4. **Its gateway recipe pins `llamacpp_backend: vulkan`**, the backend
   `RESULTS.md` found wins every LLM cell here.

**It did not serve.** Probe issued 17:31:44Z. The weights reached the GPU —
`/sys/class/drm/card1/device/mem_info_gtt_used` rose to **22,504 MiB** by
17:34:26Z, which is the 22.1 GB checkpoint and is the *difference* from
`Brain-35B`, whose attempt never allocated anything. GTT then stayed at exactly
22,504 MiB, unchanged, for the next **seven minutes**; `model_loaded` stayed
`null`; and the completion returned an **empty body after 600 s**
(`elapsed_first=600s`). `RESULTS.md` records this checkpoint needing 29.9 GiB
GTT at full context, so it stalled with the weights resident and the KV
allocation incomplete.

### 3.5 The escalation, recorded in order

With the first choice failing, the remaining station candidates were tried
smallest-risk-first. Every step was preceded by `POST /api/v1/unload`
returning `"All models unloaded successfully"`, and GTT never fell below
22,504 MiB again.

| # | model | path | issued | outcome |
|---|---|---|---|---|
| 1 | `Brain-35B` | llamacpp, no backend pin | 16:4xZ | wedged the loader ~31 min (§3.3) |
| 2 | `qwen3.6-moe-35b-a3b-FLM` | NPU / FastFlowLM | 17:24:03Z | no token in 7 min, abandoned |
| 3 | `Qwen3.6-35B-A3B-MTP-GGUF` | llamacpp, vulkan-pinned | 17:31:44Z | weights loaded, **empty body after 600 s** |
| 4 | `Qwen3.5-4B-MTP-GGUF` | llamacpp, static baseline, 3.41 GB | 17:42:09Z | GTT never moved; no response |
| 5 | `qwen3.5-9b-FLM` | NPU / FastFlowLM | 17:43:2xZ | no response in 190 s |
| 6 | `qwen3.5-2b-FLM` | NPU, static baseline — **had served in 1.1 s and 1.667 s earlier today** | 17:46:50Z | no response in 290 s |

Step 6 is the decisive one: the model that answered twice in under two seconds
this same session stopped answering. That is not a property of any candidate
model — **the gateway's loader was wedged**, and no choice of model could fix
it. No root access was available to restart `lemond`
(`sudo -n` → *"interactive authentication is required"*), and its health probe
cannot see the fault because `/api/v1/health` reports `status: ok` throughout.
Nothing was restarted and no service was touched.

### 3.6 What un-wedged it, and what was finally selected

Recovery came from a **quiet** unload cycle — the earlier attempts had kept
issuing requests, which kept the loader busy. Verbatim, from
`restore-station.log`:

```
T0 17:52:02
{"message":"All models unloaded successfully","status":"success"} unload1 17:52:02
              ← 180 s of silence: no request of any kind
{"message":"All models unloaded successfully","status":"success"} unload2 17:55:02
              ← 60 s of silence
load1 start 17:56:02
{"checkpoint":"qwen3.5:2b","model_name":"qwen3.5-2b-FLM","recipe":"flm","status":"success"} load1 done 17:59:33
{"choices":[{... "content":"OK" ...}], ... "model":"qwen3.5:2b" ...} probe done 17:59:34
```

GTT fell from 22,504 MiB to **871 MiB** during the first quiet interval — the
first time all session that the previous allocation was actually released.

**Selected: `station/qwen3.5-2b-FLM`.** Not because it is the best station
model — it plainly is not — but because it is **the only station model that
served on this host today**, and an arm that cannot execute measures nothing.
It is also a **static baseline** in `src/station-provider.ts` (its docstring
calls it "the NPU gate model"), so it carries a tuned `flm` compat entry rather
than a dynamically-guessed one.

**State this wherever the arm's numbers appear:** a 2 B model is *below* the
capability floor this recipe was written for.
`scripts/smoke-explore.mjs` says so in its own comment — "a 4 B model runs the
protocol fine and fails the task, which would make this gate about model
capacity instead of the recipe". The arm therefore reports **feasibility, cost
and replicate spread**, and its coverage number is a floor for the station
provider, not an estimate of it. It is already marked not-rank-comparable
against the n = 1 khal arms; against *larger station models* it is not
comparable either, because none of them ran.

**Re-runnable.** This is the wish's own pre-registered mitigation for this risk
("Station gateway down for the bench arm | Low | n=2 re-runnable any time").
The command in `station-arm/README.md` takes `--model station/<model>`; when
the gateway will hold a 35 B again, the same two replicates re-run unchanged.

## 4. Station arm — protocol and result

### 4.1 Preflight, verbatim

`--dry-run` before spending anything. Note the third line: **no ground-truth
drift**, so `--allow-drift` was neither needed nor passed.

```
$ node $R/run-train-round.mjs --gen 1 --model station/Qwen3.6-35B-A3B-MTP-GGUF \
    --recipe $R/optimizer/gens/gen-1/recipe \
    --gen-dir $R/optimizer/station-arm/rep-1 --label station-arm-rep1 \
    --concurrency 1 --dry-run
# run-train-round: gen-1 · station/Qwen3.6-35B-A3B-MTP-GGUF · tasks 3,4,5,6,7,8 · concurrency 1
# recipe …/optimizer/gens/gen-1/recipe → SYSTEM.md 02184f35 / agent.yaml 20f8e018
# suite  …/round2/train-tasks  (held out, never run here: 1, 2)
# env    RLMX_REPL_TIMEOUT_MS=600000 RLMX_MCP_RUN_TIMEOUT_MS=900000 PARITY_CALL_TIMEOUT_MS=600000 PARITY_MAX_TOTAL_TIMEOUT_MS=2400000
# root   /home/namastex/prod/xdna-top  .rlmx ABSENT — a run will scaffold one, removed at the end
# root   /home/namastex/prod/genie-desktop  .rlmx ABSENT — a run will scaffold one, removed at the end
# root   /home/namastex/prod/fde-station  .rlmx ABSENT — a run will scaffold one, removed at the end
# dry run — nothing spawned
```

`RLMX_REPL_TIMEOUT_MS=600000` is set on every `rlmx mcp` process the round
spawns, as the harness header requires and as this task mandated.

### 4.2 What was actually run

```
=== rep-1 start 2026-07-27T17:59:52Z ===
# run-train-round: gen-1 · station/qwen3.5-2b-FLM · tasks 3,4,5,6,7,8 · concurrency 1
# recipe …/optimizer/gens/gen-1/recipe → SYSTEM.md 02184f35 / agent.yaml 20f8e018
# suite  …/round2/train-tasks  (held out, never run here: 1, 2)
```

Both replicates, sequentially, then `optimizer/union-report.mjs` over the two.
Records land under `parity/round2/optimizer/station-arm/rep-{1,2}/` — **not**
under either frozen path.

`--pin-child-model` is on (the harness default). Read live out of the round's
scratch HOME while task 3 was running, showing the recursive children pinned to
the same local model and **no key of any kind** in the file:

```
$ cat /tmp/rlmx-parity-station-arm-rep1-t3/.rlmx/settings.json
{
  "model.provider": "station",
  "model.model": "qwen3.5-2b-FLM",
  "model.sub-call-model": "qwen3.5-2b-FLM"
}
```

That is the fix `6ec4822` made structural (the child now also carries `--model`
on its own argv) and the belt-and-braces the harness keeps: round 1's only
three recursive spawns ran unpinned and returned silently empty
(`recursion-recon.md` §2.2).

### 4.3 The failure mode, characterised

Worth stating separately from the totals, because it is *not* the failure the
khal arms had. The 2 B does not answer badly — **it does not use the REPL at
all**. Verbatim, rep-1 task 4:

> "I apologize. I do not have access to any codebase or files. The query asks
> me to analyze a repository that is inaccessible, so all citations would be
> \"NOT FOUND\"."

and rep-1 task 3 opens:

> "Since I don't have access to your working directory or file paths (as none
> were provided) … I would print that nothing is found in this tree."

Both then print `look()` **as source text** instead of executing it.

Two consequences in the records, and they must be read separately:

1. **Five of six runs emit zero citations**, so their criteria 2 and 3 pass
   *vacuously* — the scorer had nothing to fail. `union-report.mjs` marks that
   case `VACUOUS` by design. Do not read those PASSes as citation discipline.
2. **The sixth is a real fabrication.** rep-1 task 8 emitted exactly one
   citation and it failed **both** criteria:

   ```
   TASK 8 … c2=FAIL c3=FAIL cites=0/1 …
     C2FAIL app/models/order.rb:88 (missing-file)
     C3FAIL app/models/order.rb:88 (missing-file)
   ```

   `app/models/order.rb:88` does not exist in that task's root
   (`/home/namastex/prod/fde-station`). It is a **worked example inside the
   recipe's own prompt** — `gens/gen-1/recipe/SYSTEM.md` lines 500, 510 and 514
   (`grep -c` → 3). The model recited its instructions and the scorer counted
   it, correctly, as a fabricated citation.

That second item is worth stating plainly because it is the defect class that
sank gen-4: **prompt content leaking into answers**. Here it produced no false
HIT — this suite's fact anchors are its own paths — but it produced a real c3
failure, which is the first one in the round-2 record on any arm. All four khal
arms were 0-fabrication. The difference is the model, not the prompt.

**The fan-out never fired: `spawns=0` on all six runs.** So this arm does not
exercise recursion at all; it measures the parent loop alone.

### 4.4 Result — verbatim

```
=== rep-1 start 2026-07-27T17:59:52Z ===
# task 3 OK exit=0 893.9s scored=true
# task 4 OK exit=0 170.8s scored=true
# task 5 OK exit=0 207.6s scored=true
# task 6 OK exit=0 414s   scored=true
# task 7 OK exit=0 259.8s scored=true
# task 8 OK exit=0 135.4s scored=true
ROUND gen=1 facts=0/34 fitness=0 weak=0 tasksPassed=0/6 runsOk=6/6 c2fail=1 c3fail=1 cites=0/1 spawns=0 cost=$0 wall=2082s
=== rep-1 exit=0 2026-07-27T18:34:34Z ===

=== rep-2 start 2026-07-27T18:34:35Z ===
# task 3 OK exit=0 187.3s scored=true
# task 4 OK exit=0 900.6s scored=true
# task 5 OK exit=0 405.2s scored=true
# task 6 OK exit=0 292.7s scored=true
# task 7 OK exit=0 304.2s scored=true
# task 8 OK exit=0 186.8s scored=true
=== rep-2 exit=0 2026-07-27T19:12:33Z ===

UNION facts=0/34 coverage=0 perReplicate=[0, 0]/34 spread=0 unionLift=+0
      runsOk=[6, 6]/6 c2fail=1 c3fail=1 vacuousCriteria=6 fabrications=1 citeFail=1
      cites=[0/1, 0/0] spawns=[0, 0] perRun=0..0 cost=[$0, $0] wall=[2082, 2277]s
```

**Honest exit codes:** both replicates exited **0** and every one of the 12 runs
completed and scored. Nothing timed out, nothing was lost, and no failure had to
be recorded because none occurred — which is itself the arm's main positive
result, since `deepseek-v4-pro` and `glm-5.2` each lost a run on this same
suite.

**`union.txt` label.** The first union run was emitted with
`--label "station arm (Qwen3.6-35B-A3B-MTP-GGUF)"` — the model that was chosen
but **never served**. That label was wrong the moment it was written, so
`union-report.mjs` was re-run with
`--label "station arm (station/qwen3.5-2b-FLM, n=2, NOT rank-comparable)"`.
The round records themselves always carried the true model
(`round.json` → `model: station/qwen3.5-2b-FLM`); only the label was stale.

**Records** (none under a frozen path):

```
parity/round2/optimizer/station-arm/
├── README.md
├── union.json, union.txt
├── rep-1/{round.json,summary.json,summary.txt,recipe/,runs/task-{3..8}.{json,score.json},logs/}
└── rep-2/{round.json,summary.json,summary.txt,recipe/,runs/task-{3..8}.{json,score.json},logs/}
```

**The three task roots were never written to.** `~/prod/xdna-top`,
`~/prod/genie-desktop` and `~/prod/fde-station` are the user's own checkouts;
each `round.json` records, for all three and in both replicates:

```
{"rlmxExistedBefore":false,"rlmxExistsAfter":false,"createdByThisRound":false,"cleanedUp":false}
```

No `.rlmx/` was scaffolded, so none had to be cleaned up — because auto-scaffold
is triggered by a recursive child running with the root as its cwd, and
`spawns=0` means no child ever ran. Confirmed live afterwards: `[ -d
<root>/.rlmx ]` is false for all three.
