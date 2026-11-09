# Design: DSH code mode hands off to Herdr

| Field | Value |
|-------|-------|
| **Slug** | `dsh-herdr-handoff` |
| **Date** | 2026-11-09 |
| **WRS** | Unscored; owner decisions settled, technical proofs pending |
| **Size** | G · one cutover, five sequential implementation groups (gn-9 brief) |

This is a design awaiting independent review, not a shipping receipt. The companion wish remains DRAFT. The present assignment writes these two documents only; every implementation and attended proof below is future work.

## Problem

DSH code mode still creates its own coding session instead of handing the request to the existing Herdr main bot. That duplicates the coding path and prevents DSH from showing the actual Herdr worker required by R1-30/R1-31.

**Promise check, 2026-11-09:** after `git fetch origin`, `origin/dev` was `e02eded30289558cfc602c02b4b7612f708ff861`; the assigned tree was `034ab793d5e17a6ec562403a93cf0fca8966ab27`. The relevant plugin and Rust files match between those trees. In both, `grantWish` calls `cloneForWish` and then `rt.startTask({ cwd: folder, agentPreset: 'standard' })`; the tool still advertises a new coding thread. The promise is false. Evidence: `plugins/genie-dsh/src/host/genie.js:330-380,538-570`; clone implementation: `plugins/genie-dsh/src/host/git.js:108-140`.

## Scope

### IN

| # | Deliverable | Files changed during implementation | Source |
|---|-------------|-------------------------------------|--------|
| 1 | Host recap and human-only Start bound to one request | `plugins/genie-dsh/src/client/` and `src/host/` beneath that plugin; new handoff proof tests | Q2 |
| 2 | Private request record, fixed ID notification, trusted read/return binding and duplicate prevention | New `plugins/genie-dsh/src/host/code-requests.js`, handoff adapter and tests | Q1, Q3 |
| 3 | Existing Herdr main bot creates a tracked task and its normal worker | New adapter in `plugins/genie-dsh/src/host/`; exact external adapter revision established by proof | R1-31, Q3 |
| 4 | Live worker view, named times, freshness, result and cost unknown until M3 | New client handoff view, Host read adapter and tests | Q4 |
| 5 | Genie-only exclusion of workflow loader and native delegation; same-PR removal of DSH coding | Genie profile/preset integration identified in proof; `plugins/genie-dsh/src/host/genie.js`, unused coding helpers, tests and README | Q5, Q6 |

The `src/host/` and `src/client/` abbreviations in row 1 mean paths inside `plugins/genie-dsh/`. The implementation groups share files and therefore run sequentially, in one cutover PR. They are not independently deployable releases.

### OUT

- Per-person rights or an owner approval for each start in Herdr; Q1 chose connection-level access. Per-person rights need a separate DSH identity wish.
- A second skills provider, global workflow-loader retirement, changes to unrelated loader users, or routing research/council workflows to Herdr (Q6; shared skills boundary: `.claude/rules/dsh-skills-source.md:12`).
- Meter implementation, guessed task cost, transcripts, terminal input, kill/merge controls, opening or focusing the owner's Herdr window (Q4).
- A durable delivery service, automatic retry, reconciliation daemon, new main bot, new DSH coding session, legacy drain release, clone/history deletion or automatic replay (Q3, Q5).
- General DSH approval-adapter repair for other bots. R1-31's claim to settle #3181 is bounded to replacing this coding entry.

## Decisions

The authoritative decision source is the live, gitignored `/Users/feliperosa/workspace/repos/genie/.genie/brainstorms/dsh-herdr-handoff/QUESTIONS.md`, read on 2026-11-09. Owner words below are verbatim; these decisions are closed. The source notes are not files pinned by the repository SHA.

R1-30, from the same checkout's `.genie/brainstorms/genie-v7-tasks/DRAFT.md:115-119`:

> genie on dsh becomes the main bot orchestrator that also exists on herdr, the idea is that it doesnt delegate on dsh, but can be used as a general bot on dsh at the same time, check herdr stuff, talk to non technical users about whats going on... and if they want to see action, code mode

R1-31 chooses the Herdr main-bot/worker route and live view, replacing genie-dsh coding, in a separate wish after genie-v7-tasks. Source: that live `DRAFT.md:120-122`.

### Q1 — connection-level access, C

> Anyone who can reach DSH

Owner answer, 2026-11-08, relayed verbatim by Chat twin t441. Anyone who can reach DSH may request a worker on the owner's Mac; the main bot may refuse. There is no additional owner-go-ahead step in Herdr and no amendment to R1-30.

