# Automagik Genie 2.0 Transition Master Plan

## 1. Objectives & Success Criteria
- **Primary Goal**: Deliver the `genie-2.0` architecture as the next official release of `automagik-genie`, preserving key workflows (init/update, agent orchestration) while introducing provider selection and MCP support.
- **Success Indicators**:
  - `npx automagik-genie init` and `npx automagik-genie update` function on the new codebase with parity or deliberate improvements over legacy behavior.
  - Users are guided through Codex/Claude provider selection without manual config edits.
  - Workspaces store version metadata (`.genie/state/version.json`) enabling update checks and migration warnings.
  - CLI startup detects outdated installs, notifies by default, and optionally performs auto-update when users enable it.
  - Migration guide documents the break from `.claude` scaffolding and legacy commands.

## 2. Packaging & Distribution Strategy
1. **Package Identity**
   - Retain npm package name `automagik-genie`.
   - Update `package.json` `bin` map to expose both `automagik-genie` and `genie`, where `automagik-genie` resolves to a published shim in `bin/automagik-genie.js` that forwards into `.genie/cli/dist/genie-cli.js`.
2. **Build Artifacts**
   - Ensure `pnpm run build` produces transpiled CLI + MCP under `.genie/cli/dist` and `.genie/mcp/dist`.
   - Restrict npm `files` to built output, `.genie` content, and the compatibility shims under `bin/`; **intentionally retain** `.genie/mcp/src/**/*` so MCP integrators can reference example handlers (document rationale in release notes or remove from package.json if we decide on compiled-only distribution).
   - Keep `.genie/cli/dist/**/*` committed to git (as upstream does today) until we redesign the packaging flow; document the "build → commit dist" step in the release checklist.
3. **Versioning**
   - If last published version < 1.0.0, release as `1.0.0`; else bump to `2.0.0`.
   - Update CHANGELOG summarizing breaking changes and migration expectations.
4. **Release Pipeline**
   - Prepublish script: `pnpm run build && pnpm run test:all` (fail-fast on regressions).
   - Validate packaging via `npm pack` dry run; inspect tarball for expected layout.
   - Ensure `.genie/cli/dist` was rebuilt and committed in the release branch prior to publish.
5. **Legacy Invocation Compatibility**
   - Ensure the new CLI wrapper understands historical entry points:
     - `npx automagik-genie <cmd>` should internally dispatch to the commander-based router while preserving positional arguments.
     - Maintain published shim files in `bin/` so scripts referencing `./bin/update.js`, `bin/automagik-genie`, or friends continue to resolve.
     - Provide shim executables/modules bundled in the npm package:
       - `bin/automagik-genie.js` → forwards to `.genie/cli/dist/genie-cli.js`.
       - `bin/update.js` → forwards to the new TypeScript `update` implementation.
       - `bin/rollback.js`, `bin/status.js`, `bin/cleanup.js` → invoke CLI-level handlers that warn about upcoming removal yet still surface backups/status information.
       - `bin/statusline.js` → executes the maintained statusline renderer (see §3.2) to preserve editor integrations.

## 3. CLI Command Portfolio
1. **Retained Commands**
   - `init`: reintroduce initialization workflow on top of `.genie` assets.
   - `update`: smart update mechanism for `.genie` structures (agents, config, templates).
   - `rollback`: restores `.genie/backups/<timestamp>` snapshots automatically, mirroring legacy behaviour while logging actions for transparency.
   - `statusline`: renders a one-line status stream powered by the new `.genie` state and provider metadata; still prints a deprecation warning directing users to updated docs.
2. **Transitional Commands (Deprecation Shims)**
   - `status`, `cleanup` emit deprecation notices pointing to updated workflows (e.g., `genie update --status`, documented backup pruning) and exit with success so scripts don’t break.
   - Update migration guide and CLI help with clear “deprecated” labels and links to the new status/update story.
3. **Statusline Compatibility Plan**
   - Port legacy `lib/statusline.js` logic to `.genie/cli/src/statusline/` (TypeScript) so it reads `.genie/state/version.json`, `provider.json`, and git metadata.
   - Ensure `bin/statusline.js` imports the transpiled module and produces identical newline-delimited output for editor integrations.
   - Add tests that compare legacy and new statusline output given the same mocked repo state.
4. **Entry Flow**
   - `genie-cli.ts` handles command parsing (commander). Introduce subcommands `init` and `update` bridging to new implementations (likely in TypeScript under `.genie/cli/src/commands`).
   - Maintain existing agent orchestration commands unaffected.
   - Default invocation (`npx automagik-genie` with no arguments) displays a help summary highlighting `init` as the starting point.
