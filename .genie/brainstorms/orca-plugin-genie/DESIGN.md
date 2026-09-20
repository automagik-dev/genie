# Design: The Genie Orca plugin as a real integration (RF1, RF2, RF3, RF6)

| Field | Value |
|-------|-------|
| **Slug** | `orca-plugin-genie` |
| **Date** | 2026-09-19 |
| **Revision** | 2 — revision 1 was written from the owner-approved plan (handoff of 2026-09-19, decision D-B of the v6 rev. 4 design) and from Orca 1.4.205's own code on the authoring host; revision 2 applies the eleven findings of the independent plan review of 2026-09-19T17:32Z (Run binding for `worker-start`, the `active` selector, `{kind}` capabilities, the 30 s host timeout, `genie orca gate` removed in favour of the adapter verbs the guide already owns, and the smaller items) |

## Problem

`plugins/genie` contributes exactly one palette entry, `genie.orca.run-list`, with `capabilities: []`; every real capability lives in the closed CLI adapter, which needs no plugin at all. The owner's decision D-B makes the plugin a real integration on Orca's **native** mechanisms — the command palette and keybindings, the existing board (a workspace's status and its one-line card comment), decision gates, and desktop notifications — and names three things it must never become: a second board (Orca's board *is* workspace status; `workspace.openBoard` already exists), a task provider (`TaskProvider` is a closed union, [orca#15328](https://github.com/stablyai/orca/issues/15328)), or a panel in this wave. Genie is the only writer; Orca never writes back into genie state.

## Evidence base

Two sources, both read-only, both on 2026-09-19:

1. The research note `orca-integration-research.md` (Orca CLI 1.4.205, schema v1, 234 commands; plugin API facts corroborated by Orca's own tracker — [orca#15328](https://github.com/stablyai/orca/issues/15328), [orca#15655](https://github.com/stablyai/orca/issues/15655), [orca#19809](https://github.com/stablyai/orca/issues/19809), [orca#13306](https://github.com/stablyai/orca/issues/13306), [orca#16853](https://github.com/stablyai/orca/issues/16853) — never by the third-party reconstruction alone). It sits beside this file on the authoring host; brainstorm notes other than `DESIGN.md` are machine-local by the repository's taxonomy, so every fact this design relies on is restated here.
2. Orca's own application bundle, `/opt/orca/squashfs-root/resources/app.asar` (the 1.4.205 build the host runs) and `app.asar.unpacked/out/main/plugin-host-entry.js`, read with `grep`/Python windows. This is primary evidence for the plugin host API, which has no public documentation site. The independent reviewer re-verified every row below against the same bundle.

### What Orca 1.4.205's plugin host actually provides (from its bundle)

| Fact | Where it is in the bundle | Consequence |
|---|---|---|
| Host API spec table: every method carries `stability: "experimental"`, a `scope`, a `capability`, `mutation`, `params` and `result` schemas | `RCr=[LK({name:"workspace.readContext",…}),…]` | Pin `engines.orca` to the verified version; keep the manifest parity test |
| `workspace.readContext` — scope `active-worktree`, capability `workspace:read`, result `{branch ≤512, displayName ≤512, terminals: [{id}] (≤50)}` or `null` when no worktree is active; the resolver knows `worktreeId` and `path` but strips them | handler `resolveActiveWorktreeContext()` + `listWorktreeTerminals(worktreeId)` | The **host** resolves the active workspace; a handler never receives a workspace id; the CLI's `active` selector names the same workspace |
| `terminal.sendText` — scope `explicit-terminal`, capability `terminal:send`, params `{terminalId, text, enter}`, result `{accepted}`; throws `no active worktree is available for terminal input` and `terminal is outside the active worktree` | same handler map | A send is bound to the active workspace by the host; the plugin names one terminal id it obtained from `readContext` |
| `notifications.show` — scope `desktop`, capability `notifications:show`, params `{title, body}` | `dispatchPluginNotification({pluginId,title,body})` | RF6 is one call per event |
| Events: exactly `worktree.created {worktreeId, path}`, `worktree.removed {worktreeId, path}`, `agent.status.changed {worktreeId \| null, paneKey, state, receivedAt}` where the agent status `state` vocabulary is `working \| blocked \| waiting \| done`; manifest `contributes.events: [{on}]`; dynamic subscription behind `events:subscribe` | `oNa={…}`, `emitEvent("agent.status.changed", …)` in `subscribeEnrichedStatus`; the agent-status record schema `state:u.r(["working","blocked","waiting","done"])` | RF6 reacts when an agent settles (`waiting`, `done`, `blocked`), keyed by workspace |
| Commands: `{id, title, context?: "global" \| "worktree", action?}`; keybindings `{command, key (1–128 chars, parsed by Orca's own `Ctrl+Alt+Shift+Key` grammar), when?: "global" \| "worktree"}`; **capabilities are objects** `{kind: <one of the seven>}` (`f.array(GZ).max(32)`, `GZ=f.object({kind:f.enum(dRe)}).strict()`); validator: `keybinding context must match its command context`, `unknown contributed command`, `duplicate keybinding`, and a `main` is required when any command has no built-in `action` | manifest zod schema `u3`, `GZ`, validator `f3` | Eight commands with `context: "worktree"`, eight keybindings with `when: "worktree"`, capabilities written as `[{"kind": …}]` — a string element fails validation and the plugin never loads |
| Palette: a `worktree` command is listed only with an active workspace (`isAvailable → no-active-workspace`); a keybinding for a `worktree` command is skipped without one; invocation is `plugins:invokeCommand {pluginKey, commandId}` from the renderer → main `invokeCommand(pluginKey, commandId, args)` → worker message `{type:"invokeCommand", callId, commandId, args}`; the host rejects the call after `invokeTimeoutMs ?? 30 000` ms (`timed out after ${s}ms`) | `ua(e)` (palette), `tr(…)` (keybinding dispatch), `$Un`/`Nfi` schemas, worker controller | **Probe 2 answered:** no code path puts the workspace id into `args`; the workspace is resolved host-side per call. A handler has 30 s end to end |
| Capabilities: closed set `workspace:read, terminal:send, notifications:show, storage, secrets, events:subscribe, settings:own`; a call is refused `consent_required` (`plugin is not enabled with current consent`) when `grantedCapabilities === null` and `capability_denied` when the capability was not granted | `dRe`, `fNa` | Every capability the handlers use must be declared in the manifest |
| Consent: the "Review permissions" dialog lists "This plugin can …" per capability with "Enable plugin" / "Keep Disabled"; the lockfile stores a per-plugin `consentFingerprint`; when "Permissions, the worker trust tier, or instructional content changed since you last reviewed this plugin", the plugin `needsReconsent` and cannot run until reviewed again; the dialog warns the worker "still runs as a normal process on your computer with full access to your files, network, and other processes" | `PluginConsentDialog.*` strings, `mHn` lockfile schema | **Probe 1 answered:** consent is per plugin and per capability set, granted once at enable time and re-asked once when the set changes — never per `terminal.sendText` call |
| Worker: ES module child process forked by the main process (not a terminal), `activate({commands:{register}, events:{on}, host:{call}, grantedCapabilities, log})`; commands are registered by the worker (`registered no handler for` otherwise); idle workers are reaped after 60 s | `plugin-host-entry.js`, worker controller | Handlers must finish well inside 30 s and must never throw into the host; the worker is bound to no Run and no terminal |
| Selectors: `branch:<x>` is `selector_ambiguous` on a host with two checkouts of one branch (this host: 4 on `dev`, 6 on `main`); `active`, `current`, `id:<repoId>::<path>`, `path:<abs>` and `name:<displayName>` resolve one workspace | `orca worktree show --worktree branch:dev --json` (reviewer's probe) | Palette handlers address the workspace as `active`, then by its `id` |

### What genie already has

`src/lib/orca-orchestration-adapter.ts`: 19 `orca orchestration` verbs plus the `status` probe, `.strict()` schemas compiled to an exact argv allowlist, `shell: false`, adapter-owned `--json`, mutation receipts with public read-backs, a typed error taxonomy, a 30 s default process bound. `plugins/genie/orca-runtime.ts` probes `>=1.4.192` and `orchestration.contract.v1` **before every operation**. `scripts/orca-bundle-parity.test.ts` pins the entrypoint bundle to its source and the registered command set; `scripts/orca-manifest-parity.test.ts` pins the marketplace index to the manifest and the subtree to Orca's loader limits. The lifecycle skills already carry an Orca branch in prose (`skills/work/references/orca-coordinator.md`, `skills/wish/SKILL.md` step 4, `skills/review/SKILL.md` § Orca mode, `skills/fix/SKILL.md` § Handoff), and under that protocol the coordinator terminal is bound to one Run per wish, so the gate verbs the adapter already allowlists (`gate-create`, `gate-list`, `gate-resolve`) are available at every lifecycle point that matters.

## Scope

### IN
- **RF1** — eight palette commands with keybindings, `context: "worktree"`: `Genie: Wish`, `Work`, `Review`, `Fix`, `Report`, `Council`, `Doctor`, `Update`. Six send the slash command, with the workspace context filled in, into the workspace's active agent terminal; with no agent terminal they create a Run and start a supervised worker whose task spec is the text. Two (`Doctor`, `Update`) have no slash command: they run the genie binary and report through a notification (decision 10).
- **RF2** — `genie orca mirror`: the fixed one-way map genie → Orca (`APPROVED → todo`, `IN_PROGRESS → in-progress`, review verdict → `in-review`, `SHIPPED → completed`, `BLOCKED → in-progress`, where `BLOCKED` is the "waiting on a gate" state) written through the adapter's new `worktree-set` operation with a short dated comment; emitted from the lifecycle skills' Orca branches.
- **RF3** — every question that stalls the flow today (approve wish, accept BLOCKED, merge, promote) becomes an Orca decision gate raised with the adapter verbs the loaded Orca guide already owns (`gate-create` on the wish's or the group's task, the guide's structured wait, `gate-list` to confirm), mirrored onto the card as the `BLOCKED` transition with the gate as evidence; the four gates are catalogued in the work skill's Orca reference.
- **RF6** — notifications from the plugin worker: review finished and gate pending (both read from the card comment when a workspace's agent settles), `genie update` available and doctor warnings (from the two palette commands).
- The adapter amendment (three read operations, one write, one amended verb) as the written amendment to `genie-dual-mode-orca-plugin/DESIGN.md:135`, with schema, argv, receipt and read-back tests and an independent threat-boundary review before any consumer is built.
- Manifest, bundle, marketplace description, `engines.orca` pin; parity tests updated; docs (README Orca section and command count, plugin README, contributor contract, CLAUDE.md, AGENTS.md, INDEX).
- **RF4** (roadmap cards → GitHub issues → Orca's Tasks page) and **RF5** (nightly automations) **designed only**, as follow-up groups.

### OUT
- A second board, a genie task provider, a status-bar segment, `contributes.agents`, a `contributes.panels` Genie panel (v7 at the earliest).
- Executing RF4 or RF5.
- A `genie orca gate` verb: gates ride the adapter verbs already allowlisted and documented by the Orca guide; a genie-side polling loop with its own Run/Task bookkeeping is the "queue / lifecycle store" the contributor contract forbids without a separately approved design (review finding 5).
- Any Orca-side change, any private Orca API, any marketplace-install automation (installation stays a human act in Orca's UI).
- Any write from Orca into genie state, and any read of Orca workspace status as lifecycle truth.
- `orca terminal send` / `orca terminal create` through the adapter (the contributor contract keeps rejecting direct terminal verbs; text reaches a terminal only through the host API).

## Approach

Four mechanisms, one native surface each, all on top of the existing closed adapter:

1. **Palette → worker → host API.** At activation the worker runs the compatibility probe once and caches it (a per-call probe would spend one of the four child processes a 30 s window allows). A handler calls `workspace.readContext`; `null` becomes a notification ("no active workspace") and a `{ok:false}` result. Otherwise it reads the active workspace record (`worktree-show --worktree active`: `id`, `path`, `linkedIssue`, `createdWithAgent`, `displayName`, `branch`) and the active workspace's terminals (`terminal-list --worktree active`: `handle`, `worktreeId`, `agentIdentity`, `writable`, `connected`, `lastOutputAt`). Both calls carry an explicit `timeoutMs` of 8 000 so the whole path stays under the host's 30 s. It picks the most recently active writable, connected terminal that has an `agentIdentity` and whose handle is one `readContext` returned (exact match first, then with the `term_` prefix stripped on both sides — the two id spellings are the one thing the bundle does not settle, so QA records which spelling won), composes `/<verb> — workspace <displayName>; branch <branch>; issue #<n>; worktree <path>` (issue omitted when unlinked) and calls `terminal.sendText {terminalId, text, enter: true}`. With no agent terminal it creates a Run (`run-create --objective "Genie: <Verb> — <displayName>"`) and starts the worker on it (`worker-start {run, spec: <text>, title: "Genie: <Verb> — <displayName>", agent: createdWithAgent ?? "claude", worktree: "id:<id>", timeoutMs: 15 000}`); the supervised worker receives the spec as its task, so no second send is needed. A `worker-start` that ends in `timeout` or `ambiguous_after_possible_commit` is reported as "start requested; confirm in Orca before retrying" — the plugin never retries a mutation. Every outcome ends in one notification; no handler ever throws into the host.
2. **Lifecycle → `genie orca mirror` → `worktree-set`.** A pure module (`src/lib/orca-lifecycle-mirror.ts`) turns a genie transition into `{workspaceStatus, comment}`; the CLI verb executes `worktree-set` through the adapter, which proves the write with a `worktree-show` read-back. The skills' Orca branches call the verb at their existing relay points. The module takes no Orca status as input, which is how the one-way property is proven by a test rather than promised in prose.
3. **Human decisions → gates through the verbs the guide owns.** At each of the four catalogued moments the coordinator, from its Run-bound terminal, runs `gate-create --task <task> --question … --options …` exactly as the loaded Orca guide spells it, mirrors the wait onto the card with `genie orca mirror --to BLOCKED --evidence "gate <id>: <question>"`, waits with the guide's structured wait (`check --wait --types decision_gate --timeout-ms <n>`, a timeout being a checkpoint) and confirms the resolution with `gate-list --task <task>` before acting on it. The approve-wish gate runs from the wish's coordinator terminal after the `run-create` that `work` needs anyway; the Run and task ids are recorded in WISH.md so `work` resumes them instead of creating duplicates.
4. **Card comment → worker → notification.** The worker subscribes to `agent.status.changed`; when a workspace's agent settles (`state` is `waiting`, `done` or `blocked` — anything but `working`) it reads that workspace's comment (`worktree-show --worktree id:<worktreeId>`), and when the comment is a genie line it has not shown before it calls `notifications.show`. A `BLOCKED` line naming a gate is therefore the "gate pending" notification and a `review:` line the "review finished" one. `Doctor` and `Update` notify their own results.

Alternatives considered and rejected:

- *Prose-only skill recipes that run `orca worktree set` directly for the mirror.* The map would live in four skills, be untestable, and contradict the house rule that the loaded Orca guide owns command shapes ("never run remembered flags"); no receipt or read-back would prove the write. The verb makes the map code and makes "one writer" literal: the genie binary writes.
- *A `genie orca gate` verb that creates a Run and a task when none is bound, polls `gate-list` for up to ten minutes, completes its own task and writes card comments* (revision 1). Rejected by the independent review as a second orchestration client with its own Run semantics beside the coordinator's, and as the ledger/queue machinery the contributor contract forbids; the four verbs it wrapped are already allowlisted and documented, and the coordinator terminal is already Run-bound.
- *Polling gates from the plugin worker.* The worker is reaped when idle and holds no Run context.
- *`orca terminal create` for a missing agent terminal.* A direct terminal verb the contributor contract rejects; `worker-start` is orchestration-native and yields a supervised Dispatch the coordinator can read and release.
- *Addressing the workspace by `branch:<branch>` from the handler* (revision 1). `selector_ambiguous` on any host with two checkouts of one branch; `active` names the same workspace `readContext` resolved, and the record's `id` names it exactly afterwards.
- *The plugin writing card comments about its own actions.* The comment is one line owned by the lifecycle; two writers clobber each other.
- *Sending `genie doctor` / `genie update` as terminal text.* Neither is a slash command, an agent would interpret the text as a prompt, and RF6 already names their results as notifications.

## The adapter amendment (decision 10 of v6 rev. 4, expanded)

`genie-dual-mode-orca-plugin/DESIGN.md:135` froze the 19-verb set and named every unlisted verb as outside the plugin, requiring a design amendment, schema/argv/response tests, threat review and a new plugin compatibility version for any addition. That file carries a stamped review digest and is the record of what was designed; **this section is the amendment record**, the per-group independent review of group 1 is the threat-boundary review, and the compatibility version that moves is `plugin.json`'s `dev.orca.compatibility.minimumRuntimeVersion` (with `engines.orca` and `ORCA_MINIMUM_RUNTIME_VERSION`), from `1.4.192` to `1.4.205`; `requiredContract` stays `orchestration.contract.v1` because the orchestration verbs' contract did not change. The allowlist stays closed; it changes from 19 orchestration verbs to the following, and nothing else:

| Operation | argv (adapter appends `--json`) | Kind | Receipt identity | Public read-back |
|---|---|---|---|---|
| `worktree-show {worktree}` | `worktree show --worktree <selector>` | read | — | — |
| `worktree-set {worktree, workspaceStatus?, comment?}` (at least one) | `worktree set --worktree <selector> [--workspace-status <id>] [--comment <text>]` | **mutation** | the returned record's `id`, and each requested field equal to the request | `worktree-show --worktree id:<returned id>`: `workspaceStatus`/`comment` must equal the request |
| `terminal-list {worktree}` | `terminal list --worktree <selector>` | read | — | — |
| `worker-start` (amended) | `worker-start (--task <id> \| --spec <text> [--task-title <t>]) [--run <id>] --worktree <selector> --agent <a> [--model] [--effort] [--timeout-ms]` | mutation | `{dispatchId, taskId}`; with `spec` the task id is taken from the receipt | `worker-show --dispatch <id>` as today, comparing the receipt's task id |

Grammar rules:

- **Argv root is per verb**: `orchestration` for the nineteen, `worktree` for two, `terminal` for one. `ORCA_ORCHESTRATION_VERBS` keeps its meaning (the orchestration subset); a new `ORCA_ADAPTER_OPERATIONS` names all twenty-two; `OrcaAdapterError.operation` widens accordingly.
- **Worktree selector** is a closed grammar validated before spawn: `current`, `active`, `id:<repoId>::<absolute path>`, `path:<absolute path>`, `branch:<git ref name>` (the ref charset `git check-ref-format` accepts, ≤ 256 bytes), `name:<display name>` (one line, ≤ 256 bytes). It is the one placement value a caller may now provide, because the plugin worker runs outside every terminal and `current` cannot name the active workspace from there; `worker-start` still defaults to `current` and rejects every other placement/creation flag. `run` is the Run id domain (`id`), because the worker is bound to no Run and must name the one it created.
- **Workspace status** is `todo | in-progress | in-review | completed` (Orca's four default board columns); a custom column id is out of scope until a host is measured to need one.
- **Comment** is one line, ≤ 512 bytes, NFC, no control characters — the adapter's existing `shortText` domain.
- **Worktree and terminal receipts** are `.strict()` on the fields genie reads (`id`, `path`, `branch`, `displayName`, `comment`, `workspaceStatus`, `createdWithAgent`, `linkedIssue`; `handle`, `worktreeId`, `agentIdentity`, `connected`, `writable`, `lastOutputAt`, plus the list's `truncated` flag) and **pass the remaining fields through**: Orca's worktree record is a 45-field UI projection that grows with every release, and a fully closed schema would turn each Orca release into `unexpected_response` (decision 4). Passthrough is bounded by the existing 1 MiB stdout cap and the typed field bounds.
- The flag-shaped predicate (`value[0] === '-'`), the rejection of raw argv, executable override, caller `--json`, unknown fields, `terminal send`, `--inject`, and every other unlisted verb are unchanged. `worktree-set` joins the mutation set (ambiguity classification, no automatic retry).

## `genie orca mirror` — the one verb

`genie orca mirror --to <APPROVED|IN_PROGRESS|REVIEW|SHIPPED|BLOCKED> [--verdict <SHIP|FIX-FIRST|BLOCKED>] --evidence "<text>" [--worktree <selector>] [--json]`

- Map (code, fixed): `APPROVED → todo`, `IN_PROGRESS → in-progress`, `REVIEW → in-review` (requires `--verdict`), `SHIPPED → completed`, `BLOCKED → in-progress`. `BLOCKED` is the "waiting on a human" transition: its evidence names the gate.
- Comment: `<YYYY-MM-DD> genie <transition>[: <verdict>] — <evidence>`; evidence is one line, ≤ 300 bytes, control characters rejected. Examples: `2026-09-19 genie review: FIX-FIRST — group 2, head 0ef761c, 3 gaps`; `2026-09-19 genie blocked — gate gate_7f3a: Merge PR #3005 into dev?`.
- Default selector `current` (the worktree that contains the working directory; from a coordinator terminal inside Orca this is the coordinator's workspace).
- Output: one JSON line `{worktree: {id, displayName, branch}, workspaceStatus, comment, receipt}`. Exit 0 on a proven write; 1 on a typed adapter error (the error JSON on stderr, including `process_exit` when the directory is not an Orca-managed worktree); 2 on usage.
- Works in standalone mode too: it is a write to a UI card, not a lifecycle authority question; the skills invoke it from their Orca branches only.
- It is the only new CLI surface: `src/term-commands/orca.ts` holds one linear command body and stays inside the cognitive-complexity budget.

## The gate catalogue (RF3) and the mirror points (RF2)

Kept in `skills/work/references/orca-coordinator.md` (no line ceiling), referenced by name from the wish, review and fix skills, which each spend at most the line budget group 3 and group 4 name:

| Moment | Gate question | Options | What each resolution means |
|---|---|---|---|
| Plan review returned (wish, Orca branch, from the coordinator terminal after `run-create`) | `Approve wish <slug>? plan review: <verdict>` | `approve, fix-first, blocked` | persisted Status `APPROVED` / `FIX-FIRST` / `BLOCKED`; an authorization the user already gave satisfies this gate, and it is not raised again |
| Group ends BLOCKED or the fix loop is exhausted (work/fix) | `Group <n> of <slug> is BLOCKED: <cause>. Accept and continue?` | `accept, stop` | `accept`: the blocker is recorded and independent groups continue; `stop`: the wish is `BLOCKED` |
| PR merge-ready (work § Delivery) | `PR #<n> for <slug> is merge-ready against <base>. Merge?` | `merge, hold` | `merge` is the operator's recorded decision; the coordinator merges only into a non-protected base and never bypasses a hook; a protected base stays merge-ready for the operator |
| Promotion (work § Delivery, when the wish promotes) | `Promote <from> to <to> (<version>)?` | `promote, hold` | the decision is recorded; the promotion itself stays the operator's act |

Each gate is raised with `gate-create` on the wish's task (approve wish) or the group's task (the other three), mirrored with `genie orca mirror --to BLOCKED --evidence "gate <id>: <question>"`, waited on with the guide's structured wait, and confirmed with `gate-list` before the coordinator acts; the next mirror transition (`APPROVED`, `IN_PROGRESS`, `SHIPPED`) closes the loop on the card.

Mirror points: `APPROVED` after plan review (wish); `IN_PROGRESS` at `work` entry; `REVIEW` with the verdict at every relayed review verdict (work, fix); `BLOCKED` when a gate is raised or a loop is exhausted; `SHIPPED` after the authorized merge, with the merge SHA or PR. Orca's workspace status is never read back as lifecycle truth: the documents and (in standalone) `genie.db` stay the record.

## Plugin manifest and bundle

- `contributes.commands`: `genie.wish` "Genie: Wish", `genie.work` "Genie: Work", `genie.review` "Genie: Review", `genie.fix` "Genie: Fix", `genie.report` "Genie: Report", `genie.council` "Genie: Council", `genie.doctor` "Genie: Doctor", `genie.update` "Genie: Update" — all `context: "worktree"`. `genie.orca.run-list` is removed, with its `ORCA_RUN_LIST_COMMAND` export and the bundle test's assertion on it.
- `contributes.keybindings`: one `Ctrl+Alt+Shift+<letter>` chord per command (`W`, `K`, `R`, `F`, `P`, `C`, `D`, `U`), each `when: "worktree"`.
- `contributes.events`: `[{on: "agent.status.changed"}]`.
- `capabilities`: `[{"kind":"workspace:read"}, {"kind":"terminal:send"}, {"kind":"notifications:show"}, {"kind":"events:subscribe"}]` — exactly what the handlers call, in the object form Orca's schema requires, so consent lists exactly what runs.
- `engines.orca`: `>=1.4.205`; `ORCA_MINIMUM_RUNTIME_VERSION` and `plugin.json`'s `minimumRuntimeVersion` follow, because the host API shapes above were verified on that build and nothing older was.
- `description` (manifest, `plugin.json`, marketplace — the parity test keeps them equal): "Genie's wish, work, review, fix, report and council verbs in Orca's palette and keybindings; genie lifecycle status and review verdicts mirrored onto the existing board cards; human decisions as Orca gates; result notifications." The marketplace category stays `workflows`: the parity test pins it and changing a category buys nothing.
- `orca-bundle-parity.test.ts` asserts: the registered command set equals the manifest's command ids exactly (a manifest entry with no handler fails, and so does a handler with no entry), every keybinding names a manifest command with `when === context`, every capability is a `{kind}` object from the closed set, the bundle is byte-deterministic from its source.

## Simplicity Case

- **Simplest complete design:** manifest entries plus handlers over the existing adapter, one pure map module, one CLI verb, prose at the existing relay points of four skills and one reference.
- **Added machinery:** (1) three read operations and one write in the adapter, plus the `worker-start` amendment (`spec`, `run`, `worktree`) — required by RF1 (find the agent terminal; start one on a Run the worker created) and RF2 (write status and comment), and by the contributor contract's rule that a mutation gets its official read-back when one exists (`worktree show` exists); (2) the `genie orca mirror` verb — required so the map is code and the writer is one binary; (3) the event subscription with an in-memory dedupe — required by RF6 because the worker can neither poll nor hold Run context; (4) the worktree selector grammar — required because the worker runs outside every terminal; (5) a per-invocation Run created by the plugin when no agent terminal exists — required because `worker-start` needs a Run and the worker is bound to none (decision 8).
- **Deferred until measured:** RF4 and RF5 (wave 2, designed below); a Genie panel (v7); a gate verb (trigger: the coordinators measurably fail to follow the guide's gate verbs); persisting the notification dedupe through `storage` (trigger: a duplicate notification observed after a worker reap); a per-user agent preference for `worker-start` (trigger: a workspace created without an agent); custom board column ids (trigger: a host with a configured status set).
- **Complexity removed:** a second board, a task provider, plugin-side gate polling, a genie-side gate poller with its own Run/Task ledger, any Orca → genie write, any settings surface, per-command consent handling (Orca owns consent), a genie-side notification transport, a per-call compatibility probe.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Native mechanisms only — palette, board, gates, notifications; no new screen | Owner decision D-B; the research shows each surface is reachable today with no Orca change |
| 2 | Text reaches a terminal only through the host API `terminal.sendText`; the adapter keeps rejecting `terminal send` | The contributor contract's boundary stays intact; the host binds a send to the active workspace itself |
| 3 | The adapter allowlist gains `worktree-show`, `worktree-set`, `terminal-list` and amends `worker-start` (`spec`, `run`, `worktree` selector), with a per-verb argv root; this section is the written amendment to `genie-dual-mode-orca-plugin/DESIGN.md:135`, group 1's independent review is its threat-boundary review, and `minimumRuntimeVersion` is the compatibility version that moves | Every verb the four mechanisms need, none they do not; the stamped design cannot be edited without breaking its digest, so the amendment lives here |
| 4 | Worktree and terminal receipts are strict on the fields genie reads and pass the rest through | Orca's worktree record has 45 fields and grows per release; a fully closed schema would break the plugin on every Orca update |
| 5 | `genie orca mirror` is the one emission verb; gates use the adapter verbs the Orca guide already owns; skills call both from their Orca branches | The map is code and tested; one writer; no remembered flags in prose; no second orchestration client (review finding 5) |
| 6 | Fixed map and comment format (`<date> genie <transition>[: <verdict>] — <evidence>`); `BLOCKED` is the gate-pending transition | The owner's map verbatim ("BLOCKED → in-progress + gate"); a dated one-line comment fits the card's one status line and is the channel RF6 reads |
| 7 | Four gates catalogued in the work skill's Orca reference; an authorization the user already gave satisfies a gate | RF3 names exactly these stalls; the existing "do not ask again" rule survives as the satisfied-gate clause |
| 8 | With no agent terminal, the palette handler creates one Run per invocation and starts the worker on it; a timed-out or ambiguous start is reported, never retried | `worker-start` needs a Run, the worker is bound to none, and a Run is a cheap durable namespace; the mutation rule forbids the retry (review finding 1) |
| 9 | Palette handlers address the workspace as `active` and then by its record `id`; `branch:` and `name:` stay in the grammar for the CLI verb | `branch:` is ambiguous on multi-checkout hosts; `active` is the workspace `readContext` resolved (review finding 2) |
| 10 | `Doctor` and `Update` run the genie binary in the worker and notify; the other six send slash commands | Neither has a slash command; their outputs are RF6's named notifications |
| 11 | One `Ctrl+Alt+Shift+<letter>` chord per verb, `when: "worktree"` | Conflict-free with Orca's defaults; the validator requires `when` to match the command context |
| 12 | `engines.orca >= 1.4.205`; runtime floor and `plugin.json` follow | The host API shapes were verified on that build only |
| 13 | Marketplace description rewritten; category `workflows` kept | The old text described a category genie invented; the category is pinned by the parity test and harmless |
| 14 | RF4 and RF5 are designed as follow-up groups and not executed | Owner: wave 2 |
| 15 | The two probes are answered from Orca's bundle and recorded here and in the PR body | Handoff requirement; primary evidence beats the third-party reconstruction |
| 16 | The compatibility probe runs once per worker lifetime; every handler operation carries an explicit `timeoutMs` so the send path spends at most two child processes and the start path at most three inside the host's 30 s | `invokeTimeoutMs ?? 30 000` in Orca's worker controller (review finding 4) |
| 17 | RF6 rides `agent.status.changed` and the card comment; dedupe in worker memory | The only native, plugin-readable channel; the worker cannot poll |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | `readContext` terminal ids and CLI terminal handles may be spelled differently (`term_<uuid>` vs `<uuid>`) | Medium | Exact match first, prefix-stripped match second; the host refuses a wrong terminal with a typed error that becomes a notification; QA records which spelling won |
| 2 | The `agent.status.changed` `state` vocabulary (`working \| blocked \| waiting \| done`) is read from Orca's agent-status record schema, not from a published contract | Low | The handler treats every state but `working` as settled, so an added state degrades to one extra read, bounded by the dedupe |
| 3 | Adding capabilities forces one re-consent on the next plugin update | Low | Documented in the README; Orca's dialog explains it |
| 4 | The plugin host API is `experimental` and may change under `pluginApi: 1` | High | Pinned engine floor; parity tests; every host call wrapped so a failure is a notification, never a crash |
| 5 | The host rejects a command after 30 s while a `worker-start` may still commit | Medium | Probe once; explicit per-operation timeouts (8 s reads, 15 s start); the notification names the ambiguity and forbids the blind retry |
| 6 | `worker-start --spec` on a workspace whose agent is unknown | Low | `createdWithAgent` from the record, default `claude`, reported in the notification |
| 7 | Skills sit 2–6 lines under the 90-line ceiling and two groups add text to them | Medium | Per-skill line budgets in the plan (wish +3, work +4, review +1, fix +2); every table and template lives in the reference; `skills:lint` enforces the ceiling |
| 8 | A Run per palette start on a workspace with no agent terminal accumulates Runs | Low | One Run per human action, named after the verb and workspace; `run-list` shows them; the coordinator releases the worker as usual |

## Success Criteria

- [ ] `bun test src/lib/orca-orchestration-adapter.test.ts` proves the exact argv of the three new operations and the amended `worker-start` (`spec`, `run`, `worktree`), the selector grammar's rejections, the `worktree-set` receipt identity and `worktree-show` read-back, and that the twenty-two operation names are the whole allowlist.
- [ ] `bun test src/lib/orca-lifecycle-mirror.test.ts` proves the five-row map and the comment format, and that the module exports no function taking an Orca status as input.
- [ ] `bun test src/term-commands/orca.test.ts` proves `genie orca mirror` exit codes (0/1/2), stderr, the argv sent to a fake `orca` on PATH, and that a read-back disagreement fails the mirror.
- [ ] `bun test scripts/orca-bundle-parity.test.ts scripts/orca-manifest-parity.test.ts plugins/genie/orca-runtime.test.ts` proves the eight-command set with handlers, the keybinding/context rule, the `{kind}` capability set, the engine pin, the description equality, the symlink-free subtree inside the file cap, and the bundle's byte parity.
- [ ] `plugins/genie/orca-runtime.test.ts` proves a handler turns `readContext → null`, a host-API refusal and an adapter error each into one notification and a `{ok: false}` result, sends the composed text with `enter: true` to the chosen agent terminal, creates a Run and starts a worker on it when no agent terminal exists, reports a timed-out start as ambiguous without retrying, probes once across many invocations, and passes explicit timeouts.
- [ ] The four skills and the Orca reference name `genie orca mirror` at the mirror points and the four gates with their `gate-create` / wait / `gate-list` sequence; `bun run skills:lint` and `bun run wishes:lint` pass.
- [ ] The two probe answers appear in this design and in the PR body before any handler was written.
- [ ] QA on a live Orca 1.4.205 after merge: the palette in a workspace lists the eight entries, `Ctrl+Alt+Shift+R` sends `/review …` into the agent terminal and the run records whether the `readContext` id equalled the `term_` handle or its stripped form, `genie orca mirror --to REVIEW --verdict SHIP --evidence x` flips the card to `in-review` with the comment, and a notification appears when the agent settles.

## Follow-ups designed only

### RF4 — roadmap cards on Orca's Tasks page through the native GitHub provider (group 7, not executed)

`genie task push --github` creates or updates one GitHub issue per roadmap card, one-way genie → GitHub for content; the issue number is stored on the card as the identity key and GitHub → genie carries only that number; the lane becomes a label (`genie:<lane>`); `worktree create --issue <n>` links the workspace. Open product questions that must be answered before it starts: whether 75 cards (56 Done) become public issues at all; whether `tasks.wish` maps to a label, a milestone or a parent issue; what Idea/Brainstorm/Wish become, since GitHub has no word for those lanes. Boundary: a `task sync` rule making GitHub a derived mirror, never a second writer.

### RF5 — nightly `dream`, `skill-audit-sweep`, `research-sweep` as Orca automations (group 8, not executed)

`orca automations create --name "genie dream" --trigger daily --time 02:00 --prompt "/dream" --provider <agent> --workspace <selector> --precheck "genie orca precheck dream"` and likewise for the two sweeps; the precheck exits non-zero when there is nothing to do (no SHIP-ready wish; no skill or research drift), so Orca records a skipped run. Open questions: which provider; whether a fresh worktree per run (`--repo`) or the existing workspace; where the precheck's "nothing to do" evidence lives. The precheck verb is the only genie code RF5 needs.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `291011e2ece7a9e3346cac93c234bc795c3c2495216bfd92cfb96b868445fc70`
- **Reviewer:** plan-review@claude-fable-5.1/orca-plugin-genie-independent
- **Reviewed at:** 2026-09-19T18:09:43.000Z
<!-- genie-design-review:end -->