### Q3 — delivery, corrected A

> Queue it, show pending (Recommended)

Owner answer, 2026-11-08, relayed verbatim by t441. Send once; show “sent, waiting for the code bot”. A lost reply is “unknown”. Before any retry show the existing pending or started request; never create a duplicate worker.

### Q3 — transport, saved record and ID

> Saved record + ID ping (Recommended)

Owner answer, 2026-11-08, relayed verbatim by t441. The Host saves the request file; the terminal receives only fixed `new request <id>` text. The main bot reads the record as untrusted data. The user's words never enter its terminal input.

### Q2 — human-only Host Start, A-Host

> A button the user clicks (Recommended)

Owner answer, 2026-11-08, relayed verbatim by t441. One Start button is bound to that exact recap/request. Only a human click can dispatch it; the model cannot. Proving that control exists in DSH is a design-time shipping gate, not an instruction to trust the model or its native approval dialog.

### Q4 — live view ships, cost unknown

> Ship it, cost 'unknown' for now (Recommended)

Owner answer, 2026-11-08, relayed verbatim by t441. Ship the live worker view with the handoff and refresh only while viewed. Cost remains unknown until meter M3. This explicitly accepts the R1-31 live-cost gap until M3; it does not authorize estimated branch spend as task cost.

### Q5 — same-PR removal, dissent C

> i dont know what youre talking about

After the twin explained the old clone/session path and asked whether any DSH coding session might still be running:

> No / don't think so (Recommended)

Owner answers, 2026-11-08, relayed verbatim by t441. The cutover PR deletes the old coding and settlement path after one manual pre-merge check by the orchestrator: nothing is running, including entries marked `working` **or** `lost`. Keep clones and readable history. This answer is not itself a live-thread inventory; there is no coded cutover gate or later drain/removal release.

### Q6 — no helper agents on DSH, A

> Cut it, as your rule says (Recommended)

Owner answer, 2026-11-08, relayed verbatim by t441. Genie answers non-coding requests itself and hands coding to Herdr. Its composition must exclude both the loader row and native standard/ptc `delegation` group, for Genie only. Other loader users remain unaffected. An unavailable per-bot lever is a blocker, not permission to substitute an instruction or global tool check.

## Approach

Keep the same conversational main-bot identity across DSH and Herdr. DSH prepares a recap, the Host owns Start and request data, and only the existing Herdr main bot starts work. There is no model-facing direct-launch tool.

### Current code and boundaries to preserve

| Evidence in the assigned tree | Consequence for the cutover |
|---|---|
| `GENIE_INSTRUCTIONS` tells the model to call `grant_wish`; the tool checks Genie kind and `rt.readOnly()` before dispatch (`plugins/genie-dsh/src/host/genie.js:51-58,558-570`). | Replace those instructions; retain a refusal-only compatibility response for stale `grant_wish` calls. These checks do not establish a person's identity. |
| Existing request routes check DSH connection authentication and same-origin loopback (`plugins/dsh-genie-board/src/runtime.ts:227-240`). Board actions build specific v5 `task` argv (`plugins/dsh-genie-board/src/service.ts:34-47`). | Reuse the fence pattern, not the v5 action API, for this v7 handoff. It is not a demonstrated human-click boundary. |
| The loader checks for a calling agent, then invokes `workflowEngine.start`; that execution path has no Genie-specific authorization (`plugins/dsh-workflow-loader/src/index.ts:138-160`). The supplied preset row names the loader (`plugins/dsh-workflow-loader/agent.cordis.yml:1-5`). | Remove the capability through Genie's composition, not a new global loader restriction. |
| The loader README describes standard/ptc web presets with an isolated delegation group (`plugins/dsh-workflow-loader/README.md:129-139`). Genie's bot definition has kind, role and instructions, while bot creation delegates to `rt.createBot` (`plugins/genie-dsh/src/host/genie.js:98-103,200-206,241`). | These are repository evidence, not verification of the installed per-bot composition API. That lever remains open. |
| `genie-rs start` accepts title/lead/project and returns task/branch/worktree/lead/base SHA (`crates/genie-rs/src/lib.rs:283-320`). Its options have no handoff request ID (`crates/genie-tasks/src/start.rs:84-103`). | Keep request-to-task correlation in the Host record; a title/time match cannot prove identity. No tasks schema change is assumed. |
| The start implementation documents a freshly fetched base, atomic worktree claim and push lockout (`crates/genie-tasks/src/start.rs:1-14`). | Reuse that contract rather than DSH clone logic; prove its preservation in the actual integration. |
| Legacy history has versioned records and distinct local-only/lost outcomes (`plugins/genie-dsh/src/host/wishes.js:6-21`; `plugins/genie-dsh/src/client/wishes.js:7-49`). Settlement may repeat for `lost` because it can still run (`plugins/genie-dsh/src/host/genie.js:465-477`). Retention caps wishes at 30 (`plugins/genie-dsh/src/host/genie.js:47,398-400`). | Preserve read-only history; inspect actual sessions as well as records at cutover. The retained list alone is not an inventory. |

