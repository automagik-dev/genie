# Wish: Perfect Spawn Hierarchy — End the Ghost-Approval Deadlock

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `perfect-spawn-hierarchy` |
| **Date** | 2026-04-10 |
| **Priority** | P0 — worst active bug in the product |
| **Trace** | See Context section below |
| **Related** | Commit `7c21301a6` (2026-04-02 partial fix), Issue #1094 (2026-04-09 SDK-path fix) |

## Summary

Every time a teammate in a native team tries to write a new file at its project cwd root, Claude Code's permission gate routes the request to `~/.claude/teams/<team>/inboxes/team-lead.json` — and because two of the three team-spawn paths create the team with `leadSessionId: "pending"` (a literal placeholder that nothing ever reconciles), the request lands on a ghost leader and never gets a response. The teammate sees `"The user doesn't want to proceed with this tool use"` and silently gives up. 44 unanswered requests have piled up in a single inbox since 2026-03-26. This wish kills the class of bug by making **every spawn establish a real parent session at the moment of spawn**, enforcing a three-layer hierarchy (master → task-lead → underlings) so approval requests always route to a live ancestor, and teaching `genie doctor` to catch the next variant before users do.

## Context — What We Know (from the 2026-04-10 trace)

**Rejected Write that triggered the investigation:**
```
/home/genie/.claude/teams/genie/inboxes/team-lead.json:15469
→ {"type":"permission_request","request_id":"perm-1775838084154-39n5jxl",
   "agent_id":"genie","tool_name":"Write",
   "input":{"file_path":"/home/genie/workspace/agents/genie/.gitmodules",...}}
```
No corresponding `permission_response` exists. Inbox-wide: **44 permission_requests, 1 permission_response** (the response is from 2026-03-26).

**Primary root cause — two code sites still hardcode `'pending'`:**
- `src/lib/team-auto-spawn.ts:144` — Omni recovery path: `ensureNativeTeam(teamName, ..., 'pending', leaderName)`
- `src/genie-commands/session.ts:77` — interactive session path: `ensureNativeTeam(teamName, ..., 'pending', leaderName)` with a comment that claims "CC updates it internally once started" — **this claim is false**; nothing updates it.

**The third path already does it right** — `src/lib/protocol-router-spawn.ts:269-270` resolves a real `parentSessionId` via `resolveParentSession()` (line 43-47). But even that helper has a fallback to `"genie-${team}"` (line 46) — a fake string that won't route either.

**The fix that shipped on 2026-04-02** (commit `7c21301a6`) added `ensureTeammateBypassPermissions()` in `src/lib/claude-settings.ts:63` to force the global `teammateMode: "bypassPermissions"`. It closed one escape path. The commit message literally calls the failure "deadlock where subagents hang forever". But my global settings confirm `teammateMode: "bypassPermissions"` is set — and the Write to `.gitmodules` **still routed to the ghost leader**. Claude Code has at least one write-gate code path that ignores the global bypass (exact path unknown — the gate lives in the closed-source `claude` binary).

**Issue #1094** (closed 2026-04-09, yesterday) fixed the `claude-sdk.ts:183-196` spread-override bug: `...translatedSdk` was clobbering `permissionMode: 'bypassPermissions'`. Different code path, same user-visible symptom: "The agent gets stuck in a self-approval loop."

**Three instances of the same class of bug in 8 days.** We keep patching individual leaks while the architecture leaks. The durable fix is to make the parent chain unbreakable and stop trusting Claude Code's internal bypass.

**`genie doctor` is blind to all of this.** `src/genie-commands/doctor.ts` checks tmux/jq/bun/claude prereqs, genie config existence, Claude settings existence, tmux server, worker profiles, and the Omni bridge. **Zero team-health checks.** No `leadSessionId === "pending"` detector. No inbox backlog check. No pane liveness check. No `teammateMode` verifier. Users hit this bug, run `genie doctor`, see "All checks passed!", and lose trust.

## Scope

### IN

