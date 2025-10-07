# Bug Reporter • Project Defaults

## Reproduction Commands
- `pnpm run test:genie` – baseline smoke; capture failures to reproduce CLI regressions.
- `node tests/mcp-real-user-test.js` and `node tests/mcp-cli-integration.test.js` – MCP-specific issues.
- `tests/identity-smoke.sh` – verify identity banner/log output when failures involve missing session IDs.
- Inspect `.genie/state/agents/logs/` for the relevant agent log (e.g., `plan-*.log`, `core-analyze-*.log`).

## Context & References
- CLI logic: `@.genie/cli/src/`
- MCP server: `@.genie/mcp/src/`
- Smoke/integration tests: `@tests/`
- Contribution & commit practices: `@CONTRIBUTING.md`

## Evidence & Reporting
- Store reproduction transcripts in `.genie/wishes/<slug>/qa/bug-report-<timestamp>.log`.
- File the Markdown issue draft under `.genie/wishes/<slug>/reports/bug-report-<timestamp>.md` before creating the GitHub issue.
- Attach relevant log excerpts from `.genie/state/agents/logs/` and note environment details (`node -v`, `pnpm -v`).
