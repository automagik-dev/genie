# EVIDENCE — why `git-historian` was proposed

Written by `/mikro:microagent-create` on **2026-07-27**, from this host's own
Claude Code transcripts. This file exists so the proposal can be **checked**
rather than believed: every number below names the command that produced it,
and every claim about burn names a transcript line you can open.

Read the last section — *What is not claimed* — before you rename the
directory.

> **Correction, 2026-07-27 (appended, nothing above rewritten).** The
> classifier that produced §2 and §3 had a broken redirect rule: `cmd > file`
> — the standard form — never matched, so commands that read *and then wrote a
> file* were counted as read-only. The rule is fixed and the numbers are
> re-derived in **§7**, which supersedes the family figures in §2 and §3. The
> originals stay on the page so the two can be compared. The candidate does not
> change; its size does.

---

## 1. How it was measured

```bash
node plugins/claude-code/skills/microagent-create/scan-transcripts.mjs --hours 24
node plugins/claude-code/skills/microagent-create/scan-transcripts.mjs --explain git-history --examples 8
```

Both invocations were captured together at **2026-07-27T21:49:54Z**. The window
is **rolling over live transcripts** — the sessions being measured were still
being written while the scan ran — so a later run returns slightly different
totals. An earlier run minutes before this one reported 441 calls where the
canonical pair reports 443. Numbers below are from the canonical pair, and none
of the reasoning turns on the difference.

Scope of the scan: **133 transcripts, 41,788 lines**, under
`~/.claude/projects`, last 24h.

The scanner distinguishes two kinds of number and so does this file:

- **MEASURED** — read verbatim out of each assistant turn's `usage` block.
  These are the API's own counts.
- **~ESTIMATED** — tool-result payload characters (exact) divided by 4 (a
  convention). Always written with `~`.

---

## 2. What the window looked like

> Family rows below are **pre-fix classifier** figures — superseded by §7. The
> MEASURED block and the whole-window ~ESTIMATED total are unaffected by the
> classifier (they are counted before any family is assigned).

MEASURED, whole window, all families:

| Quantity | Value |
|---|---|
| assistant turns | 16,663 |
| output tokens | 8,157,789 |
| cache-creation input tokens | 121,119,022 |
| cache-read input tokens | 2,733,055,152 |

~ESTIMATED context returned by tool results, all families: **17,085,747 chars
~ 4,271,437 tok**.

Families, ranked by context returned (`*` = offloadable — read-only work whose
whole product is a written answer):

```
  * repo-exploration     13,285,835 chars ~3,321,459 tok   77.8%  calls 4,770  sess  11  proj  5  433.6/sess  med 817 ch
    side-effecting-shell  1,502,936 chars ~  375,734 tok    8.8%  calls 1,543  sess  10  proj  5  154.3/sess  med 441 ch
    other                   918,387 chars ~  229,597 tok    5.4%  calls   844  sess   9  proj  4   93.8/sess  med 364 ch
  * git-history             840,721 chars ~  210,180 tok    4.9%  calls   443  sess   9  proj  4   49.2/sess  med 1,062 ch
    edits                   193,561 chars ~   48,390 tok    1.1%  calls 1,099  sess   8  proj  4  137.4/sess  med 170 ch
    test-and-build          147,303 chars ~   36,826 tok    0.9%  calls   259  sess   9  proj  4   28.8/sess  med 274 ch
    agent-delegation        139,865 chars ~   34,966 tok    0.8%  calls    56  sess   8  proj  4      7/sess  med 1,083 ch
  * web-research             56,056 chars ~   14,014 tok    0.3%  calls    20  sess   3  proj  3    6.7/sess  med 1,947 ch
```

Token-optimizer corroboration (present on this host, optional input): 9 session
caches in the window, 2,437 tool calls, 39,000 estimated waste tokens, worst
session `3eadf222` at 16,000 tokens with a quality score of 76.3.

---

## 3. The candidate: `git-history`

> **Pre-fix classifier figures — superseded by §7.**

**443 calls · 9 sessions · 4 projects · 840,721 chars ~210,180 tok · median
1,062 chars per call · 49.2 calls per session.**

By action, within the family — **a truncated histogram, not the whole
breakdown**. These seven rows sum to **431**, twelve short of the family's
**443**; the balance sits in low-count actions below the cut that this capture
did not print. The scanner now prints its own remainder row and its own total
precisely so a block like this cannot be mistaken for a complete one
(`scan-transcripts.mjs`, the `by action` section of `--explain`); §7 carries a
version that adds up.

