# Wish: DSH code mode hands off to Herdr

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `dsh-herdr-handoff` |
| **Date** | 2026-11-09 |
| **Author** | Genie orchestrator; gn-9 document worker |
| **Appetite** | large; five sequential bounded groups, one cutover PR |
| **Branch** | `feat/gn-9-dsh-code-mode-hands-off-to-herdr` (documents); implementation branch assigned after approval |
| **Repos touched** | `automagik-dev/genie`; external DSH/Herdr integration ownership must be established in Group 1 |
| **Design** | [DSH → Herdr design](../../brainstorms/dsh-herdr-handoff/DESIGN.md) — independent review pending |

## Summary

Replace Genie's DSH clone/session coding path with a human-clicked handoff to its existing Herdr main bot, which creates the tracked task and normal worker. Ship the live worker view in the same cutover, with unknown cost until meter M3, preserve old history/clones, and remove Genie's DSH helper-agent capabilities without affecting other loader users.

This document plans future implementation. GN-9 currently commits documents only. No product implementation, attended proof, review approval or merge clearance is claimed. The origin/dev promise check and current-code citations are in DESIGN.md's Problem and Approach sections; they establish that the old clone/session path still exists.

## Scope

### IN

- A recap and Host-rendered human-only Start tied to the exact request.
- One private Host request record, one fixed ID ping, authenticated read/return binding and persistent no-duplicate effect boundaries.
- Existing main-bot acceptance/refusal, `genie-rs start` and ordinary Herdr worker launch.
- Live structured progress, task/PR/worker times, freshness, result and unknown cost, refreshed only while viewed.
- Genie-only profile/preset exclusion of loader and native delegation; same-PR deletion of old coding/settlement after the manual Q5 pre-merge check; preserved read-only history and clones.

### OUT

- Per-person rights, an owner approval per Herdr start, new main bots or DSH coding fallback.
- Global loader retirement, helper agents/workflows for Genie in DSH, general approval-adapter repair, meter implementation, transcript/terminal/kill/merge controls.
- Daemons, automatic retry/reconciliation, old-thread replay, legacy drain release, deletion of history/clones, new skills providers or genie-tasks schema changes.

## Decisions

The design quotes every verbatim owner answer from the authoritative live QUESTIONS.md. These choices are settled; technical proof failures do not silently amend them.

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | “Anyone who can reach DSH” may request a start; main bot may refuse | Connection-level boundary; no per-start owner-go-ahead gate in Herdr. |
| Q3 delivery | “Queue it, show pending (Recommended)” | Send once; lost reply unknown; show pending/started request before any retry and prevent duplicate workers. |
| Q3 transport | “Saved record + ID ping (Recommended)” | Host writes data; terminal receives only fixed `new request <id>`. |
| Q2 | “A button the user clicks (Recommended)” | Human-only Host Start, proved before shipping; no model launch tool. |
| Q4 | “Ship it, cost 'unknown' for now (Recommended)” | Live view ships with handoff; cost unknown until M3; visible-only refresh. |
| Q5 | “No / don't think so (Recommended)” after explanation | Same-PR removal, conditional on the orchestrator's manual pre-merge inventory of working AND lost entries and actual sessions. |
| Q6 | “Cut it, as your rule says (Recommended)” | Remove loader row and native delegation for Genie alone; other users unaffected. Unsupported composition is a blocker. |

## Simplicity Case

- **Simplest complete design:** one Host record, one human action, one ID ping, existing Herdr task/worker path and a view-time adapter.
- **Added machinery:** request claim/attempt persistence and trusted return binding satisfy the present lost-reply/no-duplicate requirement; the human action boundary satisfies Q2.
- **Deferred until measured:** no delivery daemon, lease recovery, background reconciliation, cache or generalized queue. A new requirement needs separate approval.
- **Complexity removed:** legacy DSH clone/session/branch-grant/settlement execution and Genie's DSH delegation capability; retain history data rather than a drain engine.

