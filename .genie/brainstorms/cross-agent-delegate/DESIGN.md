# Design: Cross-Agent Delegation — teammates on the board

| Field | Value |
|-------|-------|
| **Slug** | `cross-agent-delegate` |
| **Date** | 2026-08-10 (fix loops 1–2 applied 2026-08-10/11) |
| **WRS** | 100/100 |

## Problem

Genie lifecycle stages run in whichever coding agent Felipe happens to be sitting in; there is no way to declare *which* agent (Claude Code, Codex, pi, Hermes, prime) works a given card at a given stage and why, and no durable back-and-forth channel between agents working as teammates. This wastes the roster (cost arbitrage, dissent diversity — established 2026-07-09) and keeps delegation manual and invisible.

## Scope

### IN

**W1 — declared routing (mechanical, ships first, gated by nothing below; pours as its own wish immediately):**
- Additive `tasks.assigned_agent` + `assigned_reason` columns; `genie task create --agent <name> --why <reason>`; a `task assign` verb for existing cards. `assigned_agent` is validated against the known roster names (allowlist) at create/assign time.
- Serialization on the **lane-path** `genie board --json` only, following the `enforcedBlock` precedent; the laneless `--json` shape stays byte-frozen per the prior boards-first-class WISH decision. Stated consumer consequence: a client reading a non-lane-defining board or the frozen laneless shape does not see these fields — that is by design, not a bug.
- Roadmap-sync lockstep for the two new columns: `EXPECTED_SCHEMA.tasks` + `schemaIsCurrent`, the hand-enumerated `insertSnapshotRows` insert, and three-way `task sync` baseline coverage — routing must survive export/import/sync or Decision 1's rationale is void.

**W2 — the delegate bridge (follow-on wish, opened by a bounded spike; blocked on the named remotty dependency below):**
- Spike first: one bounded session that proves the seam end-to-end (headless turn → brief pickup → hand-back → second turn) with a live transcript, before any bridge code lands.
- **Turn-per-launch model.** Remotty has no verb that sends input to a running session, so a "conversation" is a sequence of launches: every turn — the opening brief and every follow-up — invokes the same headless verb on the same named worktree with a per-turn argv (the follow-up turns use the agent's id-free continue form so the agent resumes its own conversation state). Adapter launch forms MUST exit when the turn is done; an adapter that launches a bare interactive binary produces a session that never ends, never hands back, and never heartbeats, and is therefore non-conforming.
- Bridge flow, per routed card: validate `assigned_agent` against the roster → `genie task checkout <id> --worker <agent>` (the bridge claims on the delegate's behalf) → `remotty worktree prepare <host> <dir> <name>` with candidate name `<task>-<agent>` (in-contract today; prints `ok <branch> <abs-path>` / `skip <reason>`) → write the turn brief **outside the worktree** under `$GENIE_HOME` (e.g. `$GENIE_HOME/briefs/<task>-<agent>/turn-<n>.md`: card id, acceptance criteria, expected verbs — `task comment`/`report`/`heartbeat`; never shell-interpolated argv) → invoke the headless verb with the adapter's argv (brief path filled into its `{brief}` placeholder) → persist the returned `{session, worktreePath, branch}` as a card timeline event, using the *returned* session name (it may be uniquified) as the durable handle for follow-up turns.
- Teammate channel: hand-backs land as `task comment`/`report` timeline events (worktrees share the main repo's `genie.db`, so the delegate writes its own state); the card timeline is the durable thread; the live terminal is visible in the remotty client. Conversation ids are recorded opportunistically but are never load-bearing (non-unique in remotty's own state contract; hermes has none).
- Adapters for all five roster agents — claude, codex, pi, hermes, prime — as **genie-side data with explicit placeholders**: per-agent cards defining the opening-turn argv and the id-free continue-form argv, each with a `{brief}` slot, plus the agent's autonomy/permission flags (e.g. codex `--full-auto` + PTY, claude `-p` with its permission mode set) — without which an agent completes a turn while never being allowed to write. This is deliberately distinct from remotty's `~/.config/remotty/agents` file, whose lines are verbatim and interpolation-free; that file stays remotty's business and genie never edits it.
- Fail-open degradation: any spawn/adapter failure logs a named reason on the card timeline, **releases the claim** (`task release`), and disposes of the prepared worktree — attempt `remotty worktree prune`; if prune refuses (dirty tree), log the orphan's path on the timeline rather than retrying silently. The orchestrator may then work the card directly (extends the 2026-07-09 counter-read policy).

**W3 — fan-out (last; rides the W2 wish; never gates W1):**
- `genie task fan <id> --agents a,b,c` runs the W2 bridge N times with candidate names `<task>-<agent>`; each candidate's resolved worktree path, branch (`wt/<name>`, remotty's prefix rule), and returned session name are recorded as timeline-event content so ranking and pruning are mechanical. Briefs living outside the worktree keep every candidate tree clean, so non-forced prune works on losers.
- The review stage ranks candidate diffs against the group's acceptance criteria with rationale; Felipe ratifies the winner in the orchestrating session (CLI picker); losers are pruned via `remotty worktree prune` (branches survive, per remotty's own rule).

