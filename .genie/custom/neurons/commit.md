# Commit • Project Defaults

## Pre-Commit Checklist
- `pnpm run build:genie` (and `pnpm run build:mcp` if MCP sources changed) to ensure TypeScript output is up to date.
- `pnpm run test:genie` (always) and `pnpm run test:session-service` if `.genie/mcp/` or session helpers were touched.
- Stage regenerated artefacts: `@.genie/cli/dist/**/*`, `@.genie/mcp/dist/**/*`, and any generated wish reports/evidence.

## Commit Message Standards
- Follow Conventional Commits; scope examples: `cli`, `mcp`, `agents`, `docs`.
- Include the Genie co-author line: `Co-authored-by: Automagik Genie 🧞 <genie@namastex.ai>`.
- Reference the active wish slug/ID in the body when applicable.

## Evidence & Reporting
- Summarise the commands run (builds/tests) in the wish Done Report along with their stored logs.
- Note any outstanding follow-up or manual verification required post-commit.
