# Spawn / Team Resolution

> **Audience:** anyone invoking `genie spawn`, writing tooling that wraps it, or debugging why a worker landed in the wrong team / minted a fresh session UUID.
>
> **Source of truth:** `src/term-commands/agents.ts` (`resolveTeamName` at line 1675, `resolveSpawnIdentity` at line 1783), `src/lib/claude-native-teams.ts` (`findTeamsContainingAgent` at line 195). Line numbers reference `dev` HEAD at time of writing — re-verify if source has moved.

## TL;DR

Each named agent has **one true Claude session UUID** — the **canonical** row. `genie spawn <name>` is the single verb; its outcome is determined by the state of that row:

| Canonical state | Result |
|-----------------|--------|
| row missing | create canonical `<name>` with a fresh UUID |
| row present, pane **dead** | resume canonical (same UUID, same `.jsonl`) |
| row present, pane **alive** | create a **parallel** `<name>-<s4>` where `<s4>` = first 4 hex chars of the parallel's own fresh UUID |

Parallels are semi-ephemeral. Bare `genie spawn <name>` never touches them — they are revived only by their full id (`genie spawn <name>-<s4>`), matching Claude Code's own `--resume <id>` pattern.

---

## The four identities

| Identity | Row id in `agents` | UUID | Auto-resume by bare name? | Lifespan |
|----------|-------------------|------|---------------------------|----------|
| **Canonical agent** | `<name>` | stable, lives forever | **yes** — `genie spawn <name>` when canonical is dead | endless |
| **Parallel** | `<name>-<s4>` (e.g. `simone-a3f7`) | fresh per parallel | **no** — only `genie spawn <name>-<s4>` revives it | semi-ephemeral; persisted, explicit-id resume only |
| **Team** | separate `teams` table | — | — | grouped lifecycle: leader + members, own tmux session, own worktree |
| **Generic spawn** | `<team>-<role>` via `genie agent spawn <role> --team <t>` | fresh | depends on role | ad-hoc workers within a team |

Row ids are **not** team-prefixed for canonical or parallel — it's `simone-a3f7`, not `simone-simone-a3f7`.

## Team-resolution precedence (5 tiers)

`resolveTeamAndResume` in `src/term-commands/agents.ts:1851` resolves the effective team for every spawn by walking this chain top-down. The first tier that returns a non-null value wins. Implemented by `resolveTeamName` at `src/term-commands/agents.ts:1675` (tiers 1–4) plus the on-disk fallback inline in `resolveTeamAndResume` (tier 5).

| Tier | Source | Authority | Notes |
|------|--------|-----------|-------|
| 1 | `options.team` (`--team` flag) | explicit user intent | only tier that flips `teamWasExplicit` |
| 2 | `agent.entry?.team` | PG `agent_templates` row | template-pinned teams |
| 3 | `process.env.GENIE_TEAM` | shell / automation context | |
| 4 | `discoverTeamName()` | full discovery: JSONL `leadSessionId` match → tmux session name | last-authoritative signal |
| 5 | `findTeamsContainingAgent(name)` | on-disk native team config member scan | heuristic; errors on ambiguity |

Tier 5 is the last-resort heuristic: scan `~/.claude/teams/*/config.json`, match exactly one team whose `members` list contains the agent. Ambiguous hits (multiple teams) exit with a clear error.

