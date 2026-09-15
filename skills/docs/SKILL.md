---
name: docs
description: "Audit documentation and developer experience against the live product — drift, onboarding, error messages — and write or fix docs when asked."
---

# Docs

Assess by default; write only when the request asks. Documentation is judged by use: a page that cannot be followed is worse than none. The live interface (the real `--help` output, routes, exports) is the truth; every README table, guide, and agent-context file is a claim to check against it.

## When to use

- Modules, APIs, or workflows are undocumented, or docs describe removed behavior.
- Code changed in ways the docs describe, or a wish deliverable includes documentation.
- Someone wants the contributor experience audited: onboarding, drift, error messages.

## Surfaces

| Surface | Where |
|---|---|
| README | `README.md`, `*/README.md` |
| Agent instructions | `AGENTS.md` (governing), `CLAUDE.md` and kin (overlays; keep both current when both exist) |
| Reference and architecture | `docs/`, `ARCHITECTURE.md`, inline JSDoc/TSDoc |
| Runtime DX | `--help` text, error messages, onboarding path in README/CONTRIBUTING |

Find where docs live before judging them: in-repo, a submodule, or a separate site with its own workflow. Internal pages deliberately excluded from a public site are design, not gaps. A fix that says "edit here" when the docs live elsewhere strands the change; name the real workflow.

## Audit

1. **Diff docs against the live interface.** Enumerate real commands, flags, routes, or exports; quote both sides of every mismatch. Governing agent instructions first.
2. **Run the contributor test** when onboarding is in scope: follow the written path verbatim from clone to the first passing check, logging every divergence. Hold the repo to its own stated bar.
3. **Classify each page** as tutorial, how-to, reference, or explanation; flag content filed in the wrong kind and kinds that are missing.
4. **Sample error messages** from a few realistic failures: exit code, text, and whether each says what failed, why, and what to do next. Terse is fine; grade on the three questions.
5. **Rank**: onboarding blockers, then drift, then misfiling, then message polish.

## Write

When asked, fill gaps in the project's existing style through its documented docs workflow. Never document features that do not exist; every referenced path, API, and behavior must be verified real. Write to the reader's decision boundary: what they need to decide, do, observe, and verify. Keep internal mechanism out of operator pages unless it changes a decision, a safety boundary, or a troubleshooting step.

## Report

Lead with the verdict: did the contributor test pass, what is the worst drift. Then findings with evidence (both sides of each drift, the exact stumble step, the quoted error message) and concrete fixes routed through the real workflow. Say what was verified current and what was skipped. Report only what was checked or written in this session.
