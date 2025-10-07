# Orchestrator • Project Defaults

## Preferred Modes
- `planning` – Pressure-test new wish briefs before `/wish`.
- `consensus` – Resolve competing approaches across CLI vs MCP changes.
- `test-strategy` – Deep dive on test coverage when new suites are proposed.
- `design-review` – Required for architecture-impacting refactors (CLI/MCP interaction).

## Mode Notes
- Planning prompts should reference the current wish folder (`.genie/wishes/<slug>/`) and recent reports.
- When evaluating CLI work, load summaries from `tests/identity-smoke.sh` and `tests/mcp-*.js` outputs kept under the wish `qa/` folder.
- Capture Genie verdicts in wish `reports/` if the mode influences go/no-go decisions.

## Evidence & Reporting
- Save orchestrator Done Reports at `.genie/wishes/<slug>/reports/done-genie-<slug>-<timestamp>.md` for high-impact sessions.
- Include the mode, confidence level, and recommended next steps in the final chat response.
- Note any follow-up tasks (e.g., rerun `pnpm run test:genie`, add migration guide items) so they feed into the wish status log.