```
    181  git diff
    123  git status
     57  git show
     46  git log
     10  git ls-files
     10  git rev-parse
      4  git branch
    ————
    431  shown — 12 short of the family's 443 (truncated histogram)
```

By project:

```
    255 calls    576,614 chars  -home-namastex-workspace
     93 calls    106,975 chars  -home-namastex-prod-brain
     52 calls     98,824 chars  -home-namastex-workspace-repos-omni
     43 calls     58,308 chars  -home-namastex-prod
```

It clears all five candidate rules:

1. **Offloadable.** Read-only by construction: the scanner routes any command
   containing a writing git verb (`add`, `commit`, `reset`, `checkout`,
   `stash`, `push`, …) into `side-effecting-shell` instead, even when the same
   compound command also runs `git diff`. That reclassification is why this
   family is 443 calls and not the 599 an earlier, looser rule reported — the
   156-call difference was compound commands that read *and then wrote*, and
   they are not offloadable.

   **Corrected (§7):** the rule was *also* supposed to catch file redirection,
   and did not — `git diff HEAD > "$D"` slipped through the whole way. The
   156-call figure above is therefore the writing-git-verb arm alone, not the
   redirect arm, and this family was still carrying commands that wrote a file.
   §7 fixes the rule and re-derives the size.
2. **Not already covered.** `repo-exploration` sits far above it at 77.8% and is
   `explore-r`'s class — proposing it again would propose a duplicate.
   `web-research` is real but small (20 calls). `git-history` is the largest
   offloadable family with no agent.
3. **Repeatable.** 9 sessions, 4 separate projects, 49.2 calls per session. Not
   one burst.
4. **Self-contained.** "Which commit introduced X, and what did it change" is
   answerable in one prompt with no follow-up — which matters, because the
   agent runs to completion and cannot ask a question mid-run.
5. **Bulk in, summary out.** Median **1,062 chars per call**, the highest of any
   candidate family except `web-research`; a diff or a log comes back long and
   is worth two lines of conclusion.

### Transcript references — open these

Heaviest calls in the family, `<transcript>:<line>`, verbatim commands:

| chars | ref | command |
|---|---|---|
| 22,646 | `~/.claude/projects/-home-namastex-workspace/2cbc9745-3e7e-4191-b818-43ee1074af44/subagents/workflows/wf_f79ae5b0-ed4/agent-a5f7f32678e7b4a4a.jsonl:148` | `cd /home/namastex/prod/mikro && D=…/staged.diff; git diff HEAD …` |
| 21,397 | `~/.claude/projects/-home-namastex-workspace/2cbc9745-3e7e-4191-b818-43ee1074af44/subagents/workflows/wf_2c703ec8-b5b/agent-ac930a9d88b2b7cfe.jsonl:96` | `cd /home/namastex/prod/mikro && echo "=== mine-explore-tasks.mjs DIFF vs HEAD ===" && git diff HEAD -- scripts/mine-explore-tasks.mjs` |
| 15,727 | `~/.claude/projects/-home-namastex-workspace/2cbc9745-3e7e-4191-b818-43ee1074af44/subagents/workflows/wf_2c703ec8-b5b/agent-a463a6e03d0653966.jsonl:65` | `cd /home/namastex/prod/mikro && git diff HEAD -- scripts/mine-explore-tasks.mjs \| head -300` |
| 12,068 | `~/.claude/projects/-home-namastex-workspace/2cbc9745-3e7e-4191-b818-43ee1074af44/subagents/workflows/wf_f79ae5b0-ed4/agent-a9e94a72bc3c24490.jsonl:25` | `cd /home/namastex/prod/mikro && git show --stat 6ec4822 && echo "=== DIFF ===" && git show 6ec4822 -- src/ \| head -200` |
| 11,074 | `~/.claude/projects/-home-namastex-workspace/2cbc9745-3e7e-4191-b818-43ee1074af44/subagents/workflows/wf_3e5dad7a-424/agent-a9cba19481ca2a0e9.jsonl:12` | `cd /home/namastex/prod/mikro && git diff HEAD -- .claude-plugin/ plugins/ CHANGELOG.md` |

Regenerate the full list with
`… scan-transcripts.mjs --explain git-history --examples 8`.

> **The first row does not survive the §7 correction.** That command is
> `… D=<path>/staged.diff; git diff HEAD > "$D"; wc -l "$D"; …` — it writes a
> file, so under the fixed rule it is `side-effecting-shell` and leaves this
> family entirely. It was the single heaviest call cited here. The other four
> are unaffected and still resolve.

