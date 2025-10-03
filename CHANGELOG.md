# Changelog

## [2.0.0] - 2025-10-03

### Added
- Restored full CLI workflow with `init`, `update`, and `rollback` commands rebuilt in TypeScript.
- Automatic migration from legacy `.claude` directories into the new `.genie` workspace structure.
- Provider persistence via `.genie/state/provider.json` and version tracking in `.genie/state/version.json`.
- Snapshot backups for every CLI operation under `.genie/backups/<timestamp>`.
- Bin shims for `npx automagik-genie` so existing automation keeps working.
- MCP-aware statusline command plus deprecation shims for legacy `status` and `cleanup` commands.
- Documentation overhaul with new README, contributing guide, and project logo.

### Changed
- Default `npx automagik-genie` now displays the command palette highlighting bootstrap commands.
- Validate/publish GitHub workflows reinstated and updated for the TypeScript CLI rebuild.

### Removed
- Reliance on legacy `.claude` bootstrap scripts; everything now runs through the rebuilt TypeScript CLI.

---

For earlier history, see the archived `genie-v0-archive` branch.
