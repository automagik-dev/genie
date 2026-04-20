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
- After `/work` completes — suggest `/docs` to document what changed

## Documentation Surfaces

Audit and maintain these doc types:

| Type | Location | Purpose |
|------|----------|---------|
| **README** | `README.md`, `*/README.md` | Project/module overview, setup, usage |
| **CLAUDE.md** | `CLAUDE.md`, `*/CLAUDE.md` | Project conventions, commands, gotchas for AI agents |
| **API docs** | `docs/api/`, inline JSDoc/TSDoc | Endpoint contracts, request/response schemas |
| **Architecture** | `docs/architecture.md`, `ARCHITECTURE.md` | System design, data flow, component relationships |
| **Inline docs** | JSDoc, TSDoc, docstrings | Function/class/module-level documentation |

**CLAUDE.md is a first-class documentation surface.** When the codebase changes significantly (new commands, changed conventions, removed features), flag CLAUDE.md for update. CLAUDE.md should always reflect the current state of the project.

## Flow
1. **Audit existing docs:** scan all documentation surfaces above — map what exists.
2. **Identify gaps:** compare documentation against actual code — find what's missing, outdated, or wrong. Pay special attention to CLAUDE.md accuracy.
3. **Generate:** write documentation to fill the gaps, matching project conventions.
4. **Validate against code:** verify every claim — file paths exist, APIs match, behaviors are accurate.
5. **Report:** return list of created/updated files with validation results.

## Dispatch

```bash
# Spawn a docs subagent
genie agent spawn docs
```

## Example

After shipping a new `genie work` dispatch fix, the orchestrator runs `/docs` to update documentation:

```bash
# 1. Spawn a docs subagent
genie agent spawn docs

# 2. Send the task
genie agent send 'Audit and update docs after PR #746 (initialPrompt added to dispatch). Check: README.md, CLAUDE.md, CO-ORCHESTRATION-GUIDE.md, skills/work/SKILL.md — verify dispatch examples match current code. Fix any stale references.' --to docs
```

The docs agent:
1. Scans all doc surfaces for references to `genie work`, dispatch, `protocolRouter.sendMessage`
2. Finds CO-ORCHESTRATION-GUIDE.md still references the old dispatch flow
3. Updates the guide with the new `initialPrompt` pattern
4. Validates every file path and API reference exists in the codebase
5. Reports: "Updated 1 file (CO-ORCHESTRATION-GUIDE.md). 3 files verified current. 0 dead references."

## Rules
- Validate every claim against actual code — no fiction.
- No dead references — every path, function, and API mentioned must exist in the codebase.
- Match existing project conventions for documentation style and structure.
- Never document features that don't exist yet.
- Include validation evidence in the report — not just "docs written" but "docs written and verified."

## Turn close (required)

Every session MUST end by writing a terminal outcome to the turn-session contract. This is how the orchestrator reconciles executor state — skipping it leaves the row open and blocks auto-resume.

- `genie done` — work completed, acceptance criteria met
- `genie blocked --reason "<why>"` — stuck, needs human input or an unblocking signal
- `genie failed --reason "<why>"` — aborted, irrecoverable error, or cannot proceed

Rules:
- Call exactly one close verb as the last action of the session.
- `blocked` / `failed` require `--reason`.
- `genie done` inside an agent session (GENIE_AGENT_NAME set) closes the current executor; it does not require a wish ref.
