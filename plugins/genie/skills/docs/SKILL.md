---
name: docs
description: "Dispatch docs subagent to audit, generate, and validate documentation against the codebase."
---

# docs — Documentation Generation

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (CLI-managed fallback or separately installed personal skill). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Audit existing documentation, fill gaps, and validate every claim against actual code. Standalone or as part of `work`.

## When to Use
- Undocumented modules, APIs, or workflows; docs referencing removed features
- A wish deliverable includes documentation
- Code just changed in ways existing docs describe (e.g. after `work` completes)

## Surfaces

| Type | Location | Purpose |
|------|----------|---------|
| README | `README.md`, `*/README.md` | Overview, setup, usage |
| AGENTS.md | `AGENTS.md`, `*/AGENTS.md` | Codex conventions, constraints, commands, verification |
| CLAUDE.md | `CLAUDE.md`, `*/CLAUDE.md` | Conventions, commands, gotchas for agents |
| API docs | `docs/api/`, inline JSDoc/TSDoc | Contracts, request/response schemas |
| Architecture | `docs/architecture.md`, `ARCHITECTURE.md` | System design, data flow |
| Inline | JSDoc, TSDoc, docstrings | Function/class/module docs |

`AGENTS.md` is the governing Codex instruction surface. `CLAUDE.md` remains evidence of repository intent when present; keep both current when the project supports both clients.

## Flow
1. **Audit** — map what exists across the surfaces above.
2. **Diff against code** — find missing, stale, or wrong claims; governing `AGENTS.md` accuracy first.
3. **Generate** — fill gaps in the project's existing documentation style.
4. **Validate** — every referenced path exists, every API matches, every described behavior is real.
5. **Report** — created/updated files with per-claim validation results.

## Dispatch

Runs as a subagent (native runtime): the dispatching agent issues an native delegation surface call with a curated brief — scope (which docs, which change triggered the audit), the code areas to validate against, and the expected report shape.

Example brief: "Audit README.md, CLAUDE.md, and skills/work/SKILL.md after PR #746 — verify dispatch examples match current code, fix stale references, report per-file verdicts with evidence."

## Rules
- Grounded progress: report only what was audited or generated in this session, each claim backed by a check actually run — "3 files verified current, 1 updated, 0 dead references", never just "docs written".
- No fiction: never document features that don't exist yet; no dead paths or APIs.
- Match existing project conventions for style and structure.
