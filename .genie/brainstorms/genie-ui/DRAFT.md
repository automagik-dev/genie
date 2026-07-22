# Brainstorm: agent-conductor — all agents, one ACP environment, collaborating

**Slug:** `agent-conductor` · **Started:** 2026-07-21 · **Status:** Raw (research in flight)

## Seed (user's words, 2026-07-21)

Testing native-mac ACP clients: "they're all painful to add agents, specially over network, this is
somewhere where we can't mistake." Newio (human+AI collaboration suite) interesting, but the real
interest: "having a client pointing to all my acp … put all my agents, mostly hermes, claude code
and codex, in the same environment, put them to collaborate… ex. fable wishes, hermes specific
profile reviews, codex executes, opus review and fix, fable final review."

## WRS

```
WRS: ██████░░░░ 60/100
 Problem ✅ | Scope ░ | Decisions ✅ | Risks ✅ | Criteria ░
```

## Research digest (2026-07-21 — full brief in RESEARCH.md)

- **Zero shims needed.** Fleet = Hermes (`hermes acp`, in-tree native), Claude Code
  (`@agentclientprotocol/claude-agent-acp` v0.60.0 — Fable + Opus = two entries, different model env),
  Codex (`@agentclientprotocol/codex-acp` v1.1.4, App-Server build, modes read-only/agent/full,
  `NO_BROWSER=1` for headless), rlmx (`rlmx acp`, ours, in flight).
- **Hermes deep-dive (user-supplied docs):** profiles are first-class isolation — `hermes -p <name>`
  = own HERMES_HOME/config/memory/sessions → **"hermes specific profile reviews" = one exec entry per
  reviewer profile**. ACP sessions persist to shared `~/.hermes/state.db` and restore across process
  restarts (most durable node in the fleet). Curated ACP toolset includes `delegate_task`, skills,
  `execute_code`. `run_agent(..., use_unstable_protocol=True)` (Python lib) — version-compat watch
  item vs TS SDK 1.x. No ACP *client* mode (#36057 open). stdout reserved for JSON-RPC (same
  discipline as rlmx acp).
- **Protocol facts:** base ACP is strictly 1 client : 1 agent per connection; no handoff primitive.
  Multi-agent = the proxy-chains RFD (proposal; `sacp-conductor` reference) or the Router-Agent
  pattern: one process = 1× AgentSideConnection upstream + N× ClientSideConnection downstream —
  fully supported by `@agentclientprotocol/sdk` 1.2.1 today.
- **Hosts:** Zed = safest mounting (N `agent_servers` entries) but star topology, agents never see
  each other; ACP UI = best remote (wss); Tidewave = agent↔app not agent↔agent; **Newio = the only
  host with true agent-to-agent visibility** (agents have accounts, DM/involve each other) but
  transport/ACP-nativeness unverified; mac "Conductor" app ≠ ACP (worktree parallel-runner).
- **Decision (topology): Option B — the hub.** Conductor = genie's role graph wearing an
  AgentSideConnection upstream and N ClientSideConnections downstream; children surfaced as
  tool_call nodes (the rlmx-acp pattern); collaboration state = git artifacts (genie .genie/ docs),
  not shared ACP context. Option A (mount-everything star) is the v0 de-risk; Newio a time-boxed spike.
- **Load-bearing unknown (test prepared, one command):** stdio-over-SSH round-trip — localhost SSH
  keys now set up; `ssh localhost … rlmx acp` harness ready to run on demand. Zed #47910 (remote-dev
  broken) believed specific to Zed's remote feature, not to ssh-as-command entries.

- **Problem ✅** — The user's agents (Hermes, Claude Code/Fable/Opus, Codex, rlmx) live in separate
  harnesses with no shared environment; wiring any of them into an ACP client is high-friction
  (especially over network), and cross-harness pipelines (wish → review → execute → fix → gate) are
  manual copy-paste between panes.
- **Scope ░** — v1 boundary unknown: registry+wiring only? full pipeline conductor? which host?
- **Decisions ░** — blocked on landscape facts (research dispatched): what claude-code-acp / Codex
  ACP / Hermes actually expose; which hosts mount N agents; whether the conductor is itself an ACP
  client, an ACP agent (hub), or host-side config.
