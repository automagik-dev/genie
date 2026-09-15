---
name: report
description: "Investigate a failure to its root cause with grounded evidence, hand the diagnosis to fix, and create a GitHub issue only when asked."
category: investigation
mutates: documents
---

# Report

Investigate; never fix. The deliverable is a diagnosis another agent can act on without reproducing the failure. Source edits belong to `fix`; creating an issue is a separate external write that happens only when the request asks for it or the user confirms it.

## When to use

- A failure exists and the cause is unknown, or the error points nowhere obvious.
- `review` or `fix` needs a root cause before spending a repair attempt.
- Someone wants a self-contained bug report, with or without a GitHub issue.
- A QA criterion in a wish failed after merge; map the failure to the criterion it violates before tracing.

## Investigate

1. **Collect symptoms:** the description (required), plus error text, stack traces, logs, URL, and expected versus actual behavior when offered. Ask only for what the investigation needs.
2. **Build a red loop before forming a theory:** name one command that fails right now for the reason under investigation, run it at least once, and keep its output. The loop must be red-capable (it drives the failing path and asserts the reported symptom, not merely "something errored"), deterministic, fast, and runnable unattended. Build it from whatever is cheapest that still reaches the failure: a failing test at any seam, a request script against a running service, a CLI invocation diffed against known-good output, a headless browser script, or a replay of a captured trace. Tighten it before trusting it — sharper assertion, pinned time and seed, fewer seconds. If you catch yourself reading code to build a theory before this command exists, stop; jumping to a hypothesis is the failure this gate prevents. When no loop can be built at all, say so, list what was tried, and name what would unblock it (access to an environment that reproduces, a redacted capture, permission to instrument) rather than hypothesizing without one.
3. **Trace:** reproduce, hypothesize, and isolate the root cause with read-only tools: search and non-mutating commands only, no edits, staging, commits, or publication. Investigate directly when one bounded investigation suffices; delegate a read-only `scout` through the runtime's native delegation surface when independent searches can run in parallel or the investigation needs isolated context, giving it the symptoms, relevant files, and the report format below, and steering it with follow-up messaging rather than starting a duplicate. If the failure cannot be reproduced, the report says so. Show 3-5 ranked falsifiable hypotheses before testing any of them — each stating what change would make the failure disappear or worsen — and then test one variable at a time against the loop.
4. **Instrument without mutating what you are investigating:** keep probes in scratch files outside the working tree. When a temporary in-tree probe is genuinely unavoidable, tag every added line with one unique marker such as `[DEBUG-a4f2]`, remove them all before handing off, and prove the tree is clean with `git status --porcelain`. Instrumentation is never a fix, and an untagged probe is a leak.
5. **Compile:** every statement traces to tool output from this investigation. Include the supporting evidence the project already offers — a browser, console or network capture where a URL or dev server exists, recent related errors from monitoring the project actually configures — and where expected evidence could not be captured, say so with the reason. Never present a planned capture as evidence.

## Diagnosis format

```
Root cause: <what is broken — file, line, condition>
Evidence: <reproduction steps, traces, proof>
Causal chain: <root cause → intermediate effects → observed symptom>
Recommended correction: <what to change, where, why>
Affected scope: <other files or features impacted>
Confidence: <high / medium / low>
```

Give file paths and line numbers for every claim. Verify every symbol named in the correction against the real file with `rg -n '<symbol>' <path>` and cite the matching line; a wrong name sends `fix` into a failing type-check. When more than one system is at fault, report each with its own confidence. An inconclusive trace is reported as "investigation incomplete" with the evidence gathered so far.

Two further outcomes are first-class, not failures to hide. **No correct seam:** when no seam exercises the real failure pattern as it occurs at the call site, a regression test placed there would give false confidence — report that as the finding and route it to `wish`, because the architecture, not the bug, is what blocks the lock-down. **Architecture, not hypothesis:** when three repair attempts have each surfaced a new problem somewhere else, stop counting failed hypotheses and report a wrong architecture; a fourth attempt is not authorized.

## GitHub issue (only when asked)

1. Search existing issues first; link an identical open issue instead of duplicating it.
2. Compose the body from `references/issue-template.md`, with only the evidence that applies and a note for expected evidence that could not be captured.
3. Present repository, title, labels (`bug` plus labels the repository already uses), and the body summary; create it through the GitHub connector when available, otherwise `gh` with the body passed as a file or stdin, never interpolated into a shell command.
4. If creation fails or authentication is missing, return the full report for manual submission.

In standalone lifecycle mode, the bug can also go on the Genie board with `genie task create --title "bug: <title> (gh#<n>)"`; skip it when there is no `.genie/genie.db`. Under explicitly selected Orca authority, a refusal is final: do not fall back to the local board.

## Handoff

Pass the diagnosis to `fix` or to the caller. Your final message is the completion signal; it carries the diagnosis and names any expected evidence that could not be captured.
