# Group 3 evidence — `/microagent-create`, propose-only (B4)

Host: this machine (Ryzen AI station), `~/prod/rlmx` on
`wish/rlmx-microagent-plugin`, **2026-07-27**. HEAD at the time of this work:
`8c1b2e3` — *"docs(genie): approve wish B plan — rlmx-microagent-plugin
(plan-b-02 SHIP)"*.

This file is written to be **checked**. Every number names the command that
produced it, every code claim names a line that resolves at this revision, and
the one thing this group's own dogfood run got wrong is written down in full
(§5.2) rather than dropped.

No secret appears in this file or in any file this group wrote. The live legs
that needed a paid key took it from the shell environment only.

---

## 0. What this group had to build, and what it re-tested

Group 3's three deliverables, and the state each was found in before this pass:

| # | Deliverable | Found | Now |
|---|---|---|---|
| 1 | `/microagent-create` skill that mines transcripts and writes a `.proposed/` draft | Group 1's placeholder stub, verbatim: *"PLACEHOLDER — not yet written. Do not invoke."* | written (§4) |
| 2 | Skip rule in `src/mcp/agents.ts` + regression test | absent — file byte-identical to HEAD, no name filter anywhere in the discovery loop | built (§1) + pinned (§2) |
| 3 | Dogfood proposal from real transcripts | absent — no `*.proposed` directory existed anywhere | written (§5) |

And the live breach that followed from deliverable 2 being absent — an
unapproved proposal that was **listed and executed for real** — re-tested
against the real server in §3.

---

## 1. The skip rule (deliverable 2, first half)

`src/mcp/agents.ts`, +35 lines, three hunks. The mechanism is two exported
symbols and one `continue`:

```ts
export const PROPOSED_SUFFIX = ".proposed";          // src/mcp/agents.ts:53

export function isProposedDir(name: string): boolean {   // src/mcp/agents.ts:64
  return name.toLowerCase().endsWith(PROPOSED_SUFFIX);
}
```

applied inside `discoverAgents`' directory loop:

```ts
      if (isProposedDir(entry.name)) continue;         // src/mcp/agents.ts:183
```

### Why it sits *there* specifically

The guard is placed before `loadOne` — before the spec is even parsed — because
that single position covers both surfaces at once. `tools/call` does not consult
`tools/list`; it consults `byToolName`, and `byToolName` is built from the same
array the list is built from:

- `src/mcp/server.ts:252` — `const byToolName = new Map(agents.map((a) => [a.toolName, a]));`
- `src/mcp/server.ts:771` — `const agent = name === GENERIC_TOOL ? undefined : scan.byToolName.get(name);`

So "not listed" and "not callable" cannot drift apart: they are the same
omission. A filter applied later, at list-build time, would have left the call
path open — which is the failure mode worth naming, because it is invisible in
a tools/list screenshot.

### Case-insensitivity, and its price

`isProposedDir` lowercases before comparing. This comparison decides whether an
unapproved agent can execute, so it fails toward **not** running: `X.Proposed`
is skipped exactly like `x.proposed`.

The price is that `.proposed` is reserved in every casing, and the skip is
**silent** — an agent legitimately named `foo.proposed` would load fine via
`loadAgentSpec` and simply never appear, with no warning. That is the wish's own
risk row, and its stated mitigation is documentation. Documented in three
places: `plugins/claude-code/skills/microagent-create/SKILL.md` (the plugin
doc named by the risk row), `docs/agent-yaml-schema.md` (new *Reserved directory
suffix* section — the canonical contract for what an agent folder is, so
non-plugin users meet it too), and the draft's own `agent.yaml` header.

---

## 2. The regression test (deliverable 2, second half)

`tests/mcp-agents.test.ts`, **+143/-2** (`git diff --numstat --
tests/mcp-agents.test.ts` → `143  2`; an earlier draft of this file said
+145/-2, which was wrong). Two new suites, six new tests; the file went from 35
tests to 41.

`describe("isProposedDir")` — 2 tests. The suffix is reserved in any casing
(`x.proposed`, `review-lite.PROPOSED`, `a.Proposed`), and it does **not** swallow
ordinary names (`proposed`, `proposals`, `x.proposed-v2`, `x-proposed`,
`explore-r` all stay discoverable).

`describe("discoverAgents — .proposed drafts")` — 4 tests, on a real temp tree
with a **valid, loadable** draft (`schema_version`, `shape: loop`, a model, a
`description`, a `system:` pointer resolving to a real `SYSTEM.md`) beside an
approved neighbour:

1. **not listed** — `discoverAgents` returns `["explore-r"]` only, and
   specifically no `rlmx_review-lite_proposed`, which is the exact leaked tool
   name wish decision 3 names.
2. **not callable** — asserted on `registry.byToolName`, i.e. the map
   `src/mcp/server.ts:771` dispatches from, not on a re-derived list.
