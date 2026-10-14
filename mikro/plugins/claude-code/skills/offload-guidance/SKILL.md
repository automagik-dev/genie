---
name: offload-guidance
description: "ROUTING RULE — when the question asks where something lives, how something works, what handles X, or how Y flows through a repository you have not already read into context, call the mikro microagent tool `mikro_explore-r` (namespaced `mcp__plugin_mikro_mikro__mikro_explore-r`) with the question as `prompt`, BEFORE running Grep/Glob/Read/Bash searches and BEFORE launching an Explore subagent. This rule outranks the habit of grepping first: it applies to multi-part questions even when each part looks small on its own, and the offloaded run costs this session almost none of its context, which is the entire reason to make it. Its citations are leads you then verify yourself. Read this skill for the protocol: the call shape and session resume, how to read the answer, and the three measured conditions that force escalation back to your own tools (citations that do not resolve; an errored or timed-out run; work where completeness matters more than cost). Read it also when an mikro result comes back errored, uncited, or thin. Does not apply when the answer is already in context, the question is about one known line or a diff you just made, or the work is a mutation."
---

# Offloading exploration to mikro

## The rule

**Explore-class question → call `mikro_explore-r` first. Treat its answer as a
lead, not as a finding. Escalate to your own tools the moment any of the three
triggers below fires.**

`explore-r` is a *first-pass* explorer. It failed its parity gate —
`Round-2 gate: FAIL` (`docs/parity-explore.md:993`), agreeing with round 1's
`Gate: FAIL` (`docs/parity-explore.md:595`). It ships anyway because a first
pass does not have to be a verdict: it has to be cheaper than reading the tree
yourself and honest about where it stops. Everything claimed below comes from
that report, at the report's own scoping. Read
`docs/parity-explore.md` in the mikro repository before quoting any of it; if it
and this file disagree, the report wins.

## When to route

Route when **all** of these hold:

- The question is about a codebase you have not already read into context.
- Answering it inline would mean opening many files — a survey, a "where is X
  handled", a "how does Y flow through this repo", a "what are all the Z".
- A wrong first answer is recoverable, because you are going to check the
  citations anyway.

Do **not** route when:

- You already have the file in context. Reading it is cheaper and exact.
- The question is about a specific known line, a diff you just made, or a test
  you just ran.
- The answer must be complete — see escalation trigger 3.
- The work is a mutation. `explore-r` reads; it does not edit, run your build,
  or touch git.

## How to call it

Tool: **`mikro_explore-r`** (namespaced `mcp__plugin_mikro_mikro__mikro_explore-r`
when it comes from this plugin). It explores the project directory the server
was started with — the plugin passes `--dir ${CLAUDE_PROJECT_DIR}`, so that is
your project root.

| Argument | Use |
|---|---|
| `prompt` | The question. Required in practice. |
| `session_id` | Continue an earlier call **on this same tool**. Omit to start fresh. |
| `context` | Optional path to a file or directory to preload, relative to the project root. |

Write the `prompt` as a complete, standalone question. The agent runs to
completion and returns a single final report; it **cannot ask you a follow-up
question mid-run**, so anything you leave implicit is simply lost. Name the
concrete artifacts you want back, and ask for `path:line` citations explicitly —
that is what makes the answer checkable, and checking it is the whole protocol.

The result carries a token/cost footer, and `structuredContent` repeats the
whole thing as `answer` alongside the `session_id`. To ask a follow-up — "you
cited three files, now show me how they call each other" — pass that
`session_id` back to **the same tool**; the prior turns are replayed into the
new prompt. A `session_id` is not portable between tools, and sessions are
in-process and time-limited: if it has expired, omit it and start again rather
than working around the error.

Prefer one resumed session over several fresh calls on the same subject. A
fresh call re-explores from nothing.

## The three escalation triggers

These are the campaign's **measured** failure signatures, not heuristics.

### 1. The answer lacks resolvable citations

If the answer carries no `path:line` citations, or its citations do not resolve
in your tree, **stop using it and re-run natively.** Do not repair it and do not
quote it.

