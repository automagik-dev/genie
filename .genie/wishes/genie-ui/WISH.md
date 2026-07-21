# Wish: genie-ui — the fleet floor + the genie lane + the wish group chat (render THE agent)

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS (execution started 2026-07-21; plan review SHIP; design digest-stamped SHIP) |
| **Slug** | `genie-ui` |
| **Date** | 2026-07-21 |
| **Author** | Felipe + Genie |
| **Appetite** | medium |
| **Branch** | `wish/genie-ui` |
| **Repos touched** | automagik-dev/genie |
| **Design** | [DESIGN.md](../../brainstorms/genie-ui/DESIGN.md) |

## Summary

genie's coding agents (Claude Code as Fable/Opus, Codex, Hermes profiles, rlmx) live in separate harnesses with no shared environment; the native-mac ACP clients that could host them abstract each agent into a thread UI — the opposite of the user's hard value, which is to **watch the real agent's own terminal**. This wish builds `packages/genie-ui`: a browser-served UI (no Electron/Tauri) that renders THE agent — a real PTY pane per fleet member (the `syv-ai/dash` pattern, zero rendering abstraction) — and layers genie's wish/board state and a wish-scoped inter-agent group chat on top.

Two channels, not competing: a **PTY viewing channel** (each pane runs the real surface locally or over plain `ssh -t`) and an **ACP control channel** (each hired agent gets one lazily-spawned, read-only ACP chat face). The ratified contract (Model B, corrected, council 4-0): **"Each hired agent is one real terminal plus one lazily-spawned, read-only ACP chat face in the same wish worktree; git artifacts are the shared memory, @-mentions route the chat, and Hermes-style session bridging is a demonstrated bonus, never a gate."** Coherence = shared worktree + git artifacts, NOT session identity. The chat backend is a separable module with **no PTY-layer imports** — the literal substrate the future conductor wish routes on.

## Scope

### IN

- **The fleet floor (PTY viewing channel).** Browser-served UI whose panes each run THE real agent surface (`claude`, `hermes -p <profile> --tui`, `codex`, rlmx/pi TUI) over a local PTY or plain `ssh -t` — PTY-faithful, no rendering abstraction. Tabs swap agents within a wish; 2+ panes split horizontally; per-pane spawn/kill/restart; screen replay on (re)attach via a compact snapshot engine. Ported from the A/B "fresh" substrate and hardened with salvaged Lane-A machinery.
- **The genie lane (left menu).** Left menu lists genie **wishes** (from `.genie/wishes` markdown + `.genie/genie.db` board state), replacing dash's Projects. Selecting a wish opens its worktree-bound context. A **hire roster** binds fleet members (CC / Codex / Hermes profile / rlmx) to a wish; hiring is a roster entry only. Worktree binding is **per roster entry** and **reuses** `genie launch`'s existing per-group worktree for the ready group that agent is on — never mints a parallel wish-level worktree.
- **The wish group chat (ACP control channel).** A wish-scoped group-chat drawer where hired agents + the human converse. Each hired agent gets one lazily-spawned, read-only ACP chat face (one `ClientSideConnection` per agent) in that agent's own per-group worktree. `@agent` delivers the message + room transcript to that agent's chat face; replies stream back as chat messages. Delivery is **@-mention-only** as the designed contract. The chat backend is a **separable module with no PTY-layer imports**.
- **Per-harness capability table**, checked into the repo, driving minimal chat-face badges (e.g. "shared memory" for Hermes) at hire time.
- **Old-UI residue check + docs.** Confirm no LIVE code references to the removed `packages/genie-app` / `src/tui/` era remain (v5-demolition already scrubbed them; `CHANGELOG.md` / completed-wish records are preserved, not scrubbed); document the two-faces contract and the two channels.
- **New code lands as a package** (`packages/genie-ui`): a small bare-`ws` PTY server entry plus the browser client, following repo package conventions (the single-file bun bundle for the CLI stays untouched; the UI server is its own entry).

### OUT

