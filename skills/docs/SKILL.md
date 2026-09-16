---
name: docs
description: "Audit documentation and developer experience against the live product — drift, onboarding, error messages — and write or fix docs when asked."
category: authoring
mutates: repo
---

# Docs

Assess by default; write only when the request asks. Documentation is judged by use: a page that cannot be followed is worse than none. The live interface (the real `--help` output, routes, exports) is the truth; every README table, guide, and agent-context file is a claim to check against it.

The assessment half is a saved workflow, not a procedure this skill performs inline. Its single source of truth is `.claude/workflows/docs-audit.js` in the genie repository's canonical workflow catalog (see `.claude/workflows/README.md` there); this skill is its front door. On Claude Code, run the native Workflow tool with the saved name `docs-audit`, passing `{focus?, surfaces?, quorum?, model?, timestamp?}` — every key optional, and with no `surfaces` list the audit runs the full four-surface roster of the table below. The workflow probes read-only: it asks nothing, writes nothing, and moves no file. Relay the returned `report` unchanged, and list `notConvened` (agents that returned nothing) beside the `unread` (paths no auditor could read) and `unprobed` (documented claims no auditor could probe read-only) lists rather than filling any of the three gaps yourself.

## When to use

- Modules, APIs, or workflows are undocumented, or docs describe removed behavior.
- Code changed in ways the docs describe, or a wish deliverable includes documentation.
- Someone wants the contributor experience audited: onboarding, drift, error messages.

## Surfaces

The four keys are the audit's shard roster: `surfaces` narrows it, never grows it, and a key it drops is named as a gap.

| Surface | Key | Where |
|---|---|---|
| README | `readme` | `README.md`, `*/README.md` |
| Agent instructions | `agent-instructions` | `AGENTS.md` (governing), `CLAUDE.md` and kin (overlays; keep both current when both exist) |
| Reference and architecture | `docs-architecture` | `docs/`, `ARCHITECTURE.md`, inline JSDoc/TSDoc |
| Runtime DX | `runtime-dx` | `--help` text, error messages, onboarding path in README/CONTRIBUTING |

The workflow resolves where docs live before judging them — in-repo, a submodule behind a symlink, or a separate site — and stamps that route into every auditor, so a fix never says "edit here" when the docs live elsewhere. Internal pages deliberately excluded from a public site are design, not gaps.

## The contributor test

This stays here, with you, and never reaches the workflow. When onboarding is in scope, follow the written path verbatim as a fresh reader: from clone to the first passing check, one serial walk, logging every divergence. It installs and builds, so it is never parallelised and never delegated to a shard. Hold the repo to its own stated bar, and freeze what you learned into `focus` before the call rather than asking the workflow to re-derive it.

## Write

When asked, fill gaps in the project's existing style through its documented docs workflow — in this repository, the docs submodule flow recorded in `CLAUDE.md`: edit under `docs/`, commit and push in the vendored submodule, open the pull request against the docs remote, then bump the superproject pointer once it merges. Never document features that do not exist; every referenced path, API, and behavior must be verified real. Write to the reader's decision boundary: what they need to decide, do, observe, and verify. Keep internal mechanism out of operator pages unless it changes a decision, a safety boundary, or a troubleshooting step.

## Without a workflow surface

On a runtime with no workflow surface, dispatch the same four stages by hand and carry no roster the script does not. **Locate**: one read-only agent resolves the docs home, its other true names, the public/internal split and the fix workflow, each claim carrying the read-only command that proved it. **Audit**: one auditor per row of the Surfaces table, each carrying several checks over its whole surface and quoting both the documented claim and the live behaviour. **Consolidate**: one judge sees every responding auditor at once, collapses one root drift restated on three surfaces into a single row, settles severity conflicts, and ranks by which blocker a reader hits first. **Render**: draw the table, the docs-home routing line, the duplicate list and the unread/unprobed lists yourself. An auditor that returns nothing is reported, never inferred.

## Report

Lead with the verdict: did the contributor test pass, what is the worst drift. Then the ranked table with evidence (both sides of each drift, the exact stumble step, the quoted error message) and concrete fixes routed through the real workflow. Say what was verified current and what was skipped. Report only what was checked or written in this session.
