# Implementor • Project Defaults

Use these instructions whenever Automagik Genie needs to implement features in this repository.

## Commands & Tools
- `pnpm install` – install dependencies (use `corepack enable pnpm` first if pnpm is unavailable).
- `pnpm run build:genie` – compile the CLI TypeScript sources under `@.genie/cli/src/` and refresh `@.genie/cli/dist/`.
- `pnpm run build:mcp` – compile the MCP server in `@.genie/mcp/src/` when changes touch the server.
- `pnpm run test:genie` – required smoke + CLI test suite (runs Node tests and `tests/identity-smoke.sh`).
- `pnpm run test:session-service` – run when the session service or `.genie/state` handling changes.
- `pnpm run test:all` – aggregated suite before publishing or large merges.

## Context & References
- Source layout: CLI code in `@.genie/cli/src/`, MCP server in `@.genie/mcp/src/`, shared agent prompts in `@.genie/agents/core/`.
- Tests live in `@tests/` (`genie-cli.test.js`, `mcp-real-user-test.js`, `identity-smoke.sh`). Keep an eye on `.genie/state/agents/logs/` when troubleshooting failing runs.
- Contribution workflow and required co-author format: `@CONTRIBUTING.md`.
- Wishes expect artefacts under `.genie/wishes/<slug>/qa/` and reports under `.genie/wishes/<slug>/reports/`.

## Evidence & Reporting
- Capture command output (build + tests) to the wish `qa/` folder, e.g. `.genie/wishes/<slug>/qa/build.log` and `tests.log`.
- Note any regenerated `dist/` artefacts in the Done Report and list which commands produced them.
- Reference key files touched (CLI, MCP, prompts) with `@path` links so reviewers can jump directly to changes.