**Cross-repo dependency (remotty repo, its own named wish — consumed here, not built here):**
- A **headless variant of `worktree open`**: inputs `<host> <dir> <name> <agent-argv>`; opens a detached shpool session on the **existing** named worktree (refuses to create a worktree of its own — no `worktree_decide` fallback, no silently degraded isolation); launches the supplied argv; returns machine-readable refs `{session, worktreePath, branch}` — the returned session name is authoritative since `worktree open` uniquifies when taken — with a meaningful exit code. The same verb carries every turn (opening brief and follow-ups alike).
- Rendering `assigned_agent`/`assigned_reason` on cards in the remotty clients.
- Tracked as a named wish in the remotty repo (working slug `headless-turn-open`) with a board card; the genie W2/W3 wish declares `depends-on` it, so the external stall is visible on the board instead of discovered at execution.

### OUT
- Cross-server delegation — a delegated/fanned agent always runs where the task already runs (Felipe, 2026-08-10). Consequence made explicit: the bridge always targets the machine it is running on, remotty host token `local`; registry-name mapping for remote hosts is deferred (see Simplicity Case).
- Remotty GUI work beyond the two cross-repo deliverables above. No diff-compare UI; ratification happens in the orchestrating session.
- Any new message bus, daemon, or agent-inbox table — the timeline + named per-turn sessions are the channel.
- Approval-gated spawns (genie spawns, user watches — D-E); unattended auto-merge of fan-out winners (ratification required — D-F).
- Global/stage-level routing config files and WISH.md agent pins — routing is board-card-driven only.
- kimi adapter (present in remotty's roster; not in the requested five).
- External-agent budget/limits and companion-session retirement — deferred behind measurable triggers (first observed host contention; first shipped wish with live sessions).
- Extending the laneless `board --json` shape — it stays byte-frozen.
- Editing remotty's `~/.config/remotty/agents` file from genie.

## Approach

**Board-as-contract, thin spawn bridge.** Genie remains the brain (board, routing declaration, lifecycle, review); remotty remains the body (shpool terminal server, worktree isolation, fleet visibility, GUI clients). The interface is two seams: genie invokes remotty plumbing to run turns, and remotty reads `board --json` (read-only, its existing contract) to render assignments. Delegated agents write genie state themselves by running the genie CLI inside their worktree (comment/report/heartbeat — viable because worktrees share the main repo's `genie.db` via `git rev-parse --git-common-dir`); the remotty *client* still never writes.

The fix-loop reviews established the exact seam shape. In-contract today: `worktree prepare` (caller-supplied name, machine-readable `ok <branch> <abs-path>` output) and `worktree open` (caller-supplied name on an existing tree) — so candidate naming needs no remotty change. Missing today: every session-opening verb exec's into an interactive attach, nothing returns refs to a caller, and nothing sends input to a running session. Hence one remotty-side deliverable — the headless `worktree open` variant — and the **turn-per-launch** conversation model built on it, instead of smuggling behavior through interactive verbs or pretending live sessions can be driven externally. Everything downstream (refs on the timeline, fan-out naming, loud isolation failure, prunable losers) keys off that verb's contract. W2's spike is the checkpoint that the contract holds live before bridge code lands; the verb lives in a named remotty wish the W2/W3 wish depends on, and W1 pours as its own wish so the external dependency gates nothing mechanical.

Routing semantics: `assigned_agent` NULL means the current orchestrating agent works the card (Felipe's default); a declared assignment carries its `assigned_reason` ("the why"). Declared assignment stays deliberately distinct from observed identity (`claimed_by`/`agent_kind`/heartbeat, shipped by boards-first-class) — during a delegation the two are linked by the bridge's checkout (`claimed_by = assigned_agent`), and divergence outside a delegation is diagnostic signal, not error.

Trust posture: brief content (card title, `assigned_reason`, acceptance criteria) becomes instructions a tool-enabled agent follows. That text is Felipe-authored board content, and this design accepts it as trusted; the injection controls (Decision 11) close the *shell* and *argv* boundaries, not the prompt boundary, and say so explicitly.

Alternatives rejected: **hire_roster-centric routing** (per-wish and machine-local — contradicts per-task declaration that syncs through roadmap.json); **remotty-driven orchestration** (violates remotty's never-write posture and D-E); **new message-bus/inbox table or Omni as the bus** (machinery without a present requirement); **bridge-without-remotty-changes** (post-hoc `state --json` joins under an exec'd attach cannot return refs or surface isolation downgrade — rejected by fix-loop-1 evidence); **driving live sessions** (no remotty verb sends input to a running session — rejected by fix-loop-2 evidence in favor of turn-per-launch).

## Simplicity Case

- **Simplest complete design:** two additive nullable columns + two CLI verbs + one bridge code path reused by every turn, by single delegation, and by fan-out + timeline events as the thread + one remotty headless verb. No new tables, no daemon, no protocol beyond one JSON line of refs per turn.
- **Added machinery:** the remotty headless `worktree open` variant (justified: fix-loop evidence — every existing session-opening verb attaches interactively and returns nothing; it is the wish's dominant cost and why W2 opens with a spike); turn-per-launch adapters with `{brief}` placeholders and autonomy flags (justified: no live-session input channel exists, and permissionless launches produce empty smoke passes); the `task fan` verb (justified: Felipe decided fan-out fully IN); roster allowlist validation (justified: assigned text reaches a shell and another agent's prompt).
- **Deferred until measured:** budget/concurrency limits (trigger: first observed host contention); session retirement (trigger: first shipped wish with live sessions); remotty diff-compare UI (trigger: CLI ratification proves painful live); cross-server spawning + host registry-name mapping (trigger: Felipe reverses D-G — until then the same-server invariant makes `local` always correct); driving live sessions instead of turn-per-launch (trigger: a measured need for mid-turn steering that re-launching cannot serve).
- **Complexity removed:** no agent-inbox schema, no Omni coupling, no approval queue on spawns, no global routing config, no WISH.md routing dialect, no winner-auto-merge state machine, no convo-id-keyed session registry (session names are the durable handle), no in-worktree state files (briefs live under `$GENIE_HOME`, keeping candidate trees clean and prunable).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Routing lives on the board card (`assigned_agent`/`assigned_reason`); default = current agent | Felipe 2026-08-10; board is the one tracker; syncs via roadmap.json unlike machine-local hire_roster — hence the W1 sync-lockstep scope |
| 2 | Remotty is the spawn/terminal substrate; genie consumes its plumbing | Terminal server, worktrees, naming-capable `worktree prepare`/`open`, fleet visibility and GUI exist today; headless turn execution and machine-readable refs do **not** — they are the named cross-repo deliverable, not assumed |
| 3 | Genie spawns, user watches | Felipe 2026-08-10; zero-friction, overnight-capable, sessions appear live in remotty clients |
| 4 | Channel = card timeline (comment/report) + turn-per-launch sessions; no new bus | Both substrates already shipped; a bus adds durable states without a present requirement; no remotty verb can drive a live session, so turns are launches |
| 5 | Fan-out fully IN, review ranks, Felipe ratifies, losers pruned (branches survive) | Felipe 2026-08-10; reuses the bridge; ratification keeps merges human-gated |
| 6 | Same-server delegation only; host token is always `local` | Felipe 2026-08-10 verbatim ("no cross server"); the invariant makes host derivation trivial and removes remote failure modes |
| 7 | Adapter cards are genie-side data: opening + continue argv with a `{brief}` placeholder, plus autonomy/permission flags; adapters must exit per turn | Five runtimes, materially different forms; remotty's own agents file is verbatim/interpolation-free so it cannot carry this — it stays remotty's business; exit-per-turn is what makes hand-back and heartbeat possible |
| 8 | Fail-open on spawn/adapter failure: named timeline reason + claim release + worktree disposition (prune, or log the orphan path on refusal) | Extends the proven 2026-07-09 counter-read policy; never block a stage on external availability, never strand a claim, never leak a tree silently |
| 9 | Declared assignment stays distinct from observed claim identity; the bridge links them via `checkout --worker <agent>` | `claimed_by`/`agent_kind` are observed at claim/heartbeat (boards-first-class); the bridge makes ownership during delegation explicit instead of conflating the fields |
| 10 | Lane-path-only `board --json` serialization | The laneless shape is byte-frozen by prior WISH decision; `enforcedBlock` is the precedent for lane-path-only runtime fields |
| 11 | Briefs and follow-ups are files under `$GENIE_HOME`, never argv and never inside the worktree; `assigned_agent` is roster-allowlisted | Card text crosses a shell boundary and another agent's prompt (trust posture stated in Approach); out-of-tree briefs keep candidate worktrees clean so non-forced prune works and the winner's diff carries no noise |
| 12 | Returned session name (+ worktree path + branch) is the durable ref; convo id is opportunistic | Remotty's state contract: convo ids are non-unique, hermes carries none; `worktree open` uniquifies names, so the *returned* name is authoritative and is what prune consumes |
| 13 | Pour as two genie wishes: W1 now; W2+W3 follow-on with `depends-on` the named remotty wish (`headless-turn-open`) | Two of three waves are externally blocked; a single wish would stall at W2 on another repo — the split makes the stall a visible board edge instead of an execution surprise |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Remotty `headless-turn-open` doesn't land, or its contract drifts (separate repo, version skew) | High | Named cross-repo wish + `depends-on` edge on the W2/W3 wish; W2 opens with a live-transcript spike against the real verb; bridge treats the JSON refs + exit code as the contract and fails open with a named reason; W1 ships regardless |
| 2 | pi/prime environments lack genie skills (agent-sync covers claude/codex/hermes today) | Medium | The brief is self-contained (card id, criteria, exact `genie task …` commands) — delegation needs the genie binary on the host, not skills; per-agent smoke criterion |
| 3 | Per-agent forms drift (hermes flag varies by version; prime binary ≠ roster name; autonomy flags change) | Medium | Adapter cards are data, correctable without code; each form verified in the per-agent smoke test whose pass requires a non-empty diff; a wrong continue form fails visibly on the next turn, not silently |
| 4 | Fan-out N× cost and same-host load | Medium | Fan is explicit per-card (never default); budget/limits deferred behind the contention trigger |
| 5 | Delegated agent dies mid-turn, never exits, or never picks up the brief | Medium | Turn-per-launch bounds each turn's lifetime; heartbeat liveness (▶/⏸/☠) already ships; stale claims release; the spike proves brief pickup per agent before the adapter is declared supported |
| 6 | `board --json` growth breaks remotty parsing | Low | Lane-path additive keys only; remotty draws nothing for unknown gaps by its own design |
| 7 | Assumption: remotty CLI + genie binary present on any server where delegation is exercised | — | Bridge preflights both and degrades open with a doctor-style hint; same-server rule means no remote naming to resolve |

## Success Criteria

- [ ] **W1 assignment round-trip:** `genie task create --title x --agent codex --why "dissent on parser"` persists both fields; `task assign` sets them on an existing card; a non-roster name is rejected; both fields appear in lane-path `genie board --json` while the laneless shape stays byte-identical; both fields survive `task export` → `task import` → three-way `task sync`.
- [ ] **W2 spike transcript:** one live session proving a headless opening turn (brief pickup from `$GENIE_HOME`) → `task comment` hand-back → a second turn through the same headless verb on the same worktree via the continue form — with the returned `{session, worktreePath, branch}` refs recorded on the card timeline.
- [ ] **W2 delegation round-trip:** a routed card is claimed by the bridge (`claimed_by = assigned_agent`), delegated, handed back, and continued for a second turn — all evidenced on the card timeline.
- [ ] **Adapter smoke ×5:** claude, codex, pi, hermes, prime each complete brief → hand-back once via the bridge with a **non-empty diff** (proving the autonomy flags let the agent act; hermes/prime explicitly exercise the id-free continue form).
- [ ] **W3 fan-out round-trip:** `genie task fan <id> --agents claude,codex,pi` yields three named candidates with refs on the timeline; review emits a ranked verdict with rationale against the group's acceptance criteria; ratification merges the winner; losers pruned non-forced with branches surviving (clean trees — briefs live out-of-tree).
- [ ] **Degradation:** a forced spawn failure logs a named reason on the timeline, releases the claim, disposes of the prepared worktree (or logs the orphan path if prune refuses), leaves the card claimable, and blocks nothing.
- [ ] **Genie-side contract for clients:** `assigned_agent`/`assigned_reason` are readable by any board client from lane-path `board --json` (non-lane and laneless readers see nothing, by design; remotty rendering itself is the cross-repo dependency, tracked in the remotty repo, not gated here).

The wish must attach a concrete command + expected artifact to every criterion (review LOW-2, loop 1).

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `c15d6a9e1de0daf39543ed71e5bfa4c7c3ad866de6a9294c6c833a2a39c00edd`
- **Reviewer:** design-review-cross-agent-delegate
- **Reviewed at:** 2026-08-11T00:14:02.000Z
<!-- genie-design-review:end -->