3. **rename activates, live, without a reconnect** — one `createAgentRegistry`
   instance, never re-created (the same object a connected server holds for the
   life of a connection, `src/mcp/server.ts:704`): refresh → draft absent →
   `renameSync` → refresh → present in `agents`, present in `byToolName`,
   `changed === true` (which is what makes the server emit
   `tools/list_changed`), and the published agent carries the drafted file's own
   `model`, proving it is the same directory rather than a lookalike.
4. **undoing the rename makes it inert again.**

### The fixture is valid on purpose, and here is the proof it matters

A draft that failed to load would be skipped by `loadOne` for the *wrong reason*
and the whole suite would pass vacuously. Test 3 renames that same directory and
requires it to appear — so the fixture's validity is asserted, not assumed.

### Negative control — the tests were run against the un-guarded build

The guard was neutralized in the compiled `dist/src/mcp/agents.js` and the suite
re-run. Verbatim:

```
=== TEST WITHOUT GUARD (expect failures) ===
ok 4 - isProposedDir
        a .proposed draft must not appear in the tool list
        an unapproved draft must not be dispatchable
        expected: false
        actual: true
not ok 5 - discoverAgents — .proposed drafts
# tests 41
# pass 38
# fail 3
```

Three of the four discovery tests fail without the guard, and the failures are
the two AC clauses by name. (`isProposedDir`'s own unit tests pass either way —
correctly: the function exists, it is the *application* of it that was removed.)
`dist/` was then restored with `npm run build`; `grep -c "NEGATIVE CONTROL"
dist/src/mcp/agents.js` → `0`, and the guard is present at
`dist/src/mcp/agents.js:155`.

Without that control, a green suite proves only that the tests ran.

---

## 3. The live breach, re-tested against the real server

The recorded breach was: a valid `agent.yaml` in `.rlmx/agents/x.proposed/`
produced `rlmx mcp: 1 microagent discovered (x.proposed)`, `tools/list`
returned `rlmx_x_proposed`, and `tools/call` **ran it for real**.

Re-tested with the MCP SDK's own client over stdio against a spawned
`rlmx mcp --dir <scratch workspace>` — no mocks, scratch `HOME` so this
machine's real `~/.rlmx/agents` cannot drift the result, and `RLMX_AGENTS_DIR`
deliberately **unset** so discovery runs the ordinary precedence path rather
than the override that would bypass it. Fixture: `x.proposed/` (valid,
executable) beside `approved-ctl/`.

```
# probe: server stderr census: rlmx mcp: 1 microagent discovered (approved-ctl)
PASS  A. startup census does not report the draft as a discovered microagent
PASS  A. startup census does report the approved control
# probe: tools/list: rlmx_query, rlmx_approved-ctl
PASS  B. draft is NOT listed (rlmx_x_proposed absent)
PASS  B. approved control IS listed
# probe: tools/call rlmx_x_proposed -> isError=true "Unknown tool: rlmx_x_proposed"
PASS  C. calling the draft is a tool error
PASS  C. draft is NOT callable — server answers Unknown tool
# probe: tools/list after rename: rlmx_query, rlmx_approved-ctl, rlmx_x
PASS  D. rename publishes the agent on the same connection
PASS  D. server emitted notifications/tools/list_changed (0 -> 1) — live refresh, no reconnect
# probe: tools/call rlmx_x -> isError=false
--- begin rlmx_x result ---
RENAME-OK

---
rlmx · agent=x · station/Brain-4B · 1 iteration · 277 in / 10 out · $0.00 · 1.7s · session sess_80d279b4803aa3a2
--- end rlmx_x result ---
PASS  D. the same directory, renamed, runs for real — so the earlier refusal was the skip rule, not an invalid agent
# probe: tools/list after undo: rlmx_query, rlmx_approved-ctl
PASS  E. reverting the rename withdraws the agent
PASS  E. and stops dispatching it

# probe: ALL CHECKS PASSED
```

All three clauses of the recorded breach now fail closed — the startup census,
`tools/list`, and `tools/call` — and leg D closes the obvious objection by
running the *same directory*, renamed, for real against the keyless local
station gateway at $0.00. (The model replied `RENAME-OK` where the prompt asked
for `RENAMED-OK`; irrelevant — the check is that a real turn executed, not what
a 4B model typed.)

### And against the real repository, with the real proposal in it

This leg ran `--dir ~/prod/rlmx` — the real repository, with the real proposal
on disk — but under a **scratch `HOME`**, carried over from the harness above.
That matters for one line of its output and for nothing else, so both the
original block and the corrected reading are below.

**As originally recorded** (scratch `HOME`, real `--dir`):

```
rlmx mcp: 0 microagents discovered
tools/list against the real repo: rlmx_query
PASS: no .proposed dir appears in the tool list
tools/call rlmx_git-historian_proposed -> "Unknown tool: rlmx_git-historian_proposed" isError=true
tools/call rlmx_git-historian          -> "Unknown tool: rlmx_git-historian" isError=true
```