- **Conductor auto-pilot / auto-advance routing** — the policy layer that makes the room advance the pipeline (Fable wish → Hermes review → Codex execute → Opus fix → Fable gate) automatically instead of by human @-mentions. A **follow-up wish** built as a routing-policy layer on this wish's chat-backend module; explicitly not v1.
- **Chat-face write-promotion toggle** — promoting a chat face from read-only to worktree-mutating. Council split 2-2; synthesis defers it. The chat face is non-mutating in v1; write access is a documented later extension point, not a v1 mode. This is what keeps the two-writers-one-worktree race defined out of existence (AC4a / D5).
- **Broadcast / all-messages-to-all-agents routing** — deferred as a later routing policy on the same @-mention bus. @-mention-only is the *designed* contract, not a temporary limitation.
- **Electron / Tauri desktop packaging** — genie-ui is browser-served from the box (works from mac + phone immediately). No Electron/Tauri dependency enters the tree.
- **Session-identity coupling as the coherence contract** — rejected. Coherence = shared worktree + git artifacts. Session bridging is best-effort (AC4b), never a gate.
- **Model A** (chat renders the ACP stream) and **Model C** (keystroke injection + output scraping) — both rejected by the council.
- **Newio / any external host** as the environment — the genie UI *is* the environment.
- **Station strip / structure sidecar / QR-remote reach** (metal-river telemetry, rlmx recursion tree, phone-grab) — cheap later additions; not v1.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | The genie UI **is** the environment; render THE agent (PTY-faithful), no host adoption. | Every surveyed host abstracts the agent into a thread UI (the opposite of the hard value). Two channels — PTY viewing + ACP control — instead of one abstracted thread. |
| D2 | Ratify Model B, corrected: two faces, one workspace; coherence = worktree + git artifacts, NOT session identity. | Unanimous 4-0. Smallest design that tells no lies, uses only published vendor contracts, extends genie's git-as-truth model. |
| D3 | Left menu = genie wishes; per-wish hired agents as tabs + horizontal splits. | The wish is the organizing layer with coding agents on it; same context, multiple simultaneous faces. |
| D4 | @-mention-only delivery, as the *designed* contract; undelivered chat is visible history, not implicit context. | Broadcast is a token/noise multiplier with emergent, undocumentable room behavior; @-mention is the primitive the conductor wish drives ("who speaks next"). |
| D5 | Chat face is **non-mutating** in v1 (read-only ACP face); only the terminal face mutates the worktree. | Two write-capable processes of one agent in one worktree is an unserialized concurrent-writer design (worst for CC: two live processes appending one JSONL). Write-promotion → OUT. |
| D6 | Lazy face spawn: hire = roster entry only; PTY face spawns on tab-open; ACP face on first @-mention, seeded with wish context + room transcript. | Halves idle process/token cost; delivers "chat-only role" agents for free; seeding prevents amnesiac first replies. |
| D7 | Chat backend is a separable module with **no PTY-layer imports**; interface = deliver message / stream reply. | Makes wish one the literal substrate of wish two; a greppable criterion. Settles B-over-C: auto-advance cannot be built on scraped terminal output. |
| D8 | Session-memory bridging is per-harness best-effort, never a v1 gate. | Demonstrate on Hermes (`state.db` is a vendor contract); CC JSONL-resume as stretch; Codex/rlmx exempt. "A gate passable on two of four harnesses is a wish, not a gate." |
| D9 | Delivery/spawn failures are named, greppable chat-drawer events, never silence. | Lazy spawn moves the failure surface to send time; silent failure reproduces Model C's undebuggability. E.g. "@codex could not start: codex-acp exited (code 127); check PATH". |
| D10 | Minimal chat-face badges driven by a checked-in per-harness capability table, rendered at hire time. | Honest labeling ("I told it in chat, why doesn't the terminal know?"); one source of truth for UI + docs; static render is required (lazily-spawned faces don't exist to probe). |
| D11 | Shell foundation = fresh substrate ported + Lane-A salvage (TerminalMirror snapshot, Utf8Base64/FitScheduler, grid/splits concept). | A/B verdict: both passed all 7 items; fresh's bare-`ws`/zero-build server wins; its two liabilities (256 KB ring replay, single-active-tab layout) are fixed exactly by the salvaged TerminalMirror + vanilla grid/splits. |
| D12 | Browser-served from the box; no Electron/Tauri. | Works from mac + phone immediately; no desktop-packaging dependency enters the tree. |
| D13 | New code = `packages/genie-ui` (separate UI-server entry); read genie state read-only; compose with `genie launch` worktrees. | Follows the repo's package pattern (the CLI's single-file bun bundle stays untouched); no second write path into genie.db; worktree binding composes with, not duplicates, existing per-group worktrees. |

