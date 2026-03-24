---
name: docs
description: "Dispatch docs subagent to audit, generate, and validate documentation against the codebase. Use when the user asks to write a README, generate docstrings, create API docs, update docs, check documentation coverage, audit stale documentation, add JSDoc or TSDoc comments, document architecture, or fix outdated references."
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
genie spawn docs
```

## Validation Example

After generating or updating documentation, validate each claim systematically:

```
Validation Report for src/lib/README.md:
  [PASS] File path "src/lib/transcript.ts" exists
  [PASS] Function "parseTranscript()" found in src/lib/transcript.ts:42
  [PASS] API endpoint "POST /api/dispatch" matches route definition
  [FAIL] Reference to "src/lib/legacy-parser.ts" — file not found (removed in commit abc123)
  Action: Removed stale reference, updated to current parser path
```

Each report entry must include the claim being verified, the verification result (PASS/FAIL), and for failures, the corrective action taken.

## Error Handling

When documentation generation encounters issues, handle them explicitly:

- **Missing source files:** If a documented module no longer exists, remove or flag the stale reference rather than silently skipping it. Log the discrepancy in the validation report.
- **Ambiguous code paths:** When a function's behavior is unclear from the source, document what is verifiable and add a `<!-- TODO: clarify behavior -->` marker rather than guessing.
- **Conflicting documentation:** If multiple doc surfaces contradict each other (e.g., README says one thing, CLAUDE.md says another), flag the conflict in the report and resolve by deferring to the actual code behavior.
- **Permission or access errors:** If a file or directory cannot be read during audit, report it as a blocked item rather than treating it as "no docs needed."

## Expected Output Format

Return a structured report after each run:

```
## Documentation Report

### Files Created
- docs/api/dispatch.md — API reference for dispatch endpoints

### Files Updated
- README.md — Added setup instructions for new env vars
- CLAUDE.md — Updated command list, removed deprecated `genie legacy` reference

### Validation Summary
- Total claims verified: 47
- Passed: 45
- Failed: 2 (corrected inline)

### Remaining Gaps
- src/hooks/ — No module-level docstrings (flagged for next pass)
```

## Rules
- Validate every claim against actual code — no fiction.
- No dead references — every path, function, and API mentioned must exist in the codebase.
- Match existing project conventions for documentation style and structure.
- Never document features that don't exist yet.
- Include validation evidence in the report — not just "docs written" but "docs written and verified."
