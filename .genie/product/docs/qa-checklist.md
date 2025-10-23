# QA Checklist (Canonical)

Use this checklist to drive repeatable QA. Keep items atomic, executable, and evidence-backed.

## Format
| Item | Category | Command | Evidence | Status |
|------|----------|---------|----------|--------|
| Agent listing latency | Performance | `time mcp__genie__list_agents` | `@.genie/qa/evidence/cmd-list-agents-<ts>.txt` | TBD |

## Categories
- Performance
- Error Handling
- Persistence
- UX/Flows
- Integration

## Examples
- Agent listing latency (<100ms)
- Session resume stability (no ID collision)
- Wish creation scaffolding (structure, validation, evidence paths)

