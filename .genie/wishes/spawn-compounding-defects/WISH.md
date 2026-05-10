# Wish: Spawn-Path Compounding Defects — Team Resolution + Settings Injection (#1710)

| Field | Value |
|-------|-------|
| **Status** | IMPLEMENTED — pending merge |
| **Slug** | `spawn-compounding-defects` |
| **Date** | 2026-05-08 |
| **Author** | genie |
| **Appetite** | medium |
| **Branch** | `wish/spawn-compounding-defects` |
| **Repos touched** | `automagik-genie` |
| **Design** | _No brainstorm — direct wish_ |
| **Issue** | [#1710](https://github.com/automagik-dev/genie/issues/1710) |
| **Related** | [#1400](https://github.com/automagik-dev/genie/issues/1400) (parent), [#1688](https://github.com/automagik-dev/genie/issues/1688) (closed, do not regress), [`master-aware-spawn`](../master-aware-spawn/WISH.md) (SHIPPED, complementary) |

## Summary

Close the four compounding defects identified in #1710 across the `genie spawn` command pipeline. Bugs 1+4 share the team-resolution code path (resolver ignores canonical team-of-self when `--team` is omitted; the CC `@<agentType>` UI hides the resulting misbinding). Bugs 2+3 share the settings-injection code path (hooks appended without dedup; `genie-hook` PreToolUse handler intercepts `AskUserQuestion` headlessly via some response field combination CC interprets as headless-handle (mechanism traced empirically per Group 2 deliverable 2), suppressing the inline UI that #1688 was filed to enable). Fixing them together — as the issue argues — restores correct master-agent binding, dedup-safe hook injection, inline `AskUserQuestion` UX, and visible misbinding warnings.

## Scope

### IN

- **(1) Spawn team-resolver fallback chain (Bug 1, P1).** When no explicit `--team` flag is passed to `genie spawn <agent>`, the resolver MUST consult `~/.claude/teams/<agent>/config.json` for self-leader registration BEFORE falling back to caller-context (tmux session / cwd / env). Resolution order:
  1. `--team` flag → use it.
  2. `~/.claude/teams/<agent>/config.json` exists AND `leadAgentId === "<agent>@<agent>"` → resolve to `<agent>` (canonical team-of-self).
  3. Caller-context fallback (current behavior, preserved for non-master agents).
  Resolver decisions emit a structured audit event (`spawn.team.resolved`) recording the chosen branch and the inputs evaluated.

- **(2) Settings-injection dedup hardening (Bug 2, P2).** Hook injection in `src/hooks/inject.ts` already has dedup via `upsertGenieEntry()` (line 194), but it keys on `isGenieDispatchCommand(h.command)` — a heuristic that misses historical/drifted command paths. Result: 65/82 team `settings.json` files on the filing host accumulated 2-7× duplicates. Harden the dedup so it (a) matches the canonical `{matcher, command, timeout}` triplet at injection time AND (b) collapses any pre-existing genie-shape entries whose command path drifted (e.g., older paths to `genie-hook` binary, codex variants). On collapse, log `dedup.collapse_drift` and emit `settings.hook.dedup.collapse_drift` audit event.

- **(3) `genie-hook` `AskUserQuestion` non-interception (Bug 3, P1).** The PreToolUse `*`-matcher hook chain currently satisfies `AskUserQuestion` headlessly via some response field combination CC interprets as headless-handle. Engineer first traces the empirical mechanism (see Group 2 deliverable 2), then patches the responsible handler(s) so AskUserQuestion calls fall through to the inline CC UI. Hooks may still observe/log. This is upstream of #1688 — that fix stays.

- **(4) Misbinding warning at spawn (Bug 4, P3).** When the resolved `--team` does not match an agent's canonical team registration (i.e., agent has a self-leader registration but spawn lands elsewhere), surface the discrepancy at spawn time (stderr): `WARN: <agent> is registered as leader of team:<canonical> but spawning into team:<actual> — pass --team <canonical> to fix or --team <actual> to suppress this warning`. The CC active-agent display annotation (`@<agentType> ⚠`) is OUT — see OUT list — because it requires a CC-side render change.

- **(5) One-time cleanup migration for accumulated duplicates.** Ship `scripts/dedup-team-settings.ts` (or equivalent in-process migration) that scans every `~/.claude/teams/*/settings.json`, deduplicates `*`-matcher PreToolUse hook entries by triplet (`matcher` + `command` + `timeout`), preserves all other hook content untouched, and writes a marker (`~/.claude/.genie/state/dedup-1710.done`) so it never re-runs. Idempotent. Dry-run mode shows planned changes without writing.

### OUT

- **No reversal of #1688.** `AskUserQuestion` stays in the default `permissions.allow` seed. Bug 3 fix is upstream of the allow-list, not a rollback.
- **No master-agent scaffolding redesign.** That is #1400's surface. This wish assumes #1400's fixes are in place (or shipped independently); it does not duplicate or extend them.
- **No re-implementation of `master-aware-spawn`.** That wish is SHIPPED (PR #1407+#1415). This wish only complements its `dir:<recipientId>` chokepoint resolution path with a self-leader fallback. The chokepoint code is not modified — `master-aware-spawn`'s test suite is included as a regression gate only.
- **No CC active-agent display annotation.** The `@<agentType> ⚠` render lives inside Claude Code's display path, not in genie source (`rg "@\${agentType}" src/` returns zero matches). Genie can only emit a stderr WARN at spawn time. The CC display annotation requires an upstream Claude Code change and is out of this wish's reach. File a separate CC issue if wanted.
- **No new schema column** for "canonical team." The information is derived from `~/.claude/teams/<agent>/config.json`'s `leadAgentId` field. No migration of `agents` or `teams` tables.
- **No retroactive re-tagging** of past misbound PG events. Historical `entity_id` values remain as recorded; only future spawns get the corrected resolution.
- **No `--headless` opt-in flag yet** for hook-mediated `AskUserQuestion` handling. YAGNI — added later if a real consumer surfaces.
- **No fix for the `permissions.allow` global rewrite re-ordering** (cosmetic key-order change in `~/.claude/settings.json` flagged in Bug 3's "side-effect" sub-section). Tracked separately if needed.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Resolver order: explicit `--team` → canonical self-leader → caller-context | Matches user mental model. Pressing enter over `genie` lands in team `genie` when registered. Caller-context fallback preserves backwards compat for non-master agents (`engineer`, `qa`, `reviewer`, etc.) which lack self-leader registrations. |
| 2 | Dedup by `{matcher, command, timeout}` triplet, not full deep-equal | Hooks are functionally identical when trigger + action + timeout match. Per-entry metadata (e.g., `_source`, future provenance keys) should not gate dedup — the triplet is what actually executes. |
| 3 | Default to non-interception for `AskUserQuestion`; no opt-in flag yet | YAGNI. The current "always intercept" default defeats #1688's UX. If headless team-lead routing turns out to be a needed feature for some integration, add `--headless` later (gated, opt-in). Default safe behavior = let inline UI render. |
| 4 | Spawn-time stderr `WARN` only; CC display annotation deferred upstream | Bug 4 is observability — silent misbinding burned the originating session. The `WARN` at spawn surfaces it loudly once. The CC active-agent display annotation (`@<agentType> ⚠`) requires a Claude Code render change (no genie-source surface — `rg "@\${agentType}" src/` returns zero matches). Filed for upstream CC follow-up; not in this wish's reach. |
| 5 | One-time cleanup migration runs idempotently, marks completion | The 65/82 host state on the filing machine is data-corruption-grade. Letting users hit the new dedup guard naturally would still leave the old duplicates dispatching N times per `PreToolUse *`. One migration, marker file, done. |
| 6 | Resolver emits `spawn.team.resolved` audit event for every decision | Structured observability replaces "I think it bound to X." Operators can `genie events list --since 5m --type spawn.team.resolved` and verify resolution in real time. Closes the inference gap that took #1710 a `/trace` to surface. |

## Success Criteria

- [x] Pressing enter over `genie` (no `--team`) when `~/.claude/teams/genie/config.json` exists with `leadAgentId: "genie@genie"` resolves to `genie@genie` (NOT caller-context team).
- [x] Same applies to all master agents on the filing host (`felipe`, `genie`, `genie-pgserve`, `email`) — each spawns into its canonical team when self-leader registration exists.
- [x] `genie spawn engineer --team <team>` run twice in a row leaves `~/.claude/teams/<team>/settings.json` with exactly ONE `*`-matcher PreToolUse hook entry. Audit events show one `injected` and one `dedup.skip`.
- [x] `AskUserQuestion` calls in a master-agent session render the inline CC UI (multi-select, preview content, header chips) — not a team-lead approval message.
- [x] When spawning with `--team X` while the agent's canonical team is `Y`, spawn-time stderr includes the `WARN:` line per Bug 4 fix direction. CC active-agent display annotation is OUT (separate upstream concern).
- [x] One-time cleanup migration removes duplicate hook entries from all `~/.claude/teams/*/settings.json` files; idempotent on re-run (marker present → no-op); emits `settings.dedup.completed` audit event with affected-file count.
- [x] No regression on #1688 — `permissions.allow` continues to seed `AskUserQuestion` for fresh `genie team create` invocations.
- [x] No regression on `master-aware-spawn` SHIPPED behavior — `dir:<recipientId>` chokepoint resolution still works for masters with `dir:` rows; new resolver path complements rather than replaces it.
- [x] `bun test` passes; new tests cover Bugs 1, 2, 3, 4 individually plus the dedup migration.
- [x] On the filing host (or equivalent fixture), running the cleanup migration reduces duplicated `*`-matcher hooks to zero across all 82 team settings files.

## Execution Strategy

Two waves. Wave 1 is **parallel** because the two code paths are decoupled per the issue's framing ("Bugs 1+4 share team-resolution, Bugs 2+3 share settings-injection"). Wave 2 is sequential and depends on Wave 1's Group 2 because the cleanup migration must not run while the un-fixed injection path can re-pollute.

### Wave 1 (parallel)

| Group | Agent | Description | Status |
|-------|-------|-------------|--------|
| 1 | engineer | Team-resolution fallback chain + misbinding warnings (Bugs 1, 4) | ✅ commit `a850d04a` |
| 2 | engineer | Settings-injection dedup guard + `AskUserQuestion` non-interception (Bugs 2, 3) | ✅ commit `83251b53` |

### Wave 2 (sequential, after Wave 1 ships)

| Group | Agent | Description | Status |
|-------|-------|-------------|--------|
| 3 | engineer | One-time cleanup migration for accumulated duplicates | ✅ this commit |

## Execution Groups

### Group 1: Team-Resolution Fallback Chain + Misbinding Warnings (Bugs 1 + 4)

**Goal:** Make `genie spawn <agent>` (no `--team`) prefer the agent's canonical team-of-self when one is registered, and surface a visible warning when the resolved team diverges from the canonical registration.

**Deliverables:**
1. Modify the spawn-time team resolver. Verified anchors: `src/term-commands/team.ts:306-320` (tmuxSessionName resolution), `src/lib/protocol-router.ts` (spawn entry), `src/lib/provider-adapters.ts` (native team adapter). Implement the three-step fallback chain in IN(1) at the resolver entry point.
2. Emit `spawn.team.resolved` audit event with `{agent, resolvedTeam, source: "explicit_flag" | "canonical_self_leader" | "caller_context", canonicalTeam}` for every spawn.
3. Add the misbinding `WARN` line to spawn stderr when `resolvedTeam !== canonicalTeam` AND a canonical registration exists.
4. (deleted — CC display annotation is out of scope; see OUT list).
5. New unit test: `src/lib/__tests__/team-resolver.test.ts` (colocated convention — see `src/hooks/__tests__/inject.test.ts` for prior art) covering the four cases in the table below. Canonical path; do not split or rename — validation command hardcodes this exact file.

| Case | `--team` | Self-leader registered | Caller context | Expected resolution |
|------|----------|------------------------|----------------|---------------------|
| 1 | `foo` | irrelevant | irrelevant | `foo` |
| 2 | (omitted) | yes (`<agent>@<agent>`) | `bar` | `<agent>` (canonical) |
| 3 | (omitted) | no | `bar` | `bar` (caller fallback) |
| 4 | `bar` | yes, but `bar !== <agent>` | irrelevant | `bar`, with WARN on stderr (no display annotation — see OUT) |

**Acceptance Criteria:**
- [x] Spawning `genie` with no `--team` from any tmux session resolves to team `genie` (assert via `genie events list --since 1m --type spawn.team.resolved`).
- [x] All four resolver test cases pass.
- [x] When Case 4 fires, stderr includes the `WARN:` line. (CC display annotation is OUT — see OUT list.)
- [x] Resolver does not regress non-master agents — `engineer`, `qa`, `reviewer` (no self-leader registration) continue resolving via caller-context.
- [x] No regression on `master-aware-spawn`'s `dir:<recipientId>` chokepoint path (covered by existing `master-aware-spawn` tests, which must still pass).

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  bun test src/lib/__tests__/team-resolver.test.ts && \
  bun test src/lib/protocol-router-spawn.test.ts src/lib/team-auto-spawn.test.ts
```

**depends-on:** none

---

### Group 2: Settings-Injection Dedup Guard + `AskUserQuestion` Non-Interception (Bugs 2 + 3)

**Goal:** Make hook injection idempotent on re-spawn AND let `AskUserQuestion` calls render the inline CC UI instead of being satisfied headlessly by `genie-hook`.

**Deliverables:**
1. Modify `src/hooks/inject.ts:upsertGenieEntry()` (line 194). Current dedup is fragile — keyed on `isGenieDispatchCommand(h.command)`, a heuristic that misses drifted paths. Strengthen: (a) match canonical triplet `{matcher, command, timeout}` exactly for the inject-time check; (b) add a separate genie-shape pass that detects ANY genie-dispatch entry (current or historical command paths via fuzzy match on path-suffix `genie-hook`) and collapses them to the single canonical entry. Both branches log `dedup.skip` (exact match) or `dedup.collapse_drift` (path-drift collapse) and emit corresponding audit events. Bug-2 anchor: log site at `src/term-commands/agents.ts:2158`.
2. **TRACE-FIRST (precedes any patch).** Engineer reproduces the AskUserQuestion suppression in a master-agent session and traces which handler response satisfies CC headlessly. Candidates to verify per response: (a) `permissionDecision: "allow"` alone; (b) `permissionDecision: "allow" + updatedInput`; (c) `additionalContext` injection on PreToolUse. Document the empirically-confirmed mechanism in a `evidence/bug3-mechanism.md` artifact under the wish dir. Patch in deliverable 3 targets the confirmed mechanism, not the wish's prior hypothesis.
3. Modify the responsible handler(s) identified in deliverable 2 (one or more of `src/hooks/handlers/audit-context.ts`, `freshness.ts`, `orchestration-guard.ts`, `brain-inject.ts`) so that, for AskUserQuestion PreToolUse events, the response does NOT satisfy CC headlessly. The handler may still observe/log; it must let the call fall through to the inline CC UI.
4. Extend `src/hooks/__tests__/inject.test.ts` (which already has a "does not duplicate AskUserQuestion across re-injections" test on line 108 — natural anchor) with the dedup-triplet cases for Bug 2: spawn-twice fixture asserts exactly one matching hook entry; second injection logs `dedup.skip`.
5. New unit test: `src/hooks/__tests__/asku-passthrough.test.ts` — feed an `AskUserQuestion` PreToolUse payload, assert the handler response does NOT satisfy CC headlessly per the empirical mechanism documented in `evidence/bug3-mechanism.md` (deliverable 2). Test assertion shape is determined by the trace step; do not pre-assume `permissionDecision: "allow"` is the load-bearing field.

**Acceptance Criteria:**
- [x] Two consecutive `genie spawn engineer --team <fresh-team>` invocations leave `~/.claude/teams/<fresh-team>/settings.json` with exactly one `*`-matcher PreToolUse hook entry.
- [x] PG audit events: fresh injection emits 1× `settings.hook.injected`; identical re-injection emits 1× `settings.hook.dedup.skip`; injection over a path-drifted genie-shape entry emits 1× `settings.hook.dedup.collapse_drift` and leaves the file with one canonical entry.
- [x] In a master-agent session, calling `AskUserQuestion` renders the inline CC UI. **Evidence:** screenshot attached to PR description showing the inline picker (multi-select, header chip) — no team-lead approval message.
- [x] `genie-hook` unit test (`src/hooks/__tests__/asku-passthrough.test.ts`) asserts the handler response shape that the trace step (Group 2 deliverable 2) identified as the load-bearing headless-handle mechanism is NOT present for `AskUserQuestion` payloads.
- [x] Existing genie-hook tests pass (no regression on other tool intercepts).

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  bun test src/hooks/__tests__/inject.test.ts && \
  bun test src/hooks/__tests__/asku-passthrough.test.ts && \
  bun test test/hooks/   # integration suite (daemon-outage, genie-hook-binary, genie-hook-perf) — no regressions
```

**depends-on:** none

---

### Group 3: One-Time Cleanup Migration for Accumulated Duplicates

**Goal:** Remove the existing duplicated `*`-matcher hook entries across `~/.claude/teams/*/settings.json` (65/82 affected on the filing host) without disturbing any other hook content.

**Deliverables:**
1. New script `scripts/dedup-team-settings.ts` (Bun-runnable) that:
   - Iterates `~/.claude/teams/*/settings.json`
   - For each file, dedupes entries in `hooks.<eventType>` arrays by the same triplet rule used in Group 2.
   - Preserves all non-matching hook entries, key order outside the deduped array, and file mtime semantics (write only if changes made).
   - Supports `--dry-run` (default) and `--apply` modes; dry-run prints diff, apply writes + emits `settings.dedup.completed` audit event with `{filesScanned, filesModified, entriesRemoved}`.
   - Writes marker file `~/.claude/.genie/state/dedup-1710.done` after successful apply; future invocations no-op when marker present unless `--force`.
2. Unit test: `scripts/dedup-team-settings.test.ts` (colocated convention — see `scripts/archive-orphan-team-configs.test.ts`, `scripts/complexity-budget.test.ts` for prior art) with fixture team-settings files containing 1×, 2×, 6× duplicates → assert correct dedup, marker write, idempotency.
3. Documentation: short README at `scripts/dedup-team-settings.README.md` (or inline doc-block) explaining when/why to run it.

**Acceptance Criteria:**
- [x] Running `bun scripts/dedup-team-settings.ts --apply` on a fixture matching the filing host's distribution (top: 7× unify-genie, 6× wish-cmd-v2, etc.) reduces duplicate `*`-matcher entries to zero in every file.
- [x] Re-running with marker present emits `dedup.skip.marker_present` and exits 0 without scanning.
- [x] Re-running with `--force` re-scans but is a no-op when no duplicates remain.
- [x] No non-matching hook entries are touched (verified by per-file unified diff in `--dry-run`).
- [x] Audit event `settings.dedup.completed` fires once, with accurate counts.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  bun test scripts/dedup-team-settings.test.ts && \
  bun scripts/dedup-team-settings.ts --dry-run  # smoke against current host (read-only)
```

**depends-on:** Group 2

> Rationale: the dedup guard from Group 2 must be live, or the migration's effect is undone by the next spawn.

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional (Bug 1):** Pressing enter over a master agent (`genie`, `felipe`, `genie-pgserve`, `email`) with no `--team` resolves to its canonical team. Verify via `genie events list --since 5m --type spawn.team.resolved`.
- [ ] **Functional (Bug 3):** In a freshly spawned master-agent session, an `AskUserQuestion` call renders the inline CC UI (manual smoke). Compare to behavior on `main` pre-merge (regression baseline).
- [ ] **Integration (Bug 2):** After running `genie team create <fresh>` followed by two `genie spawn engineer --team <fresh>` calls, `~/.claude/teams/<fresh>/settings.json` shows exactly one `*`-matcher PreToolUse entry.
- [ ] **Integration (Bug 4):** `genie spawn felipe --team genie` (force misbind) emits the WARN line on stderr. (CC display annotation is out of this wish's scope — see OUT.)
- [ ] **Migration (Group 3):** On a host with pre-existing duplicates, `bun scripts/dedup-team-settings.ts --apply` removes them and writes the marker. Re-run is no-op.
- [ ] **Regression (#1688):** `genie team create <fresh-2>` seeds `permissions.allow: ["AskUserQuestion"]` in the new team's `settings.json` (unchanged from `main`).
- [ ] **Regression (`master-aware-spawn`):** Existing master-recovery flow via `dir:<recipientId>` chokepoint still resolves session UUIDs on team-lead "hire" (existing test suite passes).
- [ ] **No spawn perf regression** — `genie spawn` wall-clock latency stays within ±15% of pre-merge baseline (measured via `command_success.duration_ms` over 20 spawns).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Resolver change breaks an automation that depends on caller-context as the implicit default for some master agent | Medium | Keep caller-context fallback when no `leadAgentId === "<agent>@<agent>"` registration exists. Emit `spawn.team.resolved` audit event so any divergence is observable. Surface a one-time `WARN` for the first 7 days post-merge so silent breakage gets noticed. |
| Hook non-interception breaks a downstream integration that relied on team-lead approval routing for `AskUserQuestion` | Medium | Pre-merge: `genie events list --since 30d --type tool_use --where details.tool='AskUserQuestion'` to identify any consumer. If found, gate fix behind `--headless` opt-in flag; otherwise default behavior change is safe. |
| Cleanup migration deletes a hook entry the user genuinely customized (e.g., custom `command` path) | Low | Inject-time triplet dedup keeps non-genie hooks untouched. The drift-collapse pass from IN(2)(b) targets ONLY entries whose command path-suffix matches genie-hook variants — purely-custom hooks with unrelated command names are not touched. Dry-run is default; user must explicitly `--apply`. Diff preview shown before write. |
| Bundle byte-offsets in #1710 are approximate; actual code paths may live in modules the issue's hypothesis didn't pinpoint | Low | Engineer confirms via `rg` on the log strings (`injected genie hook dispatch`, `permissionDecision`, `tmuxSessionName`) before editing. The issue gives strings as anchors, not bundle offsets, for exactly this reason. |
| The `master-aware-spawn` shipped path (`dir:<recipientId>` chokepoint) interacts unexpectedly with the new self-leader resolver | Low | Group 1 tests include the `master-aware-spawn` test suite (`src/lib/protocol-router-spawn.test.ts`, `src/lib/team-auto-spawn.test.ts`) as a regression gate. Resolver order ensures explicit `--team` still wins (so `master-aware-spawn`'s team-lead "hire" path is unaffected). |
| `permissions.allow` re-injection (Bug 3 side-effect — global file rewrite) remains, causing minor key-order churn in `~/.claude/settings.json` | Low | Out of scope per OUT list. Filed as cosmetic follow-up if it causes friction. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Modify (verified anchors)
src/lib/protocol-router.ts                       # Bug 1: spawn entry — verify resolver site with rg "tmuxSessionName"
src/lib/provider-adapters.ts                     # Bug 1+4: native team adapter (single file, not a directory)
src/term-commands/team.ts                        # Bug 1: tmuxSessionName resolution at line 306-320
src/term-commands/agents.ts                      # Bug 2: injection log site at line 2158 ("injected genie hook dispatch")
src/hooks/inject.ts                              # Bug 2: hook-injection function — target for dedup guard
src/hooks/index.ts                               # Bug 3: PreToolUse handler with permissionDecision logic
src/hooks/handlers/                              # Bug 3: per-handler files if AskUserQuestion has its own

# Modify (extend existing)
src/hooks/__tests__/inject.test.ts               # Group 2: extend with triplet-dedup cases (Bug 2)

# Create (new)
scripts/dedup-team-settings.ts                   # Group 3 migration
scripts/dedup-team-settings.test.ts              # Group 3 test (colocated — see scripts/*.test.ts convention)
scripts/dedup-team-settings.README.md            # Group 3 operator doc
src/lib/__tests__/team-resolver.test.ts          # Group 1: Bug 1+4 resolver cases (or extend src/lib/protocol-router-spawn.test.ts)
src/hooks/__tests__/asku-passthrough.test.ts     # Group 2: Bug 3 non-interception assertion
```