5. **Implementation Details**
   - Port reusable logic from legacy JS to TS modules (smart merge helpers, template processors) or design equivalent for `.genie` content.
   - Use dependency injection/config interfaces to keep CLI modular.
6. **Help & UX Alignment**
   - Update `--help` output to reflect slimmed command list and new options (e.g., `--provider` override).
   - Provide warnings in help text about removed commands with pointer to docs.

## 4. Provider Selection Workflow
1. **First-Run Detection**
   - During `init`, detect missing `.genie/state/version.json` or config to trigger provider selection.
   - Prompt user to choose between Codex (default) and Claude; list requirements (Codex access vs Claude CLI/auth).
2. **Config Persistence**
   - Store provider choice in the workspace under `.genie/state/provider.json` (e.g., `{ provider, decidedAt, source }`).
   - Derive runtime config by overlaying this state onto the generated `.genie/cli/config.yaml`, leaving the installed package immutable.
   - Support non-interactive flow via `--provider codex|claude`, `GENIE_PROVIDER`, or `.genie/state/provider.json` seeds created during migrations.
3. **Runtime Respect**
   - `run`, `resume`, and other commands respect config defaults; allow user overrides via flags.
   - Provide fallback messaging when selected provider dependencies are missing (e.g., Codex CLI not installed, Claude CLI unauthenticated).
4. **Future Extensibility**
   - Structure prompt logic so adding new providers (e.g., OpenAI) is a data entry rather than code rewrite.
5. **Resilience & Overrides**
   - Implement provider health checks per platform: detect Claude CLI on Windows/macOS/Linux, verify Codex CLI availability, and surface proxy/offline guidance when network calls fail.
   - Define detection order (explicit flag → env var → workspace provider.json → interactive prompt) so scripted environments can bypass prompts.
   - Provide escape hatches: per-command `--provider`, `--force-provider`, and a `GENIE_PROVIDER` env var; when the chosen provider is unavailable, prompt to retry with the other provider or exit with actionable instructions.
   - Cache failure reasons in `.genie/state/provider-status.json` (keyed by provider from `provider.json`) to avoid re-running expensive checks on every command while ensuring users can clear the cache (`genie config --reset-provider`).
6. **Migration Defaults**
   - When detecting legacy `.claude` installs, infer provider preference from prior prompts (e.g., stored flags in `.claude/genie-version.json` or backup metadata) and pre-populate `.genie/state/provider.json` so users are not re-prompted unnecessarily.
7. **User-Level Defaults**
   - Support an optional global override (e.g., `~/.genie/config/provider.json`) that seeds new workspaces, giving users who consistently select Claude/Codex a non-interactive path for fresh repos while still allowing per-workspace overrides.

## 5. Version Storage & Update Detection
1. **Version File**
   - Create `.genie/state/version.json` on `init`/`update` containing `{ version, installedAt, lastUpdated, migrationInfo }`.
   - Treat provider choice as authoritative in `.genie/state/provider.json`; `version.json` may reference it for auditing but never overrides it.
2. **Startup Check**
   - On CLI execution, compare local package version to stored version.
   - If mismatch (newer npm release available), run update logic.
3. **Update Policy**
   - Default to "notify-only" so global `npx` executions and frozen workspaces are not mutated unexpectedly.
   - Detect install context (global cache, project dependency, linked workspace) via environment heuristics and lockfiles; only offer an automatic install pathway when the package is a direct dependency with write access.
   - Provide explicit instructions for users to run `npm install -g automagik-genie@latest`, `pnpm dlx`, or equivalent based on detection.
4. **Optional Auto-Update Attempt**
   - Gate actual install commands behind a prompt/flag (`--auto-update` or config) and respect Corepack-managed package managers.
   - If auto-update is skipped or fails, ensure messaging includes manual steps plus a reminder that functionality continues on the current version.
5. **User Messaging & Opt-Out**
   - Display banner: "Automagik Genie update available (current X, latest Y)." Provide upgrade link and note whether auto-update was attempted.
   - Support config/flag to silence checks (`autoUpdate: false`, `--no-update-check`) for air-gapped or policy-restricted environments.
6. **Check Throttling & Overrides**
   - Persist last-check metadata in `.genie/state/update-check.json` including `{ lastCheckedAt, latestSeenVersion, channel }`.
   - Skip remote queries when the timestamp is <24h old unless user passes `--force-update-check` or sets `GENIE_FORCE_UPDATE_CHECK=1`.
   - Reset the timer when users change providers or after successful updates; expose `genie update --reset-check-cache` (or similar) for manual control.