### Proposed interfaces and request ownership

These signatures are a design contract, not existing exports or routes. Group 1 must pin the actual Host data-directory accessor, browser event boundary, bot identity, read/return route authentication, adapter revision and worker receipt schema before implementing groups 2–5.

```ts
type RequestId = string; // Host-generated opaque ID; fixed grammar, never a path
type RequestInput = { title: string; goal: string; acceptance: string[] };
type Binding = { thread: string; project: string; mainBot: string; returnTo: string };
type TaskReceipt = { task: string; branch: string; worktree: string; lead: string; base_sha: string };
type WorkerReceipt = { worker: string; task: string; project: string; launchedAt: string | null };
type RequestState = 'draft' | 'pending' | 'started' | 'refused' | 'unknown';
type RequestRecord = {
  version: 1; id: RequestId; input: RequestInput; binding: Binding;
  createdAt: string; updatedAt: string; state: RequestState;
  claimed: boolean; taskAttempted: boolean; workerAttempted: boolean;
  task: TaskReceipt | null; worker: WorkerReceipt | null; reason: string | null;
};
prepare(input: RequestInput, caller: AuthenticatedDshContext): Promise<RequestRecord>;
start(id: RequestId, click: VerifiedHostHumanAction): Promise<RequestRecord>;
read(id: RequestId, caller: BoundBrowserOrMainBot): Promise<RequestRecord>;
claim(id: RequestId, caller: BoundMainBot): Promise<RequestRecord>;
report(id: RequestId, update: BoundMainBotUpdate, caller: BoundMainBot): Promise<RequestRecord>;
```

The Host resolves `Binding` from trusted project configuration and the authenticated thread. The browser/model provides only bounded request text, never a terminal target, filesystem path, executable, return URL or launch options. `VerifiedHostHumanAction` is deliberately an unproven capability, not a boolean the client sends.

Persist one private `<plugin-data>/code-requests/<id>.json`, separate from legacy `genie.json`. Resolve `<plugin-data>` through the proven Host-owned accessor, not request text or cwd. Use a private directory, exclusive creation, validated IDs, no symlink traversal, atomic replace and serialized transitions under the single Host writer. Persist before notifying or starting effects; a write failure starts nothing. Do not evict unresolved records or lose duplicate protection across restart. No cache, background sender or new daemon is needed.

### Flow

1. **Prepare:** agree project, title, goal and done conditions in plain words. `prepare` persists a draft and renders its recap and Host Start. Editing the recap creates a fresh draft and invalidates the previous Start. Repeated preparation for the same pending request shows that request instead of bypassing it.
2. **Human Start:** authenticate the click and its exact draft/thread binding. Atomically move draft to pending before one fixed `hc send <trusted-main-bot-terminal> "new request <id>"` invocation, using argv rather than shell interpolation. Successful send displays “sent, waiting for the code bot”; send success is not acceptance. No user prose enters terminal input. Repeated clicks cannot send or start again.
3. **Main-bot acceptance:** the existing bound main bot reads untrusted request data and may refuse. A busy but reachable bot can receive the single pending ping. Missing, blocked or unreachable bots refuse with a reason when non-delivery is established; ambiguous delivery becomes unknown. Never use forced send, keystrokes, automatic resend or a new bot. No owner approval per start is added.
4. **Claim and start task:** the bound main bot obtains one persisted claim. Persist `taskAttempted` before invoking `genie-rs start --title <title> --lead <main-bot-id> --project <trusted-project>`. Save the exact returned `TaskReceipt` before any worker attempt. Duplicate ping/claim/report requests cannot grant another launch. A crash between the effect and receipt leaves unknown; it never clears the attempt flag automatically.
5. **Start worker:** persist `workerAttempted`, then the main bot, from its own verified caller context, uses its ordinary `automagik-herdr worker` path with the returned task/worktree/lead/project. Record the validated `WorkerReceipt` under the same request. DSH neither runs that command nor fabricates `HC_TERMINAL_ID`. The installed adapter's exact argv/receipt/caller checks are a proof gate, not an assumed API.
6. **Observe and finish:** the bound main bot reports structured updates and evidence through the validated return route. The browser reads only its bound request and worker view. Worker ended, task lane, review-ready, PR opened and merged remain distinct. The Herdr main bot retains existing review and merge ownership; this handoff adds no publish/merge permission.