## Dependencies

**depends-on:** none
**blocks:** none

> The **conductor auto-advance** wish (Pillar 3 / R11) is a downstream **follow-up** that will build a routing-policy layer on this wish's `chat-backend` module. It is not yet a registered wish slug, so `blocks` is `none` here per the linter contract; the blocking relationship is the load-bearing reason for AC6's isolation wall (`chat-backend` has no PTY-layer imports) and is recorded here in prose. Register the edge when the conductor wish is drafted.

## Success Criteria

The eight council-ratified acceptance criteria, **verbatim** from DRAFT.md (they are ratified; do not paraphrase). All must hold for v1 to ship, plus the repo gate.

- [ ] **AC1.** Left menu lists genie wishes (repo .genie), replacing dash's Projects; selecting a wish opens its worktree-bound context.
- [ ] **AC2.** A wish hires agents from the fleet roster (CC, Codex, Hermes profile, rlmx); each is a terminal tab rendering its REAL TUI (PTY-faithful); 2+ splittable horizontally. Hire = roster entry only; PTY face spawns on tab-open.
- [ ] **AC3.** Wish group chat drawer, **@-mention-only** (documented as the designed contract; undelivered chat is visible history, not implicit agent context): @agent delivers the message + room transcript to that agent's chat face; replies stream back as chat messages.
- [ ] **AC4.** **AC4a (hard, all harnesses):** both faces run in the same wish worktree; `.genie` wish artifacts are canonical shared state; the chat face is non-mutating in v1 — only the terminal face mutates the worktree. **AC4b (best-effort):** session bridging demonstrated for Hermes via state.db; CC JSONL-resume as stretch; Codex/rlmx exempt.
- [ ] **AC5.** ACP chat face spawns lazily on first @-mention, seeded with wish context + room transcript; spawn/delivery failures surface as named, greppable chat-drawer events.
- [ ] **AC6.** Chat backend is a separable module (one ACP client connection per hired agent; interface = deliver message / stream reply) with no PTY-layer imports.
- [ ] **AC7.** Per-harness capability table checked into the repo drives minimal chat-face badges (e.g. "shared memory" for Hermes).
- [ ] **AC8.** Old-UI residue in the genie repo identified and cleaned as part of the wish.
- [ ] **Gate.** `bun run check` (typecheck + lint + dead-code + test) green; the new `packages/genie-ui` honors bun runtime, `bun:test` colocated tests, biome (single quotes / 2-space / 120), commitlint, and the cognitive-complexity budget (25); browser-served (no Electron/Tauri dependency added).

## Execution Strategy

Four sequential waves. The DESIGN dependency graph is a chain: **G1 → G2 → G3 → G4**.

**Why G2 and G3 are sequential, not a parallel wave.** Both depend on G1, but they are **not** a disjoint parallel pair. Per the DESIGN Execution Groups table, **G3 depends on G1 *and* G2**, not on G1 alone — for a real data reason, not just file ownership: G3's `chat-backend` spawns exactly one ACP `ClientSideConnection` **per hired agent**, and the hire roster (which agents exist, on which worktree) is a G2 deliverable. There is no set of hired agents for the chat backend to route `@mention`s to until G2's roster + `worktreeFor(rosterEntry)` land. Running them in parallel would force G3 to stub the roster it must consume, then re-integrate — the exact churn the sequential edge avoids. So: Wave 1 = G1, Wave 2 = G2, Wave 3 = G3, Wave 4 = G4.