## Dependencies

**depends-on:** genie-v7-tasks
**blocks:** none

The tracked-task/start/list contract is the prerequisite from R1-31. Meter M3 is a dependency of future task-cost display, not of this cutover; Q4 explicitly accepts unknown until then. Group 1 must identify any missing external DSH/Herdr capability and its owner before widening repository scope. No implementation starts from this DRAFT wish or a design with PENDING independent review.

## Success Criteria

- [ ] A human Start on the exact recap yields one request, one tracked task and one actual worker; model-only requests launch nothing.
- [ ] Busy bot delivery sends once and shows “sent, waiting for the code bot”; lost replies remain unknown and cannot duplicate a task or worker.
- [ ] The request text never enters terminal input; Host and main-bot read/return bindings reject wrong callers/projects/threads and forged receipts.
- [ ] The live view ships with structured status, named times, freshness, outcome and cost unknown; refresh stops when hidden.
- [ ] Genie has neither saved-workflow loader nor native delegation capability on DSH, while another loader caller retains access.
- [ ] The same cutover PR removes DSH coding and settlement after the explicit Q5 manual pre-merge check; read-only history and clones remain.
- [ ] Targeted tests, client build freshness and `bun run check` pass on the final implementation tree; attended receipts and independent review are attached by the orchestrator.

## Execution Strategy

### Wave 1 (sequential, one cutover PR)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | High: prove runtime capability and identity boundaries before product implementation | inherit | Human-only button, per-bot composition and transport/adapter proof |
| 2 | engineer | Medium: private storage and irreversible effect boundaries | inherit | Request record, click dispatch, read/return contract and ID ping |
| 3 | engineer | High: task and worker effects cross process boundaries | inherit | Main-bot claim, task/worker correlation and failure handling |
| 4 | engineer | Medium: joined provenance, nulls and component lifecycle | inherit | Live worker view and visible-only refresh |
| 5 | engineer | High: capability removal and legacy cutover | inherit | Genie-only composition, old-path removal, final gate and manual inventory |

**Global constraints:**
- Anyone who can reach DSH may request a start; the Herdr main bot may refuse; no owner-go-ahead gate per start in Herdr.
- Only a human click on the Host-rendered Start bound to that exact request may dispatch it; the model cannot start it.
- The Host writes a request record file; the main bot gets only a fixed “new request <id>” ping and reads the record as untrusted data; user text never enters its terminal.
- Send once, show “sent, waiting for the code bot”; lost reply shows “unknown”; before any retry show the existing pending/started request; no duplicate worker.
- Ship the live worker view with the hand-off; cost shows “unknown” until meter M3; refresh only while viewed.
- The same PR deletes the old DSH coding path after one manual pre-merge check that no entry is working OR lost; keep read-only history and clones.
- Genie in DSH starts no helper agents; exclude the loader row and native delegation group for Genie only; other loader users are unaffected.
- If the human-only action or per-bot composition lever is unavailable, stop with an open blocker; never substitute an instruction-only promise.
- Preserve fresh-fetched task bases, push lockout and existing review/merge ownership; no extra publish or merge authority.
- No daemon, automatic retry/reconciliation, forced terminal input, second skills provider, legacy replay or deletion of history/clones.

These requirements are carried unchanged into each group's brief. Shared plugin files are owned sequentially; no parallel writers or repo-level git mutation by workers. Re-estimate before dispatch: a group exceeding 25 files or 2,000 changed lines must be split into bounded sibling work without weakening the single-cutover gate. All product groups land together only after Group 5; preparatory code does not expose a partial launch path.

## Execution Groups

### Group 1: Prove human-only Start and the actual runtime levers

**Goal:** Establish the concrete runtime contracts before implementing a launch path; the Q2 button proof is this group's gate.

