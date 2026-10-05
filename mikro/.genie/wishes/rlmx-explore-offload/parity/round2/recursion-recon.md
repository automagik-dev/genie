# Recursion recon — how `llm_query` / `rlm_query` actually work in rlmx

Round-2 prerequisite for the recursive explore variant (`examples/agents/explore-r/`).
Everything below is either a `file:line` citation into this checkout at
`wish/rlmx-explore-offload` (**`2a32fd9`**) or a **verbatim command + output**
from a probe run against the live khal gateway. Nothing here is inferred from
prose. Every citation is repo-root-relative, and every one of them was
re-resolved against `2a32fd9` — which is also the commit all four smoke records
in §8 were captured at (`rlmxGit.head = 2a32fd9` in each). The pin was `9abd6fa`
in the first draft and that was wrong twice over: `2a32fd9` rewrote
`src/mcp/server.ts` (+37/-21) under the doc, and two of the §4.1 anchors did not
resolve at `9abd6fa` either.

**Three anchors survived that re-pin still pointing off-target, and were
corrected on 2026-07-27.** A re-resolution pass that only checks *whether* a
line exists cannot catch a citation that resolves to the wrong line, and this
one did not. Superseded → corrected, all in `2a32fd9`:

| § | Cited | Actually | Now reads |
|---|---|---|---|
| 1 | `llm_bridge.py` 26-27 — a blank line and `msg = {` | the IPC-fault return is at 24-25 | `24-25,41-49` |
| 3 | `llm_bridge.py` 30-32 — stops one line short | `msg["model"] = model` is line 33 | `32-33` |
| 5 | `agent-spec.ts` 44-48 — 44 is blank, drops the closing `] as const;` | `VALID_SHAPES` spans 45-49 | `45-49` |

Every `path:line` anchor in this file has now been re-resolved **by content**,
not merely by range, at `2a32fd9`. Do the same before re-pinning it again: a
range check passes on all three of the rows above.

---

## 1. The call chain, end to end

```
Python REPL block            python/llm_bridge.py:58 / :64 / :71 / :77
  → JSON on real stdout      python/llm_bridge.py:22-49   {"type":"llm_request", request_type, prompts, model?}
  → Node reads the frame     src/repl.ts:444-465
  → handler installed by     src/rlm.ts:420-486  (repl.onLLMRequest)
  → routed by request_type   src/llm.ts:707-...  (handleLLMRequest)
      llm_query          →   src/llm.ts:708-716   in-process llmCompleteSimple
      llm_query_batched  →   src/llm.ts:718-726   in-process llmCompleteBatched
      rlm_query          →   src/llm.ts:727-739   spawns a CHILD rlmx PROCESS
      rlm_query_batched  →   src/llm.ts:741-755   ≤4 children at a time
```

**What the Python code calls.** Four names are bound into the REPL namespace at
`python/repl_server.py:90-93` (and re-bound after a reset at `:147-150`), and
they are on the protected-globals list at `python/repl_server.py:37-38`:

| Python name | Signature | Backing |
|---|---|---|
| `llm_query(prompt, model=None)` | `python/llm_bridge.py:58` | one in-process completion, no REPL |
| `llm_query_batched(prompts, model=None)` | `python/llm_bridge.py:64` | concurrent in-process completions |
| `rlm_query(prompt, model=None)` | `python/llm_bridge.py:71` | one child `rlmx` **process**, own REPL |
| `rlm_query_batched(prompts, model=None)` | `python/llm_bridge.py:77` | up to 4 child processes concurrently |

Every one of them **blocks the REPL** — `_ipc_lock` plus a blocking
`_ipc_in.readline()` at `python/llm_bridge.py:33-40`. A fan-out costs one
iteration of parent wall-clock, not N.

**Failures never raise.** `src/repl.ts:449-462` turns any handler throw into the
*string* `"Error: LLM handler failed — <msg>"`, one per prompt, and hands it back
as a normal result. `python/llm_bridge.py:24-25,41-49` does the same for IPC
faults. So a broken sub-call looks exactly like a returned answer. **This is the
single most important fact in this document** and it is why round 1 could use
the lever and never notice it was dead (§5).

