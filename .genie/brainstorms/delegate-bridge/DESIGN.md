# Design: Delegate Bridge — routed cards become agent turns (cross-agent W2+W3)

| Field | Value |
|-------|-------|
| **Slug** | `delegate-bridge` |
| **Date** | 2026-08-11 |
| **WRS** | 100/100 |
| **Parent** | [cross-agent-delegate DESIGN](../cross-agent-delegate/DESIGN.md) (SHIP, digest `c15d6a9e…`) — approach, trust posture, and rejected alternatives inherited; this design resolves its five recorded W2/W3 residuals and pours the remaining waves |

## Problem

W1 (shipped, PR #2766) lets a board card declare *which* roster agent works it and *why*, but nothing fulfills the declaration — no bridge turns a routed card into an actual agent turn, so delegation stays manual and the teammate channel does not exist. This is the half that actually spends the roster (cost arbitrage, dissent diversity).

## Scope

### IN

**W2 — the delegate bridge (blocked on the remotty `headless-turn-open` wish, tracked as a task block):**
- **Spike first:** one bounded session proving the seam live — headless opening turn (brief pickup from `$GENIE_HOME`) → `task comment` hand-back → second turn through the same headless verb on the same worktree via the agent's continue form — with the returned `{session, worktreePath, branch}` refs recorded on the card timeline. No bridge code lands before this transcript exists.
- **Bridge flow per routed card:** re-validate `assigned_agent` via `requireRosterAgent` at consumption (imported snapshots store it raw — W1 pre-merge MEDIUM) → claim via `task checkout <id> --worker <agent>` (`claimed_by = assigned_agent`; `claimTask` is already a conditional in-transaction UPDATE, which the bridge inherits). **Turn 1 only:** `remotty worktree prepare local <dir> <task>-<agent>`. **Every turn (opening and follow-ups):** write the turn brief outside the worktree at `$GENIE_HOME/briefs/<task>-<agent>/turn-<n>.md` (card id, acceptance criteria, exact `genie task comment`/`report`/`heartbeat` commands; never shell-interpolated argv) → invoke the headless verb with the adapter's argv → persist the *returned* session name + worktree path + branch as a timeline event (the returned name is authoritative — `worktree open` uniquifies). **Turns ≥2 never call `prepare`** — they run against the worktree path recorded on the timeline; `prepare` refuses on path *existence* (`skip add-failed`, dirty or not), so re-running it against a healthy turn-1 tree would misread success as an orphan. The bridge reads routing from the current row, never the timeline (create-time declarations carry no timeline note, by W1 design).
- **Adapter cards ×5** (claude, codex, pi, hermes, prime) as genie-side data: opening argv + continue argv with a `{brief}` placeholder, autonomy/permission flags (codex `--full-auto` + PTY, claude `-p` + permission mode, …), and a **brief-delivery fact** per card — stdin-streamed brief content where the runtime accepts prompt-on-stdin, else an explicit read grant for the brief path (parent residual LOW-1). Adapters MUST exit when the turn is done. **Hermes is stateless turn-per-launch:** no continue form (resume-by-id doesn't exist; `-c <name>` has the title-fallback trap) — every hermes follow-up brief carries accumulated context from the card timeline (parent residual M1). Id-free continue forms (pi, prime) are unambiguous by cwd: each candidate worktree is its own conversation scope.
- **Teammate channel:** hand-backs land as `task comment`/`report` timeline events written by the delegate itself inside its worktree (worktrees share the main repo's `genie.db`); the card timeline is the durable thread; the live terminal is visible in remotty clients.
- **Fail-open degradation** (extends parent Decision 8): spawn/adapter failure logs a named timeline reason, releases the claim, and disposes of the worktree (`remotty worktree prune`; on refusal, log the orphan path). **Orphan case** (parent residual M3): when a **first-turn** `prepare` returns `skip add-failed` for a card×agent that has **no live worktree recorded on the timeline** — the existence-refusal that signals a leftover from a prior crash — the bridge retries exactly once with the fixed suffix `<task>-<agent>-r1` (at most one retry per card×agent, ever; naming states are bounded to two). If `-r1` also refuses, the turn fails open with **both** orphan paths logged on the timeline and surfaced by a warning-level `genie doctor` check, and the card stays claimable; the orchestrator may work it directly.
- **One-line `TaskRow` doc** on `assignedAgent`: imported values are unvalidated TEXT (mirrors the `blockKindOf` warning); consumers passing them to a shell or prompt must call `requireRosterAgent` first. Alongside it, the third W1 pre-merge finding: fix the `task status` `Assigned to:` column alignment (`src/term-commands/v5-task.ts` — value sits one column right of sibling labels).

**W3 — fan-out (rides this wish; never gates W2 acceptance):**
- `genie task fan <id> --agents a,b,c` runs the W2 bridge N times with candidate names `<task>-<agent>`; each candidate's resolved worktree path, branch (`wt/<name>`), and returned session name recorded as timeline events so ranking and pruning are mechanical. Out-of-tree briefs keep candidate trees clean for non-forced prune.
- Review ranks candidate diffs against the group's acceptance criteria with rationale; Felipe ratifies the winner in the orchestrating session (CLI picker); losers pruned via `remotty worktree prune` (branches survive).

**Cross-repo dependency (consumed, not built here):** the remotty `headless-turn-open` verb — inputs BOTH the roster name (manifest identity: revive/fleet state/client rendering join on it — parent residual M4) and the launch argv, plus `<host> <dir> <name>`; opens a detached shpool session on the **existing** named worktree (refuses to create); returns machine-readable `{session, worktreePath, branch}` with a meaningful exit code. Tracked as its own wish in the remotty repo; recorded on this wish's card as `genie task block <id> --reason "blocked on remotty headless-turn-open"` — a task block, not a DAG edge, because `task_dependencies` is same-DB FK-constrained (parent residual M2; supersedes the parent design's stale line-37 "declares depends-on" wording, confirmed stale by W1 plan-review LOW-5). The same-repo `depends-on: cross-agent-delegate` IS a real DAG edge.

### OUT
- Cross-server delegation — host token is always `local` (parent Decision 6); registry-name mapping deferred.
- Remotty GUI work beyond the two deliverables tracked in the remotty wish (headless verb, card rendering); no diff-compare UI — ratification is a CLI picker here.
- Any new message bus, daemon, or agent-inbox table; approval-gated spawns; unattended auto-merge of fan-out winners.
- Global/stage-level routing config, WISH.md agent pins, kimi adapter.
- External-agent budget/limits (trigger: first observed host contention); session retirement (trigger: first shipped wish with live sessions).
- Checkout enforcement outside the bridge path — `task checkout --worker` stays ungated for humans/orchestrators; only the bridge links declaration to claim.
- Editing remotty's `~/.config/remotty/agents` file; extending the laneless `board --json` shape.
- Editing the digest-stamped parent DESIGN.md — corrections land by supersession here, not by invalidating SHIP evidence. Superseded parent statements: line 37's "declares `depends-on`" for the remotty wish (task block instead — M2); line 24's universal "the follow-up turns use the agent's id-free continue form" (narrowed — false for hermes, Decision 3); criterion line 104's "hermes/prime explicitly exercise the id-free continue form" (hermes now exercises a stateless follow-up instead).

## Approach

Inherited whole from the parent (board-as-contract, thin spawn bridge; turn-per-launch because no remotty verb drives a live session; genie is the brain, remotty the body; delegates write their own genie state; remotty clients never write). Rejected alternatives — hire_roster routing, remotty-driven orchestration, message bus, bridge-without-remotty-changes, driving live sessions — were each rejected on fix-loop evidence recorded in the parent; none is reopened here.

What this design adds over the parent's W2/W3 paragraphs is exactly the five residual resolutions (hermes statelessness, task-block edge, bounded orphan retry + doctor surfacing, two-input verb shape, per-adapter brief delivery) and the three W1 review handoffs (consumption validation, in-transaction RMW, row-not-timeline routing reads). Trust posture — shell and argv controls unchanged; the prompt boundary's authorship set widens: brief content is Felipe-authored board text **plus turn summaries authored by roster delegates** (hermes accumulated-context briefs, and any brief quoting a hand-back). Accepted because delegates are roster-allowlisted processes running on Felipe's own hosts, briefs remain files (never argv), and volume is bounded per Risk 6.

## Simplicity Case

- **Simplest complete design:** one bridge code path reused by every turn, by single delegation, and by fan-out; adapter cards as data; timeline as the only channel; one remotty verb consumed. No new tables, no daemon, no protocol beyond one JSON refs line per turn.
- **Added machinery:** spike-before-bridge (justified: the verb is another repo's unshipped contract — cheapest possible falsifier); single `-r1` orphan retry + doctor warning (justified: parent M3 documents a real deadlock — same card×agent can never re-prepare after a crash leaves the path behind; one fixed suffix + surfacing beats an operator-only dead end, and naming states stay bounded at two); per-adapter brief-delivery fact (justified: parent LOW-1 — `$GENIE_HOME` is outside several runtimes' default sandbox cwd; a permissionless launch produces empty smoke passes); accumulated-context briefs for hermes (justified: parent M1 — no continue form exists; re-briefing is the only stateless option that preserves turn-per-launch).
- **Deferred until measured:** budget/concurrency limits (first host contention); session retirement (first shipped wish with live sessions); diff-compare UI (CLI ratification proves painful); cross-server + host mapping (Felipe reverses D-G); mid-turn steering (a measured need re-launching cannot serve); hermes continue form (hermes ships resume-by-id).
- **Complexity removed:** no agent-inbox schema, no Omni coupling, no approval queue, no routing config, no auto-merge state machine, no convo-id registry, no in-worktree state files, no unbounded retry loops.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Parent Decisions 2–12 inherited verbatim; only residual-mandated deltas below | The parent design is SHIP with digest-stamped evidence; reopening settled decisions wastes the review chain |
| 2 | Bridge re-validates `assigned_agent` via `requireRosterAgent` at consumption; `TaskRow` gains the untrusted-import doc line | W1 pre-merge MEDIUM: imported snapshots store the field raw (declaration-only, `block_kind` precedent); W2 is where the text reaches a shell/prompt |
| 3 | Hermes adapter is stateless turn-per-launch with accumulated-context follow-up briefs; revisit when hermes ships resume-by-id | Parent M1: no id-free continue exists; `-c <name>` title-fallback trap is a proven hazard; statelessness preserves the turn model with zero new states |
| 4 | Cross-repo stall = task block on this wish's card; `depends-on: cross-agent-delegate` is the only DAG edge | Parent M2: cross-DB depends-on is inexpressible (FK-constrained); supersedes the parent's stale line-37 wording |
| 5 | `prepare` runs on turn 1 only; a first-turn `skip add-failed` with no live recorded worktree → exactly one `-r1` retry per card×agent, then fail-open + doctor listing | Parent M3: `.worktrees/<name>` path is not uniquified and `prepare` refuses on path existence (not dirtiness — remotty `worktree-test.sh` proves it); zero retries deadlocks the pair, unbounded suffixes leak trees, and per-turn prepare would misread a healthy turn-1 tree as an orphan |
| 6 | Headless verb contract takes roster name AND argv (spec lives in the remotty wish) | Parent M4: manifest identity joins revive/fleet/rendering; argv alone would orphan the session from the fleet model |
| 7 | Brief delivery is a per-adapter card fact: stdin where supported, else an explicit read grant | Parent LOW-1: sandbox cwd varies by runtime; smoke's non-empty-diff requirement catches a wrong fact |
| 8 | Bridge reads routing from the current row, never the timeline; bridge claims ride `claimTask`'s existing in-transaction conditional UPDATE | W1 review handoffs: create-time declarations write no timeline note; adopts the TOCTOU INFO's guidance — `checkout` is already transactional, while the `assignTask` identical-pair cosmetic TOCTOU remains open and out of scope here |
| 9 | W2 acceptance never gates on W3; both ride one wish as ordered waves | Fan-out reuses the bridge unchanged (parent Decision 5); one wish keeps the review chain single while the wave order keeps risk staged |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Remotty `headless-turn-open` doesn't land or its contract drifts | High | Task block keeps the stall visible on the board; spike runs against the real verb before bridge code; bridge treats JSON refs + exit code as the contract and fails open; W1 value (declared routing) already shipped |
| 2 | pi/prime hosts lack genie skills | Medium | Briefs are self-contained (card id, criteria, exact commands) — delegation needs the genie binary, not skills; per-agent smoke criterion |
| 3 | Adapter forms drift (hermes flags vary; prime binary ≠ roster name; autonomy flags change) | Medium | Adapters are data, correctable without code; smoke requires a non-empty diff; a wrong continue form fails visibly next turn |
| 4 | Fan-out N× cost and same-host load | Medium | Fan is explicit per-card; limits deferred behind the contention trigger |
| 5 | Delegate dies mid-turn / never exits / never reads the brief | Medium | Turn-per-launch bounds turn lifetime; heartbeat liveness ships; stale claims release; spike proves brief pickup per agent |
| 6 | Accumulated-context hermes briefs grow unboundedly across turns | Low | Brief carries turn summaries from the timeline, not transcripts; fan candidates are short-lived by design |
| 7 | Assumption: remotty CLI + genie binary present where delegation runs | — | Bridge preflights both, degrades open with a doctor-style hint; same-server rule removes remote naming |

## Success Criteria

- [ ] **Spike transcript:** one live session proving headless opening turn (brief pickup from `$GENIE_HOME`) → `task comment` hand-back → second turn via the same verb on the same worktree (continue form), with returned `{session, worktreePath, branch}` refs on the card timeline — before any bridge code merges.
- [ ] **Delegation round-trip:** a routed card is claimed by the bridge (`claimed_by = assigned_agent`, in-transaction), delegated, handed back, and continued for a second turn — all evidenced on the card timeline.
- [ ] **Consumption validation:** a snapshot-injected non-roster `assigned_agent` (e.g. `evil$(id)`) is refused by the bridge with a named timeline reason before any worktree/argv/prompt work; the card stays claimable.
- [ ] **Adapter smoke ×5:** claude, codex, pi, hermes, prime each complete brief → hand-back once via the bridge with a **non-empty diff**; pi and prime exercise the id-free continue form; hermes exercises a stateless follow-up turn whose brief carries accumulated context.
- [ ] **Fan-out round-trip:** `genie task fan <id> --agents claude,codex,pi` yields three named candidates with refs on the timeline; review emits a ranked verdict with rationale against the group's criteria; ratification merges the winner; losers pruned non-forced with branches surviving.
- [ ] **Degradation:** a forced spawn failure logs a named reason, releases the claim, disposes of the worktree (or logs the orphan path on prune refusal), leaves the card claimable, blocks nothing. A forced first-turn orphan (`skip add-failed`, no live recorded worktree) retries exactly once with `-r1`; a second refusal fails open with both orphan paths on the timeline and in `genie doctor`. A second turn on a healthy delegation never invokes `prepare`.
- [ ] **Docs:** `TaskRow.assignedAgent` carries the untrusted-import warning; the `task status` assignment alignment is fixed; adapter cards document argv, flags, and brief-delivery fact per agent.

The wish must attach a concrete command + expected artifact to every criterion (parent carry-forward, review LOW-2 loop 1).

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `a720e84cd18f6e61884586f73eed128dbde9dc0fbd28b2f22618348640ae44a1`
- **Reviewer:** design-review-delegate-bridge
- **Reviewed at:** 2026-08-11T21:22:57.000Z
<!-- genie-design-review:end -->
