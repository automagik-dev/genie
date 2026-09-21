# Wish: The Genie Orca plugin as a real integration — palette, board, gates, notifications

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `orca-plugin-genie` |
| **Date** | 2026-09-19 |
| **Author** | Claude Fable 5.1 (Orca worktree `orca-plugin-genie`) for Felipe Rosa |
| **Appetite** | medium |
| **Branch** | `namastex888/orca-plugin-genie` (the Orca worktree's own branch, cut from `dev`; the PR targets `dev`) |
| **Repos touched** | automagik-dev/genie |
| **Design** | [DESIGN.md](../../brainstorms/orca-plugin-genie/DESIGN.md) |

## Summary

Turn `plugins/genie` from one palette entry that prints the Run list into a real Orca integration on Orca's native mechanisms: eight genie verbs in the palette and keybindings (RF1), genie's lifecycle mirrored one-way onto the existing board cards (RF2), the human decisions that stall the flow today raised as Orca decision gates through the adapter verbs the Orca guide already owns (RF3), and result notifications (RF6). Genie stays the only writer; Orca never writes back. RF4 (roadmap cards on the Tasks page) and RF5 (nightly automations) are designed as follow-up groups and not executed.

## Scope

### IN

- The adapter allowlist gains `worktree-show`, `worktree-set`, `terminal-list` and amends `worker-start` (`spec` in place of `task`; an optional `run`; a closed `worktree` selector grammar), with a per-verb argv root, exact-argv tests, receipt identity and read-back proofs — the written amendment to `genie-dual-mode-orca-plugin/DESIGN.md:135` recorded in the linked design, with group 1's independent review as its threat-boundary review.
- Eight `contributes.commands` with `context: "worktree"` and eight `Ctrl+Alt+Shift+<letter>` keybindings; six handlers send the slash command with the workspace context filled into the workspace's active agent terminal through `terminal.sendText`, or create a Run and start a supervised worker with the text as its spec when no agent terminal exists; `Doctor` and `Update` run the genie binary and notify. `genie.orca.run-list`, its `ORCA_RUN_LIST_COMMAND` export and the bundle test's assertion on it are removed. The compatibility probe runs once per worker lifetime and every handler operation carries an explicit timeout.
- `genie orca mirror` (the fixed map genie → Orca, a dated one-line comment, adapter write with read-back) and the pure map module it is built on.
- The lifecycle skills' Orca branches emit the mirror at their relay points and raise the four catalogued gates with `gate-create`, the guide's structured wait and `gate-list`, mirrored as the `BLOCKED` transition; the catalogue and the mirror table live in `skills/work/references/orca-coordinator.md`.
- Plugin notifications: card-comment changes when a workspace's agent settles (`agent.status.changed`, state `waiting | done | blocked`), `Doctor` results, `Update` availability.
- Manifest capabilities `[{"kind":"workspace:read"},{"kind":"terminal:send"},{"kind":"notifications:show"},{"kind":"events:subscribe"}]`; `engines.orca >= 1.4.205` with `ORCA_MINIMUM_RUNTIME_VERSION` and `plugin.json`'s `minimumRuntimeVersion` following; the description rewritten in the manifest, `plugin.json` and `orca-marketplace.json`; both parity tests updated to the new exact sets.
- Docs: README Orca section and its command count, plugin README, the contributor contract's boundary list, CLAUDE.md (table row, count word, one gotcha), AGENTS.md architecture line, `.genie/INDEX.md`.
- The two probe answers (consent per capability set at enable time; a `worktree` command receives no workspace id — the host resolves it per call) recorded in the design and in the PR body before any handler was written.

### OUT

- A second board, a task provider, a status-bar segment, `contributes.agents`, a Genie panel.
- A `genie orca gate` verb (a genie-side poller with its own Run/Task bookkeeping — removed on the plan review's finding 5).
- Executing RF4 or RF5 (groups 7 and 8 below are design records only).
- Any Orca-side change, any private Orca API, marketplace-install automation, any read of Orca workspace status as lifecycle truth, any Orca → genie write.
- `orca terminal send` / `orca terminal create` through the adapter.
- Merging this PR, promotion, or any change to `.genie/roadmap.json` by hand.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | The seventeen numbered decisions of the linked design bind every group here | The design is the reviewed record; this wish sequences it |
| 2 | Wave 1 executes RF1, RF2, RF3, RF6; RF4 and RF5 are groups 7 and 8, designed only, never dispatched | Owner decision in the handoff |
| 3 | One commit per group, an independent read-only review per group (group 1's doubles as the threat-boundary review the contributor contract requires), bounded repairs, `bun run check` once at the end after merging `origin/dev` | Handoff process; two PRs landed on `dev` during this work and the branch must stay rebase-free |
| 4 | The adapter's read-back for `worktree-set` is `worktree-show`, so the allowlist grows by two worktree operations rather than the one the v6 draft estimated | The contributor contract requires the official read-back when one exists, and `worktree show` exists |
| 5 | `genie orca` is a new top-level command group holding one verb, `mirror`; CLAUDE.md's table and count word and the README's command count follow the registry | The drift guards derive them from `genie --help`; a verb over the existing adapter is smaller than four prose recipes |
| 6 | Gates are prose at four moments using the allowlisted `gate-create` / `check --wait` / `gate-list` the loaded Orca guide owns, mirrored as `BLOCKED` | The coordinator terminal is already Run-bound under the Orca protocol; a poller verb would be the queue/ledger machinery the contract forbids |
| 7 | Per-skill line budgets: wish +3, work +4, review +1, fix +2 across groups 3 and 4 together; every table and template lives in the reference | The four skills sit at 85/84/88/47 of a 90-line ceiling `skills:lint` enforces |

## Simplicity Case

- **Simplest complete design:** manifest entries and handlers over the existing adapter, one pure map module, one CLI verb, prose at the existing relay points of four skills and one reference.
- **Added machinery:** the four adapter operations and the `worker-start` amendment (RF1 and RF2 cannot be expressed otherwise; the contract demands the read-back); the `genie orca mirror` verb (the map must be code and the writer one binary); the event subscription with an in-memory dedupe (the worker can neither poll nor hold Run context); the worktree selector grammar (the worker runs outside every terminal); one Run per palette start when no agent terminal exists (`worker-start` needs a Run the worker is not bound to).
- **Deferred until measured:** RF4 and RF5; a panel; a gate verb; persisting the notification dedupe; a per-user agent preference for `worker-start`; custom board column ids — each with its trigger named in the design.
- **Complexity removed:** a second board, a task provider, plugin-side gate polling, a genie-side gate poller with its own Run/Task ledger, any Orca → genie write, a settings surface, per-command consent handling, a genie-side notification transport, a per-call compatibility probe.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] `bun test src/lib/orca-orchestration-adapter.test.ts` proves the exact argv of `worktree-show`, `worktree-set`, `terminal-list` and the amended `worker-start` (`spec`, `run`, `worktree`), the selector grammar's rejections, the `worktree-set` receipt identity and `worktree-show` read-back, and that the twenty-two operation names are the whole allowlist.
- [ ] `bun test src/lib/orca-lifecycle-mirror.test.ts` proves the five-row map and the comment format, and that no exported function takes an Orca status as input.
- [ ] `bun test src/term-commands/orca.test.ts` proves `genie orca mirror` exit codes (0/1/2), stderr, the argv received by a fake `orca` on PATH, and that a read-back disagreement fails the mirror.
- [ ] `bun test scripts/orca-bundle-parity.test.ts scripts/orca-manifest-parity.test.ts plugins/genie/orca-runtime.test.ts` proves the eight-command set with handlers, the keybinding/context rule, the `{kind}` capability set, the engine pin, the description equality across the three JSON files, the symlink-free subtree inside the file cap, and the bundle's byte parity.
- [ ] `plugins/genie/orca-runtime.test.ts` proves a handler turns `readContext → null`, a host-API refusal and an adapter error each into one notification and a `{ok: false}` result, sends the composed text with `enter: true` to the chosen agent terminal, creates a Run and starts a worker on it when no agent terminal exists, reports a timed-out start as ambiguous without retrying, probes once across many invocations, passes explicit timeouts, and notifies a changed card comment once per settle.
- [ ] `bun run skills:lint` and `bun run wishes:lint` pass with the four skills inside the 40–90 line house size and within the budgets of decision 7.
- [ ] `bun run check` exits 0 once, at the end, on the branch merged with `origin/dev`.
- [ ] The PR body against `dev` records the two probe answers with their bundle evidence, and every commit message ends with the required co-author line.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | High — the trust boundary; every other group builds on its schemas; its review is the threat-boundary review | inherit | Adapter allowlist amendment + tests |

### Wave 2 (parallel — disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | High — host API contract read from a bundle, a 30 s host budget, bundle parity | inherit | RF1 commands, keybindings, manifest, marketplace, parity tests |
| 3 | engineer | Medium — pure map + one verb + prose at existing relay points | inherit | RF2 mirror verb and the skills' mirror points |

### Wave 3 (parallel — disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | Low — prose only: the gate catalogue and four skill sentences | inherit | RF3 gates in the skills' Orca branches |
| 5 | engineer | Medium — event subscription, dedupe, two binary-backed handlers | inherit | RF6 notifications |

### Wave 4 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 6 | engineer | Low — prose pinned by three drift tests | inherit | Docs |

### Wave 5 (designed only — not executed in this wish)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 7 | engineer | Medium — three open product questions | inherit | RF4 roadmap → GitHub issues → Tasks page |
| 8 | engineer | Low — one precheck verb + three automations | inherit | RF5 nightly automations |

**Global constraints:** Orca host `1.4.205` (schema v1, 234 commands) is the verified floor and the host rejects a plugin command after `30 000` ms; the adapter keeps `shell: false`, adapter-owned `--json`, `.strict()` inputs, the flag-shaped predicate and the mutation/read-back rule; every shipped `SKILL.md` stays between 40 and 90 lines; CLAUDE.md's command table and count word and the README's command count must match `genie --help`; conventional commits ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `umask 022` first in every shell; never `--no-verify`, never force-push, never `gh pr merge`; `origin/dev` is merged, never rebased; `.genie/roadmap.json` is never edited by hand.

Groups in one wave own disjoint files (listed per group). Groups 7 and 8 are records for a later wish and are never dispatched here.

## Execution Groups

### Group 1: Adapter allowlist amendment

**Goal:** The closed adapter expresses exactly what RF1 and RF2 need — three reads, one write, one amended verb — with the same schema, argv, receipt and read-back discipline as the nineteen orchestration verbs.

**Deliverables:**
1. `src/lib/orca-orchestration-adapter.ts`: operations `worktree-show {worktree}`, `worktree-set {worktree, workspaceStatus?, comment?}` (at least one field), `terminal-list {worktree}`; `worker-start` accepts `task` XOR `spec` (+ optional `title` with `spec`), an optional `run` (id), and an optional `worktree` selector (`current` default); the selector grammar `current | active | id:<repoId>::<abs path> | path:<abs path> | branch:<ref> | name:<display name>` validated before spawn; per-verb argv root (`worktree`, `terminal`, `orchestration`); `ORCA_ADAPTER_OPERATIONS` (22) beside `ORCA_ORCHESTRATION_VERBS` (19); receipt schemas strict on the read fields with passthrough for the rest; `worktree-set` in the mutation set with `worktree-show` as its read-back; `worker-start`'s read-back compares the receipt's task id.
2. `src/lib/orca-orchestration-adapter.test.ts`: exact-argv rows for the four; rejection of every selector spelling outside the grammar, of `terminal-send`, of a `worker-start` with both `task` and `spec` or neither, of `title` without `spec`, of a `worktree-set` with neither field; receipt identity mismatch and read-back disagreement for `worktree-set`; a `worker-start --spec --run` readback keyed on the receipt's task id; the allowlist test enumerates all 22.

**Interfaces:**
- Consumes: none
- Produces: `OrcaOperation` union members `{operation:'worktree-show', worktree}`, `{operation:'worktree-set', worktree, workspaceStatus?, comment?}`, `{operation:'terminal-list', worktree}`, `{operation:'worker-start', task?|spec?, title?, run?, worktree?, agent, model?, effort?, timeoutMs?}`; response shapes `{worktree: {id, path, branch, displayName, comment, workspaceStatus, createdWithAgent?, linkedIssue?, …}}` and `{terminals: [{handle, worktreeId, agentIdentity?, connected, writable, lastOutputAt?, …}], truncated?}`; the exported `ORCA_ADAPTER_OPERATIONS` and the widened `OrcaAdapterError.operation`.

**Acceptance Criteria:**
- [ ] `buildOrcaOrchestrationArgv({operation:'worktree-set', worktree:'current', workspaceStatus:'in-review', comment:'x'})` equals `['worktree','set','--worktree','current','--workspace-status','in-review','--comment','x','--json']`, and the three other new rows are pinned the same way, including `worker-start` with `--spec`, `--task-title`, `--run` and `--worktree id:…`.
- [ ] Every selector outside the grammar, every flag-shaped value, `terminal-send`, and every unlisted verb are rejected before spawn (the executor is never called).
- [ ] A `worktree-set` whose read-back disagrees throws `readback_mismatch` with `retrySafety: 'unsafe'`; a receipt whose `id` is missing throws `ambiguous_after_possible_commit`.
- [ ] The existing 19-verb rows and every existing test stay green unchanged.

**Validation:**
```bash
umask 022 && bun test src/lib/orca-orchestration-adapter.test.ts && bunx tsc --noEmit && bunx biome check src/lib/orca-orchestration-adapter.ts src/lib/orca-orchestration-adapter.test.ts
```

**depends-on:** none

---

### Group 2: RF1 — genie verbs in the palette and keybindings

**Goal:** Eight palette entries with keybindings, available in a workspace, each delivering its slash command with the workspace context into the active agent terminal, or creating a Run and starting a supervised worker when there is none — all inside the host's 30 s.

**Deliverables:**
1. `plugins/genie/orca-plugin.json`: the eight commands (`genie.wish` … `genie.update`, titles `Genie: Wish` … `Genie: Update`, `context: "worktree"`), eight keybindings (`Ctrl+Alt+Shift+W/K/R/F/P/C/D/U`, `when: "worktree"`), `capabilities: [{"kind":"workspace:read"},{"kind":"terminal:send"},{"kind":"notifications:show"}]`, `engines.orca: ">=1.4.205"`, the rewritten description; `genie.orca.run-list` removed. `plugins/genie/plugin.json` (`minimumRuntimeVersion`, description) and `orca-marketplace.json` (description) follow.
2. `plugins/genie/orca-entrypoint.ts` + `orca-entrypoint.min.js` (regenerated with `bun scripts/orca-bundle-parity.ts --write`): `activate(ctx)` registers the eight ids; the six verb handlers follow the design's approach step 1 (readContext → `worktree-show --worktree active` → `terminal-list --worktree active` → terminal choice → composed text → `terminal.sendText`, or `run-create` + `worker-start --run --spec --worktree id:…`); `Doctor`/`Update` handlers as stubs that notify "not yet available" until group 5 lands them (the manifest carries all eight from this group so the set is stable). Every handler resolves `{ok, …}` and ends in one `notifications.show`; nothing throws into the host; a timed-out or ambiguous `worker-start` is reported as "start requested; confirm in Orca before retrying". `plugins/genie/orca-runtime.ts`: `ORCA_MINIMUM_RUNTIME_VERSION = '1.4.205'`; the probe runs once per runtime instance and is cached; `execute` accepts the operation's own `timeoutMs`; the handler helpers (`chooseAgentTerminal`, `composeSlashCommand`) exported for tests. The `ORCA_RUN_LIST_COMMAND` export is deleted.
3. Tests: `plugins/genie/orca-runtime.test.ts` (manifest shape incl. `{kind}` capabilities, the six-verb handler outcomes through a fake host and fake adapter, terminal choice exact-then-prefix-stripped, the Run-create + `worker-start` fallback with `createdWithAgent`, the ambiguous-start notification, one probe across many invocations, explicit timeouts on every operation), `scripts/orca-bundle-parity.test.ts` (registered set equals the manifest ids; keybinding `when` equals the command context; every keybinding names a manifest command; the run-list assertion removed), `scripts/orca-manifest-parity.test.ts` (description equal in the three JSON files; `engines.orca` equals `>=${ORCA_MINIMUM_RUNTIME_VERSION}`; every capability is a `{kind}` object from the closed set; existing checks kept).

**Interfaces:**
- Consumes: group 1's `worktree-show`, `terminal-list`, `run-create`, `worker-start {spec, run, worktree}`.
- Produces: `createOrcaPluginEntrypoint(adapter, host?)`, `GENIE_PALETTE_COMMANDS` (the ordered eight ids with their slash verbs), `chooseAgentTerminal(readContextIds, terminals)`, `composeSlashCommand(verb, workspace)` — consumed by group 5.

**Acceptance Criteria:**
- [ ] The committed bundle loads as ESM and registers exactly the eight manifest ids; a ninth manifest entry or a missing handler fails the parity test.
- [ ] With a fake host returning `readContext → {branch, displayName, terminals}` and a fake adapter returning one agent terminal, `genie.review` calls `terminal.sendText` once with text starting `/review` and containing the branch, the display name and the worktree path, `enter: true`, then one notification; the adapter saw `worktree-show` and `terminal-list` addressed to `active` with explicit `timeoutMs`, and the probe exactly once across three invocations.
- [ ] With no agent terminal the handler calls `run-create`, then `worker-start` with `run` equal to the created Run, `spec` equal to the composed text, `worktree: 'id:<id>'`, `agent` from `createdWithAgent`, then one notification naming the agent; a `worker-start` that throws `ambiguous_after_possible_commit` produces one notification containing "confirm in Orca" and no second `worker-start`.
- [ ] `readContext → null`, a host refusal (`capability_denied`) and an adapter error each produce one notification and `{ok:false}`; no handler rejects.
- [ ] `orca-manifest-parity.test.ts` and `orca-bundle-parity.test.ts` pass; `bun run lint:orca-bundle` passes.

**Validation:**
```bash
umask 022 && bun run lint:orca-bundle && bun test scripts/orca-bundle-parity.test.ts scripts/orca-manifest-parity.test.ts plugins/genie/orca-runtime.test.ts && bunx tsc --noEmit
```

**depends-on:** 1

---

### Group 3: RF2 — the board mirror

**Goal:** Genie's lifecycle transitions flip the workspace's board status and write a dated one-line comment through one verb, emitted from the lifecycle skills' Orca branches; the map is code and provably one-way.

**Deliverables:**
1. `src/lib/orca-lifecycle-mirror.ts`: `mirrorTransition({to, verdict?, evidence, today}) → {workspaceStatus, comment}` with the fixed map and the comment format; typed errors for a missing verdict on `REVIEW`, a verdict on any other transition, and evidence that is empty, multi-line or over 300 bytes. No export takes an Orca status.
2. `src/term-commands/orca.ts` + registration in `src/genie.ts`: `genie orca mirror --to … [--verdict …] --evidence … [--worktree <selector>] [--json]` executing `worktree-set` through `createOrcaOrchestrationAdapter()`, printing the JSON receipt line; exit 0/1/2 as designed; one linear command body inside the cognitive-complexity budget.
3. Skills, within decision 7's budgets (this group spends wish +2, work +3, review +1, fix +1): `skills/wish/SKILL.md` step 4 Orca clause (mirror `APPROVED`), `skills/work/SKILL.md` (mirror `IN_PROGRESS` at entry; the review-verdict relay and `blocked:` comment under Orca become `genie orca mirror --to REVIEW --verdict …` / `--to BLOCKED`; `SHIPPED` after the authorized merge), `skills/review/SKILL.md` § Orca mode (the coordinator relays with the mirror verb; the reviewer still writes nothing), `skills/fix/SKILL.md` § Handoff (the Orca relay names the verb), `skills/work/references/orca-coordinator.md` (the mirror table, the comment format, "Orca status is never read back as truth").
4. Tests: `src/lib/orca-lifecycle-mirror.test.ts`; `src/term-commands/orca.test.ts` (subprocess invocations of `src/genie.ts` with `TERM_PROGRAM=Orca` and a fake `orca` script on a temporary PATH that answers canned envelopes per argv and records what it received: success receipt, read-back disagreement → exit 1 with `readback_mismatch`, usage errors → exit 2 with the reason on stderr, not-a-worktree → exit 1).

**Interfaces:**
- Consumes: group 1's `worktree-set` / `worktree-show`.
- Produces: `mirrorTransition`, `GENIE_TRANSITIONS`, `ORCA_WORKSPACE_STATUSES`, `registerOrcaCommands(program)`; the comment prefix `<date> genie ` that group 5 recognizes.

**Acceptance Criteria:**
- [ ] The map test pins exactly `APPROVED→todo`, `IN_PROGRESS→in-progress`, `REVIEW→in-review`, `SHIPPED→completed`, `BLOCKED→in-progress` and the comment `2026-09-19 genie review: FIX-FIRST — group 2, head 0ef761c, 3 gaps`.
- [ ] `genie orca mirror --to REVIEW --evidence x` exits 2 naming the missing verdict; `--to APPROVED --verdict SHIP` exits 2; a multi-line evidence exits 2.
- [ ] With the fake `orca` answering a matching receipt and read-back, the verb exits 0 and prints one JSON line with `workspaceStatus`, `comment` and the receipt, and the fake recorded `worktree set … --json` then `worktree show … --json`; with a disagreeing read-back it exits 1 and stderr carries `readback_mismatch`.
- [ ] The four skills stay within 40–90 lines and decision 7's budgets; `bun run skills:lint` passes; the release-docs test's pins on those skills stay green.

**Validation:**
```bash
umask 022 && bun test src/lib/orca-lifecycle-mirror.test.ts src/term-commands/orca.test.ts && bun run skills:lint && bunx tsc --noEmit && bunx biome check src/lib/orca-lifecycle-mirror.ts src/term-commands/orca.ts src/genie.ts
```

**depends-on:** 1

---

### Group 4: RF3 — human decisions as Orca gates

**Goal:** Every question that stalls the flow today becomes an Orca decision gate the coordinator raises with the allowlisted verbs the Orca guide owns, mirrors onto the card, waits on, and confirms — resolvable from Orca's UI in any workspace.

**Deliverables:**
1. `skills/work/references/orca-coordinator.md`: the four-gate catalogue (approve wish, accept BLOCKED, merge, promote) with question templates, options, the meaning of each resolution, and the one sequence every gate follows — `gate-create --task <task>` as the loaded guide spells it, `genie orca mirror --to BLOCKED --evidence "gate <id>: <question>"`, the guide's structured wait (`check --wait … --timeout-ms <n>`, a timeout being a checkpoint), and a resolution confirmed only by `gate-list --task <task>` when the wait returns, whatever woke it — the guide promises no `decision_gate` wake for a UI resolution, so the reference must not claim one; the "an authorization the user already gave satisfies a gate" clause replacing the old "do not ask again" sentence; the approve-wish gate stated to run from the wish's coordinator terminal after the `run-create` that `work` needs anyway, with the Run and task ids recorded in WISH.md.
2. Skills, within decision 7's remaining budgets (wish +1, work +1, fix +1): `skills/wish/SKILL.md` (the approve-wish gate in the Orca branch, by name), `skills/work/SKILL.md` (merge and promote gates in § Delivery; accept-BLOCKED where a group ends BLOCKED), `skills/fix/SKILL.md` (exhausted loop → `BLOCKED` mirror + accept-BLOCKED gate; the Promotion gate's human ruling is a gate resolution under Orca).

**Interfaces:**
- Consumes: the existing `gate-create`, `gate-list`, `check` verbs; group 3's `genie orca mirror` and comment prefix.
- Produces: none beyond the reference.

**Acceptance Criteria:**
- [ ] The reference names all four gates with their questions, options and resolutions, and one gate sequence that uses only allowlisted verbs; no skill restates a flag the guide owns.
- [ ] `skills:lint` passes; the four skills are within 40–90 lines and the combined budget of decision 7; the release-docs pins on the skills and the Orca reference (`fix`, no `## Escalation Diagnosis`) stay green.

**Validation:**
```bash
umask 022 && bun run skills:lint && bun test scripts/release-docs.test.ts
```

**depends-on:** 3

---

### Group 5: RF6 — result notifications

**Goal:** Review finished, gate pending, `genie update` available and doctor warnings reach the operator as Orca desktop notifications, from the plugin worker alone.

**Deliverables:**
1. `plugins/genie/orca-plugin.json`: `contributes.events: [{on: "agent.status.changed"}]`; `capabilities` gains `{"kind":"events:subscribe"}`.
2. `plugins/genie/orca-entrypoint.ts` + regenerated bundle: `ctx.events.on('agent.status.changed', …)` — on a payload with a `worktreeId` and a `state` other than `working`, read the workspace (`worktree-show --worktree id:<worktreeId>`, explicit timeout), and when its `comment` starts with the genie prefix and differs from the last one notified for that workspace, call `notifications.show {title: "Genie — <displayName>", body: <comment>}`; the `Doctor` handler runs `genie doctor --json` (cwd = the workspace path; `genie` from PATH then `~/.local/bin/genie`; 20 s bound) and notifies the warn/fail counts with up to three names; the `Update` handler reads `genie --version` and the stable `.well-known/latest.json` (8 s bound) and notifies "update available: <v>" or "up to date" or "could not check".
3. Tests in `plugins/genie/orca-runtime.test.ts`: a settle event notifies once and a repeated identical comment does not; a `working` state reads nothing; a comment without the genie prefix notifies nothing; the doctor and update handlers through injected spawn/fetch seams.

**Interfaces:**
- Consumes: group 2's entrypoint and helpers; group 3's comment prefix; group 1's `worktree-show`.
- Produces: none beyond the manifest.

**Acceptance Criteria:**
- [ ] `agent.status.changed {worktreeId, state:'done'}` with a comment `2026-09-19 genie review: SHIP — …` produces exactly one notification whose body is the comment; a second identical event produces none; a later different comment (a `blocked — gate …` line) produces one.
- [ ] `state:'working'` triggers no adapter call.
- [ ] The doctor handler with a fake spawn returning `{ok:false, checks:[{status:'warn',…}]}` notifies `1 warn`; the update handler with a fake fetch answering a newer version notifies it and with a fetch failure notifies `could not check`.
- [ ] The bundle parity and manifest parity tests pass with the events and capability additions.

**Validation:**
```bash
umask 022 && bun run lint:orca-bundle && bun test scripts/orca-bundle-parity.test.ts scripts/orca-manifest-parity.test.ts plugins/genie/orca-runtime.test.ts && bunx tsc --noEmit
```

**depends-on:** 2

---

### Group 6: Docs

**Goal:** Every operator- and contributor-facing document names what the plugin now does, and the three drift guards stay green.

**Deliverables:**
1. `README.md` § Standalone and Orca authority: a "What the plugin does inside Orca" subsection (palette and keybindings, the board mirror and its map, the four gates, notifications, the one re-consent on update, `genie orca mirror`), the `1.4.205` floor; the CLI command count line (`16 CLI commands` → `17`).
2. `plugins/genie/README.md` (what ships, the eight commands, "No launcher or registration ships" kept) and `plugins/genie/references/orca-orchestration.md` (the positive boundary block lists the twenty-two operations grouped by argv root; the selector grammar; `worktree-set`'s read-back; the `worker-start` amendment; the `1.4.205` floor; `Reject \`terminal send\`` and the other rejections kept verbatim).
3. `CLAUDE.md`: the `orca` row in the CLI table, the count word `Seventeen`, an `### Orca subcommands` block, one gotcha on the plugin's native mechanisms and the one-way mirror; `AGENTS.md` line 20 names the plugin's surfaces; `.genie/INDEX.md` gains this wish under the section its lane implies.

**Interfaces:**
- Consumes: the final shapes of groups 1–5.
- Produces: none.

**Acceptance Criteria:**
- [ ] `bun test scripts/release-docs.test.ts src/__tests__/claude-md-drift.test.ts scripts/orca-manifest-parity.test.ts` passes.
- [ ] The contributor contract still contains every pinned phrase (`Reject \`terminal send\``, `Verb amendment checklist`, `public read-back`, the receipt-only exception list) and now lists `worktree show`, `worktree set`, `terminal list`.
- [ ] `genie --help` and the CLAUDE.md table agree on seventeen rows and the README says `17 CLI commands`.

**Validation:**
```bash
umask 022 && bun test scripts/release-docs.test.ts src/__tests__/claude-md-drift.test.ts scripts/orca-manifest-parity.test.ts && bun run wishes:lint
```

**depends-on:** 1, 2, 3, 4, 5

---

### Group 7: RF4 — roadmap cards on Orca's Tasks page (designed only, not executed)

**Goal:** Genie's roadmap cards appear where Orca users already look for work, through the native GitHub task provider, with GitHub a derived mirror and never a second writer.

**Deliverables:**
1. `genie task push --github [--lane <name>] [--dry-run]`: one GitHub issue per card, one-way genie → GitHub for content (title, body from the card and its wish, label `genie:<lane>`), the issue number stored on the card as its identity key, GitHub → genie carrying only that number; a `task sync` rule that never imports issue content.
2. `worktree create --issue <n>` documented as the link from a card's issue to a workspace.
3. Answers recorded in a design revision before any code: whether the 75 cards (56 Done) become public issues at all; whether `tasks.wish` maps to a label, a milestone or a parent issue; what Idea/Brainstorm/Wish become, since GitHub has no word for those lanes.

**Interfaces:**
- Consumes: `.genie/roadmap.json` cards; `gh issue create|edit`.
- Produces: the card field `github_issue` (number) and the label scheme.

**Acceptance Criteria:**
- [ ] A dry run lists every issue it would create or update without touching GitHub; a real run is idempotent by issue number.
- [ ] `task sync` rejects any content change that originated on GitHub.

**Validation:**
```bash
umask 022 && bun test src/term-commands/v5-task.test.ts
```

**depends-on:** 6

---

### Group 8: RF5 — nightly genie runs as Orca automations (designed only, not executed)

**Goal:** `skill-audit-sweep` and `research-sweep` run nightly as Orca automations whose precheck skips the run when there is nothing to do.

**Deliverables:**
1. `genie orca precheck <skill-audit-sweep|research-sweep>`: exit 0 when there is work (skill or research drift), non-zero otherwise, one line of reason on stdout.
2. Two `orca automations create --name "genie <job>" --trigger daily --time <HH:MM> --prompt "/<job>" --provider <agent> --workspace <selector> --precheck "genie orca precheck <job>"` recipes documented in the README, never created by genie itself.

**Interfaces:**
- Consumes: group 3's `registerOrcaCommands`.
- Produces: the precheck exit contract.

**Acceptance Criteria:**
- [ ] `automations list` on a host that followed the recipe shows the two entries and `automations runs` records a skipped run when the precheck exits non-zero.

**Validation:**
```bash
umask 022 && bun test src/term-commands/orca.test.ts
```

**depends-on:** 6

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion on a host running Orca 1.4.205 with the plugin installed from the `orca-plugin-dev` ref or the local `plugins/genie` folder; the real-runtime smoke runs with `GENIE_ORCA_REAL_RUNTIME_SMOKE=1`._

- [ ] Functional: the palette in a workspace lists the eight `Genie:` entries; `Ctrl+Alt+Shift+R` delivers `/review — workspace …` into the workspace's agent terminal, and the run records whether the id `readContext` returned equalled the `term_` handle from `terminal list` or its stripped form; in a workspace with no agent terminal, `Genie: Wish` creates a Run and starts a supervised worker whose task is the composed text.
- [ ] Integration: `genie orca mirror --to REVIEW --verdict SHIP --evidence "qa"` flips the card to `in-review` with the dated comment; from a Run-bound coordinator terminal, `gate-create` on a task plus `genie orca mirror --to BLOCKED --evidence "gate <id>: QA gate?"` shows the gate in Orca and the `blocked` line on the card, and `gate-list` reports the resolution after a human resolves it, and the run records whether the UI resolution woke the coordinator's wait or only the timeout did; a notification appears when the workspace's agent settles after the comment changed.
- [ ] Regression: flipping the card status in Orca changes no genie document and no `genie.db` row; `genie setup --orchestration-mode orca` still probes and switches on a compatible host; the real-runtime smoke still completes or fails `unsupported_environment` without mutation.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `readContext` terminal ids and CLI handles differ in spelling | Medium | exact then prefix-stripped match; the host's typed refusal becomes a notification; QA records which spelling won |
| The plugin host API is `experimental` under `pluginApi: 1` | High | engine floor pinned; parity tests; every host call wrapped so a failure is a notification, never a crash |
| The host rejects a command after 30 s while a `worker-start` may still commit | Medium | probe once; explicit per-operation timeouts (8 s reads, 15 s start); the notification names the ambiguity and forbids the blind retry |
| Skills sit 2–6 lines under the 90-line ceiling and two groups add text to them | Medium | decision 7's per-skill budgets; tables and templates only in the reference; `skills:lint` enforces the ceiling |
| Capability additions force one re-consent on update | Low | documented in the README |
| A Run per palette start on a workspace with no agent terminal accumulates Runs | Low | one Run per human action, named after the verb and workspace; visible in `run-list` |
| Two PRs landed on `dev` during this work | Low | `origin/dev` merged before the final gate; no rebase |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-09-19T17:32:43Z — FIX-FIRST, then 2026-09-19T18:09:43Z — SHIP

- Reviewer: `plan-review@claude-fable-5.1/orca-plugin-genie-independent` (a fresh read-only agent, not the author), HEAD `2ea6ee919`; blind criteria C1–C22 frozen before reading, none added afterwards; every host-API claim re-verified against `/opt/orca/squashfs-root/resources/app.asar` and the read-only `orca … --help` surface.
- Round 1 (design rev. 1): 4 HIGH (the palette `worker-start` fallback had no Run to land in; `branch:<x>` is `selector_ambiguous` on this host; manifest `capabilities` must be `{kind}` objects; the host's `invokeTimeoutMs` is 30 s and the send path spent most of it), 1 HIGH on KISS (`genie orca gate` was a poller with its own Run/Task ledger — the machinery the contributor contract forbids), 4 MEDIUM, 2 LOW. All eleven applied: design rev. 2 (decisions 3, 5, 8, 9, 16, risks 5, 7, 8) and this plan (decisions 5–7, groups 1, 2, 4, 6, QA).
- Round 2 (design rev. 2, digest `291011e2…`): SHIP. 1 MEDIUM — the reference must not claim a `decision_gate` wake for a UI gate resolution (applied to group 4 and QA above); 2 LOW — the design says idle workers are reaped after 60 s where the bundle reads `idleReapMs ?? 3e5` (300 s), accepted as-is because the slip only strengthens the design's own trigger and the design is stamped at the reviewed digest; whether a non-terminal caller can `worker-start --run` onto the Run it created stays a hypothesis routed to QA.
- Evidence: `validate-wish` passed; `wishes:lint` failed only on the then-PENDING evidence; `orca orchestration worker-start --help` carries `(--task | --spec)`, `[--run]`, `[--worktree]`; `active` and `id:` selectors resolve for `worktree show` and `terminal list` on this host. Status DRAFT → APPROVED.

### Execution — 2026-09-19 — groups 1–4 landed, each independently reviewed

- Group 1 (`98104af26`, follow-up `240537478`, chore `445bd603a`): review SHIP by `g1-review@claude-fable-5.1/orca-plugin-genie-independent` (threat-boundary review): allowlist closed at 22, receipts/read-backs proven, 75 tests; two MEDIUM applied (recovery hints spell the public command; the six-failure classifier covers the new verbs); the `worker-start` receipt passes extra fields through. Also repaired two 1.4.205 breaks that made every adapter read fail on the host (UUID `_meta.runtimeId`; `desktopWindowStatus: "openable"` + `connectionState`), proven by a live read of `status`, `run-current`, `worktree-show active`, `terminal-list active`.
- Group 2 (`bc4e6fae5`): review SHIP by `g2-review@…independent`; 41 tests; two MEDIUM recorded for a follow-up: `Ctrl+Alt+Shift+C` (`genie.council`) equals Orca's `fileExplorer.copyRelativePath` chord on Linux/Windows (move it and pin the three 1.4.205 three-modifier defaults as forbidden), and design decision 16's arithmetic is wrong — the start path spawns six child processes plus the once-per-worker probe (ceiling ≈ 68 s, send path ≈ 24 s) against the host's 30 s `invokeTimeoutMs`; the host then rejects the invoke and drops the late result but does not kill the worker, whose closing notification still arrives, and the plugin never retries the mutation; accepted as a bounded risk, recorded here and in the PR body, with a read-phase deadline before `run-create` as the follow-up hardening.
- Group 3 (`810af8719`): review FIX-FIRST by `g3-review@fable` — HIGH: the in-process seam test leaked `process.exitCode = 2` so the suite exited 2 with zero failures; applied in `e5711c58c` (the seam returns 0|1|2, only the registered command assigns process state), plus the idempotency subprocess test and a source-scan pinning the mirror module import-free. Recorded errata against the stamped design: a directory that is not an Orca worktree surfaces as `ambiguous_after_possible_commit` (the adapter classifies every failed mutation as ambiguous), not `process_exit`; the exit code (1) and the JSON stderr line are as designed.
- Group 4 (`c879c4c96`, follow-up `70933eba9`): review SHIP by `g4-review@fable`; two MEDIUM applied (the wish-level gate task is created with the guide's `task-create` after `run-create`; the promote gate also carries fix's out-of-worktree ruling naming the change and blast radius). Skills at 88/84/89/48 lines.
- Group 5 (`d1bd411a5`), group 6 (`48f03ebfa`), the group 2 follow-up (`d144cd71c`) and the `origin/dev` merge (`226d8827b`, `e3a17b74b` — dev's `genie wish` makes eighteen top-level commands): final review SHIP by `final-review@claude-fable-5.1/orca-plugin-genie-independent`, 307 focused tests green; three MEDIUM applied in the follow-up commit (the notification title is bounded to Orca's 120-character `title` limit, with a test; the 20 s read-phase deadline has a test proving it fires before `run-create`; the doctor path's three-process ceiling is stated), two LOW (the 300 s reap comment fixed; this block).
- Full gate `bun run check` green on `ad85693d1` (3148 pass, 3 skip, 0 fail); merge-ready PR [#3019](https://github.com/automagik-dev/genie/pull/3019) against `dev`, opened 2026-09-19 and deliberately not merged. Stays IN_PROGRESS through PR review and CI; SHIPPED only after the authorized merge and the QA criteria above run on a live Orca 1.4.205.

### Dogfood — 2026-09-20 — 5.260919.14 on the dogfood host; design errata on the `active` selector

- Live: `genie orca mirror --to REVIEW --verdict SHIP` flipped this worktree's card to `in-review` with the dated comment and read it back; the shipped bundle loads in Node 26 and registers the eight ids; `orca-plugin-dev` was republished from the merge; `genie doctor` ok.
- Errata against the stamped design (decision 9): the CLI's `active`/`current` are cwd shortcuts ("No Orca-managed worktree contains the current directory"), never the workspace open in the UI, so every palette handler failed at `worktree-show --worktree active` — the plugin worker's cwd is no workspace — and on a desktop paired to a remote runtime the local CLI cannot list that runtime's terminals at all (`omittedHostIds`). Fixed on branch `fix/orca-plugin-workspace-by-name`: the host context is the truth, enriched by `name:<displayName>` and accepted only on the host's branch, then addressed by `id:`; when the CLI cannot reach the workspace the send path falls back to the host's first terminal and the start path refuses with a notification. Live smoke on this host with the real adapter and a stubbed host API: the review verb chose the real agent terminal with an `exact` handle match — the `readContext` ids ARE the `term_…` handles (risk 1 closed).
- Still open for the Mac-paired topology: `agent.status.changed` notifications read the card by `id:` through the local CLI, which cannot reach a remote runtime's workspace; the settle handler logs and stays silent there.

### PR review — 2026-09-19 — FIX-FIRST, repaired

An independent PR review of `8cfd00ccb` returned FIX-FIRST. Every finding is applied on the branch:

- **HIGH — terminal injection.** `composeSlashCommand` interpolated the workspace display name and path into text submitted with `enter: true` after NFC normalization only, so a newline in an agent-chosen `--name` was a second command typed into another agent's terminal. Every interpolated fact now passes through a sanitizer (C0/DEL/C1 → space, whitespace runs collapsed, trimmed, empty segments omitted), the whole composed line is sanitized again, and the same guard covers the worker objective and both notification fields. Defence in depth at the read boundary too: the adapter's `worktreeRecord` refuses a `displayName` or `path` carrying a control character (`unexpected_response`), while spaces and unicode still decode. Nine new assertions across the two suites.
- **MEDIUM — stale base.** `origin/dev` (`5.260919.13`) merged; the only conflict was the plugin manifest version, resolved to dev's, with `bun scripts/version.ts --check` and the manifest-parity test green.
- **LOW — update channel.** `Genie: Update` hardcoded the stable `latest.json`, so a dev host read the wrong ladder. The channel now comes from the CLI (`genie config get updateChannel`, the same sticky preference `resolveChannel` reads) and selects `latest.json` or `dev.json`; every unreadable answer falls back to stable. The toast names the channel. The egress is documented in the manifest description (which the consent dialog shows) and in `plugins/genie/README.md`.
- **LOW — a flag that promised a second output.** `genie orca mirror --json` was accepted and ignored; it is removed, and the one JSON line is pinned as the only output.
- **Prose.** The coordinator reference now states that the card holds ONE genie status line (latest wins; the history belongs to the wish), and the PR body states that the RF3 gates are a convention the coordinator polls with `gate-list` (no mechanical wake) and that RF6's only proactive trigger is `agent.status.changed`.
- Errata: `genie orca mirror` takes no `--json`, against the stamped design's synopsis.

---

## Files to Create/Modify

```
src/lib/orca-orchestration-adapter.ts            (G1)
src/lib/orca-orchestration-adapter.test.ts       (G1)
plugins/genie/orca-plugin.json                   (G2, G5)
plugins/genie/plugin.json                        (G2)
plugins/genie/orca-entrypoint.ts                 (G2, G5)
plugins/genie/orca-entrypoint.min.js             (G2, G5 — regenerated)
plugins/genie/orca-runtime.ts                    (G2)
plugins/genie/orca-runtime.test.ts               (G2, G5)
orca-marketplace.json                            (G2)
scripts/orca-bundle-parity.test.ts               (G2)
scripts/orca-manifest-parity.test.ts             (G2)
src/lib/orca-lifecycle-mirror.ts                 (G3, new)
src/lib/orca-lifecycle-mirror.test.ts            (G3, new)
src/term-commands/orca.ts                        (G3, new)
src/term-commands/orca.test.ts                   (G3, new)
src/genie.ts                                     (G3)
skills/wish/SKILL.md                             (G3, G4)
skills/work/SKILL.md                             (G3, G4)
skills/work/references/orca-coordinator.md       (G3, G4)
skills/review/SKILL.md                           (G3)
skills/fix/SKILL.md                              (G3, G4)
README.md                                        (G6)
plugins/genie/README.md                          (G6)
plugins/genie/references/orca-orchestration.md   (G6)
CLAUDE.md                                        (G6)
AGENTS.md                                        (G6)
.genie/INDEX.md                                  (G6)
.genie/brainstorms/orca-plugin-genie/DESIGN.md   (this wish's design)
.genie/wishes/orca-plugin-genie/WISH.md          (this file)
```
