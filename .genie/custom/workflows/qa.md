# QA • Project Defaults

## Commands & Tools
- `pnpm run test:genie` – primary smoke suite (runs Node tests and `tests/identity-smoke.sh`).
- `pnpm run test:session-service` – execute when session service behaviour changes.
- `tests/identity-smoke.sh` – standalone identity banner verification (reads `.genie/state/agents/logs/`).
- `node tests/mcp-real-user-test.js` / `node tests/mcp-cli-integration.test.js` – MCP protocol coverage.

## Context & References
- Smoke tests live in `@tests/`; review each script before reproducing failures.
- Genie log output is stored in `.genie/state/agents/logs/<agent>-<timestamp>.log`; keep snippets for troubleshooting.
- Product/environment toggles: `@.genie/product/environment.md` (e.g., `ENABLE_SELF_LEARN_SYNC`).
- Wish artefacts belong inside `.genie/wishes/<slug>/qa/` (evidence) and `.genie/wishes/<slug>/reports/` (QA reports).

## Evidence & Reporting
- Save command transcripts (stdout/stderr) to the wish `qa/` directory (`qa/identity-smoke.log`, `qa/mcp-cli.log`, etc.).
- Reference any relevant log files from `.genie/state/agents/logs/` in the Done Report.
- Escalate confirmed regressions through the bug-reporter agent with links to evidence and log files.