---

## 2. `rlm_query` spawns a real child process

`src/llm.ts:512-651`. The spawn itself:

```
src/llm.ts:558-566
    spawn(process.execPath,
          [process.argv[1], ...buildRlmChildArgs(prompt, {...options, output:"json", stats:true, noSession:true})],
          { cwd, detached: …, stdio:["pipe","pipe","pipe"], env: buildChildEnv(process.env, parentRunId, correlationId) })
```

- `cwd` is `config.configDir` (`src/llm.ts:730`), i.e. the MCP server's `--dir`.
- `process.argv[1]` is `dist/src/cli.js`, so the child is an ordinary
  `rlmx "<prompt>"` **query** run — it goes down `runQuery`, `src/cli.ts:293`.
- argv is built by `buildRlmChildArgs`, `src/llm.ts:457-469`. The complete set:
  `--output json --stats --max-iterations --timeout --max-depth --max-cost
  --max-tokens --no-session`.
- env by `buildChildEnv`, `src/llm.ts:471-479`: full `process.env` plus
  `RLMX_PARENT_RUN_ID`, `RLMX_CHILD_CORRELATION_ID`, `RLMX_RECURSION_DEPTH+1`.
  **`KHAL_API_KEY` therefore reaches the child** — the key is not the problem.
- stdout is parsed by `parseRlmChildOutput`, `src/llm.ts:482-495`; only
  `answer`, `stats.run_id` and `usage` survive. **The child's `model` is parsed
  out of the JSON and discarded** — nothing downstream can see what the child ran on.
- Non-zero exit → `answer = "Error: child rlmx exited with code N. <stderr>"`
  (`src/llm.ts:600-602`). A *zero* exit with an empty answer is returned as-is.

### 2.1 The child does NOT inherit the agent — this is the crux

`buildRlmChildArgs` emits **no `--model`, no `--system`, no `--agent`**, and
`src/cli.ts:148-174` shows the CLI has **no `--model` flag at all**. There is no
argv route for a parent to pin its child's model.

So the child re-derives its own config from scratch, by the ordinary CLI
precedence (`src/cli.ts:34-38`, applied at `src/cli.ts:324-325`):

```
CLI flags  >  ~/.rlmx/settings.json  >  <cwd>/.rlmx/rlmx.yaml  >  hardcoded defaults
```

with `~` = the child's inherited `HOME`, `<cwd>` = the server's `--dir`, and the
hardcoded default being `google/gemini-3.1-flash-lite-preview`
(`src/config.ts:122-125`). Settings are loaded and injected in `main()` at
`src/cli.ts:965-967`.

The parent's `agent.yaml` model appears nowhere in that chain. Neither does the
agent's `SYSTEM.md`: `applyAgent` (`src/mcp/server.ts:481-500`) sets
`next.system` **in the parent's memory only**, and the child reads
`<cwd>/.rlmx/SYSTEM.md` (`src/config.ts:563-567`). A recursive child of
`explore-r` is a **generic rlmx agent running the ambient prompt**, not another
explore agent. Sub-prompts must therefore carry the whole citation contract
inline; nothing else will.

Side effect worth knowing: `runQuery` auto-scaffolds when the cwd has no config
(`src/cli.ts:313-321`), so a child **writes `.rlmx/` into the task root** the
first time it runs there.

### 2.2 Probe — verbatim

Same argv the parent builds, run by hand from this checkout.

**(a) with my real `HOME`** (`~/.rlmx/settings.json` = `{"model.provider":"station","model.model":"qwen3.5-2b-FLM"}`):

```
$ node dist/src/cli.js "Reply with the single word OK." --output json --stats \
    --max-iterations 1 --timeout 90000 --no-session
{"answer":"OK", … "model":"station/qwen3.5-2b-FLM", …}
```

The checkout's own `.rlmx/rlmx.yaml:14-17` says `google/gemini-3.1-flash-lite-preview`.
It ran on **station**. settings.json won.

**(b) with a scratch `HOME`** — this is exactly the parity-harness condition
(`.genie/wishes/rlmx-explore-offload/parity/run-task.mjs:132`,
`scripts/smoke-explore.mjs:220` both set `HOME` to a scratch dir that has no
`settings.json`):

