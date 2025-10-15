# Tests • Project Defaults

## Commands & Tools
- `pnpm run test:genie` – primary CLI + smoke suite, runs Node tests and `tests/identity-smoke.sh` (verifies the `**Identity**` banner and MCP tooling).
- `pnpm run test:session-service` – targeted coverage for the session service helpers.
- `pnpm run test:all` – convenience wrapper when both suites must pass.
- `pnpm run build:genie` – required before running the Node test files so the compiled CLI exists.

## Context & References
- Test sources live under `@tests/`:
  - `genie-cli.test.js` – CLI command coverage.
  - `mcp-real-user-test.js` & `mcp-cli-integration.test.js` – MCP protocol smoke tests.
  - `identity-smoke.sh` – shell-based identity verification (reads `.genie/state/agents/logs/`).
- TypeScript projects (`@.genie/cli/src/`, `@.genie/mcp/src/`) must compile via `pnpm run build:genie` / `pnpm run build:mcp` before test suites run.
- Keep `.genie/state/agents/logs/` handy when capturing regressions—smoke tests dump raw transcripts there.

## Evidence & Reporting
- Store test output in the wish folder: `.genie/wishes/<slug>/qa/test-genie.log`, `.genie/wishes/<slug>/qa/test-session-service.log`, etc.
- When MCP tests fail, attach the relevant log file from `.genie/state/agents/logs/` plus any captured stdout/stderr.
- Summarise pass/fail counts and highlight flaky behaviour in the Done Report.