> **Correction — the harness, not the finding.** The prose under this block
> read *"the server started against `--dir ~/prod/rlmx` reports 0 microagents"*,
> and the heading says *"against the real repository"*. Together they read as a
> census taken on this host as the user has it. It was not: the **`0`** is an
> artifact of the scratch `HOME`. This machine's real `~/.rlmx/agents/` holds
> three legacy agents — `changelog`, `codebase-qa`, `log-triage` — that predate
> this wish and are discovered through the user-scope root, so a real-`HOME` run
> reports **3**, not 0.

**Re-run just now, both ways, same `--dir`, to separate the two:**

```
$ node dist/src/cli.js mcp --dir /home/namastex/prod/rlmx          # real HOME
rlmx mcp: 3 microagents discovered (changelog, codebase-qa, log-triage)
tools/list -> rlmx_query, rlmx_changelog, rlmx_codebase-qa, rlmx_log-triage

$ HOME=$(mktemp -d) node dist/src/cli.js mcp --dir /home/namastex/prod/rlmx
rlmx mcp: 0 microagents discovered
tools/list -> rlmx_query
```

**The substantive claim is unchanged, and is the one confirmed independently:**
`~/prod/rlmx/.rlmx/agents/git-historian.proposed/` is on disk with a valid
`agent.yaml`, and **`git-historian` appears in neither census and in neither
tool list** — not as `rlmx_git-historian_proposed`, not as `rlmx_git-historian`,
under either `HOME`. The three agents that *do* appear under the real `HOME`
come from `~/.rlmx/agents/`, not from the repository's `.rlmx/agents/`, and none
of them is the proposal. The proposal this group shipped is inert in the
repository it was shipped into; what the original `0` additionally implied — an
otherwise empty agent inventory on this host — was an artifact of the scratch
`HOME` and is withdrawn.

---

## 4. The skill (deliverable 1)

`plugins/claude-code/skills/microagent-create/SKILL.md` — the placeholder is
gone, frontmatter included. Plus one bundled script,
`plugins/claude-code/skills/microagent-create/scan-transcripts.mjs`.

### Why a script and not "read the transcripts"

`~/.claude/projects` held **133 transcripts / ~106 MB** in the 24 h window
measured here. A skill that told the host to read them in order to find out
what was filling its context would be the joke telling itself. The scanner
streams them line by line and returns about a page — **0.9 s** wall clock for
the full 24 h window on this host.

### What it measures, and the distinction it refuses to blur

Two kinds of number, labelled differently everywhere they appear:

- **MEASURED** — read verbatim from each assistant turn's `usage` block. The
  API's own counts.
- **~ESTIMATED** — tool-result payload characters (exact) ÷ 4 (a convention).
  Always printed with `~`.

Tool calls are bucketed into offload families by an explicit rule table printed
with the output, so the classification is auditable rather than a vibe. Token
optimizer session data (`~/.claude/token-optimizer/quality-cache-*.json`) is
folded in when present and skipped when absent — it corroborates, it does not
rank.

### One classifier correction worth recording — and a second one, in §10

The first version routed any command containing a read-only git verb into
`git-history`. That over-counted: agents write compound commands, and
`git diff HEAD && git add -A` reads *and then writes*. A family labelled
read-only has to mean it, so a `SIDE_EFFECTING` test now runs against every Bash
command before it may enter an **offloadable** family, and anything that writes
is **refused entry to every offloadable family**.

> **(Correction, appended — see also §10.3.)** That clause first read *"and
> anything that writes lands in `side-effecting-shell` instead"*, which claims
> more than the code does and more than the runs show. `classify()` applies the
> gate as a `continue`, not as a redirect: a writing Bash command is skipped
> past each offloadable family and then classified by the **next matching
> rule**, which is whichever non-offloadable family it hits first —
> `side-effecting-shell` usually, but `test-and-build` when the command also
> runs `npm`/`tsc`/`pytest`/etc., because that family sits above
> `side-effecting-shell` in `FAMILIES`. §10.2's own movement table records this
> happening: **2 calls moved `git-history` → `test-and-build`**, not to
> `side-effecting-shell`. `test-and-build` is non-offloadable, so nothing about
> the candidate list changes — but "lands in `side-effecting-shell`" is simply
> not the invariant. The invariant that is both enforced and measured is the one
> now stated: **0 writing calls in any offloadable family.**

The correction cost the headline candidate **156 calls** — 599 → 443 — and
those 156 were exactly the compound read-then-write commands. Erring toward
"side-effecting" only ever shrinks the candidate list, which is the safe
direction for a claim.

> **That correction was only half-applied, and §10 finishes it.** The
> `SIDE_EFFECTING` test has three arms — writing binaries, writing git verbs,
> and redirection into a file — and the third one **never matched the standard
> `cmd > file` form**, because its character class required a non-space
> immediately before the `>`. So the 156-call figure above is the git-verb arm
> alone: commands that wrote a file were still being counted as read-only, the
> heaviest cited example in the proposal's `EVIDENCE.md` among them. §10 has
> the fixed rule, the A/B that isolates it, and the re-derived numbers.

### Skill contents

