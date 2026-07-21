# agent-conductor — Decision-Ready Brief

**Goal:** one ACP environment where Hermes, Claude Code (Fable + Opus roles), Codex, and rlmx collaborate as a pipeline: **Fable wishes → Hermes profile-review → Codex executes → Opus review+fix → Fable final gate.** Below: (1) what each harness's ACP path actually is today, (2) which host can mount them all for v1, (3) three concrete ways to make them *collaborate* rather than sit in silos, (4) the one thing to verify by hand before committing.

Terminology guard: "ACP" here = Zed's **Agent Client Protocol** (JSON-RPC 2.0 over stdio; host/editor = client, coding agent = agent). Not IBM's Agent Communication Protocol. Fable and Opus are *the same harness* (Claude Code) with different model/config — two `agent_servers` entries, not two integrations.

---

## 1. Fact table — per-harness ACP path (mid-2026)

| Harness / role | ACP path today | Launch | Key capabilities | Session model | Gotchas |
|---|---|---|---|---|---|
| **Claude Code** (Fable *and* Opus) | **Exists, official, no shim.** `@agentclientprotocol/claude-agent-acp` **v0.60.0** (pub 2026-07-20), Apache-2.0, actively maintained (~2.3k★). Renamed from deprecated `@zed-industries/claude-code-acp` (last v0.16.2). Built on Claude Agent SDK (TS); runs Claude as an independent process, editor supplies UI/diffs. | `npx @agentclientprotocol/claude-agent-acp` | @-mentions, images, **tool calls w/ permission requests**, following, multibuffer edit review, TODO lists, interactive + background terminals, custom slash commands, **client MCP-server passthrough** | **fork / list / resume + loadSession** (`loadSession` replays the JSONL transcript → full history reconstruction; `resumeSession` restores SDK state only). Resumed session retains transcript's model. | **No native ACP in Claude Code itself** — anthropics/claude-code #6686 closed `not_planned` 2026-02-19. SDK adapter is the *only* sanctioned path. loadSession/model behavior verified on old repo, not restated in terse 0.60.0 README (assume carried, verify). Two roles = two entries w/ different `env`/model. |
| **Codex** | **Exists, official, no shim.** `@agentclientprotocol/codex-acp` **v1.1.4** (pub 2026-07-15), TypeScript, Apache-2.0. Rebuilt on the new **Codex App Server**. Renamed from deprecated Rust `@zed-industries/codex-acp`. | `npx -y @agentclientprotocol/codex-acp` | **model selection, reasoning effort, fast mode, approval + sandbox modes**; 3 permission modes **read-only / agent / agent-full-access**; **client MCP servers over stdio *and* HTTP**; images/context/resource-links/workspace dirs; slash cmds (/review, /init, /compact…) | **Resume/loadSession NOT documented** for the App-Server build (old Rust build didn't either). Treat as prompt-only until verified. | Auth = ChatGPT sub / `CODEX_API_KEY` / `OPENAI_API_KEY`. **`NO_BROWSER=1`** = the headless/remote-auth affordance (matters for SSH). |
| **Hermes** (Nous) | **Ships ACP natively — best-integrated, no shim to build.** In-tree `acp_adapter` module (not a wrapper); same core drives CLI/TUI/Electron/web/ACP. | `hermes acp` (aka `hermes-acp`, `python -m acp_adapter`); install `hermes-agent[acp]==<ver>`. **stdio only.** | file read/write/patch/search, terminal, browser, vision, memory/todo search, skill execution. 3-tier permissions (allow once / session / always). Model inherits Hermes config at runtime. **Deliberately excludes messaging + cron.** | **list / load / resume / fork**, scoped to the running ACP process (per-session: id, cwd, model, history, cancel). | **No ACP *client* mode** (Hermes connecting OUT to other agents) — #36057 open, doesn't exist. **MCP passthrough unconfirmed.** Exact PyPI pin unknown. |
| **rlmx** (yours) | **Your own stdio ACP agent, in flight.** Notably, the orchestration lane identifies the **tool_call-node sub-agent-surfacing pattern as "the rlmx-acp pattern"** — i.e. rlmx already knows how to represent a child agent's stream as a `tool_call` node in a parent session. | (your build) | (your build) — presumed stdio ACP agent surface + the tool_call-node surfacing primitive | (your build) | This is the seed of the hub in Option B — see below. |

Bottom line: **four of five roles have a working stdio ACP path *today* with zero shim** (CC ×2, Codex, Hermes). rlmx is your own and already in flight. There is no adapter to build. The open question is not *reach* — it's *topology and network*.

---

## 2. Host verdict — who can mount all agents for v1

All four external harnesses are **stdio ACP subprocesses**. Any host that accepts arbitrary `command/args/env` exec entries can mount all of them. The differentiator is **(a) remote/network wiring** and **(b) whether agents can see each other** (agent-to-agent handoff vs. star-topology-through-a-human).

| Host | Mounts all agents? | Config | Remote / network | Agent-to-agent? | v1 fit |
|---|---|---|---|---|---|
| **Zed** (reference impl) | **Yes** — N agents = N sibling keys in `agent_servers` (`{type:"custom", command, args, env}`) + registry "Add Agent". Users already run several CC variants side-by-side this way. | copy-paste exec JSON, unbounded | Local stdio spawn only. "Remote" = Zed's own SSH remote-dev (agent runs on remote host). **⚠ #47910: registry external agents do NOT work on Zed remote-server (Win→Ubuntu SSH) or WSL — open bug.** | **No.** Each agent = isolated thread, sees only the human. Star topology. | **Safe default for mounting.** Human shuttles between panes. |
| **ACP UI** (acp-ui.github.io) | **Yes** — any ACP agent, 6 platforms incl. macOS. | name + exec, *or* remote `wss://` endpoint | **Best remote story:** browser build connects to remote agents over `wss://` with `$/ping`/heartbeat to survive NAT/idle. | No (per-session). | Strong if you want a **remote wss endpoint** surface instead of SSH. |
| **Tidewave** | Multiple agent *types* via **ACP-over-WebSockets** proxy; web build talks to **remote agents over wss only**. | browser spawns + config-injects | Genuine remote (wss). | **No** — agent↔*app*, not agent↔agent. | Only if the work is web-app-shaped (Phoenix/Rails/Vite). |
| **Newio** | Many agents per channel. | "Agent Connector" (accounts/permissions, **not** raw exec — schema unpublished) | **Unknown** (local stdio vs remote socket not documented). | **YES — the only host with true agent-to-agent visibility + handoff.** Agents have accounts, DM/mention/*involve* each other + multiplayer humans. | The **collaboration wildcard** — but transport + ACP-nativeness unverified. |
| Conductor / Intent (mac-native) | Parallel agents in isolated **git worktrees** — **NOT ACP**, deliberately isolated. | native integrations | — | No (isolation is the point). | Out of scope (not ACP). |

**Verdict:** For **v1 mounting**, **Zed** is the no-mistake choice — all four harnesses are stdio, entries are copy-paste, and it's the reference implementation. But Zed gives you a **star topology**: five threads, human is the only bus between them. That does not deliver "collaborate as pipeline roles." **Genuine agent-to-agent** exists in exactly one surveyed host — **Newio** — but its transport and ACP-nativeness are unverified, so it can't be the v1 commitment. **Conclusion: pick the host for the *mounting layer*, and solve *collaboration* separately (Section 3), because no proven host does both.**

**Network reality (can't-mistake area):** every local adapter is child-process stdio; there is **no native network transport** for local ACP. "Remote" = **SSH-launch the adapter on the remote host and pipe stdio** — exactly your preferred pattern. Two facts govern this: (1) Zed's *own* registry+remote-server path is **documented broken over SSH/WSL (#47910)** — so you cannot lean on Zed's remote-dev feature; (2) but an `agent_servers` entry whose `command` is `ssh` (`ssh host npx @agentclientprotocol/…`) is just a subprocess whose stdio happens to cross the wire — that should bypass #47910 entirely. That distinction is the crux and is the load-bearing unknown (Section 4). Codex's `NO_BROWSER=1` is the auth affordance that makes headless/SSH launches viable.

---

## 3. The conductor question — three ways to make the pipeline COLLABORATE

The protocol facts that bound this: base ACP is **strictly 1 client : 1 agent per connection**; a `sessionId` is meaningful only inside the agent that minted it. **There is NO core-spec primitive for a session spanning agents, for handoff, or for nested agents.** Multi-agent topology lives entirely in the **proxy-chains RFD** (a *proposal*, linear `Client→Proxy→…→Agent`; M:N "peer" field is future-only) and in the application-level **Router-Agent pattern** (one process that is simultaneously an ACP *server* upstream and ACP *client* downstream). So "collaboration" is something you *build on top of* ACP, not a feature you *turn on*.

### Option A — Pure registry/wiring, human is the bus
Mount all five roles as sibling entries in Zed (or ACP UI). Fable, Hermes, Codex, Opus, rlmx each get their own thread. Human copy/pastes Fable's wish into the Hermes thread, Hermes's review into Codex, etc. The pipeline lives in your hands.

- **Trade-offs:** Zero build, works *today*, full per-agent fidelity, nothing to maintain. But: no automation, **you are the message bus**, no shared context between agents, tedious and error-prone at 5 hops. It's manual relay, not collaboration.
- **Depends on:** only the adapter installs (all exist) + solving the SSH wiring once.
- **Already in your stack:** nothing to build; your **genie roles map 1:1 onto the manual steps** (wish → review → execute → review → gate). This is genie-orchestration performed by a human.
- **Use as:** the v0 that proves the agents mount + the SSH transport works, before investing in B.

### Option B — Hub process = ACP client of N agents, exposed as ONE ACP agent  ★ recommended
Build the conductor as a **Router Agent**: one process holding **1× `AgentSideConnection` upstream** (presents itself as a single agent to the human's host — Zed/ACP UI) **+ N× `ClientSideConnection` downstream** (one per child: Fable, Hermes, Codex, Opus, rlmx spawned as subprocesses). The SDK (`@agentclientprotocol/sdk` **1.2.1**) supports exactly this today — nothing in the transport limits connections-per-process. The pipeline (Fable→Hermes→Codex→Opus→Fable) is encoded as **routing/DAG logic inside the hub** — i.e. genie's role graph. Each child's `session/update` stream is re-emitted upstream as a **`tool_call` node** (`kind: other|think`, status pending→in_progress→completed, child output in `content`) so the human sees **one unified thread** with each agent as an inspectable node — **this is precisely the rlmx-acp tool_call-node pattern**. Permissions compose by forwarding: a child's `requestPermission` is either auto-answered by hub policy or re-raised on the upstream `AgentSideConnection` for the human, then relayed back.

- **Trade-offs:** **True automation + true single-pane collaboration + full control of routing.** But you own the under-specified parts: multi-agent session bookkeeping (`parentSessionId → [childSessionId…]` map), **permission fan-out/attribution** (the proxy-chains RFD *explicitly does not define* `requestPermission` composition), cancel fan-out, and backpressure when N children fan into one upstream stream. Proxy-chains is a *proposal*, not ratified core — you're building ahead of the spec (but on stable SDK primitives). Most engineering of the three.
- **Depends on:** SDK 1.2.1 (have it); the stdio-over-SSH transport for spawning remote children (Section 4). No unratified protocol feature is *required* — you synthesize handoff yourself with separate downstream sessions + re-emitted updates.
- **Already in your stack (largest reuse):** **rlmx acp** already implements the tool_call-node surfacing primitive → **the hub is essentially rlmx generalized from 1 child to N.** **genie orchestration** already *is* the pipeline: wish → profile-review → execute → review+fix → final-gate is genie's exact flow — the hub is "genie's role graph wearing an `AgentSideConnection` upstream and N `ClientSideConnection`s downstream." Your **workflows** supply the DAG. You are not starting from zero; you're wiring three things you own to a well-supported SDK shape. Reference prior art exists (`sacp-conductor` Rust, the RFD's named "Conductor", `beyond5959/acp-adapter` Go multi-CLI bridge) but none is a drop-in multiplexer.
- **Use as:** the real v1. Ship A first to de-risk transport, then collapse the human-bus into this hub.

### Option C — Host-native automation (Newio)
Let a host that has agent-to-agent messaging do the choreography. In **Newio**, agents have accounts and can DM/mention/*involve* each other; encode the pipeline as agents handing off in a shared channel, humans watching as multiplayer participants.

- **Trade-offs:** **Agent-to-agent handoff with no hub to build** — the only host that does this natively, and it gives you human+agent multiplayer for free. But: you **don't control the routing** (it's their platform), maximum vendor coupling, and the biggest pile of unknowns — whether Newio speaks ACP natively vs. wraps agents in its own account layer, its transport (local stdio vs. remote socket), its Agent-Connector config schema, and whether Hermes/rlmx mount at all are all **unverified**.
- **Depends on:** Newio actually being ACP + supporting your SSH/remote pattern + mounting all five roles — none confirmed.
- **Already in your stack:** **nothing reused** — you'd rebuild the pipeline as Newio channel choreography and abandon genie's orchestration graph.
- **Use as:** a time-boxed spike *only if* Newio's ACP-nativeness and transport check out. High ceiling, high risk.

**Lean:** **B is the fit** — it's the only option that delivers true collaboration *and* single-pane UX *and* reuses genie + rlmx-acp, and it matches the exact "server-and-client Router Agent" shape the RFD and community docs name. **A is the mandatory v0** to prove mounting + SSH before you build the hub. **C is a wildcard** worth one spike, not a commitment.

---

## 4. The single most load-bearing unknown — verify by hand

**Does stdio-over-SSH actually deliver a clean bidirectional ndjson ACP stream for at least one adapter?**

Concretely: launch one adapter remotely — `ssh <host> "NO_BROWSER=1 npx -y @agentclientprotocol/codex-acp"` (Codex is the sharp test because of headless auth) or the Claude/Hermes equivalent — pipe its stdio into a local ACP client, and confirm the full round-trip: `initialize` → `session/new` → `session/prompt` → streamed `session/update` → `session/request_permission` → response. 

This is load-bearing because **every remote path in A, B, and C rides on it**, and there is a documented failure right next to it: **Zed issue #47910** says registry external agents do *not* work on Zed's remote-server over SSH/WSL. The whole architecture hinges on whether that failure is (a) intrinsic to stdio-ACP-over-SSH — which would sink the preferred remote pattern and force a wss-endpoint host (ACP UI/Tidewave) or a co-located hub — or (b) specific to Zed's *remote-dev feature*, in which case a plain `command: ssh …` subprocess (or a hub that spawns children over SSH while only the hub↔human link crosses the wire) sidesteps it entirely. **Nothing else in this brief can be finalized until you run that one round-trip and see which world you're in.** Everything else in the research is confirmed enough to act on.
