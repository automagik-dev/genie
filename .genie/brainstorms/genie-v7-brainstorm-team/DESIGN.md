# Design: Genie's brainstorm as a native Agent Team

| Field | Value |
|-------|-------|
| **Slug** | `genie-v7-brainstorm-team` |
| **Date** | 2026-10-30 |
| **WRS** | 85/100 |
| **Size** | M · two genie wishes plus three Automagik integration items (lead, round 2) |

<!-- Source: a Settled id (R1-2), a council decision (P3), "reviewer HIGH-1" or "reviewer round-2 C4" for a recorded finding, or a backticked repository path that exists; other words in the cell are prose. -->

## Problem

Genie's brainstorm runs today as a Claude Code workflow script (`brainstorm.js`, 14 stages, mean 498k tokens and 18 minutes per round over 35 runs). It is invisible in Automagik, tied to one runtime, and cannot put each role on the model that suits it. The owner asked for the brainstorm to run as a native DSH Agent Team, with each role on its own provider, configurable in Bot settings → Genie and visible inside Live.

**What genie alone cannot deliver.** Two of the owner's three asks depend on Automagik. Per-role routes (R1-2) work only on Automagik's runtime, which patches `spawn_teammate` (stock DSH has no route parameters). The Live view (R1-3) needs a plugin activity seat in Live that does not exist yet. Both are listed below as Automagik deliverables with a contract. Until the seat ships, the brainstorm is visible under Genie's row in the sidebar.

## Scope

### IN

| # | Deliverable | Files changed | Source |
|---|-------------|---------------|--------|
| 1 | Team mode in the brainstorm skill: five roles. Genie leads. Researcher, Proposer and Critic are spawned fresh once per brainstorm and reused across its rounds by message (a message cold-resumes them). The Reviewer is spawned fresh for each design review. Each teammate is told which skill and role to follow. Proposer and Critic debate directly within the budget the crew tool returns. Questions to the owner come from the lead only. The ledger and stamp scripts are the deterministic record steps. The Reviewer's read-only access is stated as instructed, not enforced. Written in role language, with no client tool names | `skills/brainstorm/SKILL.md`, `skills/brainstorm/references/team.md` (new) | R1-1 |
| 2 | Crew settings per Genie Bot, stored by the genie-dsh host in `<team folder>/genie/crew.json` (keyed by Genie Bot id; atomic write; invalid file → defaults plus a warning). Fields: per role provider, model and effort (default "same as Genie"; a Reviewer on another provider is simply a per-role choice); per-round debate turns, clamped to a ceiling. The 16-name cap is DSH's and is shown, not edited. Budgets are advisory to the lead: DSH enforces only the name cap. Separate read (`GET`) and write (`PUT`) routes under `/api/genie-dsh/crew`, registered the way `plugins/dsh-genie-board/src/runtime.ts` registers `/api/genie-board/*`, served same-origin behind DSH's own web session. Only the settings card writes. Plus one tool the lead calls to get the resolved crew, the budget and the names left | `plugins/genie-dsh/src/host/crew.js` (new), `plugins/genie-dsh/src/host/genie.js`, `plugins/genie-dsh/index.js`, `plugins/genie-dsh/test/crew.test.js` (new) | R1-2, `plugins/dsh-genie-board/src/runtime.ts`, review findings F2, F5, N1, N3, N4 |
| 3 | The Bot settings → Genie card that edits item 2. Registered through the Bot team's `botSettings` registry, feature-detected (absent on older Bot teams: no card, no error), the way genie-dsh already guards `chatSuggestions` | `plugins/genie-dsh/src/client/crew.js` (new), `plugins/genie-dsh/src/client/core.js`, `plugins/genie-dsh/src/client/index.js` | R1-2, review finding F5 |
| 4 | The brainstorm's activity projection: a pure function over the Lead session's `agentTeam` projection, read in the browser from the shared Session store (`projectionsBySession[lead].values.agentTeam`, which host projection frames keep current, so nothing polls: the source the DSH Team panel uses), mapping the roster and task board (phases as tasks with owners and dependencies; agents with route and roster status; round; elapsed) to the prototype's `Activity` shape. No invented fields. "Waiting for X" appears only from a task blocked by another's task | `plugins/genie-dsh/src/client/live.js` (new), `plugins/genie-dsh/test/live.test.js` (new) | R1-3, review finding N2 |
| 5 | Visible now: a row under Genie in the sidebar (`botChildren`, beside the ended-wishes row) shows a running brainstorm from item 4: topic, phase, agents active of total. It opens the chat. Once the Live seat exists, item 4 also registers there, feature-detected | `plugins/genie-dsh/src/client/index.js`, `plugins/genie-dsh/src/client/live.js` (new) | R1-3, review finding F1 |

