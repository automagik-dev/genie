# Wish: Fix Ghost-Approval P0 — Kill the `'pending'` leadSessionId Literal

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-ghost-approval-p0` |
| **Date** | 2026-04-10 |
| **Priority** | P0 — worst active bug in the product |
| **Parent** | Split out of `.genie/wishes/perfect-spawn-hierarchy/WISH.md` |
| **Related** | Commit `7c21301a6` (2026-04-02 partial fix), Issue #1094 (2026-04-09 SDK-path fix) |

## Summary

Two spawn paths in genie (`team-auto-spawn.ts` and `session.ts`) create a native team config with `leadSessionId: "pending"` — a literal placeholder that nothing ever reconciles. When a teammate later writes a new file at its project cwd root, Claude Code's permission gate routes the request to `~/.claude/teams/<team>/inboxes/team-lead.json` and looks up the leader by session ID. The ghost leader never answers. Result: the teammate sees `"The user doesn't want to proceed with this tool use"` and silently gives up. This wish is a **surgical minimal fix** that (a) mints or discovers a real Claude Code session UUID before the new CC process launches, (b) writes that UUID to the team config, (c) launches CC with `--session-id <uuid>` so the config and the CC process agree, and (d) proves the fix with a real reproducer. Three-layer hierarchy, auto-approver daemon, and `genie doctor` Team Health are explicitly DEFERRED to a follow-up wish.

## Context

See `.genie/wishes/perfect-spawn-hierarchy/WISH.md` for the full trace, the 44-request-backlog evidence, and the broader architectural diagnosis. This wish is the **narrow surgical bite** that can ship today and prove the theory before we invest in the bigger hierarchy/doctor/migration work.

**Primary root cause — two code sites hardcode the `'pending'` literal:**
- `src/lib/team-auto-spawn.ts:144` — Omni recovery path: `ensureNativeTeam(teamName, ..., 'pending', leaderName)`
- `src/genie-commands/session.ts:77` — interactive session path: `ensureNativeTeam(teamName, ..., 'pending', leaderName)` with a comment that falsely claims "CC updates it internally once started".

**Why the naive fix of "resolve the caller's session ID first" doesn't work here:** both paths are launching a **new** Claude Code process in tmux. At `ensureNativeTeam()` call time, the new CC process doesn't exist yet — there's no JSONL file and no `CLAUDE_CODE_SESSION_ID` env var to read. We have to either (a) pre-mint a UUID and force CC to use it via `--session-id`, or (b) defer the write until after CC boots and self-registers. Approach (a) is already supported by the existing `buildTeamLeadCommand()` helper in `src/lib/team-lead-command.ts:70-72`, so we use it.

**The resume case works the same way by reading the existing JSONL:** `sessionExists()` already scans `~/.claude/projects/<encoded-cwd>/*.jsonl` for a `custom-title` match. We extend that helper (or add a sibling) to return the matching JSONL's UUID so we can write it to the team config before passing `--resume <name>` to CC.

## Scope

### IN

- Replace the hardcoded `'pending'` literal in `src/lib/team-auto-spawn.ts:144` with a real session UUID.
- Replace the hardcoded `'pending'` literal in `src/genie-commands/session.ts:77` with a real session UUID.
- Add a helper that, given a team name + working directory, returns:
  - `{ sessionId, shouldResume: true }` if an existing `.jsonl` for this team is found (reuse its UUID, CC will `--resume` by name).
  - `{ sessionId, shouldResume: false }` if no prior session exists (mint a fresh `crypto.randomUUID()`, CC will `--session-id` into it).
- Ensure `ensureNativeTeam()` **upserts** a stale `leadSessionId` (`"pending"` or any non-UUID) with the newly resolved ID, so machines that already have the broken config get healed on the next spawn.
- Pass the resolved `sessionId` through to `buildTeamLeadCommand()` so the new CC process boots with that exact UUID (or resumes by name into the existing JSONL, whose UUID we also wrote to the config).
- One new unit test file covering the helper (fresh mint path, resume-by-existing-jsonl path, stale config upsert path).
- One integration-ish test that exercises `ensureTeamLead()` end-to-end with a pre-seeded stale config and asserts the resulting config has a UUID, not `"pending"`.
- A reproducer script (or manual steps captured in a markdown checklist) that matches the 2026-04-10 failure: fresh team → spawn a teammate → teammate writes `.test-marker` at cwd root → succeeds.
- Update the lying comment at `src/genie-commands/session.ts:63`.

### OUT

- **Three-layer hierarchy** (master → task-lead → underling routing). Deferred to the parent wish.
- **Auto-approver daemon.** Deferred.
- **`genie doctor` Team Health section.** Deferred — the P0 must land first; doctor coverage gets reevaluated after.
- **Migration script / `genie doctor --fix` auto-remediation** for existing broken machines. Deferred. (In-process upsert on the next spawn will heal live-in-use teams as a side-effect; explicit migration is only needed for teams that are never respawned.)
- **Changes to `src/lib/protocol-router-spawn.ts`.** That path already calls `discoverClaudeParentSessionId()` for its parent session; it's a separate class of bug. Hardening its `?? \`genie-${team}\`` fallback is part of the deferred residual wish.
- **Architecture docs / troubleshooting write-up.** Deferred.
- **Any `genie spawn`-side hierarchy work.** The P0 only fixes the two `ensureNativeTeam('pending', ...)` sites that run before CC boots.
- **Editing the `'pending'` fixture in `src/lib/team-auto-spawn.test.ts:58`** — that test intentionally seeds a broken config to exercise detection. Leave it alone.

## Decisions

| Decision | Rationale |
|----------|-----------|
| **Pre-mint the session UUID and pass it via `--session-id`, don't wait for CC to self-register.** | `buildTeamLeadCommand()` already supports `--session-id`. The "wait for CC to self-register" model is exactly what the lying comment at `session.ts:63` claims today, and it's been wrong for weeks. Pre-minting is synchronous, deterministic, and race-free. |
| **In the resume case, read the UUID from the existing JSONL filename.** | Claude Code stores sessions as `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. When we pass `--resume <name>`, CC loads the JSONL whose `custom-title` matches. The filename UUID IS the session ID. We scan for the match and write the UUID to the config before launching CC. No race. |
| **Force-upsert stale `leadSessionId`.** | Without this, a machine that already has `"pending"` in its config from a previous broken run will hit the `if (existing) return existing;` short-circuit in `ensureNativeTeam()` and keep the broken value. Upserting in place heals those machines on the next spawn, no migration script needed. |
| **Ship two tests only.** | One helper unit test and one config-upsert integration test. This is a P0 surgical fix — the test bar is "prove the fix works", not "achieve full coverage". Full regression sweeps are part of the residual wish. |
| **Ship a reproducer, not a mock.** | A live test that spawns a teammate and writes a new cwd-root file is the only proof that actually matters. If the automated integration test and the manual reproducer both pass on the `@next` publish, the P0 is done. |
| **Explicitly keep the `'pending'` fixture in `team-auto-spawn.test.ts`.** | That test is validating detection of broken configs. The fixture is intentional. Don't regress the test. |
| **No `GhostLeaderError` or throw-on-miss.** | The original parent-wish design wanted to throw if nothing resolved. For the P0, we just mint a fresh UUID — there's no "miss" case because we own the ID. Throwing is deferred to `protocol-router-spawn.ts` hardening in the residual wish. |

## Success Criteria

- [ ] **Zero `'pending'` literals in production code paths.** `grep -n "'pending'" src/lib/team-auto-spawn.ts src/genie-commands/session.ts` returns zero matches.
- [ ] **`ensureNativeTeam()` is never called with a literal or synthetic session ID** from `team-auto-spawn.ts` or `session.ts`. Both sites pass a value that is either a freshly-minted `crypto.randomUUID()` or a UUID read from an existing JSONL filename.
- [ ] **Stale `leadSessionId` is force-upserted.** A config with `leadSessionId: "pending"` on disk before the spawn has a real UUID after the spawn (verified by reading `~/.claude/teams/<name>/config.json`).
- [ ] **The new CC process boots with the same UUID that was written to the config.** Verified by: spawning, reading the config, finding the corresponding `~/.claude/projects/<cwd>/<uuid>.jsonl` on disk.
- [ ] **Unit test for the resolver helper** covers: (a) no prior JSONL → mints a UUID, (b) prior JSONL exists → returns its UUID, (c) stale `"pending"` config → upserts with the resolved UUID.
- [ ] **Integration test** pre-seeds a stale config, calls the ensure-team path, and asserts the config's `leadSessionId` is a UUID (matches `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) — never `"pending"`.
- [ ] **`bun run typecheck` is clean.**
- [ ] **`bun test` passes** — the existing `team-auto-spawn.test.ts` fixture still works, new tests pass, nothing else regresses.
- [ ] **`bun run lint` is clean** (biome check).
- [ ] **Reproducer passes on the `@next` build.** After `genie update --next` pulls in the fix: in a fresh cwd, run `genie` → inside Claude Code, spawn a teammate via `genie spawn engineer` → instruct the teammate to `Write` a new file `.test-marker` at cwd root → the write must succeed with no "user rejected" error.
- [ ] **No permission_request accumulates in the team-lead inbox** during the reproducer run. `jq 'map(select(.type=="permission_request"))|length' ~/.claude/teams/<team>/inboxes/team-lead.json` reads the same value before and after the teammate's write.

## Execution Strategy

One wave. One group. One engineer. Ship it.

### Wave 1 (single group, sequential within)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Implement the helper, fix both call sites, force-upsert stale configs, write 2 tests, update the lying comment. |
| review | reviewer | Verify acceptance criteria + run the reproducer on `@next`. |

## Execution Groups

### Group 1: Kill the `'pending'` literal + real session ID at spawn time

**Goal:** Every native team config written by `ensureTeamLead()` or `ensureNativeTeamForLeader()` contains a real Claude Code session UUID, matching the UUID the newly-launched CC process actually uses.

**Deliverables:**

1. **New helper `resolveOrMintLeadSessionId(teamName, cwd): Promise<{ sessionId: string; shouldResume: boolean }>`** in `src/lib/claude-native-teams.ts` (or a sibling file — engineer's call based on minimum-diff principle):
   - Scan `~/.claude/projects/<sanitizePath(cwd)>/*.jsonl` for a JSONL whose `custom-title` matches `sanitizeTeamName(teamName)` (the same lookup `sessionExists()` in `team-lead-command.ts` already does).
   - If a match is found → extract the UUID from the filename (`<uuid>.jsonl`) and return `{ sessionId, shouldResume: true }`.
   - Otherwise → return `{ sessionId: crypto.randomUUID(), shouldResume: false }`.
   - Exposes the underlying file scan so it can be unit-tested without spawning CC.

2. **Upsert logic for stale `leadSessionId`** — either as a new helper `hydrateLeadSessionId(teamName, realSessionId)` that:
   - Loads the existing config (if any).
   - If config exists and `leadSessionId !== realSessionId` (e.g. the stale value is `"pending"`), updates it and saves.
   - If no config exists, calls `ensureNativeTeam()` with `realSessionId`.
   - **OR** modify `ensureNativeTeam()` to take an `upsertLeadSessionId: boolean` flag. Engineer's call — whatever produces the smaller diff and clearer call sites.

3. **`src/lib/team-auto-spawn.ts:ensureTeamLead()`** — replace the call at line 144:
   ```typescript
   await ensureNativeTeam(teamName, `Genie team: ${teamName}`, 'pending', leaderName);
   ```
   with something like:
   ```typescript
   const { sessionId, shouldResume } = await resolveOrMintLeadSessionId(teamName, workingDir);
   await hydrateLeadSessionId(teamName, `Genie team: ${teamName}`, sessionId, leaderName);
   // ... later when building the CC launch command ...
   const cmd = buildTeamLeadCommand(teamName, {
     systemPromptFile: systemPromptFile ?? undefined,
     leaderName,
     ...(shouldResume
       ? { continueName: sanitizeTeamName(teamName) }
       : { sessionId }),
   });
   ```
   Note: drop the `sessionExists()`-based decision at line 166 because the new helper already computed `shouldResume`.

4. **`src/genie-commands/session.ts:ensureNativeTeamForLeader()`** — replace the call at line 77 with the same pattern. Accept the new session ID as a parameter (the outer caller is `createSession()` / `focusTeamWindow()` / `launchInsideTmux()`, which already compute resume information). Thread the `sessionId` through so all three launchers use the same value. Update `buildClaudeCommand()` signature if needed to take `sessionId` in addition to `continueName`.

5. **Delete the lying comment at `src/genie-commands/session.ts:63`** — rewrite it to describe the real flow: "The leadSessionId is resolved at spawn time by `resolveOrMintLeadSessionId()` and matches the UUID passed to CC via `--session-id` (or discovered from the existing JSONL in the resume path)."

6. **New test file `src/lib/claude-native-teams.lead-session-id.test.ts`** (or extend the existing `claude-native-teams.test.ts` if that's more idiomatic):
   - **Test 1:** With an isolated `CLAUDE_CONFIG_DIR` and an empty `~/.claude/projects/<cwd>/`, `resolveOrMintLeadSessionId("my-team", cwd)` returns `{ shouldResume: false, sessionId: <valid UUID> }`. Assert the UUID matches the UUID v4 regex.
   - **Test 2:** With a pre-seeded `<cwd>/.claude/projects/<encoded>/abc-123-....jsonl` containing a `custom-title` entry matching `my-team`, the helper returns `{ shouldResume: true, sessionId: "abc-123-..." }`.
   - **Test 3:** Pre-seed a team config with `leadSessionId: "pending"`, call `hydrateLeadSessionId("my-team", desc, "fresh-uuid-xxx", "genie")`, then load the config from disk — `leadSessionId` must be `"fresh-uuid-xxx"`.
   - **Test 4 (bonus):** Same as Test 3 but with `leadSessionId: "genie-my-team"` (the synthetic fallback) — also gets upserted.

7. **Reproducer script / manual checklist** at `.genie/wishes/fix-ghost-approval-p0/REPRO.md` that documents the exact steps to prove the fix post-publish:
   - `cd /tmp/test-repro && rm -rf ~/.claude/teams/test-repro`
   - `genie` (opens CC as team-lead)
   - Inside CC: spawn a teammate via `genie spawn engineer --team test-repro`
   - In the teammate: `Write` to `.test-marker` at cwd root
   - Expected: write succeeds, no "user rejected" error, `jq '.leadSessionId' ~/.claude/teams/test-repro/config.json` returns a real UUID.

**Acceptance Criteria:**
- [ ] `grep -n "'pending'" src/lib/team-auto-spawn.ts src/genie-commands/session.ts` returns zero matches.
- [ ] `resolveOrMintLeadSessionId` exists, is exported, and is exercised by all four new tests.
- [ ] Spawning a team writes a real UUID to `config.json` (not `"pending"`, not `"genie-<team>"`).
- [ ] Spawning a team whose config already has `"pending"` heals it to a real UUID on the next call.
- [ ] `bun run typecheck` passes.
- [ ] `bun test src/lib/claude-native-teams.test.ts src/lib/claude-native-teams.lead-session-id.test.ts src/lib/team-auto-spawn.test.ts` passes.
- [ ] `bun run lint` clean.
- [ ] REPRO.md exists at `.genie/wishes/fix-ghost-approval-p0/REPRO.md` with copy-pasteable steps.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
bun run typecheck
bun run lint
bun test src/lib/claude-native-teams.test.ts src/lib/claude-native-teams.lead-session-id.test.ts src/lib/team-auto-spawn.test.ts
! grep -n "'pending'" src/lib/team-auto-spawn.ts src/genie-commands/session.ts
```

**depends-on:** none

---

## Dependencies

- `depends-on`: none — this wish is a self-contained surgical fix.
- `blocks`: `.genie/wishes/perfect-spawn-hierarchy/WISH.md` (residual) — that wish is explicitly DEFERRED until this P0 lands and the reproducer passes.

## QA Criteria

_What must be verified on dev after merge. The QA agent (or the human) tests each criterion on the `@next` build._

- [ ] **Reproducer check:** on a fresh checkout of `dev` built via `genie update --next`, run the steps in `REPRO.md`. The teammate's `Write` to `.test-marker` at cwd root must succeed without any "user rejected" error.
- [ ] **Config check:** after the reproducer runs, `jq '.leadSessionId' ~/.claude/teams/<team>/config.json` returns a UUID (not `"pending"`, not `"genie-<team>"`).
- [ ] **No new permission_requests in the inbox:** `jq 'map(select(.type=="permission_request"))|length' ~/.claude/teams/<team>/inboxes/team-lead.json` reads the same value before and after the teammate's write.
- [ ] **Healing check:** pre-seed a team config with `leadSessionId: "pending"`, then trigger `ensureTeamLead()` (via `genie team ensure <name>` or a spawn that routes through it). The config now has a UUID.
- [ ] **No regressions:** `bun test` passes with the same or higher count than pre-wish baseline. `bun run typecheck` clean.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `--session-id` behavior in Claude Code may not actually honor the pre-assigned UUID (e.g. CC might still mint its own internally). | High | `buildTeamLeadCommand()` at `src/lib/team-lead-command.ts:70-72` already constructs `--session-id ${shellQuote(options.sessionId)}` and has been shipped. If CC didn't honor it, that code would already be broken in another place. The integration test (Criterion 4 above) verifies agreement between the config and the JSONL filename — this is the gate. |
| Concurrent `ensureTeamLead` calls race to mint different UUIDs. | Low | `ensureNativeTeam()` has a `loadConfig → short-circuit-if-exists` pattern. The loser of the race reads the winner's config; our upsert only replaces truly stale values (like `"pending"`). Two live UUIDs won't fight each other. |
| Resume-by-filename scan picks the wrong JSONL if two sessions in the same cwd have the same team name. | Low | Pick the most recently modified match (same tiebreaker `sessionExists()` effectively uses). Document in the helper. |
| `bun test` pre-existing test-pollution bug re-surfaces during the pre-push hook. | Medium | Per the last compaction: stop the local `genie serve` daemon before `git push`. Alternatively, sandbox `GENIE_HOME` in the tests we add (we already have that pattern in `omni-bridge-pidfile.test.ts` — reuse it). |
| The reproducer can't run in CI (no tmux, no interactive CC). | Medium | CI runs the unit + integration tests. The reproducer is a manual end-to-end gate on the `@next` build, tracked in `REPRO.md`. |
| We ship a UUID the config but CC resumes into a different JSONL because of a stale `custom-title`. | Low | The `shouldResume=true` path extracts the session ID from the matching JSONL's filename and writes THAT to the config. By construction, config and JSONL agree. |

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# New files
.genie/wishes/fix-ghost-approval-p0/WISH.md                      # this file
.genie/wishes/fix-ghost-approval-p0/REPRO.md                     # reproducer steps
src/lib/claude-native-teams.lead-session-id.test.ts              # unit+integration tests (or inline into existing test file)

# Modified files
src/lib/claude-native-teams.ts                                   # add resolveOrMintLeadSessionId + hydrateLeadSessionId (or upsert flag on ensureNativeTeam)
src/lib/team-auto-spawn.ts                                       # kill 'pending' (line 144); thread sessionId through buildTeamLeadCommand
src/genie-commands/session.ts                                    # kill 'pending' (line 77); thread sessionId through; rewrite lying comment (line 63)
```