**Deliverables:**
1. Version/source-pinned proof in the design for DSH, bots runtime, Host data accessor and Herdr adapter, exact main-bot/terminal binding and authenticated read/return endpoints.
2. An attended Q2 receipt plus `plugins/genie-dsh/test/handoff-proof.test.js` fixtures distinguishing a human Host action from model/tool/synthetic/replayed actions and stale recaps.
3. Effective Genie preset/tool-graph proof identifying a Genie-only lever for both loader row and native standard/ptc delegation, including existing-bot update behavior and an unaffected other caller.
4. Exact worker command/receipt and launch timestamp schema; data root and same-machine reachability proof. No external edit is implicit in this evidence task.

**Interfaces:**
- Consumes: the proposed `RequestInput`, `Binding`, `TaskReceipt`, `WorkerReceipt`, `VerifiedHostHumanAction` and `BoundMainBot` contracts in DESIGN.md.
- Produces: concrete `VerifiedHostHumanAction` verification and route/authentication contract; trusted `<plugin-data>` accessor; Genie composition source/lever; pinned worker adapter argv and `{ worker, task, project, launchedAt }` receipt mapping. Record exact source names/types and version evidence in DESIGN.md before Group 2.

**Acceptance Criteria:**
- [ ] **Q2 gate:** an attended human click invokes the exact recap's Host action once; model tool calls, synthetic clicks, forged/replayed requests and changed recaps cannot invoke it. Prove the primitive with a harmless action witness before implementing launch; Group 3 proves the task/worker effect. Host rendering, a prompt, a client boolean or native approval dialog alone fails this gate.
- [ ] Prove the actual Genie-only composition lever exists and removes both capabilities while another loader caller retains them. If unavailable, record OPEN blocker and stop; no instruction-only/global fallback.
- [ ] Pin the trusted data root, main-bot identity, read/return endpoints, actual worker command and timestamp format; show what survives restart without claiming durable hc delivery.
- [ ] If any contract cannot be proven, preserve DRAFT/blocked implementation status and report the exact missing capability to the orchestrator. Do not reopen the six decisions implicitly.

**Validation:**
```bash
npm --prefix plugins/genie-dsh test
genie wish lint --dir .
```
Attach the attended runtime proof with versions, exact request/task/worker IDs, negative attempts, effective tool graphs and observed outcomes. Automated fixtures cannot replace the attended Q2 proof. Group 1 does not pass while that receipt or a required runtime contract is missing.

**depends-on:** none

### Group 2: Persist the request and dispatch only the fixed ID

**Goal:** Implement the proven Host/browser boundary and private request state without task or worker launch by DSH.

**Deliverables:**
1. New `plugins/genie-dsh/src/host/code-requests.js`, Host handoff route module, client recap/Start component and focused tests under `plugins/genie-dsh/test/`.
2. Exclusive request creation, atomic writes and serialized claim/update transitions; unreadable/corrupt state fails closed. Preserve unresolved records and duplicate protection across reload.
3. Exact recap-bound human Start and one argv-based ID ping to the trusted bot, with cross-thread/project and stale-action rejection.

**Interfaces:**
- Consumes: Group 1's proven action, storage, route/authentication and identity contracts.
- Produces: `prepare(input: RequestInput, caller: AuthenticatedDshContext): Promise<RequestRecord>`, `start(id: RequestId, click: VerifiedHostHumanAction): Promise<RequestRecord>`, `read(id: RequestId, caller: BoundBrowserOrMainBot): Promise<RequestRecord>`, `claim(id: RequestId, caller: BoundMainBot): Promise<RequestRecord>` and `report(id: RequestId, update: BoundMainBotUpdate, caller: BoundMainBot): Promise<RequestRecord>` using DESIGN.md's exact record shapes. Final concrete context/update types come from Group 1's pinned route contract.