Note what those five have in common: three of them re-read the *same* diff at
different slice widths. That is the shape the agent targets — the session did
not need the patch, it needed the conclusion. (The correction sharpens this
rather than blunting it: in the post-fix list of §7, **four** of the eight
heaviest calls are the same `git diff HEAD -- scripts/mine-explore-tasks.mjs`,
sliced four different ways — whole, `| head -300`, `| head -200`, and
`| sed -n '200,420p'`.)

---

## 4. Feasibility probe — run twice, and the first run failed

A draft that has never executed is a guess about a runtime. So the draft's own
`agent.yaml` + `SYSTEM.md` were copied into a scratch agents root
(`MIKRO_AGENTS_DIR=<tmp>`) and run against this repository as `--dir`. **The
proposal itself was never activated** — `MIKRO_AGENTS_DIR` replaces the default
roots entirely, so `.mikro/agents/` was not even scanned.

> **Traceability, stated up front.** Both probes ran in a scratch
> `MIKRO_AGENTS_DIR` that was deleted with the temp directory, and **no run
> record was kept**. The iteration counts, token counts, dollar figures and
> wall-clock times below are therefore **self-reported by the session that ran
> them and are not re-derivable** — unlike every scan figure in this file,
> which has a committed run record under
> `.genie/wishes/rlmx-microagent-plugin/scan-runs/`. What *is* re-derivable is
> the substance: the run-1 fabrications and the run-2 claims were each checked
> against this repository with the `git` commands named in the tables, and
> those commands re-run today. Re-running the probes would produce new numbers,
> not evidence for these.

Question, both runs, verbatim:

> In this repository's git history, which commit introduced the child model
> pinning fix for recursion? Give its short SHA, its full subject line, its
> author date, and the source files under src/ that it changed. Then say which
> commit most recently changed src/mcp/agents.ts before HEAD.

### Run 1 — FABRICATED. 1 iteration, 2,820 in / 997 out, $0.0005, 37.7s. *(self-reported; no run record)*

It answered on turn one, having executed nothing. It returned the correct SHA,
subject, date and author — because an earlier version of this `SYSTEM.md`
carried them in a worked example — and then invented everything it actually had
to look up:

| claim | truth |
|---|---|
| `src/mcp/errors.ts` changed | file does not exist |
| `src/mcp/spawn.ts` changed | file does not exist |
| `src/mcp/mcp_runner.ts` changed | file does not exist |
| `baed9e5` last touched `src/mcp/agents.ts` | `git cat-file -t baed9e5` → `fatal: Not a valid object name` |

This is the parity campaign's own recorded failure mode, reproduced exactly:
gen-4 was **rejected** because "four training anchoring terms sit verbatim in
its own prompt … so its one positive claim cannot be distinguished from the
model reading its own instructions" (`docs/parity-explore.md:1049-1055`).

**Fix applied to the draft:** every repository-specific anchor was removed from
`SYSTEM.md` (there is now no worked example and no real SHA anywhere in it), and
a countable rule was added — *no `FINAL` before your fourth repl block* —
modelled on `examples/agents/explore/SYSTEM.md`, which uses the same mechanism
to stop a first-turn answer.

### Run 2 — clean. 4 iterations, 13,648 in / 2,499 out, **$0.0019**, 52.4s. *(self-reported; no run record)*

Every claim was re-checked against the repository afterwards:

| claim | check | result |
|---|---|---|
| commit `6ec4822`, subject, author date 2026-07-27, author Felipe Howit | `git log -1 --format='%h \| %ad \| %an \| %s' --date=short 6ec4822` | correct |
| changed `src/cli.ts`, `src/config.ts`, `src/llm.ts`, `src/mcp/agents.ts`, `src/mcp/server.ts`, `src/schema.ts` | `git show --name-only --format= 6ec4822 -- src/` | correct and complete — all six, no extras |
| "also changed matching files under tests/ and dist/" | `git show --name-only --format= 6ec4822` | correct |
| HEAD is `8c1b2e3`, subject `docs(genie): approve wish B plan …` | `git log -1` | correct |
| HEAD touches no file under `src/` | `git show --name-only --format= HEAD` | correct |
| `6ec4822` is the most recent commit touching `src/mcp/agents.ts` | `git log -2 -- src/mcp/agents.ts` | correct |