### OUT

- External agent apps (Claude Code, Codex) joining the crew over ACP. No ACP client provider is installed. Trigger: DSH or Automagik ships one (Source: R1-2).
- An exchange list rebuilt from teammates' private transcripts. Live and the sidebar row show phases, agents and status. The exchange list waits for A3 (Source: R1-3).
- Enforced read-only review and credential isolation for the Reviewer. No per-teammate tool restriction is documented in the Agent Teams READMEs. Tracked as a risk, not claimed (Source: R1-1).
- Retiring `brainstorm.js`. It stays as the path for runtimes without Agent Teams (Claude Code, Codex). The skill picks team mode only when the runtime offers teammates (Source: `skills/brainstorm/SKILL.md`, review finding F6).
- The delivery loop (publish, PR read-back) and learning: paused by the owner; publishing stays as foundations left it (Source: `plugins/genie-dsh/src/host/genie.js`).

## Approach

**Where it runs.** The Genie chat the owner is already talking in is the team Lead. The conversation stays in one place, and the Live session filter shows exactly that chat. Agent Teams names are permanent, failed ones included, with at most 16 per Lead.
- A brainstorm spawns three persistent roles once and one fresh Reviewer per design review, so one brainstorm costs 4–6 names.
- The crew tool reports the names left. When a new brainstorm would not fit, the lead says "This chat has no room for another brainstorm crew; start a new Genie chat for it" and stops.
- A separate lead conversation for every brainstorm lost: it breaks the owner's continuity.

**Roles are skills, not code.** A teammate on `claude-code` was verified to see Genie's skill catalogue (probe of 2026-10-30, recorded as V10 in the planning DRAFT). The other routes are probed in wish A, and where a route has no skills the lead puts the role's instructions inline. Genie as lead keeps the judgement: interpreting the owner's answers and composing the design. The deterministic steps (recording answers, the template and traceability check, the review-evidence stamp) remain the existing scripts, run as commands.

**Routes.** The crew tool resolves each role's provider, model and effort. Routes apply only on Automagik's patched runtime (A1, DSH `0.2.1-rc.4`), and only for a fresh teammate whose provider and model are given together and appear in the runtime's list of teammate routes. That list is empty unless subagent model selection is switched on in the Plugins settings. Before spawning, the lead compares each role's route with that list and reports one state per role:
- `applied`;
- `not-allowed` (the route is not listed);
- `selection-off` (the list is empty);
- `unsupported` (the runtime has no route listing).

Every state other than `applied` spawns the role on Genie's route and tells the owner once. The card shows the same four states as one line each. genie-dsh's `engines.dsh` floor becomes `0.2.1-rc.4`.

**Debate and visibility.**
- Proposer and Critic message each other directly.
- Each message is persisted in the receiving teammate's own session log ("Team message from critic:", with the sender's session id).
- DSH writes no shared team-level message record. Its `team/message/*` records are historical, and the send's Team activity is not documented as persisted. So persistence exists and a shared event does not. A3 closes that gap.
- Status comes from the roster (`running`, `inactive`, `provisioning`, `failed`).

**Automagik deliverables** (owner Automagik, automagik repository; integration dependencies of this design):

| # | Deliverable | Contract | Needed by |
|---|-------------|----------|-----------|
| A1 | Keep the teammate-models runtime patch (`apps/desktop/runtime/patches/teammate-models.patch`) until upstream DSH has route parameters | `spawn_teammate` accepts `llm_provider`, `model`, `reasoning_effort`; `list_teammate_models` lists routes | items 1, 2 |
| A2 | A plugin activity seat in Live once Live moves into DSH's right panel | a `bots-dsh` client registry beside `botSettings`, e.g. `liveActivities.register({ id, useActivities(sessionId) → Activity[] })`, `Activity` as in the prototype's `src/card.js` typedef (branch `prototype/brainstorm-live`, `4bee035`) | item 5 in Live |
| A3 | A shared team-message event | one log record per accepted send: sender, target, time, first line | the exchange list |

