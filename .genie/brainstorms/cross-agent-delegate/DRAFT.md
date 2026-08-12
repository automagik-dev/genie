# DRAFT: cross-agent-delegate (Domain F — umbrella G6 + refine)

**Parent:** [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) · **Status:** Simmering

## RE-OPENED 2026-08-10 — orca-inspired teammate delegation (Felipe)

Felipe now runs genie in **five runtimes**: Claude Code, Codex, pi, Hermes, agent-prime. New framing on top of the 2026-07 decisions:

1. **Stage routing policy** — decide *who does what at which lifecycle stage and why* (brainstorm/wish/work/review/etc.), as an explicit, inspectable policy — not "whatever runtime I happen to be sitting in."
2. **Teammate channel** — a clear back-and-forth channel between agents ("coding agents are teammates"), beyond one-shot JSON hand-back.

**Orca reference (github.com/stablyai/orca, fetched 2026-08-10):** desktop/mobile ADE, "AI Orchestrator for 100x builders." Key mechanics: (a) harness for ANY CLI-based agent — no custom protocol, wraps terminal execution; (b) parallel git worktrees — fan one prompt across multiple agents, compare diffs, merge the winner; (c) no explicit handoff protocol — orchestration happens through version control + UI review; (d) annotate-diffs feedback loop (comments on generated code flow back into agent prompts); (e) SSH worktrees for remote agents. Genie already has the worktree-per-group substrate (`launch`/warp-launch) and a CLI-adapter posture (nous-skills evidence above) — the orca deltas are the *fan-out-and-compare* pattern and the *feedback-annotation* channel.

### DECIDED 2026-08-10 (Felipe picker)

- **D-A Routing policy home = the board card.** Default agent for a task = the current coding agent (whoever is orchestrating); at task creation there is an option to declare which coding agent works it (with the "why"). Board-driven override, not global config, not WISH.md pins.
- **D-B Substrate = remotty, not a new channel.** Remotty already ships the orca-harness half: shpool terminal server, `spawn [--worktree] <host> <agent> <dir>` / `resume <host> <agent> <dir> <convo_id>` / `revive` plumbing, per-session git worktrees under `<project>/.worktrees/`, fleet state, and two GUI clients that render the genie board (read-only, by contract — see `wishes/remotty-board-asks/HANDOFF-from-remotty.md`). The user *sees* spawning agents in the remotty client, orca-style. Back-and-forth rides resumable sessions + genie card timeline (`task comment`/`report` verbs) as the durable thread.
- **D-C Fan-out fully IN.** Same task fanned to N agents in N worktrees, compare, merge winner. Remotty's worktree-per-session already isolates; the compare/merge policy is the open design work.
- **D-D Roster wave 1 = all five.** claude, codex, pi, hermes, prime — all already in remotty's built-in agent roster (`config/agents.example`; `prime` runs `prime-agent`, kimi also present). Adapter-specific facts: pi has `-p` one-shot + `--mode json|rpc` + `--session-id`; codex `resume --last`; hermes' resume flag varies by version (config-file override is the mechanism); `prime-agent`/`kimi` continue-forms in roster. Agents-as-data: adding an agent = a roster line, not code.

- **D-E Spawn driver = genie.** The orchestrating agent calls remotty's spawn plumbing when a routed card starts; the user watches the session appear in the remotty client. No approval friction; the board is the authority.
- **D-F Merge policy = review ranks, Felipe ratifies.** The review stage compares fan-out candidate diffs against the group's acceptance criteria and ranks with rationale; Felipe confirms the winner before merge. Loser worktrees pruned via remotty `worktree prune` (branches survive by remotty's own rule).
- **D-G Same-server delegation only.** A delegated/fanned agent always runs on the server the task already runs on (local or remote); cross-server spawning is OUT.

### SUBSTRATE FACTS (verified in-repo 2026-08-10)