```
$ HOME=<empty scratch> node dist/src/cli.js "Reply with the single word OK." --output json --stats \
    --max-iterations 1 --timeout 90000 --no-session
rlmx [iter 0]: WARNING — LLM returned empty response. Possible context size limit.
{"answer":"", … "model":"google/gemini-3.1-flash-lite-preview", …, "usage":{…,"totalCost":0,…}}
```

**Exit code 0. `answer` is the empty string.** No error, no non-zero exit,
nothing for `src/llm.ts:600` to catch. `rlm_query()` returns `""` to the parent.

**(c) with a scratch `HOME` carrying a model pin** — the fix:

```
$ cat $H/.rlmx/settings.json
{ "model.provider": "khal", "model.model": "deepseek-v4-flash", "model.sub-call-model": "deepseek-v4-flash" }
$ HOME=$H node dist/src/cli.js "Reply with the single word OK." --output json --stats \
    --max-iterations 1 --timeout 90000 --no-session
{"answer":"OK", … "model":"khal/deepseek-v4-flash", … "totalCost":0.00030136}
```

`~/.rlmx/settings.json` in the harness's scratch `HOME` is the **only**
mechanism that pins a recursive child's model. It is a documented product
feature (`rlmx config set model.provider …`, `src/settings.ts:1-15`), not a hack.

**A source comment said the opposite, and it was wrong.** The header of
`src/settings.ts` read *"Priority: CLI flags > rlmx.yaml > settings.json >
hardcoded defaults"* (line 5, up to and including `2a32fd9`) — the reverse of
`src/cli.ts:35` and the reverse of what probe (a) above measures.
Nothing in the pin rests on the comment, but the whole install requirement rests
on the ordering, so a reader who checked that file would have concluded the pin
could not work. The comment is corrected in this change (`src/settings.ts:6-14`,
now carrying the two call sites that establish the order:
`applySettingsModelOverrides` at `src/cli.ts:33-39` runs *after* `loadConfig`,
`src/cli.ts:324-325`). No behaviour changed — a comment was brought into line
with the code the probe already demonstrated.

---

## 3. `llm_query` — the model kwarg works, the inherited default is a landmine

`src/llm.ts:703-705`:

```ts
const subCallModel: ModelConfig = config.model.subCallModel
  ? { ...config.model, model: config.model.subCallModel }
  : config.model;
```

and `src/llm.ts:711` — `request.model ? { ...subCallModel, model: request.model } : subCallModel`.

The **provider always comes from `config.model`**; only the model *id* is
swappable. Now combine with `applyAgent` (`src/mcp/server.ts:484-489`, the
assignment itself at `src/mcp/server.ts:487`):

```ts
next.model = { ...config.model, provider: parsed.provider, model: parsed.model };
```

It spreads `config.model` — so **`subCallModel` survives from the ambient
`rlmx.yaml` while provider and model are replaced by the agent's**. At this
checkout that composes `provider: khal` with `model: gemini-3.1-flash-lite-preview`
(`.rlmx/rlmx.yaml:17`).

### 3.1 Probe — verbatim

`HOME` pinned to `{"model.provider":"khal","model.model":"deepseek-v4-flash"}`
(no `sub-call-model`, so it falls through to the checkout's yaml — the exact
composition `applyAgent` produces), run from this checkout:

```
$ HOME=$H node dist/src/cli.js 'In your FIRST repl block run exactly:
    print(repr(llm_query("Reply with the single word PONG."))) …' \
    --output json --stats --max-iterations 3 --timeout 200000 --no-session
MODEL  khal/deepseek-v4-flash
ANSWER '"""\'Error: LLM handler failed — Unknown model "gemini-3.1-flash-lite-preview"
         for provider "khal". Try updating MODEL.md or check pi/ai supported models.\'"""'
```

With the kwarg supplied:

```
$ HOME=$H node dist/src/cli.js '… print(repr(llm_query("Reply with the single word PONG.",
    model="deepseek-v4-flash"))) …' --output json --stats --max-iterations 3 …
MODEL  khal/deepseek-v4-flash
ANSWER '"""PONG"""'
COST   0.00032956
```