**Acceptance Criteria:**
- [ ] Store records only under the trusted private `code-requests/` root, separate from `genie.json`; reject path traversal, symlinks, corrupt records, excessive input and caller-supplied binding/command data.
- [ ] Only the human action can move draft to pending; double click/reload cannot send twice. Edited recaps invalidate previous Start; an existing pending request is shown before a new action is offered.
- [ ] Terminal input is exactly fixed `new request <id>`; request text containing shell syntax, leading commands or fake instructions stays in the data file.
- [ ] Send once to a busy reachable bot; show pending after send success. Known blocked/missing/unreachable targets refuse; uncertain send outcomes remain unknown. Never force, type keystrokes, retry automatically or launch DSH work.
- [ ] Unauthorized callers cannot read another thread/project or forge claims/returns. A storage failure before an effect starts nothing.

**Validation:**
```bash
npm --prefix plugins/genie-dsh test
npm --prefix plugins/genie-dsh run build
genie wish lint --dir .
```
Tests must exercise double click, duplicate ping, reload, write failure, bad bindings, invalid IDs/symlinks, unknown delivery and hostile request text against the real adapter boundary.

**depends-on:** 1

### Group 3: Bind one main-bot claim to one tracked task and worker

**Goal:** Let only the bound existing Herdr main bot create the task and normal worker, with ambiguous effects never repeated.

**Deliverables:**
1. Main-bot handoff adapter and contract tests in `plugins/genie-dsh/src/host/` and `plugins/genie-dsh/test/`, using Group 1's pinned integration surface.
2. Persisted claim/task-attempt/worker-attempt boundaries, exact receipts, authenticated report return and explicit refusal/unknown behavior.
3. Failure-injection evidence before and after each external effect; retain existing task for worker-launch recovery.

**Interfaces:**
- Consumes: `claim`, `read`, `report` and `RequestRecord` from Group 2; exact worker command/schema from Group 1; `genie-rs start --title <title> --lead <mainBot> --project <project>` → `TaskReceipt`.
- Produces: `RequestRecord.task: TaskReceipt | null`, `RequestRecord.worker: WorkerReceipt | null`, state/refusal reason and bound structured worker report for Group 4. Only the validated main-bot caller may write those receipts.

**Acceptance Criteria:**
- [ ] Main bot may accept/refuse without an additional owner approval step; DSH cannot launch the worker or impersonate the bot's caller environment.
- [ ] Persist claim/attempt before effects and exact task receipt before worker attempt. Duplicate click/ping/claim/return creates no second task/worker.
- [ ] Healthy authorized request yields one tracked task and one worker at the returned worktree/lead/project, with fresh base and push lockout intact.
- [ ] Crash or lost return between effect and receipt remains unknown. Candidates from project/lead/title/time are not proof of request identity and cannot authorize repetition.
- [ ] Before any manual retry/check show the existing pending/started request and known receipts. A task with a proven non-started worker is recovered as the same task; ambiguous worker attempts are not repeated.
- [ ] Wrong caller/project/task/worker/return destination and malicious instructions in request data cannot alter the trusted binding or existing effect permissions.

**Validation:**
```bash
npm --prefix plugins/genie-dsh test
cargo test --locked -p genie-tasks
cargo test --locked -p genie-rs
```
Attach an attended end-to-end receipt and duplicate/lost-return drill against the pinned adapter; stubbed command success alone is insufficient launch evidence.

**depends-on:** 2

### Group 4: Ship the live worker view with honest provenance

**Goal:** Show the actual worker's structured state and result while the user watches.

**Deliverables:**
1. Client handoff view, Host read/report projection and fixtures in `plugins/genie-dsh/src/client/`, `src/host/` and `test/` beneath that plugin.
2. View-scoped refresh disposal, per-source freshness, unknown/stale handling and concise result/PR link.

**Interfaces:**
- Consumes: saved request/task/worker identity and structured report from Group 3; `genie-rs list --json --project <project>` fields `task`, `title`, `lane`, `lead`, `project`, `branch`, `worktree`, `url`, `age_min`, `pr_open_min`, `pr_lead_min`; structured hc status for the saved worker.
- Produces: `WorkerView = { requestId, task, worker, lane, status, report, ageMin, prOpenMin, prLeadMin, workerElapsedMin, cost, freshness, result, prUrl }`; missing values are null/unknown and cost is unknown before verified M3 attribution. Freshness includes source and observed-at time, preserving last-confirmed values on failure.