If every tier yields nothing AND the agent is globally registered, an **auto team-of-one** is materialized downstream by `resolveNativeTeam → ensureNativeTeam` (introduced by PR #1174). The team is named after the agent itself.

### Worked example — the `simone` reproducer

Before the five-tier chain existed, `genie spawn simone` from inside the `genie` tmux session would fall back to `discoverTeamName()` → `"genie"` (from the current tmux session name) and register the worker as `simone@genie`. Every press minted a **fresh** Claude UUID because `findDeadResumable("genie", "simone")` missed the real `simone@simone` row.

After the chain, `simone`'s `agent_templates` row has `team='simone'`. Tier 2 returns `"simone"` before tier 4 ever fires, so:

- `simone` resolves to team `simone` every time, regardless of where the caller is sitting.
- `findDeadResumable("simone", "simone")` hits the canonical row.
- When canonical is dead, it's resumed with its original `claude_session_id` — the one true UUID survives.

## Single-verb state machine

`resolveSpawnIdentity` in `src/term-commands/agents.ts:1783` is the state machine. It decides, based on the current `agents` table, whether `genie spawn <name>` creates canonical, resumes canonical, or creates a parallel.

```
┌─────────────────────────────────────────────────┐
│ genie spawn <name>                              │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
        ┌─────────────────────┐
        │ row `<name>` exists?│
        └─────────┬───────────┘
                  │
          no ─────┴───── yes
          │             │
          ▼             ▼
  ┌──────────┐    ┌───────────────────┐
  │ CREATE   │    │ pane alive?       │
  │ canonical│    └─────┬─────────────┘
  │ id=<name>│          │
  │ fresh UUID│  no ────┴──── yes
  └──────────┘  │            │
                ▼            ▼
         ┌──────────┐  ┌────────────────┐
         │ RESUME   │  │ CREATE parallel│
         │ canonical│  │ id=<name>-<s4> │
         │ same UUID│  │ fresh UUID     │
         └──────────┘  └────────────────┘
```

**Cross-team branch** — if `<name>` already exists in a **different** team than the one being resolved, the state machine must route to parallel (not canonical) because `agents.id` is a PRIMARY KEY (see `migrations/005_pg_state.sql`). Re-canonicalizing in the requested team would PK-violate at insert. `resolveSpawnIdentity` forces parallel regardless of pane liveness in that case.

## Short-id collisions

`pickParallelShortId` in `src/term-commands/agents.ts:1725` computes the parallel row id from the parallel's own fresh UUID:

```ts
slice = uuid.slice(0, 4)            // tier-4 (s4): 65 536 possibilities per name
id    = `${baseName}-${slice}`
```

Uniqueness is checked **globally** (across all teams) because `agents.id` is the PK. On collision, the slice extends one hex char at a time (`s5`, `s6`, …) until unique. Killed parallel rows are **deleted** from `agents` (not tombstoned), so their short-id returns to the available pool.

Collision probability at s4: ≈ 1 / 65 536 per agent name per spawn — self-limiting since the space only fills with **live** parallels.

## CLI invocations

```bash
# Canonical resume (or create if missing)
genie spawn simone

# Parallel (auto-chosen because canonical is alive)
genie spawn simone          # → simone-a3f7  (next press: simone-8c21, etc.)

# Explicit parallel resume by full id
genie spawn simone-a3f7     # revives that specific parallel

# Override the resolved team
genie spawn simone --team some-other-team

# Spawn an ad-hoc role (not a named canonical)
genie agent spawn engineer --team my-feature
```

## Observability

| Signal | Check |
|--------|-------|
| Canonical UUID is stable | `genie db query "SELECT id, claude_session_id FROM agents WHERE id = '<name>'"` — single row, stable UUID across kill/respawn. |
| Parallel ids are well-formed | `genie db query "SELECT id FROM agents WHERE id LIKE '<name>-%'"` — each suffix matches `^[0-9a-f]{4,}$`. |
| Team binding is correct | `genie db query "SELECT id, team FROM agents WHERE id = '<name>'"` — template-pinned team wins. |
| Resolver audit | `~/.genie/logs/scheduler.log` for `recovery_*` events on daemon restart; no `--team is required` errors under normal spawns. |

## Related wishes (history)

- **`tui-spawn-dx`** (PR #1172) — introduced the single-verb state-gated spawn, the `<s4>` parallel suffix, and the TUI surfaces for "Spawn into…" / "Spawn here…" / "New team…".
- **`perfect-spawn-hierarchy`** (PR #1133) + **`fix-ghost-approval-p0`** (PR #1134) — established that `leadSessionId` must be a real Claude UUID, never a synthetic placeholder like `"pending"` or `"genie-<team>"`. The tier-2 template lookup added by `tui-spawn-dx` is an authoritative PG read, not a synthetic fallback — it does not violate this principle.

## TUI is a skin, not an alternate control plane

Every TUI action (Enter on an agent, context-menu "Spawn into…", "Spawn here…", "New team…") shows the exact `genie …` CLI command it is about to run in a preview line before Enter executes it. This comes from `buildSpawnInvocation(intent) → { cli, argv }` in `src/lib/spawn-invocation.ts` — one helper produces both the preview string and the executed argv, so render and execution can never drift.

If something worked from the CLI, it works from the TUI. If something's broken in the TUI, `Ctrl+C` out and run the printed command directly.