So: **`llm_query(p)` is broken at any root whose `rlmx.yaml` declares a
`sub-call-model` from another provider — which is every root the default
scaffold has touched** (`src/templates/default/rlmx.yaml`, and the
auto-scaffolded `.rlmx/` in the task roots). `llm_query(p, model="<id on the
root provider>")` works.

`rlm_query` ignores the kwarg entirely: `src/llm.ts:727-733` never reads
`request.model`. The Python signature accepts it (`python/llm_bridge.py:71`) and
it is put on the wire (`python/llm_bridge.py:32-33`); the Node side silently
drops it. **`rlm_query(p, model="X")` is a no-op, not an error.**

---

## 4. Limits and budgets that apply to a sub-call

Assembled at `src/rlm.ts:434-440`, per IPC request:

| Knob | Value handed to the child | Source |
|---|---|---|
| `--max-iterations` | **the parent's own cap, unreduced** | `src/rlm.ts:436` |
| `--timeout` | the parent's own wall clock, ms, **restarted** | `src/rlm.ts:437` |
| `--max-depth` | `config.budget.maxDepth ?? 3` | `src/rlm.ts:438` |
| `--max-cost` | parent's `maxCost` **minus spend so far** | `src/rlm.ts:439`, `src/rlm.ts:973-986` |
| `--max-tokens` | same, remaining | `src/rlm.ts:440`, `src/rlm.ts:973-986` |

Consequences that decide the budget in `agent.yaml`:

1. **Iterations multiply.** A child inherits the *same* `--max-iterations` as its
   parent. Parent 24 + a 4-way fan-out = up to 24 + 4×24 = 120 model turns.
2. **Cost is drawn from one shared pool.** `buildRemainingChildBudget` hands each
   child the parent's *remaining* budget, and child usage is merged back into
   the parent's totals (`src/llm.ts:734-737`) and re-recorded on the parent's
   `BudgetTracker` (`src/rlm.ts:469-478`). A tight `max_cost` starves children
   specifically, because they are spawned late.