## 6. Legacy User Detection & Migration Messaging
1. **Detection Criteria**
   - Presence of `.claude` directory and `genie-version.json`.
   - Installed package version < 1.0.
   - Absence of `.genie/state/version.json` but presence of `.claude` assets.
2. **CLI Response**
   - When detection triggers, offer two explicit paths:
     - **Guided migration** (default): walk the user through converting `.claude` assets into `.genie` equivalents (Section 7.5) and only proceed once conversion succeeds.
     - **Manual migration**: exit with link to docs plus `--skip-migration` escape hatch for advanced users.
   - Never continue blindly with a fresh `.genie` install when `.claude` data is present.
3. **Migration Guide Deliverables**
   - Document automated conversion behavior alongside manual fallback steps (archive `.claude`, run `genie migrate`, verify agents/hooks).
   - Explain removed commands and new flows, highlighting functional replacements (statusline, backups, update).
   - Provide FAQ for common friction points (statusline integration, backup expectations, provider defaults).

## 7. `init` Command Rebuild
1. **Target Behavior**
   - Generate `.genie/` structure (agents, product docs, config) where absent.
   - Optionally adapt to existing `.genie` installations (merge vs skip).
   - Run provider selection, write version file, highlight next steps.
2. **Implementation Tasks**
   - Translate legacy smart-merge and template utilities to TypeScript modules under `.genie/cli/src/init/`.
   - Update templates referencing `.genie` paths rather than `.claude`.
   - Provide non-destructive merges: detect user modifications (e.g., by comparing to template manifest) and prompt before overwriting.
3. **Post-init Hooks**
   - Display quick-start commands relevant to new CLI.
   - Optionally run analyzer agent or remind user how to start (no auto Claude call by default unless provider=Claude and user opts-in).
4. **Smart Merge Parity Checklist**
   - Backup strategy: snapshot existing `.genie/` (or `.claude/`) to `.genie/backups/<timestamp>` before writes, including CLAUDE.md equivalents and user-created hooks.
   - Diff presentation: show categorized preview (new, changed, skipped) mirroring legacy console UX; offer a `--json` flag for machine parsing.
   - Template variable recovery: port backup analysis to ingest prior CLAUDE.md metadata (build commands, testing frameworks, agent names) and feed the new templates via variable substitution.
   - Hook preservation: detect custom scripts (e.g., `tdd_hook.sh`, user-defined commands) and rewire settings to include them.
   - Idempotency: rerunning `init` should result in no-op when templates match, confirming merge logic respects existing edits.
5. **Legacy Conversion Workflow**
   - Implement `genie migrate` (invoked automatically during init when `.claude` detected) to:
     - Copy `.claude` backups into `.genie/backups` with metadata.
     - Translate `.claude/agents/*.md` into `.genie/agents` equivalents (preserving custom content via templates or tagged sections).
     - Convert `.claude/settings.json` hooks into `.genie/state/hooks.json` and update generated config accordingly.
     - Merge CLAUDE.md insights into `.genie/product` docs and wish records.
   - Provide detailed logging and a post-migration summary for user verification.

## 8. `update` Command Rebuild
1. **Scope**
   - Pull latest agent/template updates from package assets (no remote Git fetch required unless desired).
   - Compare local `.genie` files to packaged templates.
2. **Process Flow**
   - Analysis: compute diff categories (agents, product docs, config, CLI assets).
   - User consent: interactive summary with options to apply per category.
   - Backup: snapshot `.genie/` to `.genie/backups/<timestamp>/` before changes.
   - Execution: apply updates with smart merge or template replacement depending on file type.
   - Validation: sanity check version file, config integrity, optional dry-run.
3. **Options**
   - `--dry-run`, `--agents-only`, `--docs-only`, `--force` similar to legacy but trimmed to relevant categories.
4. **Logging & Output**
   - Provide machine-readable log (JSON) for CI plus human-readable summary.
5. **Parity Checklist**
   - Backup metadata: include manifest describing files touched, enabling manual rollback even without dedicated command.
   - Diff tooling: port legacy `diff`/`merge` helpers to handle partial updates and highlight conflicts, including user-modified sections.
   - Template context: preserve variable-driven sections (e.g., recovered build commands) during updates by merging front matter rather than overwriting entire files.
   - Hook awareness: keep user-added hooks intact while updating packaged examples, surfacing warnings when manual intervention is required.
   - Regression guard: add post-update smoke step that re-runs provider detection and ensures `.genie/state/version.json` reflects the new version.
