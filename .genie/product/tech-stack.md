# Genie Dev Technical Stack

Genie Dev extends the core Genie template with diagnostics and automation focused on self-evolution. The stack stays lightweight so downstream repos can still install it cleanly.

## Core CLI
- **Runtime:** Node.js 20.x managed with `pnpm`
- **Language:** TypeScript 5.9 (compiled via `.genie/cli/tsconfig.json`)
- **UI:** `ink` + `react` for interactive CLI flows
- **Formatting & Parsing:** `yaml` for agent metadata, native fs/stream tooling for logs

## Agent Assets
- **Prompts:** Markdown agents under `.genie/agents/` with utilities in `.genie/agents/utilities/`
- **Specialists:** Extensible specialist prompts tuned for self-audit (bug-reporter, tests, qa, learn, polish, project-manager)
- **State:** Session and ledger files stored in `.genie/state/` (never edit manually; inspect via MCP genie tools: `mcp__genie__list_sessions`, `mcp__genie__view`)

## Testing & Validation
- **Smoke Suite:** `tests/genie-cli.test.js` exercises CLI commands and prompt loading
- **Identity Check:** `tests/identity-smoke.sh` ensures guardrails match expectations
- **Recommended Checks:** `pnpm run build:genie` followed by `pnpm run test:genie` before publishing upgrades

## Meta-Agent Instrumentation
- **Done Reports:** `.genie/wishes/<slug>/reports/` captures experiment evidence and upgrade readiness
- **Learning Ledger:** `.genie/instructions/*` houses behavioural overrides promoted from experiments
- **Genie Orchestrator:** `.genie/agents/orchestrator.md` powers second-opinion audits before adopting risky changes

## Toolchain Integrations
- **Version Control:** Git-driven; branch `genie-dev` serves as the experimental lane
- **CI Hooks (planned):** GitHub Actions pipeline to run build + smoke tests and publish artefacts for review
- **Optional Runtimes:** Node/TS remains primary; Rust components can be referenced via `vendors/` for cross-language experiments

## Observability
- **Logs:** CLI captures command transcripts under `.genie/state/logs/`
- **Metrics (manual):** Encourage recording latency/quality metrics inside wish evidence tables until automated collectors land

This stack keeps Genie fast to iterate while providing the hooks required for self-auditing and safe downstream adoption.
