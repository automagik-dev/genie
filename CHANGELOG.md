# Changelog

## [2.3.7] - 2025-10-16

### Added
- Multi-template system: `genie init [code|create]` for specialized workflows
- Token-efficient output: 99.0-99.6% reduction for AI-to-AI orchestration (16k → 122-168 tokens)
- Neuron cognitive architecture: Clear separation of neurons/modes/workflows directories

### Changed
- Reorganized agent directory structure: `core/` → `neurons/` + `workflows/`
- Session views now use lightweight markdown instead of Ink rendering
- Custom overrides restructured to mirror cognitive architecture

### Removed
- Ink UI dependencies (~1,200 lines of rendering overhead)
- ViewEnvelope abstraction layer (replaced with markdown formatter)

### Performance
- Enables 10+ concurrent AI agents without token budget explosion
- Session monitoring: 36-48k tokens → <600 tokens (98.8% reduction)

## [2.0.1] - 2025-10-07

### Fixed
- Minor patch release

## [2.0.0] - 2025-10-03

### Breaking
- CLI rewritten in TypeScript with a new command palette. Legacy Node-based scripts and `.claude` bootstrap entry points have been removed.
- Genie now manages the `.genie/` workspace instead of `.claude/`; running `npx automagik-genie init` migrates the old layout.
- Requires Node.js 18+ and ships with pnpm-based tooling.

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