Step 1 measure (run the scanner, keep the labels) · Step 2 choose one candidate
against five stated rules, and **propose nothing** if none clears them · Step 3
write the three files, with `agent.yaml` defaults derived from
`examples/agents/explore-r/agent.yaml` and each default justified by the
measurement in explore-r's own comments · Step 4 stop, and hand the user the
`mv` command to run themselves.

Plus an honesty section carrying wish decision 1 explicitly: burn numbers
describe what a family **costs today**, never what an agent would save; and
explore-r's parity numbers are not inheritable by a new agent — cited only whole
and with their scoping, or not at all.

---

## 5. The dogfood proposal (deliverable 3)

`~/prod/rlmx/.rlmx/agents/git-historian.proposed/` — `agent.yaml`, `SYSTEM.md`,
`EVIDENCE.md`. Expected class per the design was review-lite / git-historian;
the data chose git-historian without being pushed.

### 5.1 The measurement

Canonical scan pair captured together at **2026-07-27T21:49:54Z** over
**133 transcripts / 41,788 lines**, last 24 h. The window is rolling over live
transcripts — sessions were still being written while the scan ran — so a run
minutes earlier reported 441 calls where the canonical pair reports 443. Nothing
below turns on the difference, and `EVIDENCE.md` says so too.

MEASURED, whole window: 16,663 assistant turns · **8,157,789** output tokens ·
121,119,022 cache-creation · 2,733,055,152 cache-read.

~ESTIMATED context returned by tool results, all families: 17,085,747 chars
**~4,271,437 tok**.

> **This table is pre-fix-classifier — superseded by §10.** The redirect arm of
> `SIDE_EFFECTING` was broken when it was captured; the offloadable families are
> overstated. Kept here unedited so the two can be compared.

| family | chars | ~tok | share | calls | sess | proj | med ch/call | offloadable |
|---|---|---|---|---|---|---|---|---|
| repo-exploration | 13,285,835 | ~3,321,459 | 77.8% | 4,770 | 11 | 5 | 817 | yes |
| side-effecting-shell | 1,502,936 | ~375,734 | 8.8% | 1,543 | 10 | 5 | 441 | no |
| other | 918,387 | ~229,597 | 5.4% | 844 | 9 | 4 | 364 | no |
| **git-history** | **840,721** | **~210,180** | **4.9%** | **443** | **9** | **4** | **1,062** | **yes** |
| edits | 193,561 | ~48,390 | 1.1% | 1,099 | 8 | 4 | 170 | no |
| test-and-build | 147,303 | ~36,826 | 0.9% | 259 | 9 | 4 | 274 | no |
| agent-delegation | 139,865 | ~34,966 | 0.8% | 56 | 8 | 4 | 1,083 | no |
| web-research | 56,056 | ~14,014 | 0.3% | 20 | 3 | 3 | 1,947 | yes |

`repo-exploration` tops the table and is **not** the candidate: it is
`explore-r`'s class, and proposing it would propose a duplicate.
`web-research` is real but small. `git-history` is the largest offloadable
family with no agent — 443 calls across 9 sessions and 4 projects, median
**1,062 chars per call**, the bulk-in/summary-out shape the offload targets.

Transcript references (`<transcript>:<line>`, openable) are in the proposal's
`EVIDENCE.md` §3; the heaviest three are all *re-reads of the same diff at
different slice widths*, which is the shape the agent exists for.

### 5.2 The first dogfood run fabricated, and that is recorded here

The draft was probed by copying its own `agent.yaml` + `SYSTEM.md` into a
scratch agents root (`RLMX_AGENTS_DIR=<tmp>`) and running it against this
repository as `--dir`. **The proposal was never activated** — `RLMX_AGENTS_DIR`
replaces the default roots entirely, so `.rlmx/agents/` was not scanned.

> **Traceability of the two probe figures.** Both probes ran in a scratch
> `RLMX_AGENTS_DIR` that was deleted with its temp directory, and **no run
> record was kept**. The iteration/token/cost/latency figures in the next two
> paragraphs are **self-reported by the session that ran them and are not
> re-derivable**; re-running the probes would produce new numbers, not evidence
> for these. What *is* re-derivable is the substance — the run-1 fabrications
> and the run-2 claims were each checked with named `git` commands that still
> run today. The proposal's `EVIDENCE.md` §4 carries the same annotation at the
> point of use. (The scan figures are in the opposite position: run records for
> those are committed, see §10.)

**Run 1 — 1 iteration, 2,820 in / 997 out, $0.0005, 37.7 s. Fabricated.** It
answered on turn one having executed nothing. It got the SHA, subject, date and
author right — because an earlier version of the draft's `SYSTEM.md` carried
them in a worked example — and invented everything it actually had to look up:
`src/mcp/errors.ts`, `src/mcp/spawn.ts`, `src/mcp/mcp_runner.ts` (none of the
three exist) and commit `baed9e5` (`git cat-file -t baed9e5` →
`fatal: Not a valid object name`).

That is the parity campaign's own recorded failure mode, reproduced exactly:
gen-4 was **rejected** because "four training anchoring terms sit verbatim in
its own prompt … so its one positive claim cannot be distinguished from the
model reading its own instructions" (`docs/parity-explore.md:1049-1055`).

