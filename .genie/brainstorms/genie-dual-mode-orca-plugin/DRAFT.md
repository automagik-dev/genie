# Genie dual-mode Orca plugin — Option A

Felipe selected Option A: Genie retains its standalone CLI, skills, and local board/task behaviour, while an
explicit Orca mode moves lifecycle orchestration to a Genie-owned Orca plugin that invokes only a closed,
schema-built set of official `orca orchestration` CLI commands. The current `v6/corpo-leve` prototype is
evidence only: its typed-host-API dependency, Linear requirement, and stale model assumptions are rejected.

## Locked answers

- **Problem:** Genie currently owns a writable SQLite lifecycle and MCP bridge, whereas users running in Orca
  need one authoritative Orca Run/Task/Dispatch lifecycle without shell or terminal injection risk.
- **Scope:** Add a global `orchestration.mode` of `standalone | orca` (default `standalone`), a hard
  write barrier in Orca mode, a packaged Orca plugin and marketplace, MCP retirement, and lifecycle-safe
  install/update/rollback/uninstall/mode switches. No Orca fork, host-private API, local lifecycle mirror,
  terminal injection, or upstream dependency.
- **Decisions:** The plugin constructs argument vectors from per-command schemas, appends `--json` itself,
  spawns no shell, and accepts only official `orca orchestration` commands in its source allowlist. Mutators
  require bounded receipts plus authoritative read-back; any unavailable executable, timeout, overflow,
  non-zero exit, malformed JSON, or read-back mismatch fails closed.
- **Risks:** Orca's public plugin capability declaration does not currently expose a process-exec permission;
  a real local Orca CLI contract test is mandatory, and incompatibility is a typed unsupported-environment
  failure rather than an alternate transport. Broad MCP removal and installer ownership require separate,
  independently reviewable PRs.
- **Criteria:** Standalone board/task commands remain unchanged; Orca mode opens no writable Genie DB and
  never writes `roadmap.json`; all plugin operations are demonstrably structured argv-only; updates and
  reversals preserve user-owned configuration and never delete Orca lifecycle records.

WRS: ██████████ 100/100 — Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅

The authoritative design is crystallized in `DESIGN.md`; it awaits an independent review before a WISH is
created.
