# Changelog

## [Unreleased]
**Current Version:** !`node -p "require('./package.json').version"`
**Generated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`

All notable changes to this project will be documented in this file.

---

## [2.4.0-rc.33] - 2025-10-19

No changelog entries (packaging-only RC).

## [2.4.0-rc.32] - 2025-10-19

No changelog entries (packaging-only RC).

## [2.4.0-rc.31] - 2025-10-19

No changelog entries (packaging-only RC).

## [2.4.0-rc.29] - 2025-10-18

No changelog entries (packaging-only RC).

## [2.4.0-rc.28] - 2025-10-18

No changelog entries (packaging-only RC).

## [2.4.0-rc.25] - 2025-10-18

No changelog entries (packaging-only RC).

## [2.4.0-rc.24] - 2025-10-18

No changelog entries (packaging-only RC).

## [2.4.0-rc.23] - 2025-10-18

No changelog entries (packaging-only RC).

## [2.4.0-rc.22] - 2025-10-18

### Features
- implement Groups F-G of self-updating ecosystem (79c295e)
### Fixes
- update identity-smoke test for V2 session format (ed9b371)
- clean up cross-references and improve validator (ee07ea8)
### Other
- fix(tests): correct identity-smoke.sh for V2 session format (71964ae)
- fix(mcp): background polling V2 format + RC17 prep (50f752e)
- docs(learn): add sequential questioning protocol teaching (7f68986)
- feat(skills): add sequential-questioning protocol (e25717b)

## [2.4.0-rc.10] - 2025-10-17

### Fixed
- **CRITICAL**: Background agent launch failure - Changed `detach: true` to `detach: false` in config to fix executor spawn
- **CRITICAL**: Workspace root resolution - MCP server now searches upward for `.genie/` directory instead of using `process.cwd()`
- **CRITICAL**: Absolute path resolution - `paths.baseDir` now uses `path.resolve()` for cross-process compatibility
- Executor spawn now explicitly uses workspace root for `cwd` option

### Context
- Root cause: MCP server running from `/tmp/test-genie` (Claude Code temp dir) caused all spawned processes to inherit wrong cwd
- Impact: Background agents timed out with `executorPid=null`, tried to open `.genie/package.json` from wrong directory
- Solution: Three-layer fix ensuring workspace root correctly propagates from MCP → CLI → executor spawn

### Files Changed
- `.genie/cli/src/lib/config.ts:164` - Convert baseDir to absolute path
- `.genie/cli/src/commands/run.ts:194` - Override spawn cwd with baseDir
- `.genie/mcp/src/server.ts:31-44` - Search upward for workspace root

---

## [2.3.7] - 2025-10-16

### Added
- Multi-template system: `genie init [code|create]` for specialized workflows
- Token-efficient output: 99.0-99.6% reduction for AI-to-AI orchestration (16k → 122-168 tokens)
- Agent cognitive architecture: Clear separation of agents/modes/workflows directories

### Changed
- Reorganized agent directory structure: `core/` → `agents/` + `workflows/`
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