Zero fabrications in run 2, on this one question. Model
`khal/deepseek-v4-flash` (wish decision 5 default; `station/<model>` is the $0
offline alternative on this host).

---

## 5. What is **not** claimed

- **No quality claim.** Two probe runs on one question, one of which fabricated,
  is a feasibility result, not a measurement. Nothing here establishes accuracy,
  coverage, or a pass rate on git-history questions in general.
- **No saving is claimed.** `~210,180 tok` (corrected: `~235,284 tok` on the
  §7 window) is what this family **returned into context during the window**.
  It is not what the agent would save: the agent's own answer still enters the
  session, some of those 443 calls (corrected: 496) would not have been asked
  of an agent at all, and 123 of them (corrected: 138) were `git status`, which
  is cheap to run natively and rarely worth a delegated round trip.
- **The ~ numbers are estimates.** Characters are exact; the ÷4 is a convention.
  The MEASURED rows are the API's own counts and are the only exact token
  figures here.
- **`explore-r`'s parity numbers are not inherited.** They describe a different
  agent on a frozen suite. Cited only as calibration for how a first-pass mikro
  agent behaves, whole and with their scoping: out-of-sample coverage **0.714**
  on the holdout against **0.853–0.912** in-sample, "a real drop of 0.14–0.20"
  (`docs/parity-explore.md:1046-1048`); **zero fabrications in the frozen
  configuration only** — earlier rounds fabricated, including a run that cited
  `src/lib/providers.ts:9`, which does not exist
  (`docs/parity-explore.md:426-427`) — and the verification block is what fixed
  it, "fabrications fell sharply wherever it ran"
  (`docs/parity-explore.md:685`); premium-token reduction **1,077×** aggregate
  on that suite for **$0.22** (`docs/parity-explore.md:960-968`); and that shot
  still **failed** the gate on facts, **0 of 6 tasks passing where 5 of 6 were
  required** (`docs/parity-explore.md:977-989`). Run 1 above is what those
  numbers are warning about.
- **Not run at scale.** Two runs, one repository, one question.

---

## 6. Activating it — your move, not the agent's

This directory ends in `.proposed`, which `discoverAgents` skips
(`src/mcp/agents.ts`, `isProposedDir`). It is neither listed nor callable, and
calling it by name answers `Unknown tool: mikro_git-historian_proposed`.
`tests/mcp-agents.test.ts` pins that.

To activate:

```bash
mv .mikro/agents/git-historian.proposed .mikro/agents/git-historian
```

The tool appears as `mikro_git-historian` on the next request — live refresh, no
restart, no reconnect. To withdraw it, rename it back; it stops dispatching just
as fast.

`.proposed` is a **reserved suffix**, matched case-insensitively. An agent you
genuinely wanted to call `something.proposed` would be permanently invisible,
and the skip is silent by design.

---

## 7. Correction — the redirect rule never fired *(appended 2026-07-27)*

Everything above this section is the original file. Nothing in it was
rewritten. This section supersedes the family figures in §2 and §3.

### 7.1 The bug

`SIDE_EFFECTING` in `scan-transcripts.mjs` is the test that keeps a writing
command out of a family labelled read-only. Its third arm was supposed to catch
redirection into a file. It read:

```js
String.raw`(^|[^0-9&\s])>>?\s*[^&\s|]`     // before
```

The leading class excludes whitespace, so the `>` had to be glued to the
preceding character. `cmd>file` matched; **`cmd > file` — the form every shell
user writes — never did.** The single heaviest call cited in §3,
`… git diff HEAD > "$D"; wc -l "$D"; …`, wrote a 22,646-character diff to disk
and was counted as read-only git history. Worse in the other direction, the
class *admitted* `-`, `=` and `<`, so `a -> b`, `x => y` and `3<>/dev/tcp/…`
were all read as redirects and their commands pushed out of read-only families
that they belonged in.

Fixed:

```js
String.raw`(^|[^0-9&<>=-])>>?\s*[^&\s|]`   // after
```

Whitespace is now allowed before `>`; digits, `&`, `<`, `>`, `=` and `-` are
not. Verified case by case:

| command | classified | why |
|---|---|---|
| `git diff HEAD > "$D"` | **side-effecting** | space before `>`, target `"` |
| `git diff HEAD >/tmp/x` | **side-effecting** | space before `>`, target `/` |
| `git log >> /tmp/log` | **side-effecting** | `>>` matched, target `/` |
| `npm test 2>&1` | not a file write | fd digit before `>` |
| `ls 2>/dev/null` | not a file write | fd digit before `>` |
| `rg "a->b" src/` | not a file write | `-` before `>` |
| `git diff 1>&2` | not a file write | fd digit before `>` |