- Eliminate every `'pending'` literal passed to `ensureNativeTeam()` in the production spawn paths.
- Establish a single helper — `resolveSpawnerSessionId(cwd)` — that every spawn path uses to get a real Claude Code session ID for the CURRENT caller. Strategy: `CLAUDE_CODE_SESSION_ID` env var → newest JSONL in `~/.claude/projects/<sanitized-cwd>/` → **fail loud** (do not silently fall back to fake strings).
- `genie spawn` (CLI and internal callers) always registers the caller's session ID as the spawnee's `parentSessionId`. If the caller is running inside Claude Code, the spawner becomes the team-lead for the spawnee **at the moment of spawn**.
- Three-layer hierarchy enforcement: every spawn uses the NEAREST live ancestor as `parentSessionId`, not the root. When a task-lead (a worker that was itself spawned) spawns its own underlings, those underlings route to the task-lead — not to the master. The master session only receives permission requests from its direct children.
- Auto-approver daemon: the inbox watcher gains a "permission responder" component that, when the team-lead is an automated (non-TUI) Claude session, auto-emits `permission_response {subtype: "success"}` for any `permission_request` whose `agent_id` is a known member of the team. Trust-on-team-membership.
- `genie doctor` gains a **Team Health** section with four checks: (1) stale `leadSessionId`, (2) inbox permission-request backlog, (3) `teammateMode` verifier, (4) team-lead pane liveness.
- `genie doctor --fix` extends to auto-remediate: respawn missing team-leads, patch stale `leadSessionId`, drain stuck inbox backlog by issuing synthetic `permission_response` entries (with audit log).
- Migration script: one-shot backfill for existing teams with `leadSessionId: "pending"` on machines that upgrade to the new version. Runs from `genie setup` and `genie doctor --fix`.
- Regression tests: unit tests for `resolveSpawnerSessionId`, `resolveParentSession` hardened path, the auto-approver's trust-on-membership logic, doctor checks, and the migration script. Integration test that spawns a three-layer hierarchy and writes a new-file-at-cwd-root from a level-3 agent end-to-end on dev.
- Documentation: update `src/genie-commands/AGENTS.md` (if it exists) or the top-level docs with the hierarchy model, add a troubleshooting section to the docs describing the bug + fix, and cross-reference commit `7c21301a6` and issue #1094 so the pattern is recorded.

### OUT

- **Fixing Claude Code's internal write-gate.** The exact path inside the `claude` binary that routes writes-at-cwd-root through the team inbox despite `bypassPermissions` is closed-source and out of our control. This wish works *around* it by ensuring the leader is always real and always responsive.
- **Removing native-teams support entirely.** Some folks have considered "just disable it for non-TUI leaders". This wish preserves native teams and makes them actually work, rather than ripping them out.
- **Rewriting the permission-request inbox protocol.** We stick with the current JSON-append-with-read-flag format.
- **Changing the SendMessage-based in-process communication.** Different subsystem, not part of this fix.
- **Fixing the related `claude-sdk.ts` spread order.** Already fixed in #1094.
- **Adding per-request approval UX to the TUI.** Out of scope — the auto-approver handles the daemon case; TUI leaders already surface prompts interactively.
- **Backporting to versions older than the currently-supported release.** We fix forward on `dev`.

## Decisions

| Decision | Rationale |
|----------|-----------|
| **Every spawn resolves `parentSessionId` at spawn time — no deferred "CC will update it" assumption.** | The deferred model is the exact assumption that broke production. The comment at `session.ts:63` literally says "CC updates it internally once started" and that's been wrong for weeks. Resolve eagerly, fail loudly if we can't. |
| **Trust-on-team-membership for the auto-approver.** | If a request's `agent_id` matches a member in the team config, it's trusted. Alternative (require a signed token per member) is overkill for a local-process setup and delays shipping. |
| **Three-layer hierarchy via nearest-live-ancestor lookup, not a recorded tree.** | A recorded tree would need migration, persistence, and garbage-collection. Nearest-live-ancestor is computed at spawn time from the current process env, is stateless, and naturally handles death/respawn. |
| **`genie doctor` gains a Team Health section, not a new `genie teams doctor` subcommand.** | Users already run `genie doctor` when things break. Adding a new subcommand means they won't find it. Put the checks where users look. |
| **Auto-approver writes a `permission_response` with `subtype: "success"` — does not try to "grant" via the Claude Code API.** | The Claude Code side only reads `permission_response` entries from the inbox. Writing one is the same mechanism the TUI leader already uses (see inbox evidence: one real response from 2026-03-26 used exactly this shape). |
| **Migration is read-only scan + write-replace, not a schema version bump.** | The team config file is JSON with a flat `leadSessionId` field. Replacing `"pending"` with a real value is a string-level edit. No schema bump needed. |
| **Fail loud on `resolveSpawnerSessionId()` returning null.** | Silent fallback to `"genie-${team}"` (current behavior at `protocol-router-spawn.ts:46`) is exactly how we got here. If we can't find a real session, throw — the caller either passes a session ID explicitly or the CLI exits with an actionable error. |
| **Do not remove the `'pending'` literal from the test file.** | `src/lib/team-auto-spawn.test.ts:58` uses `'pending'` as fixture data that exercises the "config-exists-but-not-hydrated" detection. Keep the fixture, fix the production sites. |