3. **Depth ceiling is 3 and `agent.yaml` cannot change it.** `applyAgent`
   (`src/mcp/server.ts:481-500`) copies `model`, `system` and `budget.maxCost`
   **and nothing else** — `budget.max_depth` and `budget.max_iterations` from
   `agent.yaml` never reach `config.budget`. `max_iterations` is rescued by a
   separate path (`agentMaxIterations`, `src/mcp/server.ts:474-478`, passed as
   `rlmLoop`'s `maxIterations`); **`max_depth` has no such path and is inert.**
   The effective ceiling is `config.budget.maxDepth ?? 3` from the *ambient*
   `rlmx.yaml` — `null` at this checkout (`.rlmx/rlmx.yaml:39`), hence 3. It
   does propagate correctly downward from there: the child receives
   `--max-depth 3`, `src/cli.ts:350-352` writes it into its own config, and the
   guard at `src/llm.ts:528-531` compares it against `RLMX_RECURSION_DEPTH`.
4. **Fan-out width is 4.** `MAX_CONCURRENT = 4`, `src/llm.ts:667`. A list of 9
   prompts runs as 4 + 4 + 1, three blocking waves.
5. **Cancellation is a process-group kill.** `src/llm.ts:569-586` — the parent's
   abort signal `SIGTERM`s `-child.pid`.

### 4.1 The 30-second wall — the limit that actually stops recursion

None of the knobs above is what bites first. This is:

```
src/repl.ts:81-87
    function defaultReplTimeoutMs(): number {
      const raw = process.env.RLMX_REPL_TIMEOUT_MS;
      if (!raw) return 30_000;                          // ← the wall
      …
    }
src/repl.ts:195      async execute(code, timeoutMs = defaultReplTimeoutMs())
src/repl.ts:424-429  setTimeout(… this.process?.kill("SIGKILL");
                       reject(new Error(`REPL execution timed out after ${timeoutMs}ms`)) …)
```

`rlm_query_batched` **blocks the Python REPL** for the entire lifetime of its
children (`python/llm_bridge.py:33-40`). So the parent block that spawned them
is on a **30-second** clock — while the children it is waiting on were just
handed `--timeout 900000` and `--max-iterations 18` by `src/rlm.ts:436-437`.
The two numbers are set 350 lines apart and nothing reconciles them: the child
budget is derived from the parent's *run* clock, the block is on the *REPL*
clock, and the second is 30× smaller than the first by default.

It is worse than a lost block. `repl.execute` at `src/rlm.ts:681` is **not
wrapped in try/catch**, so the rejection escapes `rlmLoop`, escapes `runTurn`,
and lands in the MCP call handler's catch at `src/mcp/server.ts:853-857`, which
returns the whole call as an error. There is no partial credit: everything read
before the fan-out is discarded.

Measured, in `parity/round2/smoke/smoke-2.json` — 4 spawns fired at iteration 2,
4 child processes observed with their verbatim argv, and then:

```
"ok": false, "isError": true, "wallSeconds": 51.1,
"fullText": "rlmx rlmx_explore-r failed: REPL execution timed out after 30000ms"
```

`RLMX_MCP_RUN_TIMEOUT_MS` does not help — it lifts the *run* wall clock only
(`src/mcp/server.ts:567-570`), and there is no per-block equivalent anywhere in
`src/mcp/`. **`RLMX_REPL_TIMEOUT_MS` must be set on the `rlmx mcp` process, or
recursion through the MCP path cannot complete.** This is an *environment
correction* in the exact sense round 1 used the term
(`docs/parity-explore.md:242-268`): a harness default that ends runs for
reasons that have nothing to do with the model.

`parity/round2/smoke-explore-r.mjs` sets it to `600000` — enough for a 4-wide
wave of 18-iteration children, leaving ~300s of a 900s run for the phases
either side of the fan-out.

The product fix, stated and not applied: `runTimeout()` at
`src/mcp/server.ts:567-570` has no sibling for the REPL clock, and `rlmLoop`
never passes one to `repl.execute` (`src/rlm.ts:681`). Either the MCP server
grows a `RLMX_MCP_REPL_TIMEOUT_MS`, or — better — `execute` for a block that
issued an `rlm_query*` should be on the *run* clock rather than the REPL one,
since the run clock is what already bounds the children.

---

## 5. What `shape: recurse` changes vs `loop` — **nothing**

`shape` is parsed and validated at `src/sdk/agent-spec.ts:35`, `:45-49`,
`:120-124`. Every use of the parsed value in the entire tree:

```
$ git rev-parse --short HEAD
2a32fd9
$ grep -rn "\.shape" src/ --include=*.ts
src/mcp/agents.ts:97      fallback tool description text
src/mcp/server.ts:176     tool description text: `shape=<shape>`
src/mcp/server.ts:477     agentMaxIterations(): `single-step` ? 1 : undefined
src/sdk/agent-spec.ts:120 the parse itself
```

(Captured at `2a32fd9`, the commit this document is pinned to. The `HEAD` line is
part of the block for a reason: this grep is a reproduction step in §7, and a
line number in a source file is only a fact about a revision.)

`recurse` and `loop` are **behaviourally identical**. Only `single-step` does
anything (caps iterations at 1). `recurse` does not enable recursion, raise a
depth limit, change the prompt, or alter routing — it changes one substring in
the tool description the host model reads. Recursion is available to *every*
shape, because it is a REPL namespace binding
(`python/repl_server.py:90-93`), not a shape feature.

**So the whole of the "recursive variant" lives in `SYSTEM.md` and `budget`.**
Declaring `shape: recurse` is honest labelling, and that is all it is.

---

## 6. What this means for round 1, and for round 2

**Round 1 used the lever exactly once in 97 recorded task-runs, and it returned
nothing.**

```
$ grep -rho "recursive spawn" .genie/wishes/rlmx-explore-offload/parity/runs/ | wc -l
3
$ grep -rl  "recursive spawn" .genie/wishes/rlmx-explore-offload/parity/runs/
.genie/wishes/rlmx-explore-offload/parity/runs/r15-flash-control/task-6.json
```

Three `Recurse` events, all in iteration 22 of one run, root
`/home/namastex/workspace/repos/genie`. Those three children ran under
`HOME=/tmp/rlmx-parity-r15-flash-control-t6`
(`.genie/wishes/rlmx-explore-offload/parity/run-task.mjs:51-52,132`) —
no `settings.json` — with `cwd = /home/namastex/workspace/repos/genie`, whose
`.rlmx/` is **untracked and auto-scaffolded** (`git status --porcelain .rlmx/`
→ `?? .rlmx/`) to `provider: google` (`.rlmx/rlmx.yaml:14-17` there). No Google
key was in the environment. By probe (b) in §2.2 that is a zero-exit,
empty-string return, three times.

`llm_query` was in the same state at that root, by §3 — every call would have
come back `Error: LLM handler failed — Unknown model "gemini-3.1-flash-lite-preview"
for provider "khal"`. And by §1 neither failure raises, so the round log
recorded "the lever was real" (`docs/parity-explore.md:358-362`) on the strength
of an anchor-coverage delta, with no way to see that the sub-calls were empty.

**Four things follow for round 2, in priority order.**

0. **`RLMX_REPL_TIMEOUT_MS` must be raised on the `rlmx mcp` process.** At the
   30s default the fan-out block is killed mid-wait and the *whole run* returns
   an error with no answer (§4.1). This one comes first because it is not a
   degradation, it is a total loss — and because it means round 1's harness
   could never have completed a fan-out even with the model pin in place. Any
   round-2 sweep on `run-task.mjs` must set it alongside
   `RLMX_MCP_RUN_TIMEOUT_MS`.
1. **The scratch `HOME` must carry `~/.rlmx/settings.json` pinning
   `model.provider` / `model.model` / `model.sub-call-model` to the round's
   model.** Without it, recursion is measurably a no-op. This is an
   *environment correction* of the same kind as `RLMX_MCP_RUN_TIMEOUT_MS`
   (`docs/parity-explore.md:242-268`) — it fixes a harness defect, changes no
   prompt and no rubric — and it must be recorded as one. `parity/run-task.mjs`
   is **not** modified by this task; round 2's smoke driver writes the file into
   its own scratch `HOME` and says so.
2. **`SYSTEM.md` must not depend on `llm_query`'s default model.** Either pass
   `model=` explicitly (which hard-codes a khal id and breaks the escalation
   ladder) or treat a sub-result beginning `Error:` as "this lever is
   unavailable here" and fall back to reading. `explore-r` takes the second
   route — it is model-agnostic and it is the one that survives the ladder.
3. **Sub-prompts must be fully self-contained, and must bound the child's
   effort.** The child runs the *ambient* `SYSTEM.md`, so it inherits none of
   round 1's hard-won citation discipline (`examples/agents/explore/SYSTEM.md`).
   Every rule the parent needs obeyed — `path:line` for every claim, "not found"
   over a guess, no dumping — has to be written into each sub-prompt. And
   because the ambient prompt tells a child to delegate and iterate freely, the
   sub-prompt must also say **stop early** and **do not delegate further**:
   measured below, an unbounded child ran its parent's whole iteration cap out.

### 6.1 Measured child cost — the numbers the budget is sized from

All `khal/deepseek-v4-flash`, against this checkout, argv identical to what
`buildRlmChildArgs` produces:

| Scenario | Result |
|---|---|
| one child, focused question, alone | **3 iterations, 27s**, $0.0016 |
| four children concurrently, loose questions | **1 / 9 / 12 / 18 iterations**, 61 / 74 / 154 / 233s |

Two things to read off it. First, four concurrent children against one khal key
completed — round 1's concurrency defect (`docs/parity-explore.md:246-252`,
six at once) does not reproduce at four. Second, **one of the four ran the cap
out at 18 iterations**: a child on the ambient prompt does not stop when it has
the answer, so the iteration cap *is* the child's wall clock, at ~8.5s per
iteration under contention. That is why `explore-r` sets `max_iterations: 14`
and why its sub-prompt template says "stop early, do not delegate further".

