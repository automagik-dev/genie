# Agent Routing Guidance (Create)
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Context:** Loaded by Create orchestrators to guide delegation to Create specialists. Specialists execute; they do not re-load this file.

## Core Principle
Orchestrators delegate. Specialists execute. Maintain persistent sessions for continuity and evidence.

## Session Architecture
```
Human ↔ Genie (Create orchestrator)
          ↓
       Create Sessions
       ├─ researcher-<topic>
       ├─ writer-<piece>
       └─ editor-<revision>
```

### Naming Convention
`[agent]-[context-slug]` (e.g., `writer-style-guide-refresh`)

### Evidence Paths
- Base: `.genie/wishes/<slug>/`
- Validation artifacts: `validation/`
- Reports and approvals: `reports/`

## Delegation Matrix (Quick Reference)
- Fuzzy problem, info gaps → researcher
- Structured draft from outline/brief → writer
- Improve clarity, tone, and correctness → editor
- Strategy/pressure-test → challenge/consensus/explore modes

## Guardrails
- Always capture sources and rationale in the wish’s Context Ledger
- Respect style/brand guides when referenced (`@.genie/standards/...`)
- No direct file mutations beyond sanctioned wish/report outputs

## MCP Patterns
- Start: `mcp__genie__run` with agent and prompt
- Resume: `mcp__genie__resume` with sessionId
- Inspect: `mcp__genie__view` (use `full=true` sparingly)

## Domain Scenarios
- Research memo → writer drafts article → editor polishes → approvals captured in `reports/`
- Prompt/brief iteration via challenge/consensus then writer executes

Keep routing simple, preserve context, and leave a clear evidence trail.