**Acceptance Criteria:**
- [ ] Show only the recorded task/worker join; missing or conflicting identity remains unknown. No screen scrape, transcript, invented update or percentage.
- [ ] Label task age, PR open/lead time and worker elapsed separately; worker elapsed needs the proven launch timestamp. Null is never zero.
- [ ] Cost reads “unknown” until meter M3; no branch estimate or new metering implementation. Missing reports produce no invented prose.
- [ ] Refresh only while viewed; stop when hidden/unmounted; batch project reads and avoid per-card process fanout, log scans, price fetches and resident polling.
- [ ] Blocked/failed/ended worker, review-ready, open PR and merged states remain distinct; stale data is labelled and result/PR link reflects evidence.

**Validation:**
```bash
npm --prefix plugins/genie-dsh test
npm --prefix plugins/genie-dsh run build
```
Exercise visible/hidden lifecycle, source failure, stale/null time, missing meter, wrong worker join and completed-turn-without-merge cases. Attach an attended live-view receipt; the view must ship in the cutover, not a follow-up.

**depends-on:** 3

### Group 5: Remove DSH coding and Genie's delegation, then verify the cutover

**Goal:** Complete the single-PR replacement, preserve old data, and merge only after the Q5 manual absence-of-live-work check.

**Deliverables:**
1. Genie-only profile/preset change at the exact integration location proved in Group 1, plus existing-bot update and other-caller regression proof. No global loader behavior change.
2. Replace `GENIE_INSTRUCTIONS`; remove `grantWish` clone/session launch, coding branch grants/copy-back, settlement/classification/startup-reconcile execution and helpers proven unused. Keep `grant_wish` refusal-only for stale calls, readable versioned history, clones and general conversational Genie identity.
3. Update affected plugin wiring, generated client, tests and README; final implementation check, independent review and Q5 pre-merge inventory receipt in the PR/design.

**Interfaces:**
- Consumes: all Group 1–4 contracts and evidence; Group 1's exact Genie composition lever; legacy `genie.json` versioned entries as read-only input.
- Produces: effective Genie tool graph with neither loader row nor native delegation; stale `grant_wish` → refusal text only; old history remains readable with original local-only/lost outcomes; new coding requests use only the proven human Start/handoff path.

**Acceptance Criteria:**
- [ ] Remove both delegation capabilities for new and existing Genie bots across reload; prove another loader caller still works. An instruction-only promise, global loader retirement or bot-kind check substituted inside the loader fails Q6.
- [ ] No new clone, DSH coding session, branch-grant/copy-back or old settlement/reconcile execution occurs from any Genie entry. Cached `grant_wish` calls refuse without side effects.
- [ ] Legacy v1/v2 history and clones are preserved; no schema rewrite, fabricated done outcome, replay, archive deletion or drain-release machinery.
- [ ] Full integration keeps the general DSH conversation and read-only state explanations, and ships the live worker view and unknown cost together.
- [ ] **Explicit Q5 manual pre-merge step:** immediately before merging this same cutover PR, the orchestrator reads retained legacy records **and the actual DSH sessions**, including every `working` and `lost` entry. A lost entry may still run and a capped record list is not an inventory. Record time, runtime/source, inspected session/entry identities and conclusion. Establish that no legacy coding session is working or lost/unresolved; if any is live or uncertain, stop merge and resolve it without deleting its clone/history. Felipe's earlier “No / don't think so” is not this check. There is no coded cutover gate.
- [ ] The final PR includes removal and replacement together, a release note asking the owner to verify no old coding thread (including lost entries) runs before upgrade, all required checks, attended receipts and independent review. If the tree or session state changes, refresh the relevant evidence and manual inventory.

