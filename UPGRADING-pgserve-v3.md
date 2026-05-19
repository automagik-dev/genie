---
title: "Upgrading to pgserve v3 (autopg)"
description: "How existing and new users move onto autopg/pgserve v3. What is automatic, what is preserved, and the one manual step when you have data to carry."
---

# Upgrading to pgserve v3 (autopg)

`pgserve` v3 ships as **autopg** — a router-less, single-postmaster
distribution (the old daemon, accept-hook router, and SO_PEERCRED
fingerprint routing are gone). Genie now natively detects autopg v3 and
owns its own database on it. Everything below is verified end-to-end.

## What new genie does on the host it finds

| You currently run | New genie behavior | Action needed |
|---|---|---|
| **pgserve v1.x** (port 8432, no admin.json) | falls back to the legacy TCP/headless path; `_genie_migrations` and your data stay where they are | none — keep running, upgrade pgserve later when you choose |
| **pgserve v2.x** (admin.json + accept-hook router) | stays on `database = postgres`; the router routes you to your existing `app_genie_<fp>` DB; migrations are idempotent | none — your data is preserved |
| **autopg / pgserve v3** (writes `<socketDir>/runtime.json`) | auto-detects v3, auto-creates a dedicated `genie` database, runs migrations into it | none — first boot provisions everything |

Detection is **strictly** keyed on `<socketDir>/runtime.json` (the v3
marker). v1/v2 hosts are never retargeted, so an upgraded genie on an
old pgserve never moves your data and never blocks you.

The dedicated v3 database name is `genie`; override with
`GENIE_DB_NAME=<name>` if you need something different (e.g. multi-tenant
hosts). `GENIE_ROLE_CUTOVER=0` continues to work; native-DB provisioning
is decoupled from the role-cutover kill-switch.

## Moving data from old pgserve → autopg v3

This is the only step that isn't automatic. New genie on autopg v3
creates a **fresh empty `genie` DB**; your existing teams / agents /
tasks / sessions live in the *old* pgserve's `app_genie_<fp>` DB and
will not migrate themselves.

If you don't need the history, just install autopg v3 — you're done.

If you do, dump-then-restore around the upgrade:

```bash
# 1. On the old pgserve / old genie — snapshot to .genie/snapshot.sql.gz
genie db backup

# 2. Install autopg v3 (replaces pgserve)
curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh | bash

# 3. On the new autopg v3 — let new genie provision its `genie` DB
genie db migrate    # creates + populates the v3 `genie` database

# 4. Restore your snapshot into the freshly-provisioned `genie` DB
genie db restore    # defaults to .genie/snapshot.sql.gz
```

The snapshot is portable across pgserve versions because `genie db
backup` is a logical (`pg_dump`) dump, not a physical replication of the
old data directory.

## Verifying after the upgrade

```bash
genie ls                                                # lists your agents
genie db status                                         # table counts, version
psql -h "$XDG_RUNTIME_DIR/pgserve" -U postgres -d genie # explore the new DB
```

## Rolling back

The old pgserve install (its data dir, admin.json, role state) is
untouched by autopg v3's installer. If you decide to roll back, point
genie's environment at the old socket / port again and `genie db
restore` from your snapshot into the old `app_genie_<fp>` DB. The
embedded-migrations change in new genie is forward-compatible: it does
not modify migrations that have already been applied.

## Migrating in-place from a v1-shape DB on autopg v3

If you have a v1-era genie database that genie's first connect detected
(`Legacy v1 data detected (N tasks, N wishes, N teams, N sessions). Run
genie db migrate-v1 to import.`), run the in-place migration:

```bash
# Stop the supervisor while migrate-v1 reshapes the DB
pm2 stop Genie

# On autopg v3 you MUST pass --no-archive — the archive step writes
# to pgserve-v2's `pgserve_meta` table which v3 removed (no router).
# Without --no-archive the migration aborts with
#   PostgresError: relation "pgserve_meta" does not exist
# after the source DB has already been renamed; recover by renaming
# `genie_archive_<date>` back to `genie` and re-running.
genie db migrate-v1 --yes --no-archive --include-sessions 99999