- **Risks ✅ (initial)** — ACP has no first-class multi-agent/handoff primitive; adapter capability
  drift (loadSession/MCP/permission support varies); network transport is where clients hurt today
  (stdio-over-SSH is the working pattern); Hermes likely needs a shim; pipeline state (who holds the
  wish artifacts between stages) must live somewhere durable.
- **Criteria ░** — candidate: the user's example pipeline runs end-to-end visibly in one client.

## Known substrate (verified this session)

- `rlmx acp` (wish rlmx-acp-adapter, in flight): stdio ACP agent on `@agentclientprotocol/sdk` ^0.26,
  single-session serialized, drives instrumented rlmLoop; Groups 2-3 add event translation +
  loadSession persistence.
- genie's orchestration model (roles: wish/review/execute/fix/gate, reviewer ≠ engineer) is the
  process the pipeline example encodes — the conductor is that model lifted across harnesses.
- stdio-over-SSH gives remote agents in any stdio ACP client with zero transport code.

## Reframe (2026-07-21, after user shared the genie-UI plan)

User: "honestly i dont know what to decide... i already planned for genie to have an UI, inspired in
a project named dash which renders THE CODING AGENT (github.com/syv-ai/dash) … i hate ui
abstractions.. even claude sdk is a claude code wrapup."

dash verified: MIT, active (v0.15.0 Jul 2026), React+xterm.js+node-pty desktop app that spawns the
REAL Claude Code CLI in per-task git worktrees — PTY-faithful rendering (the UI is the agent's own
terminal face), terminal state snapshots, worktree pool, QR/URL remote control of a task terminal.
Claude-Code-only today; no multi-agent.

**The reframe: don't adopt a host — the planned genie UI IS the environment.** The "which client"
question dissolves. Two channels, not competing:
- **PTY channel (dash pattern)** — each fleet member is a pane running its real surface (`hermes
  --tui`, `claude`, `codex`, rlmx/pi TUI), locally or over plain `ssh -t` (PTY-over-SSH is native —
  the network pain disappears for the viewing channel). Zero abstraction: you watch the actual agent.
- **Control channel (the conductor)** — genie's role graph routes the pipeline and needs
  machine-readable events, not pixels: headless CLI modes and/or ACP client connections per harness
  (ACP earns its place for sessions/streamed structure/permissions; rlmx-acp + claude-agent-acp +
  codex-acp + hermes acp all exist). Artifacts stay in git.

This also explains the mac-client frustration: those hosts abstract the agents into thread UIs —
the opposite of what the user wants. Zed/Newio panes were never going to satisfy the "render THE
agent" value. Newio remains interesting later as a *social* surface, not the environment.

## Genie UI — reconstructed vision (2026-07-21; original plan lost to an unfindable session)