6. **Automated Rollback Command**
   - Reimplement `genie rollback` to enumerate `.genie/backups`, show diffs, prompt for target, and restore files automatically (with dry-run option).
   - Ensure rollback updates `version.json`, clears update-check caches, and replays provider health checks post-restore.

## 9. Testing & Quality Assurance
1. **Unit Tests**
   - Port or rewrite tests for template merging, version file handling, provider selection, update analysis.
2. **Integration Tests**
   - CLI smoke: `init` + `run plan` + `update` on clean workspace.
   - Migration detection: simulate old `.claude` repo (including backups, custom hooks) and ensure CLI exits with notice or shim behavior.
   - Auto-update simulation: cover notify-only, prompted auto-update, and opt-out paths.
   - Provider failure matrix: mock missing Codex CLI, unauthenticated Claude CLI, offline mode, Windows path quirks.
   - Cross-runtime runs: global `npx`, local dev dependency (`pnpm dlx`, `npm exec`), and CI images with read-only filesystems.
3. **Manual QA**
   - Test across Node versions (>=18) and package managers (npm, pnpm).
   - Validate behavior on macOS/Linux/Windows (esp. auto-update path and file permissions).
   - Exercise rollback substitute workflow using generated backups to ensure recovery guidance is clear.
4. **Continuous Integration**
   - Ensure existing `pnpm run test:all` covers new suites; add GitHub Actions or alternative CI pipeline if missing.

## 10. Documentation Deliverables
1. **README Refresh**
   - Reflect new CLI architecture, provider selection, command list.
2. **Migration Guide**
   - New doc under `docs/migration-guide.md` covering legacy detection, manual steps, removed features.
3. **Command Reference**
   - Document `init` and `update` usage, flags, expected outputs.
4. **Release Notes/CHANGELOG**
   - Outline breaking changes, new capabilities, deprecated commands.
5. **FAQ**
   - Address common questions (auto-update, providers, template customization, backups).
6. **MCP Documentation**
   - Brief guide for running MCP server and using prompts (reuse existing docs where possible).

## 11. Timeline & Milestones (Suggested)
1. **Week 1**
   - Finalize CLI command design (init/update specs, provider flow).
   - Draft migration guide outline.
   - Prototype version file + detection logic.
2. **Week 2**
   - Implement `init` command (basic path, template copy, provider selection, version file).
   - Begin test harness updates.
3. **Week 3**
   - Implement `update` command with analysis + merge.
   - Add auto-update detection/messaging.
   - Complete migration handling logic.
4. **Week 4**
   - Comprehensive testing, cross-platform checks.
   - Documentation completion (README, migration guide, CHANGELOG).
   - Release candidate build (`npm pack` verification).
5. **Release Week**
   - Publish `1.0.0` (or `2.0.0`).
   - Announce via repo release notes.
   - Monitor for regressions/feedback.

## 12. Risk Assessment & Mitigations
| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Auto-update fails or hangs | High | Medium | Provide timeout, skip on failure, print manual instructions |
| Provider dependencies missing | Medium | High | Robust detection + guidance (install Codex CLI, authenticate Claude) |
| Smart merge overwrites user edits | High | Medium | diff preview, prompts, backups before changes |
| Users unaware of removed commands | Medium | Medium | CLI help + migration guide callouts + release notes |
| Version file drift (deleted/edited) | Low | Medium | Regenerate on detection, warn user |
| Multi-package-manager environments | Medium | Medium | Detect lockfile (`package-lock`, `pnpm-lock.yaml`) to choose update command |

## 13. Open Questions
- Should `init` support importing legacy `.claude` agents automatically, or is documentation-only migration sufficient?
- What shape should the optional user-level provider config take (single provider.json vs richer settings)?
- How opinionated should auto-update be (pure warning vs executing package manager commands)?
- Any telemetry/analytics desired for measuring adoption (likely no, but confirm).
- Do we support offline environments for update checks (i.e., skip npm query gracefully)?

## 14. Immediate Next Steps
1. Confirm release version target (1.0.0 vs 2.0.0) with stakeholders.
2. Align on auto-update behavior expectation (silent attempt vs prompt).
3. Start drafting migration guide skeleton referenced in detection messaging.
4. Design CLI interface for `init/update` (options, prompts) and document in `.genie/cli/docs/` for developers.
