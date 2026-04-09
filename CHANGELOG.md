# Changelog

## Unreleased

### Breaking

- Removed `genie omni bridge`, `genie omni start`, `genie omni stop`, and
  `genie omni status` subcommands. The Omni bridge is now managed
  exclusively by `genie serve`, and health is reported via `genie doctor`.
  The in-process `getBridge()` / `bridgeInstance` singleton was also
  removed from `src/services/omni-bridge.ts`; all health checks go
  through the cross-process IPC helpers in `src/lib/bridge-status.ts`.