**Validation:**
```bash
bun install --frozen-lockfile
npm --prefix plugins/genie-dsh test
npm --prefix plugins/genie-dsh run build
bun --cwd plugins/dsh-workflow-loader run test
genie wish lint --dir .
bun run check
```
The orchestrator performs the manual Q5 check above and an attended no-clone/no-session/no-helper test with an unaffected loader caller. No shell command substitutes for the live inventory or independent review. Stop merge-ready; merging remains the operator's decision.

**depends-on:** 4

## QA Criteria

- [ ] On the approved target runtime, anyone who can reach DSH can prepare a recap and human-click Start; the existing Herdr main bot accepts/refuses and starts at most one worker.
- [ ] Busy delivery, duplicate actions, Host/hc restart, lost replies, blocked/missing bots, wrong callers and effect-boundary failures preserve pending/unknown identity without duplicates.
- [ ] The visible live view shows the actual worker, labelled times, freshness, result and unknown cost; hiding it stops refresh.
- [ ] Genie has no helper-agent or old coding capability, another loader caller remains functional, and legacy history/clones are readable after upgrade.
- [ ] The pre-merge inventory receipt covers actual sessions and working/lost records; the release note carries the pre-upgrade instruction.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Human-only Host button is unproven | High | Group 1 gate; no implementation on an assumed click boundary. |
| Genie-only preset composition is unproven | High | Identify actual lever and source owner; report blocker if absent; preserve other loader users. |
| Private data root, read/return authentication or adapter identity unavailable | High | Pin exact runtime/source and prove on the target host before Group 2; do not invent terminal environment. |
| Crash after effect but before saved receipt | High | Persist attempt first; keep unknown and refuse automatic repeat. |
| Live legacy session hidden by lost/capped records | High | Orchestrator's explicit actual-session inventory immediately before merge; stop on uncertainty. |
| Cost unavailable until meter M3 | Medium | Q4 accepts unknown; no fake zero or estimated task spend. |

## Review Results

PENDING. The author has not independently reviewed this design or plan. The orchestrator must append actual independent verdict, reviewer, timestamp and reviewed digest; DESIGN.md's review evidence remains PENDING. Wish lint checks structure, graph and linked-design review evidence; it does not execute this implementation. No implementation is authorized by this DRAFT status.

The GN-9 document check `genie wish lint --dir .` currently exits 1 with four linked-design evidence findings: SHIP verdict, reviewed digest, reviewer and UTC timestamp are missing. The document worker was instructed not to start subagents and cannot supply independent review of its own work. Keep the link and PENDING evidence visible; the orchestrator must obtain independent review before this gate can pass.

## Files to Create/Modify

Current gn-9 document assignment (only these two files):

```text
.genie/brainstorms/dsh-herdr-handoff/DESIGN.md
.genie/wishes/dsh-herdr-handoff/WISH.md
```

Proposed future implementation ownership, sequential within the cutover:

```text
plugins/genie-dsh/src/host/code-requests.js                 new; Group 2
plugins/genie-dsh/src/host/handoff.js                       new; Groups 2–3
plugins/genie-dsh/src/client/                              recap/live view; Groups 2, 4
plugins/genie-dsh/test/handoff-proof.test.js                new; Group 1
plugins/genie-dsh/test/                                    focused boundary/history fixtures; Groups 2–5
plugins/genie-dsh/src/host/genie.js                        instructions, retirement/history wiring; Group 5
plugins/genie-dsh/src/host/{git,binding,wishes}.js          only coding helpers proven unused; Group 5
plugins/genie-dsh/index.js                                only required wiring; Group 5
plugins/genie-dsh/client.js                               generated client; Groups 2, 4–5
plugins/genie-dsh/README.md                               handoff, failure and pre-upgrade instructions; Group 5
Genie profile/preset composition source                   exact path/owner OPEN until Group 1
```

The OPEN external composition location is a blocker to execution, not authorization to edit an unspecified repository or global installation. Do not delete the conversational plugin, change global loader consumers, or expand the documented write scope without an explicit approved task.