## Success Criteria

- [ ] **No production code path passes the literal `'pending'` to `ensureNativeTeam()`.** Grep `src/` excluding tests for `ensureNativeTeam.*pending` returns zero matches.
- [ ] **`resolveSpawnerSessionId(cwd)` exists** as a single exported helper in `src/lib/claude-native-teams.ts` and is the only way any spawn path looks up the caller's session ID. Throws on not-found.
- [ ] **`genie spawn <role>` sets the spawnee's `parentSessionId`** to the caller's real Claude Code session ID (verified by reading `~/.claude/teams/<team>/config.json` after the spawn and checking it's a UUID, not `"pending"` and not `"genie-<team>"`).
- [ ] **Three-layer hierarchy works.** Integration test: spawn agent A from a master session, spawn agent B from A, spawn agent C from B. Then have C attempt a Write to a new cwd-root file. The permission request must land in **B's** inbox, not A's and not the master's. B's auto-approver must respond within 2 seconds and C's write must succeed.
- [ ] **Auto-approver ships and is on by default** for non-TUI leaders, runs as part of the inbox watcher, and writes a `permission_response` for each `permission_request` it can validate as coming from a known team member. An audit log is written to `~/.genie/auto-approve.log` with one line per decision.
- [ ] **`genie doctor` reports Team Health.** Running `genie doctor` on a machine with a team config that has `leadSessionId: "pending"` produces a FAIL line with the exact team name and a one-line fix suggestion. Running it on a machine with a backlog of 10+ unanswered requests produces a FAIL line. Running it without `teammateMode: "bypassPermissions"` in `~/.claude/settings.json` produces a FAIL line.
- [ ] **`genie doctor --fix` auto-remediates.** Running on a machine with the exact state we see on 2026-04-10 (leadSessionId pending, 44-entry backlog, teammateMode set, pane alive) must: (a) patch `leadSessionId` to a real session ID if one can be discovered, (b) drain the backlog by writing synthetic `permission_response` entries, (c) log every action to `~/.genie/doctor-fix.log`.
- [ ] **Migration runs once on upgrade** and logs a summary: `[migrate] perfect-spawn-hierarchy: patched N teams, drained M requests`. Idempotent — running a second time is a no-op with summary `0 teams, 0 requests`.
- [ ] **`bun test` passes with no regressions** and includes:
  - `src/lib/claude-native-teams.test.ts` — new tests for `resolveSpawnerSessionId`.
  - `src/lib/team-auto-spawn.test.ts` — updated to assert no `'pending'` literal is written.
  - `src/lib/inbox-watcher.test.ts` — new tests for the auto-approver.
  - `src/genie-commands/doctor.test.ts` — new file, covers the four Team Health checks.
  - `src/lib/spawn-hierarchy.integration.test.ts` — new file, end-to-end three-layer test (may be marked `.skip` if tmux isn't available in CI).
- [ ] **`bun run typecheck` is clean.**
- [ ] **`bun run lint` is clean** (or worsens no further than baseline, with justification if it does).
- [ ] **`genie doctor` exit code is 0** on a machine in the fixed state.
- [ ] **Docs updated.** A troubleshooting section exists in the README or docs/ that explains the bug, the fix, and cross-references `7c21301a6` and #1094.

## Execution Strategy

Three waves. Wave 1 is parallel foundation work. Wave 2 builds on Wave 1. Wave 3 is the daemon + tests + migration. Review gates between waves.

### Wave 1 (parallel — 3 independent streams)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Kill the `'pending'` literal in `team-auto-spawn.ts:144` + `session.ts:77`. Add `resolveSpawnerSessionId()` helper. Harden `resolveParentSession()` to never return `"genie-<team>"`. |
| 4 | engineer | Add **Team Health** section to `genie doctor` with the four checks (stale leadSessionId, inbox backlog, teammateMode, pane liveness). Read-only — no fix wiring yet. |
| 8 | engineer | Docs: hierarchy model write-up, troubleshooting section, cross-references to prior fixes. Can start immediately, no code dependencies. |

### Wave 2 (after Wave 1 review)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | `genie spawn` wires the spawner's session ID as `parentSessionId`. Every spawn path (session.ts, protocol-router-spawn.ts, team-auto-spawn.ts) calls the single helper from Group 1. Hard-fail if no session ID can be resolved. |
| 3 | engineer | Three-layer hierarchy: when a spawned worker itself spawns, the nearest-live-ancestor (its own session) becomes the parent. Verify via env propagation (`GENIE_PARENT_SESSION_ID`) and filesystem introspection. |
| 5 | engineer | Migration + `genie doctor --fix` auto-remediation. Runs the backfill for stale configs and drains the inbox backlog with synthetic responses. Must be idempotent. |

### Wave 3 (after Wave 2 review)

| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | Auto-approver daemon integrated into inbox-watcher. Trust-on-team-membership. Audit log at `~/.genie/auto-approve.log`. Default-on for non-TUI leaders. |
| 7 | qa | Regression tests — unit for every new helper + integration test that spawns a 3-layer hierarchy and writes a new cwd-root file successfully. |
| review | reviewer | Review Groups 1-7 against acceptance criteria. Verify the exact reproducer from the 2026-04-10 trace (writing `.gitmodules` at cwd root from a teammate) now succeeds on dev. |

## Execution Groups

### Group 1: Kill `'pending'` + introduce `resolveSpawnerSessionId()`

**Goal:** Make every production spawn path resolve a real session ID before calling `ensureNativeTeam()`. Eliminate the `'pending'` literal.

**Deliverables:**
1. New exported function `resolveSpawnerSessionId(cwd?: string): Promise<string>` in `src/lib/claude-native-teams.ts`. Strategy: `CLAUDE_CODE_SESSION_ID` env var → newest `.jsonl` in `~/.claude/projects/<sanitized-cwd>/` → throw `GhostLeaderError` with an actionable message. (Do NOT fall back to `"genie-${team}"` or any other synthetic string.)
2. `src/lib/team-auto-spawn.ts:144` — replace `'pending'` with `await resolveSpawnerSessionId(workingDir)`. Wrap in try/catch; on failure, log clearly and propagate — do not silently continue with a broken team.
3. `src/genie-commands/session.ts:77` — same replacement. Update the comment on line 63 that currently claims "CC updates it internally once started" (it doesn't) to instead reference this wish + the real resolution flow.
4. `src/lib/protocol-router-spawn.ts:46` — remove the `?? \`genie-${team}\`` fallback. Throw instead. The ONLY legal return is a real session UUID.
5. `src/lib/team-manager.ts:332-336` — stop silently swallowing `registerAsTeamLead` errors. Log to stderr with `[team]` prefix. Still non-blocking, but visible.

**Acceptance Criteria:**
- [ ] `grep -rn "'pending'" src/lib/team-auto-spawn.ts src/genie-commands/session.ts src/lib/protocol-router-spawn.ts` returns zero matches.
- [ ] `resolveSpawnerSessionId()` exists, is exported, has at least 4 unit tests (env var hit, filesystem hit, both miss, malformed jsonl).
- [ ] Unit test asserts `GhostLeaderError` is thrown when nothing resolves, with a message containing "CLAUDE_CODE_SESSION_ID" and a link to this wish.
- [ ] `bun test src/lib/claude-native-teams.test.ts src/lib/team-auto-spawn.test.ts` passes.
- [ ] `bun run typecheck` clean.

**Validation:**
```bash
cd /path/to/genie && \
  bun run typecheck && \
  bun test src/lib/claude-native-teams.test.ts src/lib/team-auto-spawn.test.ts && \
  ! grep -rn "'pending'" src/lib/team-auto-spawn.ts src/genie-commands/session.ts src/lib/protocol-router-spawn.ts
```

**depends-on:** none

---

### Group 2: Spawner-as-leader in every spawn path

**Goal:** Every spawn (CLI, TUI, inbox-watcher recovery, protocol router) establishes the caller's session as the spawnee's parent at the moment of spawn.

**Deliverables:**
1. `genie spawn <role>` (entry in `src/genie-commands/*`) calls `resolveSpawnerSessionId(process.cwd())` at the top and passes the result through to whichever backend spawn function it uses (likely `spawnWorkerFromTemplate`).
2. `resolveParentSession()` in `src/lib/protocol-router-spawn.ts:43-47` is refactored:
   - Priority 1: explicit `parentSessionId` argument (passed from the CLI layer).
   - Priority 2: stored `nativeTeamParentSessionId` in team config.
   - Priority 3: `resolveSpawnerSessionId()` (the new helper).
   - Priority 4: **throw** — no fake string fallback.
3. `GENIE_PARENT_SESSION_ID` env var is set on every spawned subprocess (`buildTeamLeadCommand`, `buildSpawnParams`, and any other launcher) so grandchildren can read it for their own resolution.
4. `resolveSpawnerSessionId()` checks `GENIE_PARENT_SESSION_ID` before it checks `CLAUDE_CODE_SESSION_ID` — this is how grandchildren find their direct parent instead of the root.

**Acceptance Criteria:**
- [ ] Integration test: spawn a worker from a test harness; read the resulting team config; `leadSessionId` must match the harness's `CLAUDE_CODE_SESSION_ID` (or, in a mock, the injected value).
- [ ] Integration test: spawn-within-spawn — spawner S1 spawns S2 which spawns S3. S3's team config `leadSessionId` must equal S2's session ID, **not** S1's.
- [ ] `resolveParentSession` has zero occurrences of `genie-${team}` or any other synthetic fallback.
- [ ] `GENIE_PARENT_SESSION_ID` is documented in `src/lib/team-lead-command.ts` (or equivalent) as part of the launcher env.

**Validation:**
```bash
bun test src/lib/protocol-router-spawn.test.ts src/lib/spawn-hierarchy.integration.test.ts
bun run typecheck
```

**depends-on:** Group 1

---

### Group 3: Three-layer hierarchy — nearest-live-ancestor routing

**Goal:** When a task-lead (a worker that was itself spawned by the master) spawns its own underlings, those underlings route to the task-lead, not the master. The master receives only requests from its direct children.

**Deliverables:**
1. When the inbox-watcher or any process resolves "who is the team-lead for this team", it walks the hierarchy by reading team configs and finding the nearest ancestor whose session is still alive (JSONL exists and was modified recently, AND its tmux pane is alive per `isPaneAlive`).
2. New helper `resolveNearestLiveAncestor(childSessionId: string): Promise<string>` in `src/lib/claude-native-teams.ts`. Walks `parentSessionId` → `grandparentSessionId` until it finds one that's alive. Throws if none are.
3. Team config schema gains an optional `taskLeadSessionId` field. When set, the inbox-watcher treats THAT as the effective leader for the team, not the master. Set by the spawn layer whenever a task-lead is introduced (i.e. whenever a spawned worker itself spawns workers).
4. Permission-request routing respects `taskLeadSessionId` — requests from that task-lead's subtree route to the task-lead's inbox, not the master's.
5. If a task-lead dies, its subtree falls back to the nearest live ancestor (the master, eventually).

**Acceptance Criteria:**
- [ ] Three-layer integration test passes: master M spawns task-lead T spawns underling U. U issues a permission request. The request lands in T's inbox (not M's). T auto-approves. U's tool call succeeds.
- [ ] Kill-the-task-lead test: after T dies, U's next permission request falls back to M and M auto-approves. No request is ever lost.
- [ ] `resolveNearestLiveAncestor` has unit tests for all branches (direct parent alive, parent dead and grandparent alive, all dead → throw).

**Validation:**
```bash
bun test src/lib/claude-native-teams.test.ts src/lib/spawn-hierarchy.integration.test.ts
bun run typecheck
```

**depends-on:** Group 2

---

### Group 4: `genie doctor` Team Health checks

**Goal:** Give users (and agents) a single command that catches this class of bug in 10 seconds instead of 15 days.

**Deliverables:**
1. New `checkTeamHealth()` function in `src/genie-commands/doctor.ts` returning `CheckResult[]`.
2. **Check 1 — Stale leadSessionId:** walk `~/.claude/teams/*/config.json`. For each team with `leadSessionId === "pending"` or a value that doesn't correspond to an existing `.jsonl` file, FAIL with `Team '<name>' has a ghost leader. Fix: genie doctor --fix or genie team respawn-lead <name>`.
3. **Check 2 — Inbox backlog:** for each team, count `permission_request` entries minus `permission_response` entries in `inboxes/team-lead.json`. If (requests − responses) > 5 AND the oldest unanswered request is >30 minutes old, FAIL with `Team '<name>' has N unanswered permission_requests (oldest: X min). Leader is probably dead or unresponsive.`
4. **Check 3 — teammateMode verifier:** read `~/.claude/settings.json`. If `teammateMode !== "bypassPermissions"` while native teams are in use, FAIL with the suggestion to run `genie setup` or the specific jq command to fix it.
5. **Check 4 — Team-lead pane liveness:** for each team with native-teams enabled, check if the team-lead's tmux pane is alive. If not, WARN (not FAIL — might just be a closed window) with `genie doctor --fix` as the remediation.
6. Wire `checkTeamHealth` into `doctorCommand()` as a new section.
7. This group is **read-only** — it only detects. Remediation is Group 5.

**Acceptance Criteria:**
- [ ] Running `bun run src/bin.ts doctor` on my current machine (team config has `leadSessionId: "pending"`, 44 unanswered requests) produces four distinct FAIL lines in a Team Health section.
- [ ] `checkTeamHealth` is covered by unit tests in `src/genie-commands/doctor.test.ts`, using tmp filesystems and mock team configs.
- [ ] Each check has a one-line suggestion that's a runnable command.

**Validation:**
```bash
bun run typecheck
bun test src/genie-commands/doctor.test.ts
# Manual: bun run src/bin.ts doctor  # must show Team Health section with FAILs
```

**depends-on:** none

---

### Group 5: Migration + `genie doctor --fix` auto-remediation

**Goal:** Make `genie doctor --fix` idempotently repair the exact state we see on 2026-04-10: stale `leadSessionId: "pending"`, 44-entry inbox backlog.

**Deliverables:**
1. Extend `doctorFix()` in `src/genie-commands/doctor.ts` with a new step `fixTeamHealth()`.
2. **Patch stale leadSessionId:** for each team with `leadSessionId === "pending"`, call `resolveSpawnerSessionId()`. If one is found, write it to the config. If not, spawn a new team-lead via `ensureTeamLead()` (the same path Omni uses) — but NOW with the Group 1 fix so it writes a real session ID.
3. **Drain inbox backlog:** for each unanswered `permission_request` in `inboxes/team-lead.json`, write a matching `permission_response` with `subtype: "success"` **only if** the request's `agent_id` is a known member of the team. For unknown agents, log a warning and leave the request in place (safer default).
4. **Migration on upgrade:** add a one-shot migration `migrations/2026-04-10-perfect-spawn-hierarchy.ts` (or similar location — follow the existing migration pattern) that runs `fixTeamHealth()` once per machine, tracked via a marker file at `~/.genie/migrations/perfect-spawn-hierarchy.done`.
5. **Audit log:** every change goes to `~/.genie/doctor-fix.log` with one line per action (timestamp, team, action, agent_id, result).
6. Idempotency test: run the migration twice; second run must report `0 teams patched, 0 requests drained`.

**Acceptance Criteria:**
- [ ] Running `genie doctor --fix` on a machine matching the 2026-04-10 state successfully (a) patches leadSessionId or respawns, (b) drains the backlog, (c) writes the audit log. Subsequent `genie doctor` shows all Team Health checks PASS.
- [ ] The auto-drain only responds to requests from known members. A synthetic request with `agent_id: "unknown"` is left in place and logged.
- [ ] Migration marker prevents double-execution on boot. Unit test covers this.

**Validation:**
```bash
bun run typecheck
bun test src/genie-commands/doctor.test.ts migrations/2026-04-10-perfect-spawn-hierarchy.test.ts
# Manual dry-run on a copy of current state.
```

**depends-on:** Group 1, Group 4

---

### Group 6: Auto-approver daemon

**Goal:** Prevent future regressions by making the leader **actively responsive**, not passively pollable. When a non-TUI leader receives a permission request from a known team member, it responds automatically within seconds.

**Deliverables:**
1. New component `src/lib/permission-auto-approver.ts` with an exported function `runAutoApprover(teamName, opts)`.
2. Integrated into `src/lib/inbox-watcher.ts` — every poll cycle, the watcher scans `inboxes/team-lead.json` for unanswered `permission_request` entries (not just unread generic messages) and invokes the auto-approver.
3. **Trust model:** the auto-approver compares `request.agent_id` against the team config's `members[]` list. If the agent is a known member, write a `permission_response` with `subtype: "success"` to the inbox. Otherwise skip and log.
4. **Default-on for non-TUI leaders.** A leader is "non-TUI" if its session JSONL does NOT contain a `custom-title` entry or its agent-type is not `"team-lead"`. TUI sessions surface prompts to the user via Claude Code's built-in UI and must not be overridden.
5. **Config toggle:** `genie config set autoApprove.enabled false` disables it globally. Default: `true`.
6. **Audit log** at `~/.genie/auto-approve.log` — one line per decision: timestamp, team, request_id, agent_id, decision (approved/skipped), reason.
7. **Rate limit:** no more than 100 approvals per minute per team (guardrail against runaway loops).

**Acceptance Criteria:**
- [ ] Unit tests cover: known-member-approved, unknown-member-skipped, rate-limited, config-disabled.
- [ ] Integration test: a request lands in an inbox, the auto-approver responds within 2 seconds, the response is well-formed and readable by whatever format Claude Code expects (match the shape of the one historical successful response at team-lead.json entry from 2026-03-26).
- [ ] Audit log entries are parseable and include all required fields.

**Validation:**
```bash
bun run typecheck
bun test src/lib/permission-auto-approver.test.ts src/lib/inbox-watcher.test.ts
```

**depends-on:** Group 2, Group 3

---

### Group 7: Regression tests — the reproducer must pass

**Goal:** Ensure the exact failure from 2026-04-10 can never recur silently. Lock it in with an end-to-end test.

**Deliverables:**
1. `src/lib/spawn-hierarchy.integration.test.ts` — end-to-end test:
   - Create a temporary team via the same API genie uses in production.
   - Spawn two layers of agents.
   - Have the level-3 agent write a **new file at its cwd root** (the exact failure mode from the trace).
   - Assert the write succeeds, the team config has a real `leadSessionId`, the permission request landed in the correct inbox (Group 3's routing), and the auto-approver (Group 6) wrote a response within 2 seconds.
2. `src/lib/claude-native-teams.test.ts` — expanded tests for `resolveSpawnerSessionId` and `resolveNearestLiveAncestor`.
3. `src/genie-commands/doctor.test.ts` — tests for the four Team Health checks.
4. `src/lib/permission-auto-approver.test.ts` — already delivered in Group 6; this group re-verifies edge cases + adds a load test.
5. **Anti-regression sentinel:** a simple lint rule or grep-based CI check that fails the build if `'pending'` is reintroduced into any `ensureNativeTeam(` call site in production code. Script lives in `scripts/check-no-pending-literal.sh`.

**Acceptance Criteria:**
- [ ] All new tests pass locally and in CI.
- [ ] The lint sentinel fires on a deliberately-reintroduced `'pending'` in a throwaway branch (prove it works).
- [ ] `bun test` runs in under 3 minutes on CI.

**Validation:**
```bash
bun test
bun run typecheck
bash scripts/check-no-pending-literal.sh  # must exit 0
```

**depends-on:** Group 1, Group 2, Group 3, Group 4, Group 5, Group 6

---

### Group 8: Docs + hierarchy model write-up

**Goal:** Document the hierarchy so the next engineer who touches this code doesn't reintroduce the bug.

**Deliverables:**
1. New file `docs/architecture/spawn-hierarchy.md` (or similar — match existing doc layout). Explains the three-layer model (master → task-lead → underling), how `parentSessionId` flows through spawns, and where permission requests route.
2. Troubleshooting section in the top-level README (or docs/troubleshooting.md): "My agent says 'user rejected this tool use' and I didn't reject anything — what's going on?" Explain the bug class, link to `genie doctor`, link to the fix commit.
3. Cross-reference prior fixes: commit `7c21301a6` and issue #1094. Explicitly note this is the third instance of the same class of bug.
4. Update `src/genie-commands/session.ts:63` comment (the "CC updates it internally once started" lie) to reference the truth and this wish.
5. If `AGENTS.md` exists at the repo root or under `src/`, update it with a brief hierarchy note so agents loading the file understand the model.

**Acceptance Criteria:**
- [ ] Docs file exists, is linked from the top-level README index or docs index.
- [ ] The troubleshooting section quotes the exact user-visible error message `"The user doesn't want to proceed with this tool use. The tool use was rejected."` so people can find it via search.
- [ ] Zero broken links.

**Validation:**
```bash
# Markdown link check (use whatever the repo uses)
# Or manual review during /review.
```

**depends-on:** none (can be written in parallel with Group 1)

---

## Dependencies

- `depends-on`: none external — this wish is self-contained within the genie repo.
- `blocks`: any wish that relies on native teams working reliably (currently nothing is explicitly blocked, but every agent-spawning wish is implicitly at risk until this ships).

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Reproducer check:** on a fresh checkout of `dev`, start `genie setup`, spawn an engineer via `genie spawn engineer`, and have the engineer create a new file at the cwd root (e.g. `.test-marker`). The write must succeed without any "user rejected" error.
- [ ] **Three-layer check:** spawn a task-lead that itself spawns a worker. The worker creates a new file at cwd root. Succeeds. The master's inbox contains **zero** new entries — all routing stopped at the task-lead.
- [ ] **Doctor pass:** on a fresh checkout after the fix, `genie doctor` exits 0 and shows a Team Health section with all checks PASS.
- [ ] **Doctor catch:** manually corrupt a team config back to `leadSessionId: "pending"`. `genie doctor` must exit non-zero with a FAIL line naming the team. `genie doctor --fix` must repair it.
- [ ] **Backlog drain:** manually append 5 fake `permission_request` entries to a team inbox. `genie doctor --fix` must drain them (writing synthetic responses), log to `~/.genie/doctor-fix.log`, and leave the inbox in a consistent state.
- [ ] **Idempotency:** `genie doctor --fix` run twice in a row on a healthy machine must report `0 patched, 0 drained` the second time.
- [ ] **No `'pending'` literals in production code:** `grep -rn "'pending'" src/lib/team-auto-spawn.ts src/genie-commands/session.ts src/lib/protocol-router-spawn.ts` returns zero matches.
- [ ] **Regression sentinel works:** deliberately reintroduce a `'pending'` literal in a test branch; CI must fail.
- [ ] **No regressions:** `bun test` passes with the same or higher count than pre-wish baseline. `bun run typecheck` clean. `bun run lint` clean or unchanged baseline.
- [ ] **Documented:** README troubleshooting section exists and is discoverable.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude Code's internal write-gate may change shape in a future version and bypass our auto-approver. | Medium | The regression test (Group 7) will catch breakage on upgrade. Document the exact Claude Code version tested. |
| `discoverClaudeSessionId` heuristic (newest JSONL in project dir) may pick the wrong session if the user has multiple concurrent Claude sessions in the same cwd. | Medium | Prefer the `CLAUDE_CODE_SESSION_ID` env var path; fall back to JSONL only when env is missing. Test explicitly with concurrent sessions. |
| Auto-approver could approve malicious requests if a non-member somehow writes to a team inbox. | Low | Trust-on-team-membership + audit log. The team inbox dir has user-only permissions on Unix. If an attacker can write there, they already have the user's shell. |
| Migration might mis-identify legitimate placeholder values if someone extends the schema later. | Low | Match the literal string `"pending"` exactly, case-sensitive. Document the sentinel value in the code. |
| Three-layer hierarchy lookup could be slow on large teams. | Low | Cache `resolveNearestLiveAncestor` for the lifetime of an inbox-watcher poll cycle. O(hierarchy depth) lookups, not O(N members). |
| Fix-forward on `dev` leaves users on older versions broken. | Medium | Document the minimum safe version in the README troubleshooting section. `genie doctor` on old versions won't show Team Health but will at least not claim everything is fine. |
| The user's current machine has 44 stale requests in its inbox from before the fix. | Confirmed | Group 5 explicitly drains existing backlogs via `doctor --fix`. This wish fixes the bug AND cleans up after it. |

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# New files
src/lib/permission-auto-approver.ts
src/lib/permission-auto-approver.test.ts
src/lib/spawn-hierarchy.integration.test.ts
src/genie-commands/doctor.test.ts
migrations/2026-04-10-perfect-spawn-hierarchy.ts
migrations/2026-04-10-perfect-spawn-hierarchy.test.ts
scripts/check-no-pending-literal.sh
docs/architecture/spawn-hierarchy.md

# Modified files
src/lib/claude-native-teams.ts           # add resolveSpawnerSessionId, resolveNearestLiveAncestor
src/lib/claude-native-teams.test.ts      # new tests for the helpers
src/lib/team-auto-spawn.ts               # kill 'pending' literal (line 144)
src/lib/team-auto-spawn.test.ts          # update assertions; keep fixture 'pending' for config-detection test
src/lib/protocol-router-spawn.ts         # harden resolveParentSession; remove fake-string fallback
src/lib/team-manager.ts                  # stop swallowing registerAsTeamLead errors (line 332-336)
src/lib/team-lead-command.ts             # propagate GENIE_PARENT_SESSION_ID env
src/lib/inbox-watcher.ts                 # integrate auto-approver
src/lib/inbox-watcher.test.ts            # tests for the new auto-approve path
src/genie-commands/session.ts            # kill 'pending' literal (line 77); update stale comment (line 63)
src/genie-commands/doctor.ts             # add Team Health section + fixTeamHealth
README.md                                # troubleshooting section
# Possibly AGENTS.md if present
```