### 6.2 A REPL timeout orphans the children

`src/repl.ts:426` kills the *Python* subprocess with `SIGKILL`. The rlmx
children it was blocked on are spawned `detached` in their own process group
(`src/llm.ts:563`), and `terminateChildTree` is wired only to the run's abort
signal (`src/llm.ts:582-586`) — which a REPL timeout never raises. So they keep
running, on their own `--timeout 900000`, after the run that spawned them has
already returned an error. Observed: a child of the failed `smoke-2` was still
alive and was picked up by `smoke-3`'s process poller 10 minutes later
(`smoke-3.json`, the `secondsIntoRun: 0.3` entry — it is not one of smoke-3's
own four, which appear together at 50.5s). Harmless here, and it means a
cost-accounting number taken from the parent's footer can undercount.

### The one-line source fix, stated but deliberately NOT applied

`src/mcp/server.ts:484-489` should also clear or override the inherited
sub-call model:

```ts
next.model = { ...config.model, provider: parsed.provider, model: parsed.model,
               subCallModel: parsed.model };   // ← the missing clause
```

That repairs `llm_query` under every agent whose provider differs from the
ambient yaml's. It does **not** fix `rlm_query`, which needs either a `--model`
CLI flag or `buildRlmChildArgs` learning to pass the resolved model
(`src/llm.ts:457-469`). Neither change is made here: both alter the arm under
measurement, and that is the orchestrator's call, not this task's.