This is the dominant recorded failure. In the frozen shot, two of the six
answers named the anchor file for only **3 of 14** and **2 of 12** of the facts
they were supposed to state (`docs/parity-explore.md:855-858`), and the report
screened both out on the rule that "a fact cannot be stated by an answer that
never mentions the file it is about" (`docs/parity-explore.md:862-864`).

Citations resolving is *not* the same as citations being right. In that same
frozen configuration every citation resolved, and the answers still failed the
quality bar. Resolution is the floor, not the bar: open the lines.

### 2. The run errors or times out

An `isError` result, or an error string in place of an answer, is **not a
partial answer**. Re-run natively; do not retry the same call hoping for a
different outcome, and do not report the error text as a finding.

The recorded signature looks like this, verbatim from a real run record
(`parity/round2/optimizer/gens/gen-4/rep-2/runs/task-5.json`):

```
mikro mikro_explore-r failed: REPL execution timed out after 600000ms
```

Sixty-seven characters, zero citations, after 650 seconds of wall clock. Lost
runs are a normal event in the record, not an anomaly: two matrix arms each lost
a run to the same 600-second REPL wall (`docs/parity-explore.md:1041`). The
cost of the lost run is already sunk; the only wrong move is to spend more on it.

### 3. Completeness matters more than cost

When the question must be answered *completely* — a security review, a release
gate, a migration that has to touch every call site, anything in the class the
frozen suite was built to measure — do the work natively. Route only if you then
verify every claim yourself, and never let the offloaded answer decide the
scope.

This is what the numbers say, at the report's scoping:

- **Out-of-sample coverage 0.714** (10/14) on the holdout — run once, after the
  recipe and model were chosen, never fed back — against **0.853–0.912 on the
  fitness set it was tuned on**, which the report calls "a real drop of
  0.14–0.20" (`docs/parity-explore.md:1046-1048`). 0.714 is the number that
  describes a question nobody has tuned against; it is the one that applies to
  yours.
- **Zero fabrications in the frozen configuration only.** That shot produced
  "215 citations, zero unresolvable, zero fabricated"
  (`docs/parity-explore.md:827-828`). This is a property of that configuration,
  not of the tool: **earlier rounds fabricated**, including a run that burned 24
  iterations and cited `src/lib/providers.ts:9`, which does not exist
  (`docs/parity-explore.md:426-427`). The verification block in the tuned prompt
  is what fixed it — "fabrications fell sharply wherever it ran"
  (`docs/parity-explore.md:685`). Change the prompt and you leave the
  configuration the number was measured in.
- Even so, the frozen shot **failed the gate on facts**: "Criterion 1 passes on
  none" — **0 of 6 tasks pass, and the suite requires 5 of 6**
  (`docs/parity-explore.md:977-989`). Missing facts, not wrong ones, is the
  characteristic failure.

## What the offload actually buys

Premium-token reduction, **frozen configuration**: **1,077×** aggregate across
the six-task suite — per task **530×–1,835×** — for **$0.22** of gateway spend
(`docs/parity-explore.md:960-968`). Round 1's `r15-flash-control`, a different
and non-shipping configuration, measured **921×** for **$0.14**
(`docs/parity-explore.md:554-562`); the two are not interchangeable and neither
is "about 1000×".

The report states the price of that number in the same breath, and so should
you: "It still buys an answer that fails the quality bar, which is why this
column was never allowed to be the gate" (`docs/parity-explore.md:972-973`).

So the offload is worth making because at **1,077×** on that suite a first pass
is close to free in premium tokens even at **0.714** coverage — **provided you
check it**. It is not worth making if you were going to trust the output.

## Reading the footer

Every result ends with a token/cost footer. Read it. It is what makes the
offload visible in the transcript instead of taken on faith, and a run whose
footer shows near-zero work is a run that did not explore.

## Provenance of these numbers

Every figure above traces to `docs/parity-explore.md` in the mikro repository at
the line given, with that report's own scoping, and none is rounded up. The
campaign evaluated **four generations and rejected a fifth** — gen-4, rejected
because four training anchoring terms sit verbatim in its own prompt, so its one
positive claim cannot be distinguished from the model reading its own
instructions (`docs/parity-explore.md:1049-1055`). The recursion product fixes
are in commit **`6ec4822`** (child model pinning, `rlm_query` model arg, loud
child failure) — those are in git, not in the report.