**Fix applied to the draft**, both halves of the pattern: every
repository-specific anchor removed from `SYSTEM.md` (no worked example, no real
SHA anywhere in the file — `grep -nE "6ec4822|Felipe|baed9e5" ` returns nothing),
and a countable rule added — *no `FINAL` before your fourth repl block* —
modelled on `examples/agents/explore/SYSTEM.md`, which uses that exact mechanism
to stop a first-turn answer.

**Run 2 — 4 iterations, 13,648 in / 2,499 out, $0.0019, 52.4 s. Clean.** Every
claim re-checked against the repository afterwards: commit `6ec4822` with its
subject, date and author; the six `src/` files it changed, complete and with no
extras; that it also touched `tests/` and `dist/`; `HEAD` = `8c1b2e3` with its
subject; that HEAD touches nothing under `src/`; and that `6ec4822` is the most
recent commit to touch `src/mcp/agents.ts`. Zero fabrications, on this one
question.

Two runs on one question, one of which fabricated, is a **feasibility** result.
`EVIDENCE.md` §5 says so, and states four things it does not claim: no quality
claim, no saving claim, the `~` numbers are estimates, and explore-r's parity
numbers are not inherited.

---

## 6. Number provenance (wish decision 1)

Every user-facing figure this group wrote, and where it comes from. Nothing is
rounded up.

| Figure | Where it appears | Source |
|---|---|---|
| out-of-sample coverage **0.714** (10/14) holdout, vs **0.853–0.912** in-sample, "a real drop of 0.14–0.20" | SKILL.md honesty section; proposal EVIDENCE.md §5 | `docs/parity-explore.md:1046-1048` — verified verbatim |
| **zero fabrications in the frozen configuration only** — "215 citations, zero unresolvable, zero fabricated" | same | `docs/parity-explore.md:827-828` |
| earlier rounds fabricated — a run cited `src/lib/providers.ts:9`, "which does not exist" | same | `docs/parity-explore.md:426-427` |
| the verification block is what fixed it — "fabrications fell sharply wherever it ran" | same | `docs/parity-explore.md:685` |
| premium-token reduction **1,077×** aggregate for **$0.22** — *not* "about 1000×" | same | `docs/parity-explore.md:960-968` (table total row) |
| the frozen shot still failed on facts: **0 of 6 tasks pass, the suite requires 5 of 6** | same | `docs/parity-explore.md:977-989` |
| gen-4 **rejected**, anchoring terms verbatim in its own prompt | evidence §5.2; proposal EVIDENCE.md §4 | `docs/parity-explore.md:1049-1055` |
| product fixes = commit **`6ec4822`** (child model pinning, `rlm_query` model arg, loud child failure) | proposal EVIDENCE.md §4 | git — `git log -1 --format='%h \| %ad \| %an \| %s' --date=short 6ec4822` |
| default worker **`khal/deepseek-v4-flash`**; station = the $0 offline option | draft `agent.yaml`; SKILL.md step 3 | wish decision 5 / `docs/worker-models.md` |
| ~~**443 calls / 840,721 chars / ~210,180 tok**~~ and every other scan figure | evidence §5.1; proposal EVIDENCE.md §2–3 | `scan-transcripts.mjs`, canonical run 2026-07-27T21:49:54Z — **superseded**, the classifier was broken (§10) and the window is not re-creatable |
| **496 calls / 941,136 chars / ~235,284 tok** (post-fix), and the pre/post delta | evidence §10; proposal EVIDENCE.md §7 | `scan-transcripts.mjs` A/B pair 2026-07-27T22:42:4{2,3}Z — **run records committed** at `.genie/wishes/rlmx-microagent-plugin/scan-runs/` |
| **+143/-2** on `tests/mcp-agents.test.ts` | evidence §2, §9 | `git diff --numstat -- tests/mcp-agents.test.ts` |
| Run 1 / Run 2 probe figures (iterations, tokens, $, seconds) | evidence §5.2; proposal EVIDENCE.md §4 | **self-reported, no run record, not re-derivable** — annotated as such in both files |
| **~1,000×** | **nowhere** | deliberately not written — the report's numbers are 1,077× (frozen config) and 921× (round 1's non-shipping `r15-flash-control`), and neither is "about 1000×" |

All six parity-report line ranges above were re-opened and read at this revision
before being cited here; none was taken from another group's evidence file.

---

## 7. Validation

Group 3's validation command from the wish, verbatim output:

```
$ cd ~/prod/rlmx && npm run build && node --test dist/tests/mcp-agents.test.js
> tsc && cp src/benchmark-data.json dist/src/ && rm -rf dist/src/templates && cp -r src/templates dist/src/templates
1..10
# tests 41
# suites 10
# pass 41
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 276.758613
```

41 tests, up from the 35 that were there before this pass — the 6 added are the
two suites in §2. A green run on this file now means the propose boundary was
tested, which was the point: before this pass the same command exited 0 on 35
unrelated tests.

Repo gate:

