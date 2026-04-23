# Changelog

## Unreleased

### Changed

- **Agent config has moved from `AGENTS.md` frontmatter to a dedicated
  `agents/<name>/agent.yaml` file.** Files on disk are now the source of
  truth for every runtime-consumed field (`team`, `model`, `provider`,
  `promptMode`, `description`, `color`, `roles`, `permissions`, `sdk`,
  `disallowedTools`, `omniScopes`, `hooks`). `AGENTS.md` holds pure prompt
  content from line 1 — no YAML fence. Wish
  `dir-sync-frontmatter-refresh`.
- **`genie dir sync` is now unconditionally read-write.** The old
  `Unchanged:` skip was eliminated; every reached agent's DB row is
  re-parsed and upserted on every run. Output summary is now
  `Synced: N agent(s), M removed.` (never `Unchanged:`).
- **`genie dir edit` writes `agent.yaml` first**, then triggers a single-
  agent sync to propagate into PG. No more direct `agent_templates`
  writes from the edit handler.
- **`genie dir add` scaffolds both files** — `agent.yaml` from the CLI
  flags + a frontmatter-less `AGENTS.md` body template — and triggers
  sync. Existing agents are unaffected.
- **`genie doctor` gains an `Agent Config` section** that warns when an
  `AGENTS.md` contains `---` frontmatter while `agent.yaml` is also
  present (drift sync silently ignores). Warning-only, never fails the
  doctor run.

### Migration (automatic, zero-touch)

- First `genie dir sync` after upgrade detects any agent with frontmatter
  in `AGENTS.md` but no `agent.yaml`, calls `migrateAgentToYaml`, and
  writes:
  - `agents/<name>/agent.yaml` — every frontmatter field validated via
    `AgentConfigSchema`. DB-only fields (`skill`, `extraArgs`) stay in
    the PG row.
  - `agents/<name>/AGENTS.md.bak` — byte-identical copy of the original
    `AGENTS.md`.
  - `agents/<name>/AGENTS.md` — post-frontmatter body only.
- Idempotent: a second sync on an already-migrated agent leaves files
  untouched and skips the migration step entirely.

### Downgrade safety

- `AGENTS.md.bak` preserves pre-migration frontmatter byte-for-byte. To
  revert to an older genie CLI: copy `AGENTS.md.bak` back over
  `AGENTS.md`, delete `agent.yaml`, downgrade. No DB schema changes —
  the DB rows survive either shape intact.
- `.bak` files are now git-ignored (`agents/*/AGENTS.md.bak`) so they
  never leak into source control.

### Testing

- Added end-to-end integration coverage for the `tui-spawn-dx` wish
  (`src/__tests__/tui-spawn-dx.integration.test.ts`) and a shell reproducer
  (`scripts/tests/repro-canonical-uuid.sh`) that locks the three
  perfect-spawn-hierarchy invariants: canonical UUID stable across
  dead/alive cycles, canonical never clobbered by parallel creation, and
  parallels off the auto-resume path.
- Added end-to-end integration coverage for the
  `dir-sync-frontmatter-refresh` wish
  (`src/__tests__/agent-yaml-migration.integration.test.ts`, 7 cases)
  and a shell reproducer (`scripts/tests/repro-yaml-config.sh`) that
  locks the "files are source of truth" invariant: edit `agent.yaml`,
  run `genie dir sync`, DB reflects the edit in the next breath.

### Breaking

- Removed `genie omni bridge`, `genie omni start`, `genie omni stop`, and
  `genie omni status` subcommands. The Omni bridge is now managed
  exclusively by `genie serve`, and health is reported via `genie doctor`.
  The in-process `getBridge()` / `bridgeInstance` singleton was also
  removed from `src/services/omni-bridge.ts`; all health checks go
  through the cross-process IPC helpers in `src/lib/bridge-status.ts`.