### Wave 1

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 5 — stateful PTY substrate (+2), subjective manual-QA acceptance on real TUI + `ssh -t` panes / no deterministic render test (+2), multi-package gate wiring across tsconfig+complexity-budget+biome (+1) | engineer-complex / high | Port the fresh shell substrate into `packages/genie-ui`; wire the package into the gates first |

### Wave 2 (after Wave 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 3 — worktree-binding + read-only DB state integration reasoning (+2), multi-module client+server work (+1) | engineer-standard / high | The genie lane: left menu of wishes, hire roster, worktree binding that composes with `genie launch` |

### Wave 3 (after Wave 2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 6 — @-mention routing / who-speaks orchestration (+2), stateful ACP connection pool + lazy spawn (+2), subjective / no-deterministic R1 ssh round-trip proof + Hermes bridging demo (+2) | engineer-complex / high | Group chat drawer + the separable `chat-backend` ACP module (isolation wall is the load-bearing invariant) |

### Wave 4 (after Wave 3)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | 1 — docs + verification only, no deterministic product test (+1) | engineer-trivial / low | Residue verification + the two-faces contract docs |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance. Add **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work. Route the total in **Model**: **0–1** → `engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high; **4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an independent `final-gate`.

## Execution Groups

### Group 1: Shell substrate — PTY/ws server + vanilla client, wired into the gates

**Goal:** Port the fresh A/B substrate into `packages/genie-ui` (bare-`ws` PTY server + vanilla client), replacing Vite with a bun-native serve path, and salvage the Lane-A machinery — with the package covered by the repo gates before any feature code lands.