**Ownership.**

| Piece | Repository and owner |
|---|---|
| Skill team mode, crew settings and API, settings card, activity projection, sidebar row | genie (Genie) |
| A1 route patch, A2 Live seat, A3 team-message event | automagik (Automagik) |

**Delivery order.**
- Wish A = items 1–3: configure the crew, run a team brainstorm.
- Wish B = items 4–5: the brainstorm visible in the sidebar now, and in Live with A2.
- The first usable slice is A + B on Automagik's runtime. Live visibility follows A2.

Alternatives that lost:
- Storing routes in `<GENIE_HOME>/config.json`. It needs a new `config set` verb and a UI writing user config, and it is global rather than per Genie.
- Keeping `brainstorm.js` as the only path. It stays Claude Code only and invisible in Automagik.

## Simplicity Case

- **Simplest complete design:** one skill section, one per-Genie settings file with one API route and one read tool, one settings card, and one pure projection drawn in an existing sidebar row.
- **Added machinery:** the crew settings file and its route, required by R1-2 (routes configurable per Genie in Bot settings).
- **Deferred until measured:** ACP agent apps; a read-only teammate profile; an exchange list before A3; per-session task attribution for the Live filter (Automagik's).
- **Complexity removed:** on Automagik, the 14-stage script per round and its agent-run ledger steps.

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | Five roles by default: Genie leads; Researcher, Proposer, Critic, Reviewer | owner's pick | R1-1 |
| 2 | Native per-role providers and models now; external agent apps later | owner's pick; ACP client absent | R1-2 |
| 3 | The brainstorm shows as one activity inside Live; questions and decisions go to the chat | owner's pick, read with the 2026-10-29 correction that Live itself moves into DSH's right panel | R1-3 |
| 4 | Runs in the owner's current Genie chat as Lead; three roles persist per brainstorm, the Reviewer is fresh per review | continuity within the 16-name cap | R1-3, review finding F3 |
| 5 | No exchange list from private transcripts; wait for a shared event | Automagik's requirement | R1-3 |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Agent Teams is experimental and may change in any DSH update | Medium | genie-dsh pins `engines.dsh`; tests run against the installed harness |
| 2 | Skills unverified on `deepseek-official` and `openai-codex` teammate routes | Medium | wish A probes each route and records the result; the lead inlines role instructions where skills are absent |
| 3 | The Reviewer can write files; read-only is instructed, not enforced | Medium | stated in the skill and the card; review evidence records the route used |
| 4 | A2 or A3 never lands | Medium | the sidebar row keeps the brainstorm visible; the exchange list stays out |
| 5 | A1 is dropped before upstream DSH has routes | Medium | every role reports `unsupported`, runs on Genie's route, and the card says so |

## Success Criteria

- [ ] Crew resolution maps each role to its configured route and to the right state (`applied`, `not-allowed`, `selection-off`, `unsupported`) against a fake route list, and every state but `applied` falls back to Genie's route. **Proof:** `plugins/genie-dsh/test/crew.test.js`.
- [ ] (A1, automagik) the patched runtime spawns a fresh teammate on a given provider and model. **Proof:** automagik `apps/bots-dsh/test/teammate-models.test.js`, which exists.
- [ ] The host clamps the debate budget to its ceiling, refuses invalid routes and efforts, survives a corrupt `crew.json`, and the card saves and reloads every control. With no `botSettings` registry there is no card and no error. **Proof:** `plugins/genie-dsh/test/crew.test.js`.
- [ ] The projection turns a recorded roster and task board into the activity shape with phases, agents and status and no invented fields; the sidebar row draws it; with a Live seat present it registers there too. **Proof:** `plugins/genie-dsh/test/live.test.js`.
- [ ] Each teammate route's skill probe result is recorded in the wish. **Proof:** the wish's evidence file.
- [ ] Plugin tests pass under the plugin's own gate, and the skill passes the repository gate. **Proof:** `npm test` in `plugins/genie-dsh`; `bun run check`.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `023d31963d64744714bbc4c057e7d26379d75580faefb87c85ddf3180d2bf6cf`
- **Reviewer:** independent-claude-sonnet-cli-readonly (fresh process, not the author), round 3
- **Reviewed at:** 2026-10-30T06:30:00.000Z
<!-- genie-design-review:end -->
