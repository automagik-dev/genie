# **Historical Reference** – Legacy `.claude` Implementation

> This document captures the pre-2.0 Node/JavaScript stack that generated `.claude` assets. For the current TypeScript-based `.genie` architecture and migration strategy, see `docs/genie-2.0-transition-plan.md` (and the upcoming `.genie` architecture guide).

# Automagik Genie Main Branch Feature Map

This document inventories the features and behaviors shipped on `main` with an emphasis on the command line experience and the supporting subsystems that keep the CLI operational.

## 1. CLI Entry Points (`bin/automagik-genie`, `bin/update.js`, `bin/version.js`)
- Primary binary is published as `npx automagik-genie` and dispatches commands based on the first argument (defaulting to `init`).
- Built-in flags: `--help` / `-h` for usage, `--version` / `-v` for the packaged version, and `statusline` for a direct statusline render.
- Command matrix handled in `bin/automagik-genie`:
  - `init`: runs the initialization workflow (smart merge by default, legacy mode behind `--legacy`).
  - `statusline`: invokes `lib/statusline.js` directly as a command helper.
  - `update`, `rollback`, `status`, `cleanup`: delegated to the update CLI (`bin/update.js`).
  - Unknown commands trigger a help suggestion and non-zero exit.
- Update CLI (`bin/update.js`) exposes subcommands with rich options via `yargs`:
  - `update`: options for `--dry-run`, `--agents-only`, `--hooks-only`, `--force`, `--backup-dir`, and `--project-path`.
  - `rollback`: optional backup id targeting and `--list` mode for enumerating snapshots.
  - `status`: supports `--check-remote` and `--detailed` reporting.
  - `cleanup`: manages retention with `--max-age`, `--keep-count`, and `--cache`.
- `bin/version.js` (invoked via scripts) prints the current package version for release tooling.

## 2. Initialization Flow (`lib/init.js`)
- Presents interactive prompts (via Node readline) for:
  - Opt-in statusline configuration inside Claude Code settings.
  - Claude Opus model selection to improve reasoning.
  - Permission mode (`--dangerously-skip-permissions`) before auto-running the analyzer wish.
- Two high-level modes:
  - Smart merge (default): merges new assets into existing `.claude` content, preserving user customizations via granular file analysis.
  - Legacy mode: destructive replacement guarded by backups and explicit messaging.
- Backup-aware bootstrap:
  - `analyzeBackupClaude` scrapes `.claude.backup*` directories for build commands, tooling hints, agent names, and preserved sections that feed new templates.
  - Recovered metadata is injected into template variables for CLAUDE.md and logging.
- Template expansion:
  - `generateProjectVariables` assembles substitution variables (project name, git origin, timestamps, recovered data).
  - `copyTemplateDirectory` and `processTemplateFile` populate `.claude` assets from `templates/` with variable interpolation.
  - Fallback path synthesizes CLAUDE.md content if the template is missing or unreadable.
- Genie asset generation:
  - Writes `.claude/agents/*` definitions, `.claude/hooks/examples/*`, `.claude/commands/wish.md`, and `.claude/settings.json` tailored to the project.
  - Detects developer-provided hooks (for example `tdd_hook.sh`) and threads them into settings.
- Version tracking:
  - `createGenieVersion` produces `.claude/genie-version.json` with install timestamps and package version, reused by the updater.
- Post-install automation:
  - Validates Claude CLI availability (`lib/claude-cli-check.js`) and authentication before proceeding.
  - Optionally wires Claude Code’s statusline to the local `genie-statusline.js`, wrapping existing commands when needed.
  - Auto-spawns `claude` with an initial `/wish` analysis command using the chosen options.