```
$ npm run check     → tsc --noEmit, exit 0
$ npm run build     → exit 0
$ npm test          → # tests 526 · # pass 526 · # fail 0 · # suites 121
```

526 green, against the wish QA floor of 517+.

Frozen paths untouched — `.genie/wishes/rlmx-explore-offload/tasks/` and
`.genie/wishes/rlmx-explore-offload/parity/runs/`:

```
$ git status --porcelain -- .genie/wishes/rlmx-explore-offload/tasks/ .genie/wishes/rlmx-explore-offload/parity/runs/
(no output — 0 lines)
```

---

## 8. Acceptance criteria

- [x] **Dogfood proposal exists with evidence tying it to real token burn.**
  `.rlmx/agents/git-historian.proposed/` with all three files. `EVIDENCE.md`
  carries the family's numbers with MEASURED/~ESTIMATED labels intact and five
  `<transcript>:<line>` references that open. Chosen from a ranked scan of 133
  real transcripts, not selected to fit the design's expectation.
- [x] **Skip rule present in `src/mcp/agents.ts`; regression test proves a valid
  `x.proposed/` agent is neither listed nor callable; rename activates without
  reconnect (live refresh).** `src/mcp/agents.ts:183`; 6 tests in
  `tests/mcp-agents.test.ts`; negative control in §2 shows 3 of them fail
  without the guard; and §3 proves the same three properties against the real
  server, including a real executed turn after the rename.
- [x] **Nothing is created outside `.proposed/` without user action.** The only
  agent directory this group created is `git-historian.proposed/`. §3 shows the
  real server, started against this repository with the proposal in place,
  omitting it from the startup census and from `tools/list` under both a
  scratch `HOME` (census `0`) and this host's real `HOME` (census `3` — the
  pre-existing `changelog`, `codebase-qa`, `log-triage` from `~/.rlmx/agents/`,
  and no `git-historian`). The skill's step 4 hands the `mv` to the user and
  never runs it.

## 9. Files this group changed

```
src/mcp/agents.ts                                             (+35)   skip rule
tests/mcp-agents.test.ts                                      (+143/-2) 6 tests
docs/agent-yaml-schema.md                                     (+24)   reserved suffix
plugins/claude-code/skills/microagent-create/SKILL.md         (rewritten — placeholder replaced)
plugins/claude-code/skills/microagent-create/scan-transcripts.mjs  (new)
.rlmx/agents/git-historian.proposed/{agent.yaml,SYSTEM.md,EVIDENCE.md}  (new — the proposal)
.genie/wishes/rlmx-microagent-plugin/evidence-group-3.md      (new — this file)
dist/src/mcp/agents.{js,d.ts}, dist/tests/mcp-agents.test.{js,d.ts}  (build output; dist/ is committed)
```

Added by the §10 correction pass:

```
plugins/claude-code/skills/microagent-create/scan-transcripts.mjs  (SIDE_EFFECTING redirect arm; --explain by-action remainder + total)
.genie/wishes/rlmx-microagent-plugin/scan-runs/               (new — 4 run records + README)
.rlmx/agents/git-historian.proposed/EVIDENCE.md               (§7 appended; §2–§5 annotated, not rewritten)
plugins/claude-code/README.md                                 (skills table — placeholder text was stale)
CHANGELOG.md                                                  (### plugin: skills shipped; .proposed reserved suffix)
```

---

## 10. Correction — the redirect arm of `SIDE_EFFECTING` never fired

*Appended 2026-07-27, after §1–§9 were written. Nothing above was rewritten;
the superseded blocks are annotated in place.*

### 10.1 The defect

`scan-transcripts.mjs`'s `SIDE_EFFECTING` regex is the single mechanism that
stops a writing command from being counted in a read-only family. Its third
arm — redirection into a file — read:

```js
String.raw`(^|[^0-9&\s])>>?\s*[^&\s|]`     // before
```

The class before `>` excludes whitespace, so the operator had to be glued to
the preceding character. `cmd>file` matched. **`cmd > file` did not** — which is
the form essentially every command uses. The claim in §4 that "anything that
writes lands in `side-effecting-shell` instead" was therefore not true of file
redirection at all, and the proposal's own heaviest cited call
(`… git diff HEAD > "$D"; wc -l "$D"; …`, 22,646 chars) was counted as
read-only git history.

The same class admitted `-`, `=` and `<`, so `a -> b`, `x => y` and
`3<>/dev/tcp/…` were read as redirects — pushing commands *out* of read-only
families that they belonged in. The rule was wrong in both directions at once.

```js
String.raw`(^|[^0-9&<>=-])>>?\s*[^&\s|]`   // after
```

| command | classified | why |
|---|---|---|
| `git diff HEAD > "$D"` | **side-effecting** | space before `>`, target `"` |
| `git diff HEAD >/tmp/x` | **side-effecting** | space before `>`, target `/` |
| `git log >> /tmp/log` | **side-effecting** | `>>` matched, target `/` |
| `npm test 2>&1` | not a file write | fd digit before `>` |
| `ls 2>/dev/null` | not a file write | fd digit before `>` |
| `rg "a->b" src/` | not a file write | `-` before `>` |
| `git diff 1>&2` | not a file write | fd digit before `>` |