User: "we actually need to make a genie wish… i made the plan for this a couple days ago, and i
cannot find the context." Search of all reachable `.genie` indexes found no genie-ui plan
(brain's `bench-ui` = Brain Lab benchmarking, unrelated). Rebuilt from first principles + everything
known about the user. **A/B build-off launched** (fork-dash vs fresh, opus lanes + judge) →
`~/prod/genie-ui-ab/{dash-fork,fresh}` — decides the shell's foundation empirically.

### Pillars (proposed)

1. **The fleet floor** — the dash pattern, fleet-wide: a grid of PTY panes, each THE real agent
   (`claude`, `hermes -p <profile> --tui`, `codex`, rlmx/pi TUI), local or `ssh -t`. Panes carry
   role identity (fable / reviewer / executor / gate badges), worktree binding, spawn/kill/snapshot.
   Zero rendering abstraction — the terminal IS the UI.
2. **The genie lane** — genie's state, rendered: wish cards (status/WRS), execution groups with
   waves + review verdicts, the board (`genie board` live), artifacts (WISH.md, review evidence)
   rendered from git. Click a task → focus the pane where its engineer is actually working. This is
   exactly what the orchestrator narrates in text today, as a surface.
3. **The conductor** (separate wish, same design) — auto-advance the role pipeline across harnesses
   (headless dispatch and/or ACP client connections); permission requests surface as UI prompts;
   reviewer ≠ engineer enforced by construction.
4. **Station strip** — the telemetry they already own: lemonade model residency, NPU/GPU/thermal
   from metal-river's ring, per-pane token/cost meters (rlmx event metrics; CC cost lines).
5. **Structure sidecar** — beside a pane, optional structured views from event streams where they
   exist: rlmx recursion tree (the watch-headless tree, live), tool-call timelines via ACP. Never
   replaces the PTY; augments it.
6. **Reach** — dash's QR/URL "grab this pane from my phone"; later, genie:omni channel bridges.

### THE RECOVERED PLAN (user, 2026-07-21 — this supersedes my pillar guesses where they differ)

- **Start from dash's UI wholesale** — "we don't spend time wiring and extend an already good
  pattern, it's perfect actually… but they're cc[-oriented]".
- **Left menu: replace dash's Projects with GENIE WISHES** — the wish is the organizing layer,
  with coding agents on it.
- **Per wish: hired agents** — "every wish can have one claude code, one codex, one hermes, all in
  terminal." A roster/hiring model: assign fleet members to a wish.
- **Swap/split: a new tab system inside one wish context** — tab between the wish's agents, or
  split 2+ horizontally. (Same wish context, multiple simultaneous agent faces.)
- **ACP's true purpose (user): the agents hired on a wish use ACP to communicate WITH EACH OTHER** —
  plus a **wish-scoped "group chat" drawer** where agents + human converse. (Self-hosted, wish-scoped
  Newio-lite, inside dash.)

### The one hard design knot: one agent, two faces

The PTY tab (the agent's real TUI — the thing the user loves) and the chat-drawer participation
(needs structured in/out) cannot be the same OS process: TUIs speak pixels, the chat needs text/
events. ACP has no agent-to-agent primitive, so the group chat is OUR bus: genie-ui's backend is an
ACP client per hired agent; a chat message @-agent becomes session/prompt (+chat context); replies
stream back as chat messages. The knot is IDENTITY: is the chat session the SAME agent-session as
the terminal tab?

Per-harness session-bridging facts:
| Harness | TUI session ↔ ACP session shareable? |
|---|---|
| Hermes | **Best**: one core drives TUI/CLI/ACP; ACP sessions persist to shared `~/.hermes/state.db`, visible in `session_search`; profiles isolate per role |
| Claude Code | **Plausible**: sessions are JSONL transcripts on disk; `claude --resume` and the adapter's `loadSession` both replay them — same-session-different-face looks feasible |
| Codex | Unknown — App-Server build's resume/loadSession undocumented |
| rlmx | Ours — we control it (session store is Group 3 of rlmx-acp) |

Candidate models:
- **Model A (rejected):** chat-only agents, terminal renders the ACP stream — the abstraction the user hates.
- **Model B (recommended):** two faces, one workspace — interactive TUI pane + a sibling ACP session
  per agent, both bound to the wish's worktree; shared truth = wish artifacts in git (genie style) +
  per-harness session-bridging where it exists (Hermes/CC). Chat drawer runs on the ACP faces.
- **Model C (rejected):** inject chat into the PTY as keystrokes + scrape output — zero abstraction
  but fragile parsing, no structured replies.

Conductor implication: the wish group chat IS the conductor's substrate — the pipeline
(fable wish → hermes review → codex execute → opus fix → fable gate) becomes "who speaks next in
the room," first manually (human @-mentions), later as policy (auto-advance). One surface, two wishes.

### Settled 2026-07-21 (user)

- **ONE wish**: wish-layer left menu + hired-agent tabs/splits + wish group chat all in wish one.
  (Conductor auto-routing = follow-up; it's chat routing policy on the same surface.)
- **Home: the genie repo itself** (~/workspace/repos/genie = automagik-dev/genie, branch dev).
  Verified: genie HAD a UI — history shows `packages/genie-app` (backend + pg-bridge) and
  `src/tui/` (React/Ink components, HelpOverlay/Nav, "Phase 5" era, Apr-May 2026) — **fully removed
  from the current dev tree** (v5 cleanup). Nothing UI-shaped in-tree today (src = CLI/hooks/lib
  only; no ink/react deps left). "Cleaning" burden = small (legacy references only); the new UI is a
  fresh package (e.g. `packages/genie-ui`), seeded from the dash fork if Lane A wins the A/B.
- WRS: ████████░░ 80/100 — Problem ✅ Scope ✅ Decisions ✅ Risks ✅ | Criteria ░ (draft below,
  pending user's confirmation of the two-faces model).

### COUNCIL VERDICT — 2026-07-21, 4-0 (full report: COUNCIL.md; persisted by orchestrator)

**Model B ratification sentence:** "Each hired agent is one real terminal plus one lazily-spawned,
read-only ACP chat face in the same wish worktree; git artifacts are the shared memory, @-mentions
route the chat, and Hermes-style session bridging is a demonstrated bonus, never a gate."

Corrections to the draft (all P0 unless noted): coherence contract = worktree + git artifacts, NOT
session identity; chat face NON-MUTATING in v1 (terminal works, chat talks, git is what both read —
kills the two-writers-one-JSONL race); @-mention-only delivery as the *designed* contract; lazy
spawn (PTY on tab-open, ACP face on first @-mention seeded with wish context + room transcript) —
which makes "chat-only role agents" free (P1); chat backend = separable module (1 ClientSideConnection
per hired agent, no PTY imports) = the literal conductor substrate for wish two; delivery/spawn
failures are named chat-drawer events, never silence. Dissent preserved in COUNCIL.md: write-promotion
toggle (2-2, deferred from v1); capability badges pared to a checked-in per-harness capability table.

### Acceptance criteria (council-revised)

1. Left menu lists genie wishes (repo .genie), replacing dash's Projects; selecting a wish opens
   its worktree-bound context.
2. A wish hires agents from the fleet roster (CC, Codex, Hermes profile, rlmx); each is a terminal
   tab rendering its REAL TUI (PTY-faithful); 2+ splittable horizontally. Hire = roster entry only;
   PTY face spawns on tab-open.
3. Wish group chat drawer, **@-mention-only** (documented as the designed contract; undelivered
   chat is visible history, not implicit agent context): @agent delivers the message + room
   transcript to that agent's chat face; replies stream back as chat messages.
4. **AC4a (hard, all harnesses):** both faces run in the same wish worktree; `.genie` wish
   artifacts are canonical shared state; the chat face is non-mutating in v1 — only the terminal
   face mutates the worktree. **AC4b (best-effort):** session bridging demonstrated for Hermes via
   state.db; CC JSONL-resume as stretch; Codex/rlmx exempt.
5. ACP chat face spawns lazily on first @-mention, seeded with wish context + room transcript;
   spawn/delivery failures surface as named, greppable chat-drawer events.
6. Chat backend is a separable module (one ACP client connection per hired agent; interface =
   deliver message / stream reply) with no PTY-layer imports.
7. Per-harness capability table checked into the repo drives minimal chat-face badges (e.g.
   "shared memory" for Hermes).
8. Old-UI residue in the genie repo identified and cleaned as part of the wish.

```
WRS: ██████████ 100/100 — crystallize pending two inputs: user ratification + A/B shell verdict
```

- Wish one = pillars 1+2 (fleet floor + genie lane, manual pipeline)? Conductor as wish two?
- Packaging: browser app served from the box (works from mac + phone immediately) vs Electron/Tauri
  desktop? (dash is Electron; browser-first fits the multi-device habit.)
- Home: new repo (`~/prod/genie-ui`) vs inside the genie plugin project?
- Station strip in wish one (cheap — the data planes exist) or wish two?

1. v1 host: Newio vs Tidewave vs a native-mac client you're already testing — which pane do you live in?
2. Is v1 "all agents mounted + wired painlessly" (registry/wiring win) with manual handoffs, or must
   the pipeline auto-advance (conductor logic) from day one?
3. Where does pipeline state (wish docs, review verdicts) live — git (like genie today) or the host?

> **RATIFIED 2026-07-21 by the user**: "i accept the council". Model B as corrected; A/B verdict = fresh substrate + salvaged TerminalMirror. Brainstorm migrated here from ~/prod/ryzen-ai-station (original slug agent-conductor); conductor auto-pilot = follow-up wish.
