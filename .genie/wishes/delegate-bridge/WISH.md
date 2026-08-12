# Wish: Delegate Bridge — routed cards become agent turns (cross-agent W2+W3)

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `delegate-bridge` |
| **Date** | 2026-08-11 |
| **Author** | Felipe + genie orchestrator |
| **Appetite** | medium |
| **Branch** | `wish/delegate-bridge` |
| **Repos touched** | genie only (remotty verb consumed, tracked in the remotty repo) |
| **Design** | [DESIGN.md](../../brainstorms/delegate-bridge/DESIGN.md) |

## Summary

W2+W3 of the cross-agent-delegation design: the turn-per-launch bridge that turns a routed card (W1, shipped PR #2766) into actual agent turns on an isolated worktree — spike-proven seam, `genie task delegate` for single delegation, adapter cards for all five roster agents, fail-open degradation, and `genie task fan` fan-out with ratified merges. Blocked on the remotty `headless-turn-open` verb (task block on this wish's card `t_msp4fp6ce714c8be`); the docs group is deliberately unblocked.

## Scope

### IN

- Seam spike: one bounded live session proving headless turn → brief pickup → hand-back → continue-form second turn, with returned refs on a scratch card's timeline. No bridge code merges before this transcript exists.
- `genie task delegate <id>`: the bridge flow — **turn 1 only:** `requireRosterAgent` re-validation, claim via `task checkout` (transactional `claimTask` inherited), `remotty worktree prepare local <dir> <task>-<agent>`; **every turn:** brief to `$GENIE_HOME/briefs/<task>-<agent>/turn-<n>.md`, headless verb with the adapter argv, returned `{session, worktreePath, branch}` persisted as a timeline event. Turns ≥2 (`--continue`) never re-validate, re-claim, or re-prepare — they run against the timeline-recorded worktree (design review LOW-1 folded in: all four steps carry an explicit cadence).
- Adapter cards ×5 as typed genie-side data: opening + continue argv with `{brief}` placeholder, autonomy/permission flags, per-adapter brief-delivery fact (stdin or read grant); hermes stateless (follow-up briefs carry accumulated timeline context); adapters must exit per turn.
- Fail-open degradation: named timeline reason + claim release + worktree disposition on any spawn/adapter failure; first-turn orphan (`skip add-failed`, no live recorded worktree) retries exactly once as `<task>-<agent>-r1`, second refusal fails open with both paths on the timeline and a warning-level `genie doctor` orphan check.
- `genie task fan <id> --agents a,b,c`: N bridge runs, candidates tracked via timeline refs; ranked review verdict + CLI ratification picker; losers pruned non-forced (branches survive).
- W1 handoff docs (unblocked): `TaskRow.assignedAgent` untrusted-import doc line (mirrors `blockKindOf`); `task status` `Assigned to:` alignment fix.
- Adapter smoke matrix: each of the five agents completes brief → hand-back once via the bridge with a non-empty diff; pi/prime exercise the id-free continue form; hermes exercises a stateless follow-up.

### OUT

- Building the remotty `headless-turn-open` verb or any remotty client rendering — remotty-repo wish, consumed here.
- Cross-server delegation (host token always `local`); registry-name mapping.
- New message bus, daemon, or agent-inbox table; approval-gated spawns; unattended auto-merge of winners.
- Global/stage routing config, WISH.md agent pins, kimi adapter.
- Budget/concurrency limits and session retirement (deferred behind the design's named triggers).
- Checkout enforcement outside the bridge path; the `assignTask` identical-pair cosmetic TOCTOU (explicitly open, out of scope).
- Editing the digest-stamped parent design or the laneless `board --json` shape.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | All design decisions 1–9 govern verbatim; the wish adds only surface naming | Design SHIP digest `a720e84c…` after 1 fix loop; re-litigating reviewed decisions wastes the chain |
| 2 | Single-delegation surface is `genie task delegate <id>` with `--continue` for turns ≥2 | The bridge needs one explicit CLI entry; `task fan` (design Decision from parent D5) runs the same path N times — one code path, two verbs |
| 3 | Adapter cards live as a typed in-code constant (like `ROSTER`), not config files | Design OUT excludes config surfaces; constant-as-data keeps per-agent facts reviewable and a one-line change |
| 4 | Spike lands as evidence in this wish's directory (`qa/spike-<date>.md`), not as merged code | Design: "No bridge code lands before this transcript exists" — the spike gate is auditable in git |
| 5 | Groups B–F hard-gate on the spike; Group A (docs) is deliberately unblocked | The remotty task block stalls the seam, not the W1 handoffs; shipping A early kills the known-papercut list |

## Simplicity Case

- **Simplest complete design:** one bridge code path (validate → claim → prepare → brief → verb → persist) reused by single delegation, every follow-up turn, and fan-out; adapters as data; timeline as the only channel; two CLI verbs.
- **Added machinery:** spike gate (another repo's unshipped contract — cheapest falsifier); single `-r1` retry + doctor warning (design M3: existence-refusal deadlock is real; naming states bounded at two); per-adapter brief-delivery fact (design LOW-1: sandbox cwd varies; permissionless launches produce empty smoke passes); hermes accumulated-context briefs (design M1: no continue form exists).
- **Deferred until measured:** budget/concurrency limits (first host contention); session retirement (first shipped wish with live sessions); diff-compare UI (CLI ratification proves painful); mid-turn steering (a measured need re-launch cannot serve); hermes continue form (hermes ships resume-by-id).
- **Complexity removed:** no inbox schema, no Omni coupling, no approval queue, no routing config, no auto-merge state machine, no convo-id registry, no in-worktree state files, no unbounded retries.

## Dependencies

**depends-on:** cross-agent-delegate
**blocks:** none

Cross-repo: the remotty `headless-turn-open` wish gates groups S–F; recorded as a task block on card `t_msp4fp6ce714c8be` (design M2: cross-DB depends-on is inexpressible — the block makes the stall a visible board edge). The same-repo `depends-on: cross-agent-delegate` edge is declared above but deliberately not materialized as a `task_dependencies` row: the parent card is already `done`, so the edge is satisfied on creation and would change no ready-set computation.

## Success Criteria

- [ ] **Spike transcript:** `qa/spike-<date>.md` shows headless opening turn (brief pickup from `$GENIE_HOME`) → `task comment` hand-back → continue-form second turn on the same worktree; `genie task status <scratch-card>` shows the `{session, worktreePath, branch}` timeline events.
- [ ] **Delegation round-trip:** `genie task delegate <id>` on a routed card yields `claimed_by = assigned_agent` (`genie task status <id>`), a hand-back comment event, and a second turn via `--continue` — all on the timeline.
- [ ] **Consumption validation:** with `assigned_agent: "evil$(id)"` injected via `roadmap.json` import, `genie task delegate <id>` exits ≠ 0, logs a named timeline reason, performs no worktree/argv work, and leaves the card claimable.
- [ ] **Adapter smoke ×5:** a recorded matrix (`qa/adapter-smoke-<date>.md`) where each of claude/codex/pi/hermes/prime completes brief → hand-back with `git -C <worktree> diff --stat` non-empty; pi/prime rows show the continue form, hermes row shows a stateless follow-up.
- [ ] **Fan-out round-trip:** mechanical half — `genie task fan <id> --agents claude,codex,pi` over the fake remotty yields three candidate ref-sets and a picker that refuses merge without selection (`bun test src/lib/v5/delegate-bridge.test.ts`); live half — `qa/fan-<date>.md` (Group E) shows a 2-agent fan with the loser pruned non-forced and its branch surviving (`git branch --list 'wt/*'`).
- [ ] **Degradation:** forced-failure tests in `src/lib/v5/delegate-bridge.test.ts` ("spawn failure fails open", "first-turn orphan retries once with -r1", "second refusal surfaces doctor warning", "healthy second turn never invokes prepare" — asserted on the fake remotty's command log) pass via `bun test src/lib/v5/delegate-bridge.test.ts`; after each failure the card is claimable.
- [ ] **Docs:** `TaskRow.assignedAgent` carries the untrusted-import warning (`grep -A2 'assignedAgent' src/lib/v5/task-state.ts`); `genie task status <id>` on an assigned card prints `Assigned to:` with its value in the same column as the `Status:` value; adapter cards document argv, flags, and brief-delivery fact per agent.
- [ ] Full gate `bun run check` passes on the branch (includes `wishes:lint`).

## Execution Strategy

### Wave 0 (unblocked — ships independently of the remotty stall)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A | engineer | 1 — two deterministic doc/CLI-polish edits (+1 no new test surface beyond existing suites) | `engineer-trivial` / low | `TaskRow` untrusted-import doc line + `task status` alignment fix |

### Wave 1 (sequential gate — blocked on remotty `headless-turn-open`)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| S | engineer | 4 — live orchestration across two tools (+2), subjective transcript acceptance (+2) | `engineer-complex` / high | Seam spike: live transcript + timeline refs, no merged code |

### Wave 2 (after S)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| B | engineer | 2 — typed data + file emission (+1 no deterministic test for per-agent facts, +1 prompt-adjacent content) | `engineer-standard` / medium | Adapter cards ×5 + brief writer |
| C | engineer | 5 — agent lifecycle (+2), stateful claims/timeline (+2), prior-rework surface (+1) | `engineer-complex` / high | Bridge core: `task delegate [--continue]` |

### Wave 3 (after C)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| D | engineer | 3 — stateful failure paths (+2), doctor surface (+1) | `engineer-standard` / high | Fail-open degradation + `-r1` retry + doctor orphan check |
| E | engineer | 5 — orchestration (+2), stateful candidate tracking (+2), env-dependent live fan artifact (+1) | `engineer-complex` / high | `task fan` + ranked-review handoff + ratification picker + live 2-agent fan evidence |

### Wave 4 (aggregate live gate)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| F | engineer | 4 — live multi-agent matrix (+2), no deterministic test (+1), env-dependent (+1) | `engineer-complex` / high | Adapter smoke ×5 with recorded evidence |

## Execution Groups

### Group A: W1 handoff docs + status polish

**Goal:** The two carried-forward W1 findings land without waiting on the remotty stall.

**Deliverables:**
1. Doc line on `TaskRow.assignedAgent` in `src/lib/v5/task-state.ts`: imported values are unvalidated TEXT; shell/prompt consumers must call `requireRosterAgent` first (mirrors `blockKindOf`).
2. `task status` `Assigned to:` value aligned with sibling labels in `src/term-commands/v5-task.ts`.

**Acceptance Criteria:**
- [ ] The doc line names `requireRosterAgent` and the import path as the unvalidated source.
- [ ] `task status` on an assigned card prints the value in the same column as `Status:`/`Created:` values.

**Validation:**
```bash
bun test src/term-commands/v5-task.test.ts src/lib/v5/task-state.test.ts && grep -q 'requireRosterAgent' src/lib/v5/task-state.ts
```
Scope: doc comment + presentation-only edit, fully covered by the two owning suites; no schema or shared-runtime reach.

**depends-on:** none

---

### Group S: Seam spike (gate for B–F)

**Goal:** The remotty `headless-turn-open` contract is proven live before any bridge code lands.

**Deliverables:**
1. `qa/spike-<date>.md` in this wish dir: full transcript of headless opening turn (brief written under `$GENIE_HOME/briefs/`, picked up by the agent) → `task comment` hand-back → second turn via the same verb + continue form on the same worktree.
2. Timeline events on a scratch card carrying the returned `{session, worktreePath, branch}` (returned session name recorded as authoritative).

**Acceptance Criteria:**
- [ ] Transcript shows both turns and the hand-back; refs match `remotty` fleet state.
- [ ] Any contract deviation found is filed against the remotty wish before bridge work starts.

**Validation:**
```bash
ls .genie/wishes/delegate-bridge/qa/spike-*.md >/dev/null && genie task status <scratch-card-id>
```
Scope: evidence-producing spike — the artifact plus live timeline events are the validation; no merged code to gate.

**depends-on:** none (externally blocked on remotty `headless-turn-open` via the card's task block)

---

### Group B: Adapter cards + brief writer

**Goal:** Every roster agent has a reviewed launch/continue form, and briefs are emitted as files with the turn contract.

**Deliverables:**
1. Typed adapter constant (×5) in `src/lib/v5/agent-adapters.ts`: opening argv + continue argv with `{brief}` placeholder, autonomy/permission flags, brief-delivery fact (stdin | read-grant), exit-per-turn note; hermes marked stateless with accumulated-context brief rule.
2. Brief writer: `$GENIE_HOME/briefs/<task>-<agent>/turn-<n>.md` emission (card id, acceptance criteria, exact `genie task comment`/`report`/`heartbeat` commands); accumulated-context assembly for hermes from timeline events.

**Acceptance Criteria:**
- [ ] Adapter shapes typecheck; `{brief}` substitution is placeholder-exact (no shell interpolation anywhere).
- [ ] Brief files land outside any worktree; hermes turn-2 brief contains turn-1 summary content.

**Validation:**
```bash
bun test src/lib/v5/agent-adapters.test.ts && bun run check
```
Scope: new shared-runtime module → focused suite plus the repository full gate per the schema/shared-core escalation rule.

**depends-on:** group-s

---

### Group C: Bridge core — `genie task delegate`

**Goal:** One code path takes a routed card through validate → claim → prepare → brief → verb → persist, and `--continue` reuses it for follow-up turns.

**Deliverables:**
1. `genie task delegate <id>` in `src/term-commands/v5-task.ts` + bridge module (`src/lib/v5/delegate-bridge.ts`): turn-1 flow with `requireRosterAgent` re-validation, `task checkout` claim, `worktree prepare`, brief, headless verb, timeline refs (returned session name authoritative).
2. `--continue`: turns ≥2 run brief → verb against the timeline-recorded worktree; never re-validate, re-claim, or re-prepare.
3. Non-roster/unassigned/missing-binary preflights exit ≠ 0 with named errors before any side effect.

**Acceptance Criteria:**
- [ ] Turn-1 command sequence and turn-N sequence assert exactly in tests (fake remotty binary): `prepare` appears in turn 1 only.
- [ ] Injected non-roster `assigned_agent` (via import) is refused at delegate time with a named timeline reason; no worktree work happens.
- [ ] Refs persisted from the *returned* JSON, including a uniquified session name differing from the requested one.

**Validation:**
```bash
bun test src/lib/v5/delegate-bridge.test.ts src/term-commands/v5-task.test.ts && bun run check
```
Scope: new verb over shared task-state runtime → focused suites plus the repository full gate per the shared-core escalation rule.

**depends-on:** group-s, group-b

---

### Group D: Degradation + doctor orphan check

**Goal:** Every failure leaves a named reason, a released claim, and no silently leaked tree.

**Deliverables:**
1. Fail-open path: spawn/adapter failure → named timeline reason, claim release, `worktree prune` attempt; on refusal, orphan path logged.
2. First-turn orphan handling: `skip add-failed` with no live recorded worktree → exactly one `-r1` retry; second refusal fails open with both paths on the timeline.
3. Warning-level `genie doctor` check in `src/genie-commands/doctor.ts` listing **recorded** orphan paths — source of truth is the card timeline events the bridge writes, never directory or git enumeration. This is deliberately distinct from the existing `doctor-worktrees.ts` launch check (authoritative `git worktree list` enumeration over `<GENIE_HOME>/worktrees/`): remotty's `<project>/.worktrees/<name>` base is a different tree, so the two checks cannot double-report.

**Acceptance Criteria:**
- [ ] Forced-failure tests (fake remotty) cover: spawn failure, prune refusal, first-turn orphan retry, second refusal.
- [ ] After every failure path the card is claimable (`task checkout` succeeds for another worker).
- [ ] Doctor check never flips `ok:false`.

**Validation:**
```bash
bun test src/lib/v5/delegate-bridge.test.ts src/genie-commands/doctor.test.ts && bun run check
```
Scope: failure-path state transitions in shared runtime + doctor surface → focused suites plus the repository full gate.

**depends-on:** group-c

---

### Group E: Fan-out — `genie task fan` + ratification

**Goal:** The same bridge runs N candidates whose ranking, ratification, and pruning are mechanical.

**Deliverables:**
1. `genie task fan <id> --agents a,b,c`: N bridge runs with candidate names `<task>-<agent>`, refs recorded per candidate.
2. Ranked-review handoff: candidate list + criteria emitted for the review stage; CLI ratification picker merges the winner.
3. Loser disposal via non-forced `remotty worktree prune` (branches survive); disposal outcomes on the timeline.
4. Live fan evidence `qa/fan-<date>.md`: one 2-agent fan on a scratch card proving non-forced prune of the loser and `wt/*` branch survival — owned here so W2 acceptance (Group F) never gates on W3 (design Decision 9). The pair is the Group S spike-proven agent plus one second agent; an adapter-fact failure surfaced by the live fan routes to Group B's correction loop (mirroring Group F deliverable 2) and does not count as an E acceptance failure.

**Acceptance Criteria:**
- [ ] Fan over a fake remotty yields N timeline ref-sets with distinct candidate names; partial spawn failure degrades per Group D without stalling the other candidates.
- [ ] Picker refuses to merge without an explicit selection; losers' branches remain after prune.
- [ ] `qa/fan-<date>.md` shows the live 2-agent round-trip: candidates, ratified winner, loser pruned non-forced, `git branch --list 'wt/*'` retaining the loser branch.

**Validation:**
```bash
bun test src/lib/v5/delegate-bridge.test.ts src/term-commands/v5-task.test.ts && ls .genie/wishes/delegate-bridge/qa/fan-*.md >/dev/null && bun run check
```
Scope: orchestration over the shared bridge path → focused suites plus the repository full gate; the live artifact carries the prune/branch-survival half of Success Criterion 5 inside this group, off Group F's critical path.

**depends-on:** group-c

---

### Group F: Adapter smoke matrix ×5 (aggregate live gate)

**Goal:** Every roster agent demonstrably completes a real turn with write permission through the real verb.

**Deliverables:**
1. `qa/adapter-smoke-<date>.md`: per-agent rows (claude, codex, pi, hermes, prime) — brief → hand-back with non-empty `git diff --stat`; pi/prime continue-form second turn; hermes stateless follow-up.
2. Any adapter-fact correction (flags, argv, brief delivery) folded back into Group B's constant with the evidence line cited.

**Acceptance Criteria:**
- [ ] Five rows, five non-empty diffs, hand-back events on each scratch card's timeline.
- [ ] No adapter marked supported without its row.

**Validation:**
```bash
ls .genie/wishes/delegate-bridge/qa/adapter-smoke-*.md >/dev/null && bun run check
```
Scope: live evidence matrix over the merged bridge; the full gate re-run guards any Group-B fact corrections that rode along.

**depends-on:** group-b, group-c, group-d

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: on a real routed card, `genie task delegate <id>` opens a live remotty-visible session, the hand-back lands on the timeline, and `--continue` runs a second turn in the same worktree.
- [ ] Integration: `genie task fan <id> --agents claude,codex,pi` end-to-end through ranked review and picker ratification; losers pruned, branches survive.
- [ ] Regression: W1 surfaces unchanged — laneless `board --json` byte-identical; `task assign`/`create --agent` behavior identical; no new daemon or resident process appears (`genie doctor`).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Remotty verb lands late or its contract drifts | High | Task block keeps the stall visible; Group S re-proves the contract live before B–F start; Group A ships regardless |
| Adapter facts wrong on first contact (flags/argv/brief reach) | Medium | Facts are data (Group B constant); Group F smoke requires non-empty diffs and feeds corrections back with evidence |
| Fake-remotty tests diverge from the real verb | Medium | Group S transcript is the source fixture; Group F re-runs the real thing per agent |
| Same-host load under fan-out | Medium | Fan is explicit per-card; limits deferred behind the design's contention trigger |
| Hermes accumulated-context briefs grow across turns | Low | Briefs carry timeline summaries, not transcripts; fan candidates are short-lived |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — SHIP (2026-08-12T00:13:41Z, after 1 fix loop)

- **Reviewer:** design-review-delegate-bridge (read-only; same reviewer as the design's fix loop — full design/code context, independent of the wish author's edits).
- **Loop 0 — FIX-FIRST (2026-08-11T21:42:37Z):** HIGH-1 doctor module path wrong in three places (`src/term-commands/` → `src/genie-commands/`; Group D's gate was non-runnable and invited a duplicate doctor surface next to `doctor-worktrees.ts`); MEDIUM-1 Success Criterion 5's live prune/branch-survival half had no owning group (Group E was fake-remotty-only; F excludes E by design); LOW-1..4 (two criteria missing the command+artifact carry-forward; glob-unsafe `test -f`; unmaterialized same-repo DAG edge unexplained; redundant `wishes:lint` in Criterion 8). All applied in-document.
- **Loop 1 — SHIP:** all six resolved, verified on disk (paths exist; stale path absent; Group F's depends-on unchanged at B,C,D so W2 acceptance never gates on W3 — Decision 9 intact; DAG acyclic A · S · B←S · C←S,B · D←C · E←C · F←B,C,D; task block on `t_msp4fp6ce714c8be` confirmed `block_kind='work'` with zero `task_dependencies` rows; validation proportionality and design fidelity re-verified, including turn-1-only prepare/validate/claim and the `-r1` bound).
- **Loop-1 advisories, applied in-document before the status flip (reviewer: no further loop needed):** MEDIUM — E's live fan pair pinned to the spike-proven agent + one, with adapter-fact failures routed to Group B's correction loop rather than failing E; LOW — Files `qa/` comment now lists (S, E, F) artifacts; LOW — E re-scored 4→5 with the env-dependent live-artifact term.
- **Verdict consumed:** Status DRAFT → APPROVED; INDEX entry moves Ready → Poured.

---

## Files to Create/Modify

```
src/lib/v5/agent-adapters.ts          # NEW — adapter constant ×5 + brief writer
src/lib/v5/agent-adapters.test.ts     # NEW
src/lib/v5/delegate-bridge.ts         # NEW — the one bridge code path (delegate + fan share it)
src/lib/v5/delegate-bridge.test.ts    # NEW
src/lib/v5/task-state.ts              # TaskRow.assignedAgent untrusted-import doc line (Group A)
src/term-commands/v5-task.ts          # status alignment (A); task delegate [--continue] (C); task fan (E)
src/term-commands/v5-task.test.ts
src/genie-commands/doctor.ts          # orphan-path warning check (D) — timeline-recorded paths, not enumeration
src/genie-commands/doctor.test.ts
src/genie-commands/doctor-worktrees.ts # touched only if the orphan check shares helpers; launch check contract untouched
.genie/wishes/delegate-bridge/qa/     # evidence artifacts (S, E, F): spike-<date>.md, fan-<date>.md, adapter-smoke-<date>.md
```
