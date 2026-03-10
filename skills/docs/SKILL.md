---
name: docs
description: "Dispatch docs subagent to audit, generate, and validate documentation against the codebase."
---

# /docs — Documentation Generation

Audit existing documentation, identify gaps, generate what's missing, and validate every claim against actual code. Can be invoked standalone or as part of `/work`.

## When to Use
- Codebase has undocumented modules, APIs, or workflows
- Existing documentation is stale or references removed features
- A wish deliverable includes documentation
- After significant code changes that invalidate existing docs

## Flow
1. **Audit existing docs:** scan for READMEs, guides, inline docs, changelogs — map what exists.
2. **Identify gaps:** compare documentation against actual code — find what's missing, outdated, or wrong.
3. **Generate:** write documentation to fill the gaps, matching project conventions.
4. **Validate against code:** verify every claim — file paths exist, APIs match, behaviors are accurate.
5. **Report:** return list of created/updated files with validation results.

## Dispatch

| Runtime | Detection | Pattern |
|---------|-----------|---------|
| Claude Code | `Task` tool available | `Task(model: "sonnet", isolation: "worktree", prompt: "<docs prompt>")` |
| Codex | `CODEX_ENV` or native API | `codex_subagent(task: "<docs prompt>", sandbox: true)` |
| OpenClaw | `genie` CLI available | `genie agent spawn --role docs` |

Default to **Claude Code** when detection is ambiguous.

## Rules
- Validate every claim against actual code — no fiction.
- No dead references — every path, function, and API mentioned must exist in the codebase.
- Match existing project conventions for documentation style and structure.
- Never document features that don't exist yet.
- Include validation evidence in the report — not just "docs written" but "docs written and verified."
