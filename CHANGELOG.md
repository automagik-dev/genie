# Changelog

## Unreleased

### Breaking — pgserve v2 (Unix socket, auto-fingerprint, no credentials)

- **Switched to pgserve v2 daemon model.** Genie now connects to pgserve
  via the well-known Unix control socket at
  `$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432` (fallback `/tmp/pgserve/...`)
  instead of TCP loopback. The pgserve v2 daemon authenticates the peer
  via `SO_PEERCRED`, derives a stable fingerprint from the nearest
  ancestor `package.json` (`sha256(realpath + name + uid)[:12]`), and
  routes the connection to that fingerprint's own
  `app_<sanitized-name>_<12hex>` database. As a consumer, genie no
  longer specifies a port, user, or password.
- **`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` env vars removed.** The only
  variable still set when shelling out to `pg_dump` / `psql` is `PGHOST`,
  pointing at the v2 socket directory. Auth happens at the kernel layer.
- **`pgserve.persist: true` declared in `package.json`.** Genie holds
  long-lived state (wishes, agents, events). The persist flag opts the
  database out of pgserve v2's default 24h TTL reaper, so a restarted
  daemon doesn't drop the wishes table after a quiet weekend.
- **Visible fingerprint banner on boot.** First successful connection in
  a process prints `[pgserve] connected to <db>` to stderr so
  developers can see the routed database name (e.g.
  `app_genie_a1b2c3d4e5f6`). Set `GENIE_NO_BANNER=1` to suppress.
- **Migration note for self-hosted deployments.** pgserve v2 expects an
  externally-supervised daemon (PM2 / systemd snippets in pgserve
  README). The legacy `genie serve` headless spawn path remains as a
  TCP fallback for environments that haven't adopted the daemon yet —
  set `GENIE_PG_FORCE_TCP=1` to opt back into TCP loopback.
- **`pgserve@2.0.0` consumed from npm.** The temporary local file pin
  (`file:../pgserve`) has been swapped for the published `^2.0.0`
  range now that pgserve v2 is on the registry. Genie tracks the
  daemon's released artifact rather than a sibling working copy.

### Breaking — design system

- **Unified design system on the Severance Lumon-MDR palette.** All color
  tokens now live in a single workspace package, `packages/genie-tokens/`,
  consumed by the TUI (`src/tui/theme.ts`), the desktop app
  (`packages/genie-app/lib/theme.ts`), and tmux (via the generated
  `scripts/tmux/.generated.theme.conf`). The old purple/green/red look is
  replaced by petrol surfaces, mint accent, and amber/crimson reserved for
  true alarms. See `docs/design-system.md`.
- **Old palette names deleted — no aliases.** `palette.purple`,
  `palette.violet`, `palette.cyan`, and `palette.emerald` are gone.
  Replacements:
  - `purple` / `violet` → `accent` (`#7fc8a9`) or `accentBright`
    (`#9eddc1`) for selection text.
  - `emerald` → `accent` for normal/OK states; `success` is the same value
    aliased for intent.
  - `cyan` → `info` (`#5a8ca8`) where it signaled attention.
  Internal callers are migrated. External consumers must switch to the new
  semantic tokens (`accent`, `accentBright`, `success`, `info`, `danger`,
  `attention`).
- **`SystemStats` thresholds recalibrated** from `>50/>80` to `>70/>90`. A
  normal multitasked dev box no longer sits permanently in amber; color is
  reserved for genuine attention.
- **Tmux theme is generated, not hand-maintained.** Run
  `bash scripts/tmux/generate-theme.sh` after any palette change; CI fails
  on a non-empty diff. This eliminates the off-by-one hue drift that
  produced `#7c3aed` (TUI) vs. `#7b2ff7` (tmux).

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