- `tasks` already has `claimed_by` + `agent_kind` + `heartbeat_at` — but those are **observed** identity (set at claim/heartbeat, boards-first-class runtime liveness ▶/⏸/☠). Declared routing needs its own additive columns; never conflate assignment with observation.
- `hire_roster` (wish, agent_adapter_id, profile, worktree, hired_at, state) exists (genie-ui-dash G5), machine-local, excluded from roadmap.json sync — per-wish hires, not the per-task declaration Felipe asked for; left as-is.
- `task comment` / `report` verbs + `task_events` timeline exist — the durable thread substrate is already shipped.
- warp-launch panes carry arbitrary shell commands — a remotty launch backend is a sibling emitter, not a rework.
- remotty plumbing contract (from `--help`): `spawn [--worktree] <host> <agent> <dir>` · `resume <host> <agent> <dir> <convo_id>` · `revive` · `worktree prune` (refuses dirty trees, only wt/* branches, branch survives). Built-in roster: claude/codex/prime/pi/kimi/hermes.

### APPROACH (chosen 2026-08-10) — board-as-contract, thin spawn bridge

Genie wish: (1) additive `tasks.assigned_agent` + `assigned_reason` columns, `task create --agent/--why` + a `task assign` verb, exposed in `board --json` (remotty handoff ask-pattern: serialize or the client can't render); (2) a delegate bridge — when a routed card starts, genie invokes `remotty spawn --worktree <same-host> <agent> <dir>` with a curated brief, persists the session/convo ref on the card timeline, hand-backs land as `task comment`/`report` events, follow-ups resume the same session; (3) fan-out `task fan <id> --agents a,b,c` reuses the same spawn path N times, candidates tracked as timeline events + `wt/<task>-<agent>` worktree convention (no new table), review ranks against group acceptance criteria, Felipe ratifies, winner merges, losers pruned via `remotty worktree prune`. Remotty-side (separate, tiny, its own repo): render `assigned_agent` on cards — noted as a cross-repo dependency, not built here.

Alternatives rejected: hire_roster-centric routing (per-wish + machine-local, contradicts per-task-in-git declaration); remotty-driven orchestration (violates remotty's never-write contract and D-E).

Degradation (extends 2026-07-09 policy): spawn/adapter failure **fails open** — logged on the card timeline, card returns to claimable, orchestrator may work it directly; never block a stage on external-agent availability, never silently pretend the delegation happened.

### CRITERIA (draft)

1. Assignment round-trip: `--agent codex --why "…"` persists and appears in `board --json`.
2. Delegation round-trip: routed card start → remotty session on the same host in a worktree, ref on timeline; hand-back event lands; a follow-up resumes the same session (2 turns proven).
3. Fan-out round-trip: 3 agents → 3 worktrees/sessions → ranked review verdict → ratified merge → losers pruned, branches survive.
4. All five adapters (claude, codex, pi, hermes, prime) pass a one-shot brief→hand-back smoke.
5. Spawn failure degrades open (timeline log, card claimable, no hang).

### GAPS 2026-08-10 (supersede the 2026-07 gap list where they overlap)

- [x] Cross-repo split — decided: remotty-side is render-only, its own repo, cross-repo dependency note in the wish.
- [ ] Prior gaps still open, deferred behind triggers: external-agent budget/limits (trigger: first observed host contention); companion-session retirement policy (trigger: first shipped wish with live sessions).

**WRS: 100/100 — crystallizing to DESIGN.md (2026-08-10).**

### FIX LOOP 1 (design review FIX-FIRST, 2026-08-10T23:55:17Z, digest `b98b2629…`)

Reviewer (design-review-cross-agent-delegate) verified the seam against remotty's actual code and found the documented plumbing cannot serve headless delegation: `spawn` exec's into an interactive attach (no refs returned, no exit code to probe), the `~/.config/remotty/agents` file governs only resume (id never interpolated), and worktree names are computed internally (`basename(dir)-<agent>[-N]`) with silent isolation downgrade on `no-git`/`add-failed`. Repairs applied to DESIGN.md: remotty-side **headless spawn verb** promoted to an explicit cross-repo deliverable (detached session, brief-file launch, loud worktree failure, machine-readable `{session, worktreePath, branch}` output); brief = file in the worktree, never argv; `assigned_agent` allowlisted against the roster; durable refs = session name + worktree path + branch (convo id opportunistic — hermes has none); bridge claims via `task checkout --worker <agent>` and releases on spawn failure; lane-path-only `board --json` serialization (laneless shape is byte-frozen by prior WISH decision); roadmap-sync lockstep work added to IN; criterion 6 restated genie-side; host token = always `local` (same-server invariant); W1 routing → W2 spike+bridge → W3 fan-out wave order with W1 never gated.

### FIX LOOP 2 (re-review FIX-FIRST narrow, 2026-08-11T00:06:33Z, digest `f2be7349…`)

12/14 loop-1 findings verified closed; reviewer also confirmed `worktree prepare`/`open` accept caller-supplied names in-contract today (recovering most of the naming problem without remotty changes). Residuals repaired in DESIGN.md: cross-repo verb respecified as a **headless `worktree open` variant** (name input on an existing tree, refuses self-created worktrees, returns the authoritative uniquified session name); **turn-per-launch** conversation model (no remotty verb drives a live session — every turn, brief or follow-up, is a launch through the same verb with per-turn argv; adapters must exit per turn); briefs moved **out of the worktree** to `$GENIE_HOME/briefs/…` (untracked in-tree files would make every fan-out loser un-prunable under non-forced prune); failed-delegation cleanup rule (prune, or log orphan path on refusal); adapter cards = genie-side data with explicit `{brief}` placeholder + autonomy/permission flags + non-empty-diff smoke requirement (remotty's verbatim agents file cannot carry interpolation and stays remotty's business); trust posture stated (brief text is Felipe-authored, prompt boundary accepted); **pour as two genie wishes** (W1 now; W2+W3 blocked on named remotty wish `headless-turn-open`) so the external stall is a board edge (new Decision 13); lane-path consumer consequence clause added.

### SHIP (loop-2 re-review, 2026-08-11T00:14:02Z, digest `c15d6a9e…`, evidence stamped + verified)

All loop-2 repairs verified real against code. **Five residuals confined to W2/W3, to be applied as DESIGN edits (with fresh review) BEFORE the W2/W3 wish pours — none touch W1:**

1. **MEDIUM-1 hermes continue:** hermes has no id-free continue form (roster file: "--resume is the whole answer"; sessions in `~/.hermes/state.db`, invisible to remotty's convo scan; `-c <name>` has a title-fallback trap). Before W2 pour: name hermes' real mechanism (continue-by-title keyed to candidate name, stateless turns with accumulated-context briefs, or single-turn scope) and fix Criterion 4.
2. **MEDIUM-2 cross-repo edge:** `task_dependencies` is same-DB FK-constrained — a depends-on to a remotty-repo wish is inexpressible. Use `genie task block <id> --reason "blocked on remotty headless-turn-open"` (`block_kind='work'`) on the W2/W3 card instead. **Also reconcile DESIGN.md line 37** — it still says the W2/W3 wish "declares `depends-on`" the remotty wish; the W1 plan review (LOW-5) confirmed the wish's `task block` wording is the right story and the design sentence is stale.
3. **MEDIUM-3 dirty-orphan deadlock:** `.worktrees/<name>` path is NOT uniquified by prepare (only the `wt/` branch is) — a dirty orphan makes every retry of the same card×agent fail at prepare forever. Decide: attempt/turn-counter suffix on candidate names, or operator-cleanup surfaced in `doctor`.
4. **MEDIUM-4 remotty ask shape:** the headless verb must take BOTH the roster name (for manifest identity — `revive`/fleet state/client rendering join on it) AND the launch argv. Write the remotty `headless-turn-open` wish from the amended paragraph.
5. **LOW-1 brief reach:** brief under `$GENIE_HOME` is outside several runtimes' default cwd sandbox — adapter cards must carry a read grant for the brief path, or the launcher passes the brief on stdin.

Keep (reviewer): the id-free continue form is unambiguous **by cwd** — each candidate worktree is its own conversation scope; that's what makes turn-per-launch safe under fan-out. Make it explicit in the adapter rationale at W2 pour.

## KNOWN (evidence — nous-skills-research 2026-07-09)
- NousResearch/hermes-agent `skills/autonomous-ai-agents/` = one adapter skill per external CLI (claude-code, codex, hermes, opencode), all CLI-over-terminal. Portable mechanics:
  - codex: `codex exec` one-shot needs git repo + PTY + `--full-auto`; JSON output; `codex review --base origin/main`; parallel via git worktrees; auth via OPENAI_API_KEY or ~/.codex/auth.json.
  - hermes: oneshot `hermes chat -q` (host alias `-z` works on cegonha); continue-by-title `-c <name>` (title-fallback trap!); sessions in ~/.hermes/state.db; `delegate_task` in-process subagents; kanban board ≈ genie task-state parallel.
  - claude-code (mirror image): `claude -p --output-format json` returns {result, session_id, cost}; `--session-id <uuid>` pins; `--resume`; `--bare` skips plugins.
- hermes-pairing skill already does the manual version (SSH + base64 + timeout + wish-<slug> sessions); its gotchas are proven (used live in this brainstorm, 2 rounds).
- Cross-LLM = off-Anthropic-bill cost arbitrage + genuine dissent diversity.

## DECIDED (umbrella D11, D12; Felipe 2026-07-09)
- ONE `delegate` skill + per-agent adapter references (delegate/agents/codex.md, hermes.md). Launch scope Codex + Hermes; opencode = stub, OUT.
- Wish-based companion sessions: one named session per (wish × agent), title `wish-<slug>`, session ref persisted on the wish row in genie.db; every /work turn reconnects.
- Structured hand-back (JSON) + background+poll for long runs.
- refine = cross-LLM prompt adapter: backbone method (intent→constraints→evidence→acceptance) + per-target style cards `refine/targets/{fable,gpt-codex,hermes,haiku}.md` ≤60 lines; auto-applied to outgoing briefs; manual `/refine --target`.
- **Auto Hermes counter-read at plan gates** (decided); execution gates trigger-based (disagreement/high blast radius). Codex + council LLM-lenses on-demand.

## Degradation policy (learned live, 2026-07-09)
First real invocation of the auto plan-gate counter-read hit cegonha unreachable (network path down; host fine an hour earlier). Decided behavior to encode in the delegate skill: **counter-read fails OPEN** — the gate proceeds on the internal reviewer alone, logs "counter-read unavailable (host unreachable)" in the review record, and the next gate retries. Never block a plan gate on external-agent availability; never silently pretend the counter-read happened.

## RECONCILE (2026-07-10 — agent-sync shipped, PR #2541 merged to dev)

**The Codex *plumbing* is now built and owned by agent-sync — this track consumes it, does not rebuild it.** `genie update` (and `genie install`) now fan the canonical `~/.genie/plugins/genie` source into every DETECTED coding agent on every invocation, including a **Codex adapter that ships genie skills to `~/.codex/skills/.curated/`** (managed manifest + adopt-with-backup + orphan removal). So the "one delegate skill + per-agent adapter references" decision is unchanged, but its Codex prerequisite — *getting genie's skills onto the Codex side* — is solved for free: the delegate skill can assume the curated genie skills are present on any machine that has run `genie update`. What remains this track's own work is the **delegation runtime** (companion `codex exec` / `hermes chat -q` sessions, JSON hand-back, background+poll, the `wish-<slug>` session persistence on the genie.db row), not the skill distribution. The Codex-install/auth GAP below narrows accordingly to *auth + which roles first*, since "are genie's skills installed on Codex" is answered by agent-sync.

## GAPS
- [ ] Codex reality on your machines: installed? auth method (API key vs OAuth)? Which lifecycle roles do you want Codex for first — engineer on suitable groups, PR review dissent, or both? (Skill distribution to `~/.codex/skills/.curated/` is now handled by agent-sync — see RECONCILE above; this GAP is now auth + role-scoping only.)
- [ ] Hermes canonical vs alias: confirm `-z` is a cegonha alias (helper works today; adapter should document canonical `hermes chat -q` + fallback).
- [ ] Budget/limits for external agents: max concurrent companion sessions? Hermes host load limits (cegonha is shared infra — benchmarks run there)?
- [ ] Session lifecycle: when a wish ships, are its companion sessions retired (hermes sessions delete is gated on shared infra) or kept as history?
- [ ] Collision: v5-completion wish carries "Codex launch target + Hermes decision" — reconcile scope so two wishes don't both own Codex integration.
- [ ] The 721-line optimizer → style cards distillation: you said your method is well-structured — walk me through the parts you consider load-bearing so the cards keep them.