pm2 start Genie
```

`--include-sessions 99999` keeps every session (default 30 days). Audit
events and session content are skipped by default — pass
`--include-audit <days>` / `--include-content` if you need them.

## Recovering in-flight agents after the upgrade

**The data layer (PG) is durable — the work layer (tmux panes +
Claude conversation JSONLs) is not.** Restoring the DB brings back agent
records / teams / session metadata; it does NOT auto-reattach the live
panes you were working in. Use this runbook to recover the actual work.

### 1. Confirm the PG layer is healthy

```bash
pm2 list                   # autopg-server should be `online` with restarts=0
genie db status            # database=genie, all migrations applied
```

### 2. Restart the genie supervisor

```bash
pm2 restart Genie
```

`pm2 logs Genie` should show: `pgserve ready`, `Scheduler started`,
`[omni-bridge] PG reachable`, `Executor read endpoint ready`.

### 3. Triage your agents

```bash
genie status --json | jq '.agents[] | {agentId, decision: .decision}'
```

Each agent falls into one of three buckets — the action differs:

| `decision.reason` | Meaning | Action |
|---|---|---|
| `ok` (`decision.resume == true`) | Tracked Claude session, `rehydrate=eager` | `genie resume <agentId>` |
| `auto_resume_disabled` | Ephemeral team worker whose pane died and lost its anchor | `genie agent recover` first |
| `no_session_id` | Sub-agent that never had a session attached | Respawn only — conversation cannot be reattached |

### 4. Resume eligible agents (the `ok` bucket)

`genie resume` requires being inside a tmux session. From a plain shell:

```bash
tmux -L genie-resume new-session -d -s rev
tmux -L genie-resume send-keys -t rev "genie resume <full-agentId>" Enter
# When done with the throwaway socket:
tmux -L genie-resume kill-server
```

Use the **full** id (`dir:genie/foo`, full UUID) — short role names are
ambiguous when multiple agents share a name. For `dir:`-prefixed agents
whose team is `-`, pass the team explicitly:

```bash
GENIE_TEAM=<team-name> genie resume dir:<agent>
```

The pane lands on the canonical `/tmp/tmux-1000/genie` socket; verify:

```bash
tmux -L genie list-panes -a -F '#{pane_id} #{pane_dead} #{pane_pid} #{window_name}'
tmux -L genie capture-pane -t %<id> -p   # see live Claude output
```

### 5. Recover ephemeral team workers (`auto_resume_disabled`)

```bash
GENIE_TEAM=<team> genie agent recover <worker-uuid> --yes
```

This flips `auto_resume` back on and tries to anchor a session UUID by
scanning Claude's JSONL store. It often fails with `no recoverable
session UUID` — not because the data is gone, but because the JSONL
header's `customName` is null so genie's name-based heuristic has
nothing to match on. Step 6 is the fallback.

### 6. Direct `claude --resume` fallback (`no_session_id` or step-5 miss)

The Claude session is still on disk under
`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Find it:

```bash
# Identify the worker's cwd from the event log
genie events list --since 30d --limit 2000 --json \
  | jq -r '.[] | select(.event_type == "worker.spawn.ok")
             | .details | "\(.agent_role) | \(.cwd)"'

# List candidates in that cwd's encoded form (slashes → dashes)
ls -lt ~/.claude/projects/<encoded-cwd>/*.jsonl

# Match by content
grep -l '<role-name>' ~/.claude/projects/<encoded-cwd>/*.jsonl
jq -r 'select(.type == "user" and .message.role == "user")
        | .message.content | tostring[0:200]' <file>.jsonl | head -1

# Resume the conversation directly (bypasses genie's worker tracker)
cd <agent-cwd>
claude --resume <session-uuid>
```

The conversation continues with full history intact. You won't get it
back into `genie ls` without DB surgery, but the content is preserved.

### 7. Known cosmetic glitch

After a mass resume, the reconciler may flip several agents to `error`
with reason `stale_spawn_dead_pane` even though the panes are alive and
running Claude. This is a registry/PID mismatch, not a real death —
a second `genie resume <id>` (from the TUI or CLI) heals the registry.

### What each step buys you

| Step | What's restored |
|---|---|
| 2 — restart Genie | Scheduler, event-router, omni-bridge, hook socket |
| 4 — `genie resume` per agent | All permanent agents with attached sessions, alive in tmux |
| 5 — `genie agent recover` | Ephemeral workers whose JSONLs match by name |
| 6 — `claude --resume` direct | Workers whose JSONLs exist but don't match genie's heuristic — recoverable, outside the registry |

**Validated on a real "very crowded" instance** (31 agents, 132 teams,
2725 sessions): 20 agents fell in the `ok` bucket and `genie resume`
successfully reattached the test agent to its live Claude pane via the
on-disk JSONL; 12 fell in `no_session_id` and need step 6 if their
conversation matters.

The key insight: **the conversation data is durable on the filesystem.**
Even when genie's worker registry can't pair an agent UUID back to its
Claude session, the JSONL is right there in `~/.claude/projects/` — any
conversation can be resumed manually.
