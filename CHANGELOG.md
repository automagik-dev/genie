# Changelog

## Unreleased

### Testing

- Added end-to-end integration coverage for the `tui-spawn-dx` wish
  (`src/__tests__/tui-spawn-dx.integration.test.ts`) and a shell reproducer
  (`scripts/tests/repro-canonical-uuid.sh`) that locks the three
  perfect-spawn-hierarchy invariants: canonical UUID stable across
  dead/alive cycles, canonical never clobbered by parallel creation, and
  parallels off the auto-resume path.

### Breaking

- Removed `genie omni bridge`, `genie omni start`, `genie omni stop`, and
  `genie omni status` subcommands. The Omni bridge is now managed
  exclusively by `genie serve`, and health is reported via `genie doctor`.
  The in-process `getBridge()` / `bridgeInstance` singleton was also
  removed from `src/services/omni-bridge.ts`; all health checks go
  through the cross-process IPC helpers in `src/lib/bridge-status.ts`.