One residual is left in place: `awk 'NR>=255 …'` — a letter before the `>`, `=`
as the target — still reads as a redirect, as does a quoted `>` passed as an
argument. It is pre-existing (identical under the old rule, so it moves nothing
in §7.2) and it errs toward "side-effecting", which only ever shrinks a family
claimed to be read-only.

> **The size of that residual is not evidence.** This paragraph first said
> "**62 commands** in the same window" and called it measured. It is
> **self-reported and not re-derivable** — the same status as the §4 probe
> figures, and the opposite of the §7.2 numbers, which have committed run
> records. `scan-transcripts.mjs` has no residual-counting mode, no file in
> `.genie/wishes/rlmx-microagent-plugin/scan-runs/` contains the figure, the
> 24 h window it was taken over has rolled and cannot be re-created, and the
> figure never stated its unit (calls or distinct command strings; commands
> where the redirect arm was the only trigger, or every command containing a
> comparison-shaped `>`). Four readings of that run over a later window returned
> 302 / 1,915 / 302 / 1,910 — the definition, not the data, decides the answer.
> The count has therefore been dropped rather than restated. **Nothing here
> depends on it:** the two things the paragraph uses are that the residual is
> one-sided (structural — a command in `side-effecting-shell` cannot be in an
> offloadable family, so this can only shrink `git-history`, never inflate it)
> and that it cancels in §7.2's A/B (structural — neither classifier excludes
> `=` from the target class, so it is identical on both sides whatever its
> size).

### 7.2 The re-derived numbers

The window is rolling over live transcripts, so the original 2026-07-27T21:49Z
window **cannot be re-created** — a later scan reads more sessions. So the
correction is measured as an A/B instead: the pre-fix and post-fix classifiers
run back-to-back over the *same* transcripts, 0.5 s apart. Both reports agree
exactly on everything the classifier does not touch (138 transcripts, 43,613
lines, 17,958,615 tool-result chars, 17,687 assistant turns), so every
difference below is the character class and nothing else.

Run records committed at
`.genie/wishes/rlmx-microagent-plugin/scan-runs/` — both JSON reports, both
`--explain git-history` outputs, and the delta table.

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

**The candidate family shrinks by 4.33% of returned context** (983,705 →
941,136 chars, ~245,926 → ~235,284 tok) and by 13 calls (2.6%). Its share of
all returned context falls 5.5% → 5.2%; its median rises 1,090 → 1,122 chars
per call, because what left was mostly cheap.

The fix cuts both ways, and the movement shows it:

```
    182  repo-exploration     -> side-effecting-shell     (missed redirects, now caught)
     19  git-history          -> side-effecting-shell     (missed redirects, now caught)
      2  git-history          -> test-and-build           (missed redirects, now caught)
     44  other                -> side-effecting-shell     (missed redirects, now caught)
    109  side-effecting-shell -> repo-exploration         (false `->`/`=>`/`<>`, now released)
      8  side-effecting-shell -> git-history              (false `->`/`=>`/`<>`, now released)
    119  side-effecting-shell -> other                    (false `->`/`=>`/`<>`, now released)
```

Read-only families lose 203 calls and get 117 back. Net **−86**, and the
direction is the safe one.

### 7.3 The by-action breakdown, complete this time

Post-fix, `git-history`, and it adds up — the scanner now prints its own
remainder row and its own total:

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

By project, post-fix: 270 calls / 588,785 chars `-home-namastex-workspace` ·
95 / 170,427 `-home-namastex-workspace-repos-omni` · 89 / 104,029
`-home-namastex-prod-brain` · 42 / 77,895 `-home-namastex-prod`.

### 7.4 What the correction does *not* change

- **The candidate.** `git-history` is still the largest offloadable family with
  no agent: `repo-exploration` is `explore-r`'s class (77.3% post-fix, and
  proposing it would propose a duplicate) and `web-research` is still 20 calls.
  The scanner's own `candidates` list is identical in both reports.
- **The five candidate rules.** All still clear, on the post-fix numbers: 496
  calls, 9 sessions, 4 projects, 55.1 calls per session, median 1,122 chars.
- **Every "what is not claimed" line in §5.** They get stronger, not weaker: the
  family is smaller than first reported and no saving was ever claimed from it.
- **The MEASURED block in §2.** Usage counts are read before any family is
  assigned; the classifier cannot touch them.