---

## 7. Reproduction

```bash
export KHAL_API_KEY=…                       # env only, never in a file
cd ~/prod/rlmx && git rev-parse --short HEAD   # this doc's citations are 2a32fd9
npm run build

# §2.2(b) — the parity-harness condition: child answers "" on google, exit 0
H=$(mktemp -d); HOME=$H node dist/src/cli.js "Reply with the single word OK." \
  --output json --stats --max-iterations 1 --timeout 90000 --no-session

# §2.2(c) — the pin that makes recursion real
H=$(mktemp -d); mkdir -p $H/.rlmx
printf '{"model.provider":"khal","model.model":"deepseek-v4-flash","model.sub-call-model":"deepseek-v4-flash"}' \
  > $H/.rlmx/settings.json
HOME=$H node dist/src/cli.js "Reply with the single word OK." \
  --output json --stats --max-iterations 1 --timeout 90000 --no-session

# §5 — shape does nothing
grep -rn "\.shape" src/ --include=*.ts

# §8 — the recipe end to end (writes nothing inside the checkout except the record)
export RLMX_MCP_RUN_TIMEOUT_MS=900000
node .genie/wishes/rlmx-explore-offload/parity/round2/smoke-explore-r.mjs smoke-4
```

---

## 8. Smoke record — recursion fires, end to end

`parity/round2/smoke-explore-r.mjs` drives `examples/agents/explore-r/` through
the real MCP path (`node dist/src/cli.js mcp --dir <this checkout>`, agent
discovered from a scratch `HOME`'s `~/.rlmx/agents/`, no `RLMX_AGENTS_DIR`
override) on self-authored questions about this repository — not a frozen parity
task, not a train task. Four runs are kept; each one is the evidence for a
different claim above.

**Read the table as four different runs, not four trials of one thing.** Two
things were being changed while these were captured, and the record shows both:

