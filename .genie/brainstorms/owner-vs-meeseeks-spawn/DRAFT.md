# Brainstorm: Owner-vs-Meeseeks Spawn Taxonomy

**Slug:** `owner-vs-meeseeks-spawn`
**Date:** 2026-04-26
**Origin:** Power-outage recovery thread (2026-04-25 outage → 2026-04-26 healing). Tonight's bug exposed a missing first-class distinction in the spawn lifecycle.

---

## Problem (one sentence)

The genie spawn code path treats every agent invocation as a "fresh meeseeks" (new session UUID via `--session-id`), even when the target agent is a workspace **owner** with a persistent claude session UUID — destroying conversational context every time a team-lead "hires" a permanent agent.

## The category Felipe drew

| Class | Example | Identity model | Session model | Lifecycle |
|-------|---------|----------------|---------------|-----------|
| **Owner** | `genie` (this conversation), `email`, `felipe`, `genie-pgserve` | Persistent — owns a workspace dir (`/home/genie/workspace/agents/<name>`), `kind='permanent'`, `reports_to IS NULL` | One canonical claude session UUID per identity, persists across reboots and team membership changes | Survives outages, restarts, team transitions |
| **Meeseeks** | `engineer-3`, `design-system-severance-engineer-5`, `council--architect`, `trace-pgserve-18-r4` | Ephemeral — exists only to serve a specific dispatch (wish, work group, council convocation, trace task) | New session UUID per invocation; UUID dies with the task | Spawned for one purpose ("I'm Mr. Meeseeks, look at me!"), reports done, gets archived |

Tonight's category error: the felipe team-lead "hired email" → spawn machinery treated email as a meeseeks → generated `--session-id b26af7ee...` (new) → blank session → 10K-message history orphaned to disk.

## Scope

### IN
- Encode the Owner/Meeseeks distinction as a first-class field on `agents` (likely a new column or repurposed `kind`).
- Wire spawn paths (manual `genie agent spawn`, team-lead child spawn, boot-pass eager-invoke) to consult identity class before deciding `--resume` vs `--session-id`.
- Heal the 13 issues already in the `.5` punch list (consolidated below).
- Ship a `genie agent recover` verb that runs the surgery I did manually for `felipe` and `email` tonight.

### OUT
- Full lifecycle redesign for v5 (e.g., teaching the team-lead to do partial-checkpoint resumes mid-task).
- Migration tooling for legacy multi-UUID owner agents (those whose history fragmented across many session UUIDs).
- TUI redesign for distinguishing owner vs meeseeks visually (separate brainstorm — would belong with severance design system).

## Tonight's evidence

1. **felipe@felipe** — owner. Had session `fa1fac7b…` (10422+ entries). Survived because it was already running pre-outage in tmux:felipe and never got team-spawned again.
2. **email@felipe** — owner. Had session `57635c8b…` (10422 entries / 19MB). Got "hired" to felipe team → team-lead spawned a meeseeks-style fresh `b26af7ee…` → blank. We had to kill the team-lead's spawn and run raw `claude --resume 57635c8b` in `genie:4` to restore.
3. **`dir:email` row got hard-deleted** somewhere between resume and team-spawn — reconciler detected PG↔disk team mismatch and **wiped silently**. Owner data shouldn't be hard-deleteable.
4. **Orphan claude --resume corrupted the live jsonl** by appending `last-prompt`/`custom-title`/`pr-link` state markers — the next `--resume` saw "session ended" markers and opened blank. We restored from `.bak` (10422 lines, mtime 2026-04-25 14:10).
5. **`auto_resume = false` wholesale on 30+ agents** post-outage — likely a watchdog/reconciler that ran "exhausted resume budget" logic on rows it shouldn't have.

## Consolidated `.5` punch list

| # | Item | Source | Severity |
|---|------|--------|----------|
| 1 | `genie agent recover <name>` verb — flips auto_resume + clears stale spawning + resumes | recovery thread | HIGH |
| 2 | `maintain_partitions` self-heals default-partition overflow (DETACH/CREATE/INSERT/DROP) | partition surgery | HIGH |
| 3 | `genie status` surfaces "recoverable session on disk" inline (uses chokepoint UUID even when resume=false) | UX gap | HIGH |
| 4 | Find code path that flipped `auto_resume=false` wholesale post-outage; scope it | data-loss diagnosis | HIGH (needs /trace) |
| 5 | Stale-`spawning` reconciler — TTL on executors stuck in `state='spawning'` for >5min | felipe's stuck executor | MED |
| 6 | Watchdog precondition: detect non-interactive sudo, return `refused` instead of hanging | autoFix robustness | MED |
| 7 | `GENIE_SKIP_PRECONDITIONS=1` → real `--emergency` flag with audit log | clean escape hatch | LOW |
| 8 | `genie doctor` partition_count discrepancy (13 reported vs 10 in pg_inherits) | accuracy | LOW |
| **9** | **Team-lead child-spawn must consult `getResumeSessionId`/`shouldResume` for Owner agents — use `--resume <uuid>` not `--session-id <new>`** | **owner-vs-meeseeks (this brainstorm)** | **CRITICAL** |
| 10 | Reconciler PG↔disk inconsistency must heal, not wipe (hard-deleted `dir:email` silently) | data-loss diagnosis | CRITICAL |
| 11 | jsonl-fallback identity match too strict — relax team match for owner-agent recovery (or version teams) | recovery resilience | HIGH |
| 12 | Orphan `claude --resume` can corrupt jsonl with state markers; `.bak` should be preferred when active jsonl tail looks ended | corruption-prevention | HIGH |
| 13 | Auto-compaction (`.trimmed.jsonl`) interaction with resume — needs documenting / explicit precedence | mystery file | MED |

---

## Open Questions

(Each gets one round of multiple-choice clarification.)

### Q1 — How is Owner vs Meeseeks encoded in the schema?

(awaiting Felipe's pick)

---

## WRS

```
WRS: ████████░░ 80/100
 Problem ✅ | Scope ✅ | Decisions ░ | Risks ✅ | Criteria ✅
```

Decisions axis is the only one stuck — we know everything else, but the schema/code shape that encodes Owner-vs-Meeseeks needs to be picked before we can write DESIGN.md.