**Deliverables:**
1. `packages/genie-ui/server/` — bare-`ws` PTY server ported from fresh: `fleet-config` (`loadFleet() → PaneSpec[]`, grows genie keys `wish_id`, `role`), `pty-session` (`PtySession` + `PtySessionManager`: `startAll/spawn/kill/restart/write/resize/replay/list/killAll`; events `data`/`exit`/`status` = `idle`/`running`/`exited`; **the single `node-pty` importer**), `transport` (the `ws` protocol: `FLEET/DATA/EXIT/STATUS/REPLAY/INPUT/RESIZE/SPAWN/KILL/RESTART/LIST`).
2. `packages/genie-ui/server/reused/TerminalMirror.ts` — salvaged verbatim (dash, MIT): headless-`xterm` + `SerializeAddon` compact snapshot engine, wired as the **replay path** (replacing fresh's 256 KB raw-byte ring). Imported only by `pty-session`. **Verify it serializes correctly under bun** on (re)attach before wiring it in (R4); fallback = keep the bounded ring behind the same interface if the loader adaptation fails.
3. `packages/genie-ui/client/` — vanilla-TS browser client: `@xterm/xterm` 5.5 + fit render per pane; **tabs + horizontal splits + maximize** (reimplemented vanilla from Lane A's grid concept); role badges; spawn/kill controls; salvaged `Utf8Base64` + `FitScheduler`. Talks to the server exclusively over `transport`.
4. **Bun-native serve path** replacing the prototype's Vite (`Bun.serve` transpiles the client TS on the fly + resolves `@xterm` via an import map, or a minimal `Bun.build` of the single client entry). Pin this as the G1 decision; no Vite enters the tree.
5. **Wire the package into the gates first:** add `packages/**` to `tsconfig.json` `include` (or a project ref); extend `scripts/complexity-budget.ts` scope beyond `src/`; add a `packages/**` biome `noExcessiveCognitiveComplexity:25` override (CLAUDE.md already claims `src/** AND packages/**` — make it true). Without this, `typecheck` and the complexity budget silently skip `packages/genie-ui`.
6. Colocated `bun:test` for `pty-session` (spawn/kill/restart/status events) and the snapshot serialize/replay round-trip.

**Acceptance Criteria (AC2 substrate):**
- [ ] `bun run check` green **with typecheck and the complexity budget actually covering `packages/genie-ui`** — proven by a scratch check that a deliberate type error and a deliberately >25-complexity function in the package each fail the gate (then reverted).
- [ ] `bun:test` on `pty-session` passes (spawn/kill/restart + `idle`/`running`/`exited` events) and the TerminalMirror snapshot serialize/replay round-trip passes under bun.
- [ ] Manual QA (record in `qa.md`): a local pane and an `ssh -t` pane each render their real TUI; 2 panes split horizontally; reattach replays the screen from TerminalMirror.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# gate coverage proof: typecheck + complexity budget must SEE the new package
bun run typecheck
bun run lint:complexity-budget
# unit tests for the PTY boundary + snapshot replay
bun test packages/genie-ui/server/pty-session.test.ts
bun test packages/genie-ui/server/reused/TerminalMirror.test.ts
# full gate
bun run check
# no Vite dependency entered the tree
! grep -q '"vite"' package.json packages/genie-ui/package.json 2>/dev/null || { echo "FAIL: vite leaked in"; exit 1; }
```

**depends-on:** none

---

### Group 2: The genie lane — wishes menu + hire roster + worktree binding

**Goal:** Replace dash's Projects with a left menu of genie wishes, add a hire roster (roster-entry-only), and bind each roster entry to the `genie launch` per-group worktree it reuses — read-only against genie state, degrade-to-empty when absent.

**Deliverables:**
1. `packages/genie-ui/server/genie-lane.ts` (+ client menu) — `listWishes()` (from `.genie/wishes` markdown, git), `wishContext(slug)`, `hire(wishSlug, fleetMember) → roster entry` (roster entry only, **no live process**), `worktreeFor(rosterEntry) → path | null`.
2. Read genie board/task state via **`bun:sqlite` read-only open OR the existing `genie mcp` read layer** (`task-state.ts`: `getBoardByName`, `getWishGroups`, `getTask`) — **never a second write path**. Read-only open + **degrade-to-empty** when `.genie/genie.db` is absent (the `genie mcp` precedent). Resolve the shared DB across worktrees via `git rev-parse --git-common-dir`.
3. `worktreeFor` **reuses** `genie launch`'s per-group worktrees (one per ready group; see `warp-launch.ts`) — resolves against a **roster entry** (agent + its ready group), returns `null`/unbound before that group is launched, and **never mints a parallel wish-level worktree**.
4. Selecting a wish opens its worktree-bound context; the client renders the wish's hired agents as the tab set (feeding G1's panes).
5. Colocated `bun:test` with a fixture `.genie` (wishes + genie.db).

**Acceptance Criteria (AC1, AC2):**
- [ ] Left menu renders wishes from a fixture `.genie` + genie.db, replacing Projects; selecting a wish opens its worktree-bound context.
- [ ] `hire(...)` adds a roster entry with **no live process** spawned.
- [ ] `worktreeFor(rosterEntry)` resolves to that agent's `genie launch` ready-group worktree, and returns `null`/unbound before the group is launched (no parallel worktree minted).
- [ ] genie.db is opened **read-only** (probe: no write path; degrades to empty when absent).

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test packages/genie-ui/server/genie-lane.test.ts
# read-only invariant: the lane never opens the db writable
! grep -RnE "new Database\([^)]*readonly:\s*false|openSqlite\(" packages/genie-ui/server/genie-lane.ts || { echo "FAIL: writable db open in genie-lane"; exit 1; }
bun run check
```

**depends-on:** group-1

---

### Group 3: Group chat + ACP chat-face backend (the conductor substrate)

**Goal:** The wish group chat drawer plus the separable `chat-backend` module — one lazily-spawned read-only ACP `ClientSideConnection` per hired agent, @-mention routing (message + room transcript → streamed reply), the checked-in capability table → minimal badges, and named fail-loud spawn/delivery events. **Hard constraint: no PTY-layer imports in `chat-backend`.**

**Deliverables:**
1. **Open with the R1 proof:** demonstrate one adapter's `initialize → session/new → session/prompt → session/update → request_permission` round-trip over a `command: ssh …` subprocess (sidesteps Zed's remote-dev feature). Record the co-located fallback (chat faces run co-located with the server; only remote *viewing* crosses the wire in v1).
2. `packages/genie-ui/server/chat-backend.ts` — a pool of one `ClientSideConnection` per hired agent, **lazy spawn on first @-mention** (seeded with wish context + room transcript). Interface: `deliverMessage(agentId, text, transcript) → void`; `streamReply(agentId) → async iterable of chat events`; `capabilities(harness) → CapabilityRow`; events `spawn-failed` / `delivery-failed` (named, greppable). Faces are **non-mutating** in v1 and `cd` into that agent's group worktree (the terminal face is the sole mutator).
3. `@mention` routing: deliver message + room transcript to that agent's chat face; stream the reply back as chat messages. **@-mention-only**; undelivered chat is visible history, not implicit context.
4. `packages/genie-ui/capability-table.ts` (or a checked-in data file) — per-harness declaration (shared-memory? write-capable? session-bridging demonstrated?), rendered at **hire time** into minimal badges ("shared memory" for Hermes only, where demonstrated). v1 depends on `session/prompt` + streamed `session/update` only (the one primitive all four adapters expose).
5. Named fail-loud events surfaced in the chat drawer (D9): a missing/failed adapter shows "@codex could not start: codex-acp exited (code 127); check PATH", never silence.
6. **AC4b best-effort:** demonstrate Hermes session bridging via `state.db`; CC JSONL-resume as stretch; Codex/rlmx exempt. Never a gate.
7. Colocated `bun:test` including the greppable isolation test.

**Acceptance Criteria (AC3, AC4a/AC4b, AC5, AC6, AC7):**
- [ ] **Greppable isolation:** `chat-backend` imports nothing from `pty-session` / `TerminalMirror` / `transport` / `client`.
- [ ] `@mention` delivers message + transcript and streams a reply; lazy spawn creates **no** ACP process before the first `@mention`.
- [ ] A forced spawn failure surfaces a **named** chat-drawer event ("@codex could not start: …; check PATH"), not silence.
- [ ] Badges render from the capability table at hire time; "shared memory" appears only for Hermes.
- [ ] AC4a: chat face is non-mutating; only the terminal face mutates the worktree. AC4b: Hermes bridging demonstrated; Codex/rlmx exempt.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# the load-bearing wall: chat-backend imports NOTHING from the PTY layer
! grep -RnE "from ['\"].*(pty-session|TerminalMirror|transport|client)" packages/genie-ui/server/chat-backend.ts \
  || { echo "FAIL: chat-backend imports the PTY layer"; exit 1; }
bun test packages/genie-ui/server/chat-backend.test.ts
bun run check
```

**depends-on:** group-1, group-2

---

### Group 4: Residue cleanup + the two-faces contract docs

**Goal:** Reconfirm no LIVE code references to the removed UI remain, preserve historical records, and write the docs that pin the two channels, the Model-B contract, the isolation walls, and the OUT extension points.

**Deliverables:**
1. **Confirm** (not delete) no LIVE code references to `packages/genie-app` / `src/tui/` remain — v5-demolition already enforced this (`grep -rn src/` is clean). **Do NOT scrub historical records:** the only surviving matches (`CHANGELOG.md`, `.genie/wishes/v5-demolition/WISH.md`) are historical record and must be preserved.
2. Docs page (under `docs/_internal/` per repo docs convention) documenting: the **two channels** (PTY viewing + ACP control), the ratified Model-B contract, the **isolation walls** (PTY wall, chat wall, state wall, worktree wall), and the OUT **extension points** (conductor auto-advance, write-promotion, broadcast) so later addition is not a silent behavior change. It must match the shipped module boundaries.

**Acceptance Criteria (AC8):**
- [ ] `grep -rn` over `src/` shows **no LIVE** references to the removed UI packages (reconfirm), and `CHANGELOG.md` / v5-demolition wish history is left untouched.
- [ ] A docs page for the two-faces contract exists and matches the shipped module boundaries.
- [ ] `bun run check` + `bun run dead-code` green (no new false positives).

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# no LIVE references to the removed UI in source
! grep -rnE "packages/genie-app|src/tui/" src/ || { echo "FAIL: live reference to removed UI"; exit 1; }
# historical records preserved
grep -q . CHANGELOG.md && test -f .genie/wishes/v5-demolition/WISH.md
# the contract docs exist
test -f docs/_internal/genie-ui-two-faces.mdx || test -f docs/_internal/genie-ui-two-faces.md
bun run dead-code
bun run check
```

**depends-on:** group-1, group-2, group-3

---

## QA Criteria

_What must be verified after the groups land. The QA agent tests each criterion._

- [ ] **Functional (fleet floor):** a local pane and an `ssh -t` pane each render the real agent TUI; tabs swap agents within a wish; 2+ panes split horizontally; spawn/kill/restart per pane; reattach replays the screen from TerminalMirror.
- [ ] **Functional (genie lane):** the left menu lists real repo wishes; hiring adds a roster entry with no process; `worktreeFor` binds to the `genie launch` group worktree (and is `null` before launch) with no parallel worktree minted.
- [ ] **Functional (group chat):** `@agent` on a hired agent lazily spawns its read-only ACP face, delivers message + transcript, and streams a reply; a forced adapter failure shows a named chat-drawer event; Hermes shows the "shared memory" badge.
- [ ] **Isolation (reviewer-greppable):** `chat-backend` has no imports from `pty-session`/`TerminalMirror`/`transport`/`client`; `node-pty` is imported in exactly one module (`pty-session`); genie state is opened read-only only.
- [ ] **Regression:** the CLI's single-file bun bundle is untouched; no Electron/Tauri/Vite dependency entered the tree; `bun run check` green with `packages/genie-ui` actually covered by typecheck + the complexity budget.

---

## Assumptions / Risks

| # | Risk / Assumption | Severity | Mitigation / Disposition |
|---|-------------------|----------|--------------------------|
| R1 | stdio-over-SSH ACP round-trip for remote chat faces (the load-bearing unknown; Zed #47910 shows remote-agent failure adjacent). | High | The *viewing* channel uses plain `ssh -t` (native PTY, already passed the A/B test) and is unaffected. G3 opens by proving one adapter's full round-trip over a `command: ssh …` subprocess. Fallback: chat faces run co-located with the server; only remote *viewing* crosses the wire in v1. |
| R2 | ACP adapter capability drift — loadSession/resume/MCP/permission support varies per harness and version. | Medium | The capability table (D10) is the single checked-in source of truth. v1 depends on `session/prompt` + streamed `session/update` only — the one primitive all four adapters expose. Nothing v1-critical rides on resume/loadSession. |
| R3 | Two-writers-one-worktree race. | High | **Defined out of existence** by D5: chat face non-mutating in v1, terminal face is the sole mutator. Why write-promotion is OUT, not a toggle. AC4a encodes it. |
| R4 | TerminalMirror integration under bun — the salvaged engine uses `createRequire` for `@xterm/headless` + `@xterm/addon-serialize` CJS entry (Lane A ran under Node/tsx ESM). | Medium | G1 verifies the snapshot engine serializes correctly under bun before wiring it in; TerminalMirror is imported only by `pty-session`, so a loader adaptation is contained to one module. Fallback: keep fresh's bounded ring behind the same interface. |
| R5 | Reading genie.db from a separate UI-server process while the CLI/skills write it (WAL, worktree-shared). | Low | Read-only open + degrade-to-empty (the `genie mcp` precedent); no write path from the UI. WAL + busy_timeout make concurrent readers clean. |
| R6 | Cognitive-complexity budget (25) on the server composition root + router. | Low | Keep `index`/composition thin (the fresh substrate already is); split only at real boundaries (PTY IO, ACP IO, transport serialization) per CLAUDE.md. |
| R7 | Assumption: the four ACP adapters are installed / on PATH where their agent runs. | Low | D9's named failure events surface a missing adapter as "@agent could not start: …; check PATH" instead of silence. |
| R8 | **Future work — write-promotion toggle** (council split 2-2). | — | Deferred to a documented later capability toggle; adding it now imports a per-harness permission-mapping matrix + modal state per chat face. Kept in OUT. |
| R9 | **Future work — broadcast / all-messages-to-all-agents delivery.** | — | Deferred to a later routing policy on the same @-mention bus; documented as a designed extension point so later addition is not a silent behavior change. Kept in OUT. |
| R10 | **Future work — richer capability-badge taxonomy** ("transcript-linked" for CC, three-tier badges). | — | v1 ships the minimal set (default statement + "shared memory" for Hermes). Add tiers only as each is demonstrated. |
| R11 | **Future work — conductor auto-advance** (Pillar 3 / the reason the chat backend is separable). | — | The follow-up wish: a routing-policy layer on the `chat-backend` module. Not v1. AC6's module boundary is what makes it cheap. |

---

## Files to Create/Modify

```
# Create — packages/genie-ui (the new package)
packages/genie-ui/package.json
packages/genie-ui/server/index.ts                    # thin composition root (bun-native serve path, no Vite)
packages/genie-ui/server/fleet-config.ts             # G1 — loadFleet(); grows wish_id/role keys
packages/genie-ui/server/pty-session.ts (+ .test.ts) # G1 — the single node-pty importer; PtySessionManager
packages/genie-ui/server/transport.ts                # G1 — the ws message protocol
packages/genie-ui/server/reused/TerminalMirror.ts (+ .test.ts)  # G1 — salvaged verbatim (dash, MIT), replay path
packages/genie-ui/client/*                           # G1 — vanilla-TS client: xterm panes, tabs+splits+maximize, Utf8Base64/FitScheduler
packages/genie-ui/server/genie-lane.ts (+ .test.ts)  # G2 — wishes menu, hire roster, worktreeFor (read-only genie state)
packages/genie-ui/server/chat-backend.ts (+ .test.ts)# G3 — separable ACP module; NO PTY-layer imports
packages/genie-ui/capability-table.ts                # G3 — checked-in per-harness capability table
.genie/wishes/genie-ui/qa.md                         # G1 — manual QA record (local + ssh -t panes)
docs/_internal/genie-ui-two-faces.mdx                # G4 — two channels + Model-B contract + isolation walls + OUT extension points

# Modify — wire the new package into the gates (G1)
tsconfig.json                                        # add packages/** to include (or a project ref)
scripts/complexity-budget.ts                         # extend scope beyond src/ to packages/**
biome.json                                           # add packages/** noExcessiveCognitiveComplexity:25 override

# Do not touch (out of scope / separate wish)
src/genie.ts and the single-file bun bundle          # the CLI stays untouched (D13)
CHANGELOG.md / .genie/wishes/v5-demolition/WISH.md   # historical record — preserve, never scrub (G4)
conductor auto-advance / write-promotion / broadcast # follow-up wishes (OUT)
```

---

## Review Results

### Plan review — 2026-07-21 — **SHIP** → Status APPROVED

- **Reviewer:** independent plan gate (Opus 4.8, wf_e86aab80-f2a). First-pass SHIP. Digest verified
  (`e9eb1e12…1145fb` recomputed on disk); AC1-8 verbatim vs DESIGN + council DRAFT; all validation
  commands confirmed runnable; task rows verified; A/B source paths verified; gate-scoping premise
  (tsconfig/biome/complexity-budget all src-scoped — G1 must wire packages/genie-ui into the gates)
  confirmed TRUE; G2→G3 sequential ordering rationale confirmed honest (G3 consumes G2's roster).
- **Minors (orchestrator-handled at dispatch):** (1) wave-table column labels vs sibling convention —
  cosmetic; (2) G1 salvage provenance restated in the dispatch brief: port from
  `~/prod/genie-ui-ab/fresh`, salvage `~/prod/genie-ui-ab/dash-fork/fleet/server/reused/TerminalMirror.ts`
  (NOT the `src/main/services/` copy) + `Utf8Base64.ts` + `FitScheduler.ts`; (3) genie.db rows are all
  `ready` from birth — the G1→G2→G3→G4 chain is orchestrator-enforced from this document, never
  dispatch on DB status alone (do not `genie launch` all four); (4) G4's `docs/_internal/` target
  lives in the `.docs-vendor` submodule — the doc requires the submodule branch/PR/pointer-bump flow,
  not a plain wish commit (G4 brief must carry this).

_Execution and PR review evidence appended below as they occur._