## 3. Update and Maintenance System (`lib/update/*`)
- `UpdateEngine` orchestrates multi-phase updates: analysis → consent → backup → execution → validation → summary.
- Analysis phase compares local `.claude` assets against the latest GitHub release templates (`TemplateManager.fetchLatestRelease`, `downloadTemplate`, `compareWithTemplate`).
- Consent phase presents categorized changes (agents, hooks, core) and honors dry run or force flags via `UpdateUI` utilities.
- Backup phase (`BackupManager`) snapshots the current `.claude` directory to timestamped archives, ensuring rollback safety.
- Execution phase leverages `MergeEngine` and `DiffEngine` for smart merges, conflict detection, and file-specific actions (add, update, skip).
- Validation phase (`ValidationEngine` via `lib/update/validation.js`) flags warnings or critical issues to halt the process when necessary.
- Auxiliary commands:
  - `rollback`: enumerates and restores backups; supports force mode.
  - `status`: reports installed vs latest versions, change summaries, remote availability, and optional deep dives.
  - `cleanup`: trims aged backups and optionally clears the cached release templates.

## 4. Statusline System (`lib/statusline.js`)
- Node script that renders a single-line status string consumed by Claude Code.
- Features include:
  - Time-of-day aware action phrases across several day-part buckets plus weekend overrides.
  - Git awareness (current branch, dirty state, ahead/behind, last commit age) via `child_process` calls.
  - Model detection heuristics based on cached data and environment variables.
  - Version reporting sourced from `.claude/genie-version.json`.
  - Graceful fallbacks when git or version info is unavailable.
- `configureStatusline` in `bin/automagik-genie` can wrap pre-existing statusline commands so Genie output coexists with custom scripts.

## 5. Template and Content Assets
- `templates/CLAUDE.md.template` contains the base documentation for a newly initialized project with placeholders for recovered backup data.
- `.claude/agents` directory (populated during init) defines specialized agent roles such as analyzer, planner, designer, coder, fixer, clone, agent-creator, agent-enhancer, testing variants, and documentation support.
- `.claude/commands/wish.md` provides an encyclopedic command reference for users, reinforcing expected wish patterns and best practices.
- `.claude/hooks/examples` ships sample automation hooks (pre-commit, pre-push, post-merge) that users can opt into.
- `.claude/settings.json` encapsulates platform-specific execution settings, optional statusline linkage, and hook registration.

## 6. Supporting Scripts and Tooling
- `scripts/` holds operational helpers:
  - `bump-version.js` uses `lib/utils/version-manager.js` to enforce semantic version sequences tied to git tags.
  - `clean.js` removes generated artifacts for a fresh start.
  - `release.js` coordinates publishing tasks (version bump plus git workflow).
  - `test-genie-workflow.js` orchestrates an end-to-end smoke run of the Genie's init/update flows.
- `lib/utils/cli-messages.js` and related helpers keep user-facing output consistent.
- Dependency footprint (from `package.json`): axios, colors, fs-extra, inquirer, semver, tar, yargs, plus jest for tests.

## 7. Testing Footprint (`tests/`)
- Jest suite exercises key behaviors:
  - Initialization prompts, smart merge scenarios, backup ingestion, and regression cases.
  - Update engine flow including diffing, backup generation, and validation logic.
  - Statusline rendering nuances and git edge cases.
  - File operation utilities and MCP configuration wiring.
  - Smoke and integration tests that approximate user journeys across init → wish setup → statusline.

## 8. Notable Operational Considerations
- CLI assumes Claude CLI (`claude`) is installed and authenticated; init aborts early with actionable instructions when checks fail.
- Network access is required for update checks and template downloads (GitHub release API and raw content).
- `.claude/genie-version.json` is the contract between init and update flows; if missing, update regenerates it before continuing.
- Smart merge relies on differentiating Genie-managed files from user customizations; rely on the analysis output before overwriting.
- Backups live alongside `.claude` in timestamped directories (`.claude.backup-yyyy-mm-ddThh-mm-ss-SSSZ`) and are integral to rollback and merge diffing.

## 9. Current User-Facing Experience Summary
- Install path: `npx automagik-genie init` → guided prompts → `.claude` structure materializes → analyzer wish auto-fired.
- Maintenance path: `npx automagik-genie update` with optional dry runs, complemented by `rollback`, `status`, and `cleanup` for lifecycle management.
- Continuous feedback via expressive console messaging (emoji-rich in implementation) keeps the tone consistent with the Genie brand.