**One residual, measured and left in place.** A comparison whose left side is a
bare word still reads as a redirect: `awk 'NR>=255 && NR<=262 {…}' file` has a
letter before the `>` and `=` as the target, so it lands in
`side-effecting-shell` even though it only reads. Same for a quoted `>` passed
as an argument (`rg '>' file`). Counted over the same 24 h window: **62
commands** — *self-reported by the session that measured it, no run record, not
re-derivable; see the annotation below.* That is the direction the scanner's own
comment calls safe — over-classifying shrinks the offloadable families and never
inflates them — and it is pre-existing, identical under the pre-fix rule, so it
does not move any number in §10.2. Excluding `=` from the target class closes
it; the note in `scan-transcripts.mjs` says so, and this pass deliberately did
not, to keep the A/B a one-variable change.

> **Traceability of the 62.** This figure is in the same position as the §5.2
> probe figures, not the same position as the §10.2 scan figures, and it was
> first written without saying so. **No command in this evidence file, in
> `EVIDENCE.md`, or in `scan-runs/` produces it**, and it appears in neither
> committed run record — `grep -c 62 scan-runs/*.json` finds only unrelated
> substrings. `scan-transcripts.mjs` has no flag that counts residuals, so
> deriving it means writing a one-off script, and the answer depends on choices
> the "62" never states: whether the unit is calls or distinct command strings,
> whether it is scoped to Bash calls only or to all tool calls, and whether a
> command is counted when the comparison-shaped `>` is the *only* thing that
> made `SIDE_EFFECTING` match versus whenever such a `>` is present at all.
> Four such readings were implemented and run against `~/.claude/projects` over
> a fresh 24 h window while writing this annotation, and they returned **302,
> 1,915, 302 and 1,910** — spread across an order of magnitude and none of them
> 62. That is not evidence the 62 was wrong when it was taken: the window has
> since rolled forward over the very sessions doing this correction pass (7,268
> Bash calls in the new window), so these runs measure different bytes and a
> guessed definition. It *is* evidence that the figure **cannot be checked by
> anyone reading this file**, which is the point. It is therefore recorded as
> **self-reported and not re-derivable**, like the §5.2 probe figures and unlike
> everything in §10.2.
>
> **Nothing rests on it.** The residual's *direction* is what the paragraph
> actually uses, and that is structural rather than measured: a command that
> lands in `side-effecting-shell` cannot be in an offloadable family, so a
> residual of this kind can only ever shrink the candidate families, never
> inflate them. The claim "it does not move any number in §10.2" is also not
> carried by the 62 — it holds because this residual behaves **identically under
> both classifiers** (neither the pre-fix nor the post-fix class excludes `=`
> from the target), so it cancels exactly in the A/B, whatever its size. The
> right reading of "62" is *small, one-sided, and unchanged across the fix* — an
> order of magnitude, not a measurement.

### 10.2 Re-derived, as an A/B rather than a re-run

The 24 h window rolls over live transcripts, so the original 2026-07-27T21:49Z
window **cannot be re-created** — a later scan reads more sessions, and the
sessions doing this very work add `git` calls to the family being measured. A
straight re-run would therefore mix the classifier change with window drift and
prove neither.

Instead the pre-fix and post-fix classifiers were run **back-to-back over the
same transcripts**, 0.5 s apart. The two reports agree exactly on everything
the classifier does not touch — 138 transcripts, 43,613 lines, 17,958,615
tool-result chars, 17,687 assistant turns, 8,537,792 output tokens — so every
difference is the character class and nothing else.

Run records committed at `.genie/wishes/rlmx-microagent-plugin/scan-runs/`:
both JSON reports, both `--explain git-history` outputs, the delta table, and a
README stating what is redacted (verbatim command samples for the seven
families *other* than `git-history`, which quote unrelated private projects;
no number is modified).

```
  off  family                 preCalls postCalls    dCalls        preChars       postChars         dChars    dChars%
   *   repo-exploration          4955      4882       -73        13913427        13874850         -38577     -0.28
       side-effecting-shell      1550      1559         9         1494782         1494442           -340     -0.02
       other                      873       948        75          926998         1007564          80566      8.69
   *   git-history                509       496       -13          983705          941136         -42569     -4.33
       edits                     1250      1250         0          223094          223094              0      0.00
       test-and-build             372       374         2          210230          211150            920      0.44
       agent-delegation            60        60         0          150323          150323              0      0.00
   *   web-research                20        20         0           56056           56056              0      0.00

   *   OFFLOADABLE TOTAL         5484      5398       -86        14953188        14872042         -81146     -0.54
```

The headline candidate loses **4.33% of its returned context** (983,705 →
941,136 chars, ~245,926 → ~235,284 tok) and 13 of 509 calls; its share of all
returned context falls 5.5% → 5.2% and its median *rises* 1,090 → 1,122 chars
per call, because what left was mostly cheap. Across all three read-only
families the net is −86 calls (−1.57%) and −81,146 chars (−0.54%).