The fixed ping is notification only. Dedupe comes from the persisted claim and attempt boundaries, not from hc. A crash can sacrifice automatic recovery to preserve no-duplicate behavior. On any user-requested check or retry, first show the existing pending/started/unknown request, task and worker. The main bot may inspect `genie-rs list --json --project <trusted-project>`, but title, lead and time only identify candidates. Without proven correlation and proof that the prior effect did not occur, keep unknown and start nothing. A proven task with no worker is recovered as that task, never a new task; an ambiguous worker attempt cannot be repeated. No retry runs automatically.

### Live view and provenance

The view ships in the cutover. It refreshes only while visible, batches reads for the viewed project, and stops on hide/unmount. Each source has an observed-at timestamp and stale/unknown marker; a failed read preserves last-confirmed data without claiming it is live.

| Display | Authority and meaning |
|---|---|
| Task, title, lane, lead, project, branch, worktree, PR link | Structured `genie-rs list --json` fields, joined to the saved receipt (`crates/genie-rs/src/lib.rs:158-180`). |
| Worker status and progress text | Structured hc status for the exact recorded worker; prose only from the worker's report. No screen scrape or invented percentage. Installed hc guidance describes `get` and status separately from `read` (`/Users/feliperosa/.agents/skills/hc/SKILL.md:60-68,158-159`); actual integration needs proof. |
| Task age | `age_min`, now minus first-created; not coding minutes (`crates/genie-tasks/src/store.rs:684-687`). |
| PR open/lead time | `pr_open_min` only while Opened; `pr_lead_min` for Merged/Closed, otherwise null (`crates/genie-tasks/src/store.rs:688-698`). |
| Worker elapsed | From the verified launch timestamp, separately labelled. Unknown if no timestamp is proven; no inference from task age. |
| Cost | “unknown” until verified M3 task attribution, never $0 or branch estimate. M3 and unknown/null semantics are defined in live `/Users/feliperosa/workspace/repos/genie/.genie/brainstorms/genie-v7-tasks/METER-DESIGN.md:64-66,80-83`. No meter daemon, price fetch or log scan on view refresh. |
| Result | Worker report/evidence and PR link if present; agent turn completion alone is not delivery. |

### Trust boundaries

- **Browser → Host:** preserve connection authentication and origin checks; prove a separate human-action capability inaccessible to model tools. A prompt, model-supplied confirmation flag, native approval dialogue, or synthetic DOM event is insufficient evidence.
- **Host → terminal:** only trusted target and fixed ID ping. Validate record text as bounded data and keep it out of terminal input. The main bot must not obey embedded instructions to change binding, execute commands, expose secrets or bypass its ordinary gates.
- **Main bot → Host:** authenticate the actual bound bot, request, project and return destination; reject cross-thread/project requests, forged receipts and wrong callers. The browser cannot write task/worker identity. Local privileged filesystem compromise is outside this plugin's boundary.
- **Host → storage:** one writer, private records, no arbitrary paths and no silent reset on parse failure. Missing/corrupt state is unknown/error, never a fresh launch. Keep runtime identities machine-local.
- **Genie → DSH tools:** exclude both delegation entry points in the effective per-bot tool graph, including existing Genies after update. Confirm another caller retains loader functionality. No instruction-only fallback.

### Failure behavior

| Failure | User-visible behavior and effect boundary |
|---|---|
| No binding, bad authentication, stale recap or non-human Start | Explain why Start is unavailable/refused; no ping, task, clone or worker. |
| Bot blocked, missing or demonstrably unreachable | Refuse with reason; preserve request; no fallback DSH coding or forced input. |
| Bot busy | Send once, retain pending; no wait loop or second worker. |
| Delivery/reply lost, restart or unreadable record | Unknown with existing identity and freshness. A user check may reconcile; no automatic retry or reset. |
| Task created, worker rejected | Show existing task and “worker not started” with reason; recover only that task after proving no worker exists. |
| Effect occurred but binding/receipt lost | Unknown; title/time guesses do not authorize another task or worker. |
| Worker blocked/failed/ended without merge | Show its actual outcome/report separately from task lane and PR state. |
| View read fails or meter unavailable | Keep last-confirmed data marked stale; missing time/cost remains unknown. |
| Q5 inventory finds a working/lost session or cannot establish absence | Stop cutover merge; preserve old runtime, clones and history until the orchestrator resolves the inventory. |

