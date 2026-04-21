# Detector Runbook — Self-Healing Observability B1

**Audience:** operators tailing `genie events stream-follow --kind='rot.*'` (the live-stream verb that owns runtime event filtering — see PR #1244 for the `*`-glob predicate) who need a mid-incident reference for what a detector event means, why it fires, when it lies, and what to do next.

**Scope:** one section per rot pattern (1–8) shipped under the wish `genie-self-healing-observability-b1-detectors`. Every detector listed here is **read-only** — it observes PG / tmux / filesystem state and emits a `rot.detected` (or `rot.team-ls-drift.detected` for Pattern 2) event. None of them mutate genie state. Remediation is still a human decision in B1; graduation to auto-fix happens per-detector in B2 once fire-rate and false-positive-rate evidence accumulates.

**Relationship to code:** each pattern lives in a dedicated source file under `src/detectors/`. The scheduler wiring is `src/serve/detector-scheduler.ts`; the plugin API is `src/detectors/index.ts`; the shared event substrate is PR #1213 (`genie_runtime_events`).

**Shipped vs planned:** at time of seeding (2026-04-20), only Pattern 2 (`rot.team-ls-drift`) is merged to `dev` (PR #1235, commit `ff27f5a9`). Patterns 1, 4, 5 are staged in PR #1237 and Patterns 3, 6, 7, 8 are staged in PR #1236 — detector IDs cited below match the code in those branches and will remain stable on merge. Sections for pending detectors note the tracking PR inline.

**Use this file live.** Every triage action below is a concrete `genie` verb or SQL snippet. If the action box reads "Triage not yet established" it is because no confirmed playbook exists yet — in that case, open an OSS issue citing the event payload when you hit it.

## Table of Contents

- [Pattern 1 — rot.backfill-no-worktree](#pattern-1--rotbackfill-no-worktree)
- [Pattern 2 — rot.team-ls-drift](#pattern-2--rotteam-ls-drift)
- [Pattern 3 — rot.anchor-orphan](#pattern-3--rotanchor-orphan)
- [Pattern 4 — rot.duplicate-agents](#pattern-4--rotduplicate-agents)
- [Pattern 5 — rot.zombie-team-lead](#pattern-5--rotzombie-team-lead)
- [Pattern 6 — rot.subagent-cascade](#pattern-6--rotsubagent-cascade)
- [Pattern 7 — rot.dispatch-silent-drop](#pattern-7--rotdispatch-silent-drop)
- [Pattern 8 — rot.session-reuse-ghost](#pattern-8--rotsession-reuse-ghost)

---

## Pattern 1 — rot.backfill-no-worktree

**Detector ID:** `rot.backfill-no-worktree` (risk class: low)
**Source:** `src/detectors/pattern-1-backfill-no-worktree.ts`
**Ship status:** pending merge of PR #1237 (branch `genie-self-healing-b1-group3a-lowrisk-detectors`).

### Description

A row exists in the `teams` table with `status = 'in_progress'`, but the `worktree_path` recorded on that row no longer points at a directory on disk. `genie team ls` shows the team as alive and actionable, but any attempt to cd into the worktree, open a PR from it, or resume work against it fails because the files vanished. The detector fires one `rot.detected` event per tick naming the first offending team and carrying `total_missing` in `observed_state_json` so the operator knows whether they are looking at a single accident or a broader cleanup job.

Concretely: Felipe has seen this after manual `rm -rf ~/workspace/…` sweeps, after disk-full truncations that nuked worktrees without touching PG, and after backfill migrations that populated `teams` from JSON snapshots without validating filesystem presence.

### Known root cause

Two production paths write to `teams.worktree_path` but nothing reconciles it against the filesystem. The detector's SQL (`SELECT name, status, worktree_path FROM teams WHERE status = 'in_progress' LIMIT 1000`) plus a `node:fs.statSync` check is the only thing that currently tells the truth. The root-cause surface is split:

- Operator deletions of worktree directories — nothing writes an `agent.archived` / `team.disbanded` event in that path.
- Historical backfills from JSON into PG (see `src/lib/team-manager.ts` team-discovery code around `listTeams` and the JSON-to-PG migration) that never stat-checked the paths before inserting.
- Incomplete `disbandTeam` runs that got killed mid-transaction — `pruneStaleWorktrees` in `src/lib/team-manager.ts:755` is supposed to reconcile but only runs as a side effect of a successful `disband`.

### Known false-positive sources

- **Race window with `disbandTeam`:** if the detector tick lands between `rm -rf <worktree>` and the PG row update to `status = 'archived'`, the detector sees a missing worktree on an in-progress row. The window is small but non-zero.
- **Transient network-mount unavailability** when worktrees live on NFS / sshfs — `statSync` returns `false` for the directory even though the team is healthy once the mount recovers.
- **Worktree intentionally moved** by the operator (e.g., `git worktree move`) without an accompanying `UPDATE teams SET worktree_path = …`. This is a real drift but not a team-lifecycle bug — treat it as data-repair, not as a team-disband candidate.

### Triage action

```bash
# 1. Inspect the offender called out in the event payload.
genie team show <team_name>

# 2. Confirm the worktree really is missing (event evidence could be stale by a tick).
ls -la "<worktree_path_from_observed_state_json>"

# 3. If you confirm the worktree is gone and the team is not recoverable, archive cleanly.
genie team disband <team_name>

# 4. If instead the worktree was moved, fix the PG row in place.
psql -c "UPDATE teams SET worktree_path = '<new_path>' WHERE name = '<team_name>';"

# 5. Verify no other offenders share the same root cause.
psql -c "SELECT name, worktree_path FROM teams WHERE status = 'in_progress' ORDER BY updated_at DESC LIMIT 20;"
```

If the detector fires more than 3× in an hour for distinct teams, suspect a batch filesystem event (disk-full, bulk operator cleanup) and investigate the common ancestor directory before draining team-by-team.

---

## Pattern 2 — rot.team-ls-drift

**Detector ID:** `rot.team-ls-drift` (risk class: medium)
**Source:** `src/detectors/pattern-2-team-ls-drift.ts`
**Ship status:** **merged** in PR #1235 (`ff27f5a9` on `dev`).

### Description

`genie team ls` and `genie team disband <name>` read two different sources and routinely disagree. Divergence shows up in three flavours, reported in `observed_state_json.divergence_kind`:

- `missing_in_disband` — PG has a row that `ls` displays but no `~/.claude/teams/<sanitized>/` directory exists, so `disband` no-ops or errors.
- `missing_in_ls` — `~/.claude/teams/<dir>/` exists but no non-archived PG row matches, so `ls` hides the team while Claude Code IPC still uses the on-disk state.
- `status_mismatch` — a PG row is visible in `ls` but its `worktree_path` is gone on disk; the next `disband` will silently prune via `pruneStaleWorktrees` with no visible log.

The event payload carries both snapshots (capped at 200 entries each) plus up to 100 divergent entries with `team_id`, `kind`, and a human-readable `reason` — that is the triage payload you read first.

Felipe's live-observed example: ghost teams showing as `in_progress` in `team ls` but "team not found" from `team disband`.

### Known root cause

Two independent code paths disagree on what a team **is**:

- `genie team ls` → `src/term-commands/team.ts:printTeams` → `src/lib/team-manager.ts:listTeams` → `SELECT … FROM teams WHERE status != 'archived'` (PG-only source).
- `genie team disband <name>` → `src/lib/team-manager.ts:disbandTeam` (line 666) which reads PG **and** deletes `~/.claude/teams/<sanitizeTeamName(name)>/` **and** runs `pruneStaleWorktrees` (line 755) which silently DELETEs PG rows whose `worktree_path` no longer exists.

`sanitizeTeamName` in `src/lib/claude-native-teams.ts` converts non-alphanumeric runs to `-` and lowercases, so the two canonical keys are not 1:1. A team named `My Wish 42` lands as `My Wish 42` in PG and `my-wish-42/` on disk — any naming collision in sanitization (`foo bar` and `foo-bar` both collapse to `foo-bar`) produces permanent drift.

Beyond the two-path split, upstream issue **#1234** (`(wish_file, repo_path)` partition root cause) and Felipe's minimum-viable fix **#1241** (warn on partition + throw on 0-row UPDATE) are the follow-ups that would eliminate the silent-prune trap. OSS issue **#1214** (`genie done` silent no-op) also feeds in: a `done` that silently drops leaves stale PG rows that Pattern 2 then surfaces.

### Known false-positive sources

- **Mid-disband tick:** the detector reads PG and filesystem as separate queries; landing between `deleteNativeTeam` and the PG `UPDATE … status='archived'` produces a transient `missing_in_disband`.
- **Case-insensitive filesystem collision:** macOS / default Windows filesystems lowercase lookups, so `sanitizeTeamName` collisions may be on-disk invisible — the detector sees a single `.claude/teams/` dir mapping to two distinct PG rows, over-reports.
- **Manual `.claude/teams/` scaffolds:** operators sometimes hand-create a dir to poke at Claude Code settings; that produces a `missing_in_ls` divergence that is an intentional scratch directory, not a ghost team.

### Triage action

```bash
# 1. Re-read both sources yourself — detector evidence is one tick old.
genie team ls --json | jq '.[] | {name, status}'
ls -1 ~/.claude/teams/

# 2. If `missing_in_disband` (PG row but no directory): the team is a PG-only ghost.
#    Confirm it has no active agents, then disband with the detector-cited raw name.
genie agent ls --team '<team_id>' --json
genie team disband '<team_id>'

# 3. If `missing_in_ls` (directory but no PG row): the directory is orphaned state.
#    Identify safely before deleting — the dir may be pre-merge state worth preserving.
ls -la ~/.claude/teams/<sanitized_dir>/
rm -rf ~/.claude/teams/<sanitized_dir>/   # only after manual review

# 4. If `status_mismatch` (PG row present, worktree gone on disk): see Pattern 1 triage.
#    Disband will auto-prune on next run — decide whether to let it or to fix the path.

# 5. If the event fires repeatedly on the same team within one hour, suspect the
#    sanitization collision case and file against #1234 / #1241.
```

Cross-reference the `divergent_count` field in the payload: a single divergence is an incident; a flood (`divergent_count > 5` per tick) points at a migration or a batch-operator action as the common cause.

---

## Pattern 3 — rot.anchor-orphan

**Detector ID:** `rot.anchor-orphan` (risk class: high)
**Source:** `src/detectors/pattern-3-anchor-orphan.ts`
**Ship status:** pending merge of PR #1236 (branch `genie-self-healing-b1-group3c-highrisk-detectors`).

### Description

An `agents` row claims the executor is alive (`spawning` or `running`) but the tmux pane is dead **and** the worktree-backed transcript is missing on disk. `genie ls` shows the agent as `working`, the operator clicks through to attach, and there is nothing to attach to — a ghost anchor. The detector emits one `rot.detected` event per tick naming the first offender and carrying up to 32 `all_agent_ids` / `all_custom_names` / `all_last_seen_at` entries so the operator sees the full cascade scope without a follow-up query.

### Known root cause

Three independent facts must agree to claim "this agent is alive": (a) the PG `agents` row state, (b) the tmux pane existence via `isPaneAlive`, and (c) the executor's `worktree` directory on disk. Root causes include tmux daemon crashes (pane vanishes, PG row unchanged), `kill -9` on a claude-code process (executor state never transitions to `error`), and resume-attempt paths that update executor state without re-probing tmux. The lookup logic is `src/lib/agent-registry.ts:listAgents` + `src/lib/executor-registry.ts:getCurrentExecutor` + `src/lib/tmux.ts:isPaneAlive`.

OSS issue **#1214** (`genie done` silent no-op) contributes: a `done` that drops before persisting leaves the agent row in an alive state even though the worker is gone.

### Known false-positive sources

- **Tmux-daemon restart transient:** during a graceful `tmux kill-server` + restart, every `isPaneAlive` probe returns false even though workers would be fine if we re-attached. The detector's `isPaneAliveSafe` wrapper treats tmux-unreachable as "pane present" to bias away from false fires, but a partial tmux outage can still slip through.
- **Worktree moved, not deleted:** if the executor's worktree was renamed by an operator, `existsSync(executor.worktree)` is false while the pane is actually alive — detector still suppresses the fire because `tmuxPresent` dominates the check, but the state object is noisy.
- **Race with spawn:** during the first ~500ms of a fresh spawn, the executor row can exist before the pane publishes; the detector's `isProbeableExecutorState` gate on `spawning | running` plus the `tmuxPresent` safe-fail default keeps this quiet in practice.

### Triage action

```bash
# 1. Confirm the orphan status by re-running the three probes.
genie agent show '<agent_id>'
tmux has-session -t '<expected_session_id>' && echo "alive" || echo "dead"
ls -la '<worktree_from_executor_row>'   # if executor JSON is visible via agent show

# 2. If all three confirm orphan, archive the agent cleanly.
genie agent archive '<agent_id>'

# 3. If the pane is actually alive and you're seeing a tmux-probe flake, wait for
#    the next scheduler tick (≤60s) before acting. Persistent fires across 3+ ticks
#    means the orphan is real.

# 4. If cascade_count > 3, the root cause is likely a tmux-daemon event; check:
tmux list-sessions | wc -l
journalctl --user -u tmux.service --since '10m ago'
```

Triage not yet established for the worktree-moved edge case — open an OSS issue referencing the detector event + the rename history if you hit it.

---

## Pattern 4 — rot.duplicate-agents

**Detector ID:** `rot.duplicate-agents` (risk class: low)
**Source:** `src/detectors/pattern-4-duplicate-agents.ts`
**Ship status:** pending merge of PR #1237.

### Description

Two or more non-archived rows in `agents` share the same `(custom_name, team)` pair when both fields are non-null. Migration 012 added `idx_agents_custom_name_team` as a partial unique index going forward (`WHERE custom_name IS NOT NULL AND team IS NOT NULL`), but pre-constraint residue survived — the index only blocks NEW violators. This detector surfaces the backlog.

The event payload carries `dup_count`, an ordered `agent_ids` array (by `created_at` ascending so the oldest row is first), and `total_offending_pairs` so the operator sees both the local scope (this pair) and global scope (how many distinct duplicate pairs exist).

### Known root cause

Two pathways produced the residue:

- Pre-migration-012 spawns with identical `(custom_name, team)` that landed in PG before the unique constraint existed.
- Non-archived orphans from OSS issue **#1215** — when `genie team disband` failed to archive member agents, those agents kept their non-null `(custom_name, team)` and would then collide with the next team that reused the name (feeding Pattern 8 as well). PR #1231 (merged) addressed the core `fix(teams): archive agent rows on team disband/archive` path, but pre-fix residue stays until surfaced and reconciled.

### Known false-positive sources

- **Mid-migration window:** while a bulk rename / re-namespace script is running, transient duplicates are expected. The detector will re-quiet as soon as the script finishes rewriting rows.
- **Fixture leakage from test runs:** if an integration test wrote `(engineer, test-team)` rows and forgot to clean up, the detector fires against the residue even though it is not operator-visible drift.
- **Re-spawn retry with identical name:** a fast retry that races the `agents` INSERT vs the `archive` of the previous row can briefly surface a duplicate before the archive commit lands.

### Triage action

```bash
# 1. Pull the full duplicate group — the event only names the first pair.
psql -c "SELECT id, custom_name, team, created_at, archived_at
         FROM agents
         WHERE custom_name = '<custom_name>' AND team = '<team>'
         ORDER BY created_at;"

# 2. Decide which row is authoritative (usually the newest active one). Archive
#    the others with the standard agent-archive verb.
genie agent archive '<older_agent_id>'

# 3. If `total_offending_pairs > 5`, batch-review the full set before reconciling
#    one at a time — the residue likely points at a single historical incident.
psql -c "SELECT custom_name, team, COUNT(*), array_agg(id)
         FROM agents
         WHERE custom_name IS NOT NULL AND team IS NOT NULL
         GROUP BY custom_name, team
         HAVING COUNT(*) > 1
         ORDER BY COUNT(*) DESC;"

# 4. Cross-reference with Pattern 8 — if the duplicate pair spans an archived team,
#    Pattern 8's session-reuse-ghost will fire next tick on the same entity.
```

---

## Pattern 5 — rot.zombie-team-lead

**Detector ID:** `rot.zombie-team-lead` (risk class: low)
**Source:** `src/detectors/pattern-5-zombie-team-lead.ts`
**Ship status:** pending merge of PR #1237.

### Description

An agent with `role = 'team-lead'` is in a live state (`spawning`, `working`, `idle`, `permission`, or `question`) but the team it leads has not emitted any `wish.dispatch`, `mailbox.delivery`, or `agent.lifecycle` event in the last 5 minutes. The lead is polling `genie status` against a team that has nothing to show.

Felipe's live-observed version: a team-lead spawned hours ago is still visible in `genie ls` with state `idle`, but its team's dispatch queue has been empty since spawn and no worker ever picked up a task. The event payload carries `team_name`, `lead_agent_id`, `lead_state`, ISO `last_activity_at` (or null), computed `minutes_idle`, and `total_zombie_teams`.

### Known root cause

Team-lead spawn is asymmetric with worker spawn: a lead can boot and enter `idle` successfully even when the team has zero workers (e.g., a `genie team create` followed by no `genie spawn <role>`). The lead then keeps itself alive via heartbeat, but nothing generates activity events. The detector's SQL joins `agents` against a `MAX(created_at)` roll-up over `genie_runtime_events` filtered by `subject IN (ACTIVITY_SUBJECTS)` and a `team_id` match, with `LEFT JOIN` so a team that has **never** emitted lands as `last_activity_ms = NULL` and is conservatively counted as a zombie.

### Known false-positive sources

- **Just-spawned lead (<5 min):** the 5-minute idleness threshold (configurable via `idleMinutes`) means a fresh lead can fire the detector in its first tick if it spawned more than 5 minutes ago but hasn't had any worker activity yet.
- **Intentional parking:** operators sometimes spawn a lead, step away to draft the wish, and come back. Between creation and first dispatch the lead looks like a zombie even though the human is actively working in another window.
- **Activity-subject drift:** if a new progress-signalling event type is added to the registry but not added to `ACTIVITY_SUBJECTS` in the detector, a genuinely busy team fires as a zombie. The test fixture guards this by exercising each subject, but new subjects arriving post-merge need the allowlist updated.

### Triage action

```bash
# 1. Inspect the lead — is it genuinely stuck, or waiting on input?
genie agent show '<lead_agent_id>'

# 2. Check the team's recent event stream directly.
genie events timeline '<team_name>' | head -50

# 3. If the lead is stuck on a permission or question state, unblock it.
genie send '<your message>' --to '<lead_agent_id>'

# 4. If the team was created and never populated with workers, either populate or disband.
genie spawn engineer --team '<team_name>'
# or
genie team disband '<team_name>'

# 5. For bulk zombie cleanup when total_zombie_teams > 5, list all candidates first:
psql -c "SELECT id, team FROM agents
         WHERE role = 'team-lead'
           AND state IN ('spawning','working','idle','permission','question');"
```

---

## Pattern 6 — rot.subagent-cascade

**Detector ID:** `rot.subagent-cascade` (risk class: high)
**Source:** `src/detectors/pattern-6-subagent-cascade.ts`
**Ship status:** pending merge of PR #1236.

### Description

A parent agent is in `error` state and at least two of its direct children (agents whose `reports_to` points at the parent) are also in `error`, with no `agent.lifecycle` recovery event observed for the parent since it first entered error. Isolated parent-error is routine (resume-attempt machinery handles it); a cascade where the parent's failure propagated to its children is the distinct failure mode that needs a human. The detector fires the instant the second child flips.

Event payload: `parent_id`, ordered `child_ids` (capped at 32), `parent_errored_at`, `children_errored_at` array, `last_parent_recovery_at` (always null at fire-time, included for payload shape consistency), `cascade_count`, and `child_count`.

### Known root cause

Root cause is pattern-specific — not a single bug. Common producers observed by Felipe include: a parent agent that crashes mid-dispatch and emits an `error` event without a recovery; children that were mid-task and hit their own error chains because the parent's output was malformed or truncated; and resume-attempt loops that re-spawn the parent but never wake the children. The detector reads `executors.state` per candidate via `getCurrentExecutor` and cross-references the latest `genie_runtime_events` row with `kind = 'state'` and `data->>'new_state' IN ('running', 'idle', 'done')` after the parent's error timestamp.

No OSS issue tracks the cascade mode directly as of 2026-04-18 — Pattern 6 surfaced during wish execution and has no historical ticket. File one from the detector payload when the first real cascade lands.

### Known false-positive sources

- **Dangling `reports_to` FK:** if a child was archived between the `listAgents` snapshot and the per-child executor probe, the detector drops it (see `known = erroredChildren.filter((c) => byId.has(c.id))`) but transient races can still briefly show a cascade that self-clears on the next tick.
- **Parent recovered mid-query:** if the recovery event lands between the child-state probe and the parent-recovery probe, the detector fires on a state that is about to clear itself. The `last_parent_recovery_at` guard narrows this window but does not close it.
- **Intentional fan-out error:** some workflows intentionally error out N children to test downstream alerting; the detector cannot distinguish drills from incidents in V1.

### Triage action

```bash
# 1. Read the cascade fingerprint from the event payload, then confirm.
genie agent show '<parent_id>'
for cid in <child_ids>; do genie agent show "$cid"; done

# 2. Pull the parent's recent state timeline to see whether it tried to recover.
psql -c "SELECT created_at, data->>'new_state' AS state
         FROM genie_runtime_events
         WHERE subject = '<parent_id>' AND kind = 'state'
         ORDER BY created_at DESC LIMIT 20;"

# 3. If the parent is genuinely dead, archive all cascade members cleanly.
genie agent archive '<parent_id>'
for cid in <child_ids>; do genie agent archive "$cid"; done

# 4. If the parent is recoverable, resume-attempt first, then reassess children.
genie spawn --resume '<parent_id>'
# Wait one full scheduler cycle (60s) before acting on children — the cascade may clear.

# 5. Capture the payload for an OSS issue. Pattern 6 has no tracking ticket yet.
```

Triage not yet established for the "intentional fan-out drill" false-positive case — document it in the new OSS issue when filing.

---

## Pattern 7 — rot.dispatch-silent-drop

**Detector ID:** `rot.dispatch-silent-drop` (risk class: high)
**Source:** `src/detectors/pattern-7-dispatch-silent-drop.ts`
**Ship status:** pending merge of PR #1236.

### Description

A broadcast event (`subject = 'genie.msg.broadcast'`) was posted to a team chat at least 60 seconds ago but at tick time at least one team member is still in `running` state and zero `genie.user.<agent>.prompt` events for that member have landed between the broadcast and now. The operator `@team`ed a message and it silently failed to wake an agent. The detector intentionally holds fire for 60s after the broadcast to avoid racing fresh messages, and fires only when `actual_prompt_count === 0` exactly (not "below expected") so slow-but-alive agents do not trigger.

Event payload: `team`, `broadcast_id` (string form of the `genie_runtime_events.id`), `broadcast_at`, `idle_member_ids` (capped at 32), `expected_prompt_count`, `actual_prompt_count` (always 0 at fire-time), and `drop_count`.

### Known root cause

OSS issue **#1218** (`genie broadcast` does not fire UserPromptSubmit) is the direct upstream bug: the broadcast path posts to the team-chat table but does not always produce the `UserPromptSubmit` hook that wakes claude-code workers. When that hook misfires, the agent's idle heartbeat continues and no prompt is ever delivered. The detector reads this at the PG level — it observes both the broadcast row **and** the absence of the prompt row, so it catches the drop regardless of the exact failure mode in the hook layer.

OSS issue **#1214** (`genie done` silent no-op) is an adjacent problem: a `done` that silently drops leaves the agent in a state that looks idle-with-no-activity and compounds the false-negative surface for `@team` broadcasts.

### Known false-positive sources

- **Agent shut down between broadcast and tick:** if the agent was alive when the broadcast posted but exited cleanly before the 60s cooldown, the detector sees "no prompt row" and fires. `listAgents({ team })` is run at tick time, not broadcast time, so an agent that archived itself is filtered out; this handles the clean-exit case. Uncleanly-crashed agents still fire.
- **Broadcast to a team that was empty:** if the operator broadcast to a team with zero running members, `idleMembers.length === 0` and the detector correctly stays quiet — but if a member was added *after* the broadcast, they have no prompt row and would fire falsely. The current code reads `listAgents({ team })` at tick time without filtering by join time, so post-broadcast joiners can trigger.
- **Prompt-subject naming drift:** the detector computes `genie.user.${customName ?? role ?? id}.prompt`. If the subject naming convention changes in the emit pipeline without updating the detector, every broadcast fires falsely.

### Triage action

```bash
# 1. Confirm the broadcast actually persisted and the hook really didn't fire.
psql -c "SELECT id, team, text, created_at FROM genie_runtime_events
         WHERE id = '<broadcast_id>';"

# 2. For each idle member, check whether they received anything since broadcast_at.
for m in <idle_member_ids>; do
  name=$(genie agent show "$m" --json | jq -r '.customName // .role')
  psql -c "SELECT id, created_at FROM genie_runtime_events
           WHERE subject = 'genie.user.'${name}'.prompt'
             AND created_at > '<broadcast_at>'
           LIMIT 1;"
done

# 3. If confirmed silent-drop, re-send directly to the specific agent(s) instead
#    of using broadcast — send targets the prompt hook directly and is reliable.
for m in <idle_member_ids>; do genie send '<your message>' --to "$m"; done

# 4. File / comment on OSS issue #1218 with the event payload if this is a new
#    manifestation class (different agent role, different team shape, etc).

# 5. If drop_count > 2 in one tick, the broadcast path may be fully down — escalate.
```

---

## Pattern 8 — rot.session-reuse-ghost

**Detector ID:** `rot.session-reuse-ghost` (risk class: high)
**Source:** `src/detectors/pattern-8-session-reuse-ghost.ts`
**Ship status:** pending merge of PR #1236.

### Description

A fresh agent spawns with `custom_name = X` in team `A` while another agent with `custom_name = X` previously existed in team `B` whose `teams.status = 'archived'`. The new agent's first user prompt (its topic seed) has Jaccard similarity below 0.25 against the archived agent's first user/assistant transcript turn when both are normalised (lowercased, punctuation stripped, tokenised, capped at the first 8 tokens).

Felipe's live-observed example: spawning `engineer` in team `wish-42` where claude-code re-attaches to a disbanded `wish-17`'s `engineer` transcript — the worker starts executing `wish-17`'s goals against `wish-42`'s branch. OSS issue **#1215** tracks the substrate bug (agent rows not archived on disband); Pattern 8 surfaces the user-visible manifestation when disband archive-propagation lags or is skipped.

Event payload: `new_agent_id`, `new_team`, `new_topic_seed` (first 256 chars), `conflicting_archived_agent_id`, `conflicting_archived_team`, `conflicting_archived_last_transcript_preview` (first 256 chars), `jaccard_similarity` (the numeric score, so operators can judge the heuristic's confidence), and `ghost_count`.

### Known root cause

Two substrate conditions conspire:

- OSS issue **#1215** — on `genie team disband`, member agent rows were historically not archived, leaving `(custom_name, archived_team)` tuples live in PG. PR #1231 fixed the going-forward path, but residue survives.
- Claude Code's session attach logic resolves `custom_name` against historical transcripts without scoping to the current team, so a fresh spawn can bind to a disbanded peer's transcript if the name matches.

Pattern 8's detection relies on a deliberately cheap heuristic (first-8-tokens Jaccard < 0.25) that the detector's own docstring calls out as fuzzy. The reasons for 8 tokens and the 0.25 threshold are documented inline in `src/detectors/pattern-8-session-reuse-ghost.ts`. The runbook **must** gate any remediation on a manual operator review of the seed and preview payload — never act on the Jaccard score alone.

### Known false-positive sources

- **Generic topic seeds:** prompts that start "continue where we left off" or "pick up the thread" are deliberately generic and will fail the Jaccard check against any specific archived topic. The detector will fire even when the operator intentionally wants session reuse.
- **Cross-topic noun overlap:** if the fresh prompt shares a subject noun with an unrelated old topic ("fix router" in both), Jaccard can drop below the threshold and misfire. The detector docstring marks this as a DONE_WITH_CONCERNS case.
- **Threshold calibration drift:** 0.25 was chosen against two hand-curated cases in the wish handoff. As more production data arrives, the threshold may need re-tuning — until that happens, treat the detector as a "review the evidence" signal, not an automated judgement.

### Triage action

```bash
# 1. Read the payload — compare new_topic_seed to conflicting_archived_last_transcript_preview
#    by eye. The detector's Jaccard score is a hint, not a verdict.

# 2. Confirm the archived peer is still in the agents table (residue evidence).
psql -c "SELECT id, custom_name, team, state, created_at, archived_at
         FROM agents
         WHERE id = '<conflicting_archived_agent_id>';"

# 3. Confirm the team is archived and cannot legitimately be revived.
psql -c "SELECT name, status FROM teams WHERE name = '<conflicting_archived_team>';"

# 4. If the detector is right (real session-reuse ghost), archive the stale agent row
#    to prevent further collisions — this is the mitigation path #1215 enables.
genie agent archive '<conflicting_archived_agent_id>'

# 5. If the fresh agent already attached to the wrong transcript, stop it before it
#    mutates worktree state, then respawn with a distinct custom_name.
genie agent archive '<new_agent_id>'
genie spawn '<role>' --team '<new_team>' --name '<unique_name>'

# 6. If ghost_count > 3 in one tick, the team-disband archive path may be failing
#    broadly — cross-reference Pattern 4 (duplicate-agents) payload for shared root cause.
```

Cross-reference with Pattern 4: duplicate-agents fires when the archive propagation lags but the teams are still active; session-reuse-ghost fires when the archive lag coincides with an archived team. Same underlying substrate gap, two surfaces.

---

## Pattern 9 — rot.team-unpushed-orphaned-worktree

**Detector ID:** `rot.team-unpushed-orphaned-worktree` (risk class: high)
**Source:** `src/detectors/pattern-9-team-unpushed-orphaned-worktree.ts`
**Ship status:** pending merge of the Pattern 9 PR (wish `team-unpushed-orphaned-worktree`, tracks issue #1250).

### Description

A non-terminal team (`teams.status NOT IN ('done','blocked','archived')`) has no executor in `running`/`spawning` state within the last `idleMinutes` (default 10), AND its worktree has commits ahead of `origin/<base_branch>` (`git rev-list --count` > 0). The autonomous team finished local work but the leader died before `git push` / PR creation — the branch sits orphaned on disk, no existing detector fires, and `genie wish status` looks nominal.

Felipe's live-observed version (issue #1250): a `team create --wish <slug>` team executes, engineers commit wip, the lead exits cleanly after marking the wish complete — but the branch is never pushed. Hours later the operator notices the PR never opened. The event payload carries `team_name`, `team_status`, `worktree_path`, `base_branch`, `branch_ahead_count`, ISO `last_commit_at`, ISO `last_executor_active_at`, `minutes_since_active`, `threshold_minutes`, `lead_agent_id`, `lead_state`, and `total_stalled_teams`.

### Known root cause

Autonomous team-lead spawn and worker spawn both emit `team.create` / `agent.lifecycle` events but the leader-completion contract is currently implicit — the lead relies on `idleExitMs` to self-terminate after the last worker goes idle, and there is no `team.pushed` / `team.pr_opened` event to assert against. If the lead exits before the final push step (crash, OOM, tmux pane kill, operator Ctrl-C), the branch is left in the worktree with commits ahead of origin and no downstream signal fires.

The detector's SQL reads `teams` plus a `MAX(created_at)` roll-up over `agents.last_activity_at` filtered by non-terminal executor states, then in-memory: filters rows whose most recent executor activity is older than `idleMinutes`, caps the probed batch at `maxTeamsPerTick` (default 32), and for each survivor runs `git -C <worktree_path> rev-list --count origin/<base_branch>..HEAD` plus `git log -1 --format=%ct HEAD`. Any probe failure (missing worktree, missing base_branch, subprocess timeout at `gitTimeoutMs` / default 3s, non-zero exit) degrades to `ok:false` and the row is silently skipped — it stays eligible for the next tick. Fires are rate-limited by the shared `firedKey` budget to once per hour per detector.

### Known false-positive sources

- **Just-committed, not-yet-pushed (<10 min):** the 10-minute idleness threshold means a team that just committed but hasn't pushed yet (e.g. operator is drafting a commit message in another window) can fire if the executor state transitioned out of `running` between tick boundaries. Tuning `idleMinutes` higher trades faster detection for fewer noise fires.
- **Intentional local branches:** operators sometimes create a team worktree for exploratory local work they never intend to push. The detector treats non-terminal `teams.status` as the contract — mark such teams as `blocked` or `archived` before leaving them parked.
- **Base branch diverged under the team:** if `origin/<base_branch>` was force-pushed while the team worked, `git rev-list --count origin/<base>..HEAD` counts rebase-able commits that are not actually ahead in the semantic sense. The detector still correctly reports the local ahead count; operators must read the payload before acting.
- **Git subprocess flaky:** slow disk, NFS mounts, or git locks can push the probe past `gitTimeoutMs`; the degrade-to-skip behaviour means the row is re-probed on the next tick. Persistent timeout on the same worktree indicates something real (hung git lock, missing `.git`).

### Triage action

```bash
# 1. Read the payload — compare worktree_path, branch_ahead_count, last_commit_at,
#    and minutes_since_active to understand what work is stranded.

# 2. Inspect the orphaned worktree directly.
cd "$(jq -r '.payload.observed_state_json.worktree_path' <<< "$EVENT")"
git log --oneline origin/<base_branch>..HEAD

# 3. Decide per-team whether the work should ship:
#    (a) Ship: push the branch and open a PR on behalf of the dead lead.
git push -u origin HEAD
gh pr create --base <base_branch> --fill

#    (b) Discard: the team's work was wrong / superseded — archive it.
genie team archive '<team_name>'
#    If the worktree should be removed from disk:
git worktree remove --force "$(jq -r '.payload.observed_state_json.worktree_path' <<< "$EVENT")"

# 4. If total_stalled_teams > 3 in one tick, the leader-completion contract is
#    failing broadly — check for recent tmux-server restarts, OOM kills, or
#    deployment events that may have killed multiple leads simultaneously.
psql -c "SELECT t.name, t.status, a.custom_name AS lead, a.state AS lead_state,
                a.last_activity_at
         FROM teams t
         LEFT JOIN agents a ON a.team_id = t.id AND a.role = 'team-lead'
         WHERE t.status NOT IN ('done','blocked','archived')
         ORDER BY a.last_activity_at NULLS FIRST;"

# 5. If the detector fires repeatedly on the same team after triage, investigate
#    why `team.status` is not transitioning — the operator may need to mark the
#    team `done`/`blocked` explicitly.
genie team done '<team_name>'   # if the ship path completed
genie team blocked '<team_name>' # if the work is parked pending input
```

Cross-reference with Pattern 5: zombie-team-lead fires when a lead is *alive-but-idle* (leader state live, team never did anything); team-unpushed-orphaned-worktree fires when the lead is *dead-with-WIP* (leader gone, work on disk, never pushed). The two spans are deliberately non-overlapping (5min idleMinutes on pattern-5, 10min on pattern-9) so a stalling team surfaces under the pattern matching its actual failure mode.

The deeper architectural fix — a `team.completed` / `team.pushed` event contract that the detector could assert against — is scoped out to a follow-up wish. Pattern 9 is the "observe the gap" half; the "close the gap" half (leader-completion contract + `genie team rescue` one-liner salvage) remains queued.
