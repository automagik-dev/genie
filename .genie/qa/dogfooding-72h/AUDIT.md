# 72-Hour Fix Audit — 2026-05-04 → 2026-05-07

**Installed binary:** `4.260507.1` (`/home/genie/.bun/bin/genie`)
**Source HEAD:** `4.260506.4` on `fix/genie-1674-team-create-fk-and-ls-id`
**Window:** 31 PRs merged, ~9 issues touching the fix surface.

## Summary

| Cluster | PRs | Risk | Live-verified? |
|---|---|---|---|
| A. Spawn / send / agent-resolution (#1674 family) | #1663, #1676 | **HIGH** — touches dispatch core | ❌ A1/A2/A3 in PR #1676 unchecked |
| B. Serve / pgserve transport | #1644, #1662, #1667, #1672, #1675 | HIGH — daemon supervision | Partial (boot probe, pm2) |
| C. TUI startup / shutdown | #1657, #1659, #1673 | MED — observable in TUI | Snapshot tests only |
| D. Task / chat FK validation | #1646, #1649, #1655, #1656 | MED — error-path UX | Unit tests only |
| E. Plugin sync (skills regression) | #1671 | HIGH — silent skill loss | Reproduction-only |
| F. Update flow unification | #1665 | HIGH — affects every install | Diagnostics v2 added, full path unverified |
| G. Security (hook redaction + SHA pin) | #1664 | MED | CI green |
| H. Cognitive-complexity refactors | #1645, #1647, #1648, #1651-1654 | LOW — behavior-preserving | Test contract updates only |
| I. Docs / wishes | #1658, #1660, #1661, #1668, #1670 | NONE | n/a |

## Confirmed-fixed (verifiable)

- **#1674 Bug 1** (team-create FK violation on `--wish`) — fixed in #1676 commit `ee32b26c`. Defers leader-id write past `handleWorkerSpawn`, plus defensive `LEADER_ID_RE` guard in `team-manager.ts`.
- **#1674 Bug 2a** (`genie send --to <role>@<team>` cross-team addressing) — fixed in #1676 commit `95a5495f`, `parseAtSyntax()` in `msg.ts`.
- **#1674 Bug 2b** (`genie ls --json` missing UUID) — fixed in #1676; `LsEntry.id` surfaced via `agent-directory.ts` SQL.
- **#1674 Bug 5** (trace skill hallucinated `resolveAgentId`) — skill text fix only, low risk.
- **#1663** spawn UUID rename regression — preserves role name as `workerId` in non-UUID guard.
- **#1671** plugin-sync orphaned-marker skill loss — prevents `.orphaned_at` from propagating to active cache.
- **#1672** serve boot probe alignment with `resolvePgserveTransport`.

## Deferred / open (NOT fixed in 72h window)

Critical operational gaps explicitly carried forward:

1. **#1674 Bug 2c** — `--bridge` flag dead from CLI. Design ambiguous (remove vs reorder resolver). Coordinate with task #181.
2. **#1674 Bug 2d** — `GENIE_TEAM=X --to team-lead` falls back to teamName. Functional accident; needs surface change in wish-175.
3. **#1674 Bug 3** — TUI left menu doesn't show fix-spawned agents. Nav.tsx (45 KB) dedup/filter logic.
4. **#1674 Bug 4** — Spawned worker's 88-message queue blocked protocol (Claude Code internals).
5. **#1674 Bug 6** — Working-tree race during stash dance. Single observation, not reliably reproducible.
6. **#1669 P0** — `genie agent list` shows ONE row per role across ALL teams (most damaging UX bug from issue narrative). Possibly addressed by #1676's `id` surfacing, but unverified.
7. **#1669 P0** — `genie send` quietly misroutes when role name collides — partially addressed by `@team` syntax (Bug 2a) but only when caller knows to use it; ambiguous-bare-role still routes silently.
8. **#1669 P1** — `genie team create --wish --no-spawn` doesn't stage the wish. Decoupling needed.
9. **#1669 P1** — Manual `genie spawn --team <busted-team>` doesn't always register an agent row. Inconsistent post-FK-error recovery.
10. **#1669 P2** — `genie inbox list <role-name>` resolution opaque + wrong (same root as #1620).
11. **#1669 P2** — `genie agent status` advertised in error text but doesn't exist.
12. **#1669 P2** — `genie team disband --yes` flag mismatch (CLI convention).
13. **#1620** — `genie agent stop <name>` matches by role-name across all teams (footgun, killed unrelated team's workers). **CRITICAL UX bug** — same root as #1669 list/send collisions.
14. **#1666** — `genie update` mutates marketplace clone (dirty-clone workaround).
15. **#1631** — PR-B follow-up: un-skip + UUID-rewrite fixture-bound tests deferred by PR #1629.
16. **#1621** — Turn-sandbox permission enforcement: 6 bugs (3 HIGH, 2 MED, 1 upstream).

## Live-state signal (right now)

`genie events errors --since 30m` shows **9 stale-spawn-dead-pane / dead-pane-zombie patterns in the last 14 minutes**. The post-spawn cleanup path is leaking pane state into the events stream even on the version that's supposed to have fixed phantom dispatch (#1599, #1600). Worth re-trace before claiming spawn lifecycle is healthy.

## Verdict

**NOT shippable as "all-fixed"**. The 72-hour campaign closed the loudest crash-class bugs (FK violation, cross-team addressing, skills regression, pgserve transport) but **left the entire bare-role-name resolution family open** (issues #1620, #1669-P0×2, #1669-P2). That family is the dominant operator footgun on this server — `genie agent list/stop/send/inbox` all share the same broken-resolution root that #1676 only patched in *one* surface (`send` with `@team` syntax).