Movement, both directions, single pass over the same bytes:

```
    182  repo-exploration     -> side-effecting-shell     (missed redirects, now caught)
     19  git-history          -> side-effecting-shell     (missed redirects, now caught)
      2  git-history          -> test-and-build           (missed redirects, now caught)
     44  other                -> side-effecting-shell     (missed redirects, now caught)
    109  side-effecting-shell -> repo-exploration         (false `->`/`=>`/`<>`, released)
      8  side-effecting-shell -> git-history              (false `->`/`=>`/`<>`, released)
    119  side-effecting-shell -> other                    (false `->`/`=>`/`<>`, released)
```

203 calls leave the read-only families, 117 come back. The fix was not a
one-way tightening, and reporting only the tightening would have been the
flattering half.

### 10.3 The corrected mechanism claim

§4's sentence has **two** problems, and only one of them was a code defect.

**The code defect.** *"a `SIDE_EFFECTING` test now runs against every Bash
command before it may enter an offloadable family"* — true of the shipped
scanner **now**, and not true when §4 was written, because the redirect arm was
dead code for every spaced redirect. That half of the wording stands; the code
was brought up to it.

**The overclaim.** The trailing clause *"and anything that writes lands in
`side-effecting-shell` instead"* was **never** true, before the fix or after,
and fixing the regex did not make it true. `classify()` does not route writers
anywhere — it skips them past offloadable families and lets the next matching
rule take them:

```js
for (const f of FAMILIES) {
  if (!f.match(name, cmd)) continue;
  // A read-only family may not absorb a command that also writes.
  if (f.offloadable && name === "Bash" && SIDE_EFFECTING.test(cmd)) continue;
  return f;
}
```

`FAMILIES` puts `test-and-build` **above** `side-effecting-shell`, so a writing
command that also invokes `npm`/`tsc`/`pytest`/`make`/`cargo` lands in
`test-and-build`. That is not hypothetical: §10.2's movement table shows **2
calls moving `git-history` → `test-and-build`** under this very fix, alongside
the 19 that moved `git-history` → `side-effecting-shell`. Writers can also land
in `other` when they match no earlier rule.

**So the wording does not stand, and §4's clause has been corrected in place**
to the invariant that `classify()` actually enforces and that the A/B actually
measures: *anything that writes is refused entry to every offloadable family* —
equivalently, **0 writing calls in any offloadable family**. This is the claim
the candidate list depends on (`test-and-build`, `side-effecting-shell` and
`other` are all `offloadable: false`, so it makes no difference to any number
which of the three absorbs a writer), and unlike the original clause it is true
of every row in both run records.

### 10.4 A histogram that adds up

The `--explain` by-action block was silently truncated at 15 rows, so the seven
rows quoted in the proposal's `EVIDENCE.md` §3 summed to 431 against a stated
443 — a twelve-call gap with no explanation on the page. The block now prints
its own remainder row and its own total:

```
  by action (16 distinct actions, top 15 shown):
      198  git diff
      138  git status
       66  git show
       54  git log
       13  git ls-files
       11  git rev-parse
        5  git branch
        3  git state
        1  git tracked
        1  git --no-pager
        1  git check-ignore
        1  git cat-file
        1  git credential
        1  git tag
        1  git tree
        1  (1 further actions below the top 15)
    —————
      496  total — equals the family's 496 calls
```

The original block is left in place in `EVIDENCE.md` §3, relabelled as the
truncated histogram it always was.

### 10.5 What did not change

- **The candidate.** `git-history` is still the largest offloadable family with
  no agent; the scanner's own `candidates` list is byte-identical in the pre-
  and post-fix reports (`repo-exploration, git-history, web-research`).
- **The propose boundary.** §1–§3 are untouched by this: the skip rule, its six
  tests, the negative control and the live-server re-test are all about
  `src/mcp/agents.ts` and never about the scanner.
- **Every "not claimed" line.** The family is smaller than first reported and
  no saving was ever claimed from it, so each of them holds a fortiori.

### 10.6 Gate, re-run after the correction

```
$ npm run check     → tsc --noEmit, exit 0
$ npm run build     → exit 0
$ npm test          → # tests 526 · # suites 121 · # pass 526 · # fail 0
```

Frozen paths still clean:

```
$ git status --porcelain -- .genie/wishes/rlmx-explore-offload/tasks/ .genie/wishes/rlmx-explore-offload/parity/runs/
(no output — 0 lines)
```

The scanner is a bundled plugin script, not TypeScript, so `npm run check` does
not cover it; the check that matters for it is the case table in §10.1, and the
two run records in `scan-runs/` are its output on real input.

`docs/agent-yaml-schema.md` is the one file outside the wish's Files list for
this group. It is unowned by any other group, and it is where the wish's own
risk-row mitigation belongs: the reserved-suffix contract has to reach people
writing an `agent.yaml` without the plugin, because the skip rule's error
surface is silence.
