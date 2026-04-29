# Wish: Make `genie stop` work for native Claude Code teammates

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-stop-native-teammate` |
| **Date** | 2026-04-28 |
| **Author** | Felipe Rosa (housekeep pass) |
| **Appetite** | medium |
| **Branch** | `wish/fix-stop-native-teammate` |
| **Repos touched** | `automagik-dev/genie` |
| **Linked issue** | [#1330](https://github.com/automagik-dev/genie/issues/1330) |
| **Design** | _No brainstorm — direct wish_ |

## Summary

`genie stop <name>` errors out with "no active executor linked" whenever the target agent was spawned through the native Claude Code teammate path, because that path registers the agent row + native team `config.json` member but never inserts an executor record in PG. Operators are forced to use `genie kill`, which destroys the pane context, session UUID, and resume history they need to debug the runaway loop. This wish closes the gap with a hybrid approach: Path (a) restores the structural invariant (registry parity — every agent row gets a linked executor, even native teammates) AND Path (b) layers a graceful inbox-based stop signal so the teammate actually halts, not just the row. Path (a) alone is registry-only (the teammate keeps producing work until its current turn finishes); path (b) alone breaks the structural invariant. Together they give correct semantics AND graceful actual-stop.

## Rollout Step

**Operators with native teammates spawned pre-fix must `genie kill <name>` then re-spawn each affected agent once after deploy.** The lazy backfill (Decision #4) only triggers on the next spawn (`createAndLinkExecutor` runs); existing native-teammate rows whose agents are still alive will not auto-backfill. This one-time mitigation covers all subsequent spawns automatically.

## Scope

### IN

- Audit the native-teammate spawn / registration paths (`registerAsTeamLead`, `registerNativeMember` call sites in `src/term-commands/agents.ts`, plus any `notifySpawnJoin` flows that bypass `createTmuxExecutor`/`launchInlineSpawn`/`launchSdkSpawn`) and identify every spot where an agent row lands in the registry without a paired executor row. **Transport-switch audit:** the `transport ===` consumers verified at planning time are `src/term-commands/agents.ts:1494` (worker filter) and `src/lib/pg-seed.ts:200` (transport normalization to `'process'|'tmux'`); plus `resolveExecutorTransport` (`agents.ts:470`) which currently returns `'tmux'|'process'|'api'`, and `src/term-commands/agent/show.ts:28` / `src/term-commands/exec/index.ts:38` which echo transport for display. Group 1 typechecker pass extends each to handle the new `'native'` variant. If new switch sites land between planning and execution, the typechecker's exhaustiveness errors will surface them — fix as encountered.
- **Path (a) — executor parity.** Add a `'native'` literal to `TransportType` in `src/lib/executor-types.ts` (currently `'tmux' | 'api' | 'process'`) so a native-teammate row can be represented without lying about tmux/process provenance. NOTE: the wish previously referenced `'inline'`/`'sdk'` literals which do not exist in the codebase — the actual mapping is `claude-sdk` provider → `transport='process'`, inline-spawn → `transport='process'`, tmux-spawn → `transport='tmux'`, codex provider → `transport='api'`. The new `'native'` literal is a fourth peer to those three.
- Wire `createAndLinkExecutor` into the native-teammate registration flow so the agent row's `current_executor_id` is set immediately after `registerNativeMember` succeeds. Kill-pane semantics must remain a no-op for this transport (there is no Genie-owned pane to kill — the teammate shares the parent CC pane).
- Update `suspendWorker` (`src/lib/idle-timeout.ts`) so it handles the native transport gracefully: skip the `kill-pane` step, mark the executor terminated, and let the normal `stop` flow print the "session preserved" hint using whatever session UUID we captured at registration time.
- **Path (b) — `writeNativeInbox` please-stop advisory.** When `handleWorkerStop` is called for a `transport='native'` agent, also write a typed advisory message via `nativeTeams.writeNativeInbox(team, agentName, msg)`. NOTE: the current `NativeInboxMessage` type (`src/lib/claude-native-teams.ts:61`) has fields `from/text/summary/timestamp/color/read/source/meta` — there is no `kind` field. Group 1 must extend the type with an optional `kind?: 'message' | 'stop_request'` discriminant (default `'message'` for back-compat) OR encode the signal in `meta.kind` and document the choice. The advisory payload includes `text` (human-readable), `summary`, and `meta: {kind: 'stop_request', requestedAt, requestedBy, reason: 'operator_stop'}`. The native teammate sees this on its next turn-close and gracefully terminates its loop. Without this, the executor row says "stopped" but the teammate keeps producing work until its current turn finishes and there's no signal to stop the next turn.
- **Path (b) prerequisite — teammate prompt-template updates.** None of the current AGENTS.md prompt templates (`plugins/genie/agents/engineer/AGENTS.md`, `qa/AGENTS.md`, `reviewer/AGENTS.md`, `team-lead/AGENTS.md`, etc.) parse a `kind` field on inbox messages or describe a graceful-stop protocol. Without prompt updates, the advisory is silently ignored — path (b) becomes a no-op. Group 2 ships a shared "graceful stop protocol" snippet (e.g., `plugins/genie/agents/_shared/stop-protocol.md` or an `@include` block) and wires it into all teammate-eligible AGENTS.md files (`engineer`, `qa`, `reviewer`, `fix`, `trace`, `pm`, `docs`, `refactor`, plus relevant council variants). The snippet instructs: "On turn-close, read your native inbox; if any message has `meta.kind === 'stop_request'`, emit a graceful exit summary and terminate without starting a new turn." A short SCOPE-LIMITED variant is acceptable (engineer/qa/reviewer + team-lead only) IF the wish explicitly tags path (b) as **best-effort for those four roles only** and tracks the fan-out as a follow-up.
- Update the `genie stop` user-facing error path in `handleWorkerStop` so the fallback message no longer name-checks "native Claude Code teammate" once the parity fix lands (the message becomes a generic "executor row missing — please file a bug" path, since native teammates now have executors).
- Tests: extend `src/lib/claude-native-teams.test.ts` (or add `src/term-commands/agents.test.ts` coverage) to assert (1) `registerAsTeamLead` / native-member registration creates an executor row, (2) `handleWorkerStop` succeeds for a native-teammate agent and writes a `stop_request` inbox message, (3) `handleWorkerKill` still works (no regression on the destructive path).

### OUT

- Changes to `genie kill` semantics. Kill remains the destructive nuclear option; only the "no executor linked" error message changes.
- Migrations. The new transport value is forward-only; existing native-teammate rows without an executor are handled by the Rollout Step (operator runs `genie kill <name>` once, then re-spawns — lazy backfill via `createAndLinkExecutor` on the new spawn). No migration script.
- Cross-host stop (stopping a native teammate registered against a different machine's CC session). Out of scope — same-host only.
- TUI sidebar UX changes. Status badges may render differently once executors exist, but visual reconciliation lives in the existing `tui-sidebar` track.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Pick **hybrid (a) + (b)**: executor parity for state-tracking + `writeNativeInbox` advisory for graceful actual-stop. | Path (a) alone is registry-only (the teammate keeps working until its current turn finishes — it has no signal to stop the next turn); path (b) alone breaks the structural invariant `agent ⇒ executor` and forks `handleWorkerStop` into "has executor" vs "send inbox + wait" branches without fixing the registry. Both together give correct semantics AND graceful stop: (a) restores the invariant that every consumer (`isResumeEligible`, `getCurrentExecutor`, `terminateActiveExecutor`, scheduler-daemon) relies on, and (b) ensures the teammate actually halts via a typed `stop_request` advisory it consumes at next turn-close. |
| 2 | Introduce `transport: 'native'` rather than reusing `'inline'` or `'tmux'`. | Reusing `'tmux'` would lie to `suspendWorker` (which would then try to kill a pane Genie doesn't own — the parent CC pane). Reusing `'inline'` muddles the SDK/inline accounting paths. A dedicated transport label keeps the executor table semantically honest and lets `suspendWorker` dispatch correctly. |
| 3 | Path (b) is co-shipped with Path (a), not deferred. | Earlier draft framed path (b) as a follow-up issue; reviews flagged that path (a) alone is cosmetic — the teammate keeps producing work after `genie stop` returns 0. The hybrid (Decision #1) makes path (b) load-bearing for the wish's user-visible goal, so it ships in the same release. The `'native'` transport label introduced in Decision #2 also gives path (b) a clean dispatch hook. |
| 4 | Backfill existing native-teammate agent rows lazily, not via a migration script. | A migration would have to scan `~/.claude/teams/*/config.json`, correlate with `agents` rows, and infer the right transport — high blast radius for a usability fix. Lazy backfill on next `stop`/`spawn` is honest about which rows are legacy and avoids touching live state on upgrade. **Lazy backfill only happens when the agent is re-spawned (`createAndLinkExecutor` runs). Existing native-teammate rows whose agents are still alive will not auto-backfill; operators with such rows must run `genie kill <name>` once and re-spawn.** See the Rollout Step section above. |

## Success Criteria

- [ ] `genie spawn <built-in>` against a native team produces an agent row with a non-null `current_executor_id` pointing at a `transport='native'` executor.
- [ ] `genie stop <name>` succeeds for that agent and prints the same "session preserved" + "send to auto-resume" hints it prints for tmux agents.
- [ ] `genie kill <name>` still tears down the agent row + native team member entry without regressions.
- [ ] `bun test src/lib/claude-native-teams.test.ts` passes, including new cases asserting executor parity at registration time.
- [ ] `bun run check` passes (typecheck + lint + dead-code + test).
- [ ] The "Cannot stop agent — no active executor linked" stderr branch becomes unreachable via the native-teammate spawn flow (verified by a regression test that exercises the spawn-then-stop path end-to-end against a fixture team).
- [ ] `genie stop <native-teammate>` writes a `stop_request` inbox message to the teammate, verified by reading `~/.claude/teams/<team>/inboxes/<name>.json` post-stop.
- [ ] The native teammate, when next prompted, sees the `stop_request` advisory and terminates its loop (verified manually in Group 3).
- [ ] `genie resume <native-teammate>` exits with the pinned print-and-exit error (Group 2 deliverable 4) — no spurious re-attach to the orchestrator's session.
- [ ] `engineer/AGENTS.md`, `qa/AGENTS.md`, `reviewer/AGENTS.md`, `team-lead/AGENTS.md` each contain the graceful-stop protocol snippet (verifiable by `grep "stop_request" plugins/genie/agents/*/AGENTS.md`).

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add `transport: 'native'` to executor types + registry, wire `createAndLinkExecutor` into the native-teammate registration path, update `suspendWorker` dispatch. |
| 2 | engineer | Update `handleWorkerStop` user-facing messaging + error path; refresh the "no executor linked" branch to a generic stale-FK message. |
| 3 | qa | Author regression tests covering native-teammate spawn → stop → resume and spawn → kill, run full `bun run check`, and validate against a real native team fixture. |

## Execution Groups

### Group 1: Native transport + executor parity at registration

**Goal:** Every native-teammate registration creates an executor row and links it as the agent's `current_executor_id`, with a `'native'` transport label that downstream consumers handle correctly.

**Deliverables:**
1. `transport: 'native'` added to `src/lib/executor-types.ts` (and any Zod schema / type guard that enumerates transport values).
2. `resolveExecutorTransport` (in `src/term-commands/agents.ts`) returns `'native'` when the spawn path is the native-teammate registration flow.
3. Native-teammate registration call sites (`registerAsTeamLead` + the `notifySpawnJoin` branch when no Genie-owned pane is created) call `createAndLinkExecutor` with the resolved transport, capturing `claudeSessionId` from the parent CC session, `tmuxPaneId = null`, and `repoPath` from the team config.
4. `suspendWorker` in `src/lib/idle-timeout.ts` dispatches on transport: for `'native'` it skips `kill-pane`, marks the executor terminated, and returns true.
5. Add `sendStopAdvisory(team, agentName)` helper that calls `nativeTeams.writeNativeInbox(team, agentName, msg)`. Concrete `msg` shape (matches existing `NativeInboxMessage` interface in `src/lib/claude-native-teams.ts:61` plus the new `kind` discriminant added in this group): `{ from: 'genie-stop', text: 'Operator requested stop. Please complete current turn and exit gracefully.', summary: 'Stop requested', timestamp: new Date().toISOString(), color: 'red', read: false, source: 'system', meta: { kind: 'stop_request', requestedAt: <iso>, requestedBy: process.env.USER, reason: 'operator_stop' } }`. Group 1 also extends the `NativeInboxMessage` type with an optional `kind?: 'message' | 'stop_request'` top-level field (default `'message'`) so consumers can pattern-match without descending into `meta`.
6. In `handleWorkerStop`, when the resolved transport is `'native'`, call `sendStopAdvisory(team, agentName)` BEFORE `suspendWorker` so the inbox write succeeds even if executor termination races.

**Acceptance Criteria:**
- [ ] `bun run typecheck` passes after the type addition.
- [ ] A unit test covering `suspendWorker(executor with transport='native')` asserts no `executeTmux` call is made and the executor ends in `state='terminated'`.
- [ ] A unit test covering native-teammate registration asserts `current_executor_id` is set on the agent row immediately after registration completes.
- [ ] A unit test covering `handleWorkerStop` for a `transport='native'` agent asserts a `stop_request` inbox message is written to `~/.claude/teams/<team>/inboxes/<name>.json` BEFORE `suspendWorker` runs.

**Validation:**
```bash
bun run typecheck
bun test src/lib/idle-timeout.test.ts src/lib/claude-native-teams.test.ts
```

**depends-on:** none

---

### Group 2: Update `genie stop` UX for the new invariant

**Goal:** With executor parity in place, the "no active executor linked" branch only fires for genuinely broken state, and the user-facing stop messaging is accurate for native teammates.

**Deliverables:**
1. Reword the `handleWorkerStop` error branch (`src/term-commands/agents.ts` ~line 2503) so it no longer cites "native Claude Code teammate" — that path is no longer expected. The new message points at `genie kill` for stale-FK cases plus a "report this" hint, since post-fix it indicates a real bug.
2. The "session preserved" hint for native teammates explicitly states the rejoin semantics: `Session preserved (parent Claude Code session): <UUID>. Resume rejoins the parent CC conversation, not a teammate-private session.` If the captured `claudeSessionId` is the team-lead's UUID (as is typical for native teammates), include the leader's name in the message: `Resume rejoins parent session led by <leader-name>.`
   **Resume mechanics — pinned:** `genie resume <native>` for a `transport='native'` row MUST NOT attempt to fork a teammate-private session (one does not exist). The implementation either (i) re-enters the parent CC session via `claude --resume <UUID>` if the operator is on the same host AND the parent session is still alive, OR (ii) prints a clear error: `Native teammates cannot be resumed in isolation — re-attach to the parent Claude Code session for team <name> and use the @-mention to re-engage <agent>.` Group 2 deliverable 4 (NEW): pick (i) or (ii) and pin it in `handleWorkerResume` for `transport='native'`. Default recommendation: **(ii) — print-and-exit**, because (i) would re-attach to the orchestrator's full conversation (not a teammate scope), surprising operators. (i) is a follow-up if real demand emerges.
3. No-regression check: tmux + process (inline + claude-sdk) stop paths print the same output as before.
4. **Resume dispatch for `transport='native'`** — `handleWorkerResume` detects the native transport and emits the print-and-exit message defined in deliverable 2 (do not call the resume-into-CC path). Add a unit test asserting native-transport resume exits with a clear error and non-zero code, with no provider call.
5. **Teammate prompt-template updates** — author the graceful-stop protocol snippet (location: `plugins/genie/agents/_shared/stop-protocol.md` or the equivalent existing shared-prompt mechanism if one exists; verify before writing) and include it in `engineer/AGENTS.md`, `qa/AGENTS.md`, `reviewer/AGENTS.md`, and `team-lead/AGENTS.md` minimally. Snippet text instructs the agent to inspect its native inbox at turn-close, recognize `meta.kind === 'stop_request'` (or top-level `kind === 'stop_request'`), and exit gracefully with a short summary instead of starting a new turn. If a shared-include mechanism does not exist, inline the snippet in each AGENTS.md with a clearly-marked region. Other roles (`fix`, `trace`, `pm`, `docs`, `refactor`, council variants) are tracked as a follow-up issue — path (b) is **best-effort** for those until updated.

**Acceptance Criteria:**
- [ ] `bun run lint` passes with the new strings.
- [ ] Snapshot or string-equality test on `handleWorkerStop` output for tmux agents is unchanged.
- [ ] New string-equality test for native-teammate stop output asserts the user-facing copy.

**Validation:**
```bash
bun run lint
bun test src/term-commands/
```

**depends-on:** Group 1

---

### Group 3: End-to-end regression coverage + full gate

**Goal:** Lock the fix in with a regression test that exercises the full spawn-then-stop flow for a native teammate, plus the `bun run check` gate.

**Deliverables:**
1. New test file (or extension of `src/lib/claude-native-teams.test.ts`) with three cases:
   - Spawn a native teammate against a fixture team → assert `agent.currentExecutorId` is non-null and the executor row has `transport='native'`.
   - Run `handleWorkerStop` against that agent → assert exit success, executor `state='terminated'`, agent `state='suspended'`.
   - Run `handleWorkerKill` against a fresh native teammate → assert agent row removed and native team member entry deactivated (regression guard).
2. Manual smoke test recipe in the PR description (since native teammates require a live Claude Code session, the fully-automated test stops at the registry-level assertions; the manual recipe covers the human-visible UX).
3. `bun run check` clean.

**Acceptance Criteria:**
- [ ] All three new test cases pass.
- [ ] Manual smoke recipe exits 0 when run against a fresh native team.
- [ ] `bun run check` exits 0.

**Validation:**
```bash
bun test src/lib/claude-native-teams.test.ts
bun run check
```

**depends-on:** Group 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: `genie spawn fix --team <native-team>` followed by `genie stop fix` exits 0 and prints "Agent fix stopped." with the session-preserved hint.
- [ ] Functional: after `genie stop fix`, `genie resume fix` re-attaches to the same CC conversation (session UUID matches the pre-stop value).
- [ ] Integration: the native team `config.json` member entry survives a `genie stop`/`genie resume` round-trip (only `genie kill` should deactivate it).
- [ ] Regression: tmux-spawned agents continue to stop/resume identically — no behavioral diff in `genie stop` output for non-native cases.
- [ ] Regression: `genie kill <native-teammate>` still removes the agent row and unregisters the native member.
- [ ] Failure mode: when an agent row genuinely has a stale `current_executor_id` (FK pointing at a deleted executor), the new error message fires and points at `genie kill` plus a "report this" hint.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Adding a `'native'` transport breaks downstream consumers that exhaustively switch on transport (e.g., `resolveExecutorTransport`, scheduler-daemon, TUI sidebar). | Medium | Group 1 includes an audit pass over every `transport ===` / `switch (transport)` site. Type system makes the audit mechanical: add the variant, fix every non-exhaustive switch the typechecker flags. |
| Existing native-teammate agent rows in the wild have `current_executor_id = NULL` post-upgrade and will hit the (now-rare) error branch on `genie stop`. | Low | Pinned via the Rollout Step section: operators with pre-fix native teammates run `genie kill <name>` once on legacy rows and re-spawn; subsequent spawns get the new behavior automatically via lazy backfill. No migration needed. |
| Native teammate ignores the `stop_request` inbox advisory (e.g., custom system prompt that doesn't read inbox, or teammate is wedged mid-turn with no turn-close coming). | Medium | Path (a) executor parity still ensures `genie stop` exits cleanly with state-tracking correctness. Group 2 deliverable 5 ships the graceful-stop protocol snippet into the four core teammate AGENTS.md files (engineer/qa/reviewer/team-lead) so the advisory is honored; other roles are best-effort until prompt updates land. Operators escalate to `genie kill` (the destructive nuclear option) when the advisory doesn't take effect. Group 3 manual smoke recipe verifies the happy path; the escalation path is documented in the PR description. |
| Prompt-template snippet drifts (a teammate AGENTS.md is rewritten without the snippet, silently regressing path (b)). | Low | Group 3 regression test greps `plugins/genie/agents/*/AGENTS.md` for the `stop_request` marker and fails if any of the four core teammate roles is missing it. CI runs the same check via `bun run check`. |
| `NativeInboxMessage` type extension (`kind` field) breaks existing inbox readers. | Low | The new field is optional with a back-compat default of `'message'`; existing readers ignore it. Group 1 typechecker run verifies all consumers compile. |
| `claudeSessionId` for a native teammate is the parent CC session, not a teammate-specific UUID — resume semantics may surprise operators. | Medium | Group 2 deliverable #2 pins the rejoin-semantics messaging in the user-visible "session preserved" hint, so operators see exactly what resume will do. No ambiguity at runtime. |

---

## Review Results

### Codex Review - 2026-04-28 (Plan)

**Verdict:** BLOCKED

**Evidence:**
- `genie wish parse fix-stop-native-teammate` passed.
- `genie wish lint fix-stop-native-teammate` passed with no structural violations.
- `gh issue view 1330` passed; issue #1330 is open and matches the reported failure that `genie stop` cannot stop native Claude Code teammates because no executor is linked.

**Blocking gap:**
- HIGH: The plan may only make `genie stop` appear successful without stopping the native teammate. It says native transport should skip `kill-pane` and mark the executor terminated while deferring the inbox-based stop path. Revise the plan to define the actual native stop mechanism: bring `writeNativeInbox` / `please-stop` into scope, identify a real native Claude Code stop signal, or add evidence that marking the executor terminated is consumed by the native runtime and halts work. Add success/QA criteria that verify the teammate stops producing work, not just DB state changes.

**Non-blocking gap:**
- MEDIUM: Legacy-row handling is inconsistent. Scope OUT says existing rows will be backfilled lazily, Decision #4 says lazy backfill, but Risks say operators must `genie kill` legacy rows. Choose one behavior and update deliverables/tests or the risk text accordingly.

---

### Claude Code Review - 2026-04-28 (Plan)

**Verdict:** AGREE with Codex BLOCKED, with a more specific recommendation.

**Agreement with Codex on the HIGH gap:** Yes — and this is the wish's central design flaw, not a small fix. Marking the executor terminated in PG **does not stop a Claude Code teammate from continuing its current turn**. Native teammates run inside the parent CC pane that genie doesn't own; there is no kill signal genie can send. So path (a) "executor parity" gives `genie stop` a clean exit code and a tidy executor row — but the teammate keeps burning tokens and replying.

This is exactly what makes #1330 a *usability* bug rather than a state-tracking bug. Path (a) alone fixes the state tracking and leaves the usability bug intact.

**My recommendation: rescope to a hybrid (a) + (b), not either-or.**

The wish over-committed to "executor parity is enough" by deferring path (b) (writeNativeInbox-based please-stop). Reconsider:

1. **Path (a) — executor parity** for accounting/`genie stop` not erroring out. Necessary.
2. **Path (b) — writeNativeInbox advisory** — when stopping a native teammate, also write a typed `please-stop` message to the teammate's native inbox. The teammate sees it on its next turn-close and gracefully terminates its loop. Necessary for actual stop semantics.
3. Document explicitly in the stop output: *"Agent <name> stop signal sent. Native teammates terminate at next turn-close (typically <5s)."* — sets operator expectations.

Without (b), this wish ships a cosmetic fix.

**Additional concerns:**

- **MEDIUM (Codex's non-blocking gap is right) — legacy-row handling contradiction.** Scope OUT says lazy backfill on next spawn/resume; Risks say operators must run `genie kill` once on legacy rows. Resolution: lazy backfill DOES happen on the next spawn (which calls `createAndLinkExecutor`), but EXISTING rows whose agents are still alive don't get re-spawned and stay broken. Document the rollout step: *"After deploy, operators with native teammates spawned pre-fix will see `genie stop <legacy>` continue to fail; one-time mitigation is `genie kill <legacy>` then re-spawn."*
- **HIGH (own observation) — `claudeSessionId` semantics for native teammates.** Risk row 4 acknowledges this. The wish proposes capturing the parent CC session UUID, but resuming via that UUID would rejoin the parent's conversation, not the teammate's. The session-preserved hint should either omit the UUID for native transport or explicitly print `Resume rejoins parent Claude Code session.` Group 2 deliverable 2 says "decided during implementation" — pin this in the wish, don't defer to the implementer.

**Next:** /fix or replan. Specifically: add path (b) writeNativeInbox advisory to Scope IN, lock the legacy-row rollout step, and pin the session-preserved hint semantics. Then re-review.

---

## Files to Create/Modify

```
src/lib/executor-types.ts                        # add 'native' to TransportType (currently 'tmux'|'api'|'process')
src/lib/executor-registry.ts                     # type-flow only; no SQL change
src/lib/idle-timeout.ts                          # suspendWorker transport dispatch
src/lib/claude-native-teams.ts                   # extend NativeInboxMessage with optional kind field;
                                                 # registerAsTeamLead → createAndLinkExecutor;
                                                 # add sendStopAdvisory helper
src/lib/pg-seed.ts                               # transport normalization includes 'native' (currently special-cases 'inline'→'process')
src/term-commands/agents.ts                      # native-spawn registration flow + resolveExecutorTransport extension
                                                 # + handleWorkerStop messaging + handleWorkerResume native dispatch
                                                 # + sendStopAdvisory dispatch
src/term-commands/agent/show.ts                  # echo 'native' transport in detail output
src/term-commands/exec/index.ts                  # echo 'native' transport in exec list/show
plugins/genie/agents/engineer/AGENTS.md          # graceful-stop protocol snippet (path-b prerequisite)
plugins/genie/agents/qa/AGENTS.md                # graceful-stop protocol snippet
plugins/genie/agents/reviewer/AGENTS.md          # graceful-stop protocol snippet
plugins/genie/agents/team-lead/AGENTS.md         # graceful-stop protocol snippet
plugins/genie/agents/_shared/stop-protocol.md    # NEW (or inline if no shared-include mechanism)
src/lib/claude-native-teams.test.ts              # executor-parity assertions + stop_request inbox write assertions
src/lib/idle-timeout.test.ts                     # native-transport suspendWorker case
src/term-commands/agents.test.ts                 # handleWorkerStop + handleWorkerResume native coverage
```