- **`smoke-1` asked a different question.** It is a *three*-part question about
  how a run's spending is bounded (its answer opens `### (1) Default budget
  values -- src/config.ts:127-131`). `smoke-2`, `-3` and `-4` share the
  four-part question about providers, recursion, budget and the MCP surface.
  So `smoke-1` is evidence about fan-out *triggering* — the claim it is cited
  for — and is not comparable to the others on coverage or cost.
- **Only `smoke-4` ran under the shipped recipe.** `smoke-1/2/3` ran under three
  earlier `SYSTEM.md` drafts and two earlier `agent.yaml`s. Their prompt digests
  are in the table so that is checkable rather than asserted; nothing above
  cites them for anything the shipped prompt is claimed to do.

Reference digests for the `‡` marks: `SYSTEM.md` `06c6ea94` — the shipped
prompt, unchanged since `smoke-4` — and `agent.yaml` `bd1cbaaf`, the recipe as
`smoke-4` ran it. The shipped `agent.yaml` now digests `20f8e018`; the delta is
comments only and is proved under the table. `‡` marks a digest that matches
neither.

| Record | promptSha / yamlSha | Question | Result | What it establishes |
|---|---|---|---|---|
| `smoke/smoke-1.json` | `6d05abe5`‡ / `91867122`‡ | **3-part, budget** | OK, 12 it, 61s, $0.0062, **0 spawns**, 7/7 citations resolve | A three-grep question does not provoke a fan-out. The recipe's countable "block 2 is the fan-out" rule was added because of this run. |
| `smoke/smoke-2.json` | `e893349e`‡ / `91867122`‡ | 4-part | **ERR**, 51s, 4 spawns, 4 child processes | §4.1 — `REPL execution timed out after 30000ms`, whole run lost. Also caught the sub-prompt hollowing bug: the child argv reads `"In this repository, answer the question in at most 150 words…"`, the wrapper intact and the question gone. |
| `smoke/smoke-3.json` | `0f591445`‡ / `a5daf17d`‡ | 4-part | **ERR**, 650s, 4 spawns at iteration 9 | `RLMX_REPL_TIMEOUT_MS=600000` was not enough with `max_iterations: 18` — §6.1. Also the only observation of an orphaned child (§6.2), and of the parent burning 9 turns before fanning out. |
| **`smoke/smoke-4.json`** | **`06c6ea94` / `bd1cbaaf`** | 4-part | **OK**, 12 it, **205.7s**, $0.03, **4 spawns at iteration 2**, **17/17 citations resolve, 9 grounded, 9 novel**, all four parts answered | The deliverable — and the only row captured against the shipped recipe. |

All four ran at `rlmxGit.head = 2a32fd9`.

> **`agent.yaml` has been edited since `smoke-4`, and the edit is comments only.**
> The shipped file now digests to `20f8e018`, not `bd1cbaaf`: its 23 citation
> anchors were re-resolved from `9abd6fa` to `2a32fd9` (two of them had stopped
> pointing at what they named) and a pin header was added. No key or value
> changed, and that is checkable rather than asserted — stripping comments and
> blank lines from both revisions gives a byte-identical body, digest
> `d1deae83`:
>
> ```bash
> strip() { git show "$1" | sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d'; }
> strip 'bd1cbaaf-era:examples/agents/explore-r/agent.yaml' | sha256sum   # d1deae83…
> strip ':examples/agents/explore-r/agent.yaml'             | sha256sum   # d1deae83…
> ```
>
> `smoke-4` therefore remains valid evidence for every behavioural claim in this
> section. It is **not** a digest match for the shipped file, and a future round
> that needs one must re-run it.

`smoke-4`'s recursion evidence is recorded three ways, and the third is the one
that cannot be argued with:

1. `recursion.spawnsReportedByProgress: 4` — MCP progress, i.e. four
   `RecurseEvent`s from the producer at `src/rlm.ts:441-443`.
2. `footer` — `152,189 in / 13,620 out` against `smoke-1`'s `32,494 in`, on the
   same tree and the same model. Child usage merges into the parent's totals
   (`src/llm.ts:734-737`), so the 4.7x is the children.
3. `recursion.childProcessesObserved` — four PIDs, all first seen at **14.6s**
   into the run (one parallel wave), with their **verbatim argv**:

```
node /home/namastex/prod/rlmx/dist/src/cli.js
  "Custom LLM providers: Which source files define rlmx's own custom LLM providers …"
  --output json --stats --max-iterations 14 --timeout 900000
  --max-depth 3 --max-cost 1.9982832 --no-session
```

That argv is §2 and §4 made concrete: `--max-iterations 14` is the parent's own
cap verbatim (`src/rlm.ts:436`), `--max-depth 3` is `?? 3` and not the
`max_depth: 2` the agent declared (§4, consequence 3), `--max-cost 1.9982832` is
2.00 minus what the parent had spent (`src/rlm.ts:973-986`), and
**`hasModelFlag: false` on all four** — the child argv carries no model, which
is why the `settings.json` pin is an install requirement and not a nicety.

The four sub-prompts are visible in full in the record. They are self-contained,
each names its subsystem, and each carries the citation contract inline — which
is what §6 item 3 requires, and what `smoke-2` proved does not happen by itself.
