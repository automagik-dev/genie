# Git Workflow • Project Defaults

## Branching & Sync
- Use descriptive feature branches: `feat/<wish-slug>` (aligns with wish status log).
- Keep branches rebased against the active wish branch (default `wish/<wish-slug>` or `main`).
- Before starting, ensure `pnpm install` has been run (uses Node 18+ / pnpm 10+).

## Required Checks Before Commit/PR
- `pnpm run build:genie` – rebuild CLI TypeScript; stage updates in `@.genie/cli/dist/` if produced.
- `pnpm run build:mcp` – rebuild MCP server when touching `.genie/mcp/src/`.
- `pnpm run test:genie` (always) and `pnpm run test:session-service` if session helpers changed.
- Review `pnpm run test:all` prior to merge when changes span CLI + session service.

## Commit Standards
- Follow Conventional Commits; include the Genie co-author line per `@CONTRIBUTING.md`.
- Ensure dist artefacts and generated files are staged alongside source changes.
- Reference the wish ID in commit body when applicable.

## Evidence & Reporting
- Document validation commands in the wish Done Report and stash outputs under `.genie/wishes/<slug>/qa/`.
- Note branch name, test suite statuses, and any manual QA performed before requesting review.
- If blockers occur, record them in `.genie/wishes/<slug>/reports/blocker-<slug>-<timestamp>.md` and update the wish status log.