## Simplicity Case

- **Simplest complete design:** one Host-owned record per request, one human action, one ID ping, the existing main bot/task/worker path and a view-time read adapter.
- **Added machinery:** persisted claim/attempt flags and trusted return binding are required now by Q3's no-duplicate/lost-reply contract. The human action capability is required by Q2. Neither is an optional scale feature.
- **Deferred until measured:** no delivery service, automatic reconciliation, leases, sharding or cache. Reconsider only through a separately approved requirement that preserves unknown outcomes and no duplicate workers.
- **Complexity removed:** the clone/session/branch-grant/settlement path and helper-agent access for Genie in DSH. Preserve read-only legacy data; do not add a drain state machine.

## Risks & Assumptions

| Risk | Severity | Mitigation |
|---|---|---|
| DSH lacks a provable human-only Host action or Genie-only composition | High | Group 1 stops implementation at a named blocker; do not weaken Q2/Q6. |
| Unpinned external Herdr adapter or inaccessible return route | High | Pin/read the actual version and prove caller, task, worker and request binding on the target host. |
| Crash between task/worker effect and receipt | High | Persist attempt first, retain unknown and disallow automatic repetition. |
| Old `lost` entry still runs; capped history hides a session | High | Orchestrator inspects records and actual sessions immediately before merge; never infer absence from the cap. |
| Cost unavailable | Medium | Owner accepted unknown until M3; no substitute spend claim. |

## Design-time proofs and open blockers

All are **OPEN**, not tests completed by this documentation task:

1. **Human-only Start:** pin DSH/Host/bots versions and prove in an attended chat that a human click on the exact recap invokes its Host action once, while model tools, forged/replayed events, synthetic clicks and changed recaps cannot invoke it. Use a harmless action witness for this primitive proof before implementing launch; Group 3 separately proves the real task/worker effect. Host rendering alone is not proof. This is Group 1's gate.
2. **Per-bot composition:** identify the effective Genie preset, creation/update lever and source owner; prove both loader row and native delegation group absent for Genie, including after reload, while another user retains the loader. Repository rows/README do not establish that lever. If unsupported, report the blocker; do not substitute instructions or global retirement.
3. **Transport/return binding:** pin trusted data root, read/return endpoint shapes/authentication, same-machine reachability and actual main-bot attachment. Confirm only the fixed ID ping reaches terminal input; record what survives hc/Host restart. Do not claim a durable hc inbox.
4. **Launch/correlation:** pin and inspect `/Users/feliperosa/.config/herdr-app/mods/am-sidebar/bin/automagik-herdr.mjs` or its authoritative source, actual worker command, identity and timestamp format. This installed file remains unverified here. Prove one authorized request yields one tracked task and worker; repeated click/ping/report, wrong callers and effect-boundary crashes yield no duplicate. Preserve fresh base/push lockout.
5. **Live view and cutover:** prove visible-only refresh, structured provenance and unknown cost, then collect the Q5 manual inventory immediately before merging the same PR that removes the old coding path. No live inventory was collected for these documents.

## Success Criteria

- [ ] Human Start dispatches exactly one request/task/worker on the healthy path; model-only, unauthorized, blocked and unreachable requests launch nothing. **Proof:** attended version-pinned receipt plus negative integration fixtures.
- [ ] Lost replies, duplicate actions and restarts never launch a second worker. **Proof:** failure injection before/after each persisted effect boundary, request/task/worker identities retained.
- [ ] DSH shows actual worker status, named times, freshness, outcome and cost unknown until M3, refreshing only while viewed. **Proof:** structured-source fixtures and attended visibility/unavailability drill.
- [ ] No new DSH clone/session/helper agent is possible; other loader users work; old history/clones remain readable. **Proof:** effective tool-graph inspection, no-launch spies, history fixtures and Q5 pre-merge inventory.

## Next Step

The orchestrator obtains independent design/plan review, records its real verdict and digest, and resolves Group 1's proofs before authorizing implementation. The DRAFT wish is a dependency plan, not evidence of design approval. No new owner decision is needed unless a proof shows the approved behavior cannot be delivered.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** PENDING
- **Reviewed content SHA-256:** PENDING
- **Reviewer:** PENDING
- **Reviewed at:** PENDING
<!-- genie-design-review:end -->
