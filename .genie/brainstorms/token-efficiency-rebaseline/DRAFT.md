# DRAFT — token-efficiency-rebaseline

| Field | Value |
|-------|-------|
| **Slug** | `token-efficiency-rebaseline` |
| **Date** | 2026-07-11 |
| **Seed** | [genie-token-efficiency-program/DESIGN.md](../genie-token-efficiency-program/DESIGN.md) (umbrella, WRS 100, 2026-07-09) + [HANDOFF-20260711.md](../genie-token-efficiency-program/HANDOFF-20260711.md) |
| **WRS** | 100/100 — crystallized → [DESIGN.md](DESIGN.md) (2026-07-11) |

## Problem (✅)

The umbrella program's highest-leverage move — stop model inheritance via pinned role agents (G1) — is
**code-complete but not in effect**: the seven role agents ship inside the plugin (`agents/` present in
cache 5.260710.2 AND 5.260711.6, installed CLI = 5.260711.6) yet still do not surface as subagent types
in fresh sessions (verified in-session 2026-07-11 ~19:40Z). Every dispatch therefore still inherits the
main session model (Fable, xhigh/max), and daily burn remains in the $1.2–5.6k/day band. Meanwhile the
plan itself has drifted: a week of shipping went into delivery infrastructure (agent-sync + hardening,
council-workflow, plugin-resource-shipping, fable5-revamp, release-pipeline fixes) rather than umbrella
groups G2–G10, and the framework evolved (ultracode/Workflow orchestration proven via /council; more
structured wish/work; upgraded brainstorm skill) in ways the 07-09 DESIGN did not anticipate.

## Plan-vs-reality reconciliation (verified 2026-07-11)

| Group | DESIGN intent | Reality 07-11 |
|-------|---------------|---------------|
| G1 Routing | pinned role agents, complexity columns, escalation | **Code SHIPPED** (routing-matrix wish, PR #2535 + columns/lint); **delivery BROKEN** — agents not offered as subagent types in fresh sessions (day-1 QA 07-10, re-confirmed in-session 07-11 on an updated host). Pins only work when hand-applied. |
| G2 Contract | single executable dispatch contract | NOT STARTED (control-plane-contract DRAFT, Raw) |
| G3 Convergence | lifecycle-four by layer + context diets + verification budget | NOT STARTED; adjacent infra shipped instead (agent-sync = distribution convergence across Claude/Codex/Hermes) |
| G4 Absorbs | 5 skill absorptions | PARTIAL — council→workflow EXECUTED + live-QA'd; fable5-revamp cut 36 surfaces ≥40%; trace→fix, wizard→genie, pm→work-ref, report→LangWatch pending (skill-absorbs DRAFT, Raw) |
| G5 Always-on + hooks | SessionStart identity, hook contract | NOT STARTED (always-on-genie DRAFT; HANDOFF says wish-ready) |
| G6 Delegate | codex+hermes adapters, companion sessions | NOT STARTED as wish, but substrate landed: codex first-class in agent-sync; codex-integration-map answers install/auth (config.toml, codex exec, SDK, MCP) |
| G7 Spend | genie spend + decision join | NOT STARTED as wish; CLI recipes PROVEN, calibration captured, DRAFT ~80%; 4 decisions await Felipe ratification |
| G8 Brainstorm upgrade | domain map, gap ledger, WRS coupling | PARTIAL — skill revamped (WRS/jar/scope-size/isolation live in current /brainstorm) but domain-map + gap-ledger not shipped (brainstorm-domain-map Simmering, WRS 80) |
| G9 Dream replatform | scheduler adapter + genie.db ledger | NOT STARTED (Raw) |
| G10 Worktree isolation | isolation policy, locks, reaper | NOT STARTED; HANDOFF: evidence chain complete, wish-ready |

**Overnight queue 2a–2d (HANDOFF-20260711) never ran**: no fastfollow PRs (F1–F10 open), no day-2 QA
file, no genie-spend WISH, no MORNING-BRIEF-20260711, handoff still untracked. Zero open PRs; dev = main
promotion v5.260711.6 done.

## New facts (this session, 2026-07-11)

1. **G1 delivery gap ROOT CAUSE FOUND: the genie plugin is DISABLED** —
   `"genie@automagik": false` in `~/.claude/settings.json` `enabledPlugins` (omni enabled → its agents
   load; genie disabled → its agents never load). `claude plugin validate` passes; frontmatter is FINE
   per official docs (cc-guide verified: `effort:` is a supported key, values low/medium/high/xhigh/max;
   `model: opus|haiku|fable` valid; plugin `agents/` auto-surface as `plugin:agent-name`, no manifest
   field needed; plugin agents load at enable time + session restart; `~/.claude/agents/` is
   live-watched within seconds, no restart). No disable logic exists in genie source — the false flag is
   manual/historical. Skills kept working because agent-sync fans them into `~/.claude/skills/`
   (this session's /brainstorm loaded from there), masking the dead plugin — the plugin is the ONLY
   delivery path for `agents/`, which agent-sync never fans.
2. **Fix-mechanism options (D-R1)**:
   - (a) Re-enable the plugin: agents surface as `genie:engineer-standard` etc. Risks: duplicate skill
     listings (plugin skills/ + fanned ~/.claude/skills), possible hook double-wiring; namespaced names
     differ from the routing-matrix acceptance test's bare names.
   - (b) **agent-sync fans `agents/` → `~/.claude/agents/`** (managed-dir stamp + backups, same engine
     as skills): keeps the plugin-less architecture coherent, bare names match the acceptance test,
     live-watched dir (updates without restart), one bounded code change. Leaves the disabled plugin as
     dead weight to eventually remove from the flow.
3. **Ultracode/Workflow is now a proven routing substrate** — council.js runs live as a saved workflow;
   `agent(prompt, {model, effort})` pins model+effort per call deterministically, bypassing subagent-type
   delivery entirely. The 07-09 DESIGN scoped "workflow-tool migration of /work wave dispatch" OUT as a
   later experiment; that OUT is flipped by the hybrid ruling (lane 2).
4. **LangWatch day-2 evidence** (full: [qa/routing-pin-qa-20260711.md](../../wishes/routing-matrix/qa/routing-pin-qa-20260711.md)):
   - $/day: 07-08 $3,447 · 07-09 $658 · 07-10 $2,499 · 07-11 ~$1,694/day run-rate (cooling).
   - First pro-design movement: Opus token share 33→41.7%, touch 28.6→59.7%; Haiku touch 6.4→19.4%;
     first-ever low/medium-effort traces (1+2). BUT Fable token share 51.7% / touch 98.5% — nowhere near
     the ~11% gate-only benchmark; movement is behavioral (hand-applied routing), not mechanical.
   - Concentration: 7 threads active, top-3 = 80.7% of cost — high-effort orchestration threads.
   - **cache_read = 95.6% of processed tokens (762× fresh prompt)** — context re-send IS the bill;
     model price is a multiplier on that volume. Context diets (umbrella D5) + fan-out shape are
     co-equal with routing, data-proven.

## Scope (✅ — Felipe ruled 2026-07-11: **C. Hybrid, both lanes**)

- **IN — lane 1 (unblock)**: root-cause + fix G1 delivery (frontmatter repair and/or agent-sync fans
  `agents/` into `~/.claude/agents/`), re-run day-2 pin QA, doctor check for the delivery path.
- **IN — lane 2 (workflow re-platform)**: flip the 07-09 OUT — structured /work wave dispatch (and review
  fan-out) moves to Workflow scripts where every `agent()` call pins model+effort; own wish; converges
  with structured wish/work + intent-to-wish-compiler direction. Ultracode = routing enforcement for
  orchestrated work; pinned agents cover ad-hoc/interactive dispatch.
- **IN**: re-sequenced remaining-groups order + LangWatch evidence baseline (day-2 QA + rebaseline verdicts).
- **OUT (carried from umbrella)**: Sonnet in the matrix; agent-teams task truth; opencode adapter;
  pm methodology; learn→brain execution; docs restructure.

Rejected framings: A (unblock-only — leaves the proven ultracode lever on the table), B (workflow-pivot-only
— abandons cheap fix for ad-hoc dispatch, which day-1 QA showed is where unpinned burn concentrates).

## Decisions (░ — open)

- ~~D-R1~~ **DECIDED (Felipe, 2026-07-11): `genie update` fans the seven role-agent files into
  `~/.claude/agents/`** (managed stamp + backups, same engine as skills); plugin stays disabled; interim
  hand-copy applied on this host 2026-07-11 so the next session runs pinned.
  **VERIFIED ~20:15Z:** fresh headless session lists all seven as bare-named subagent types — the
  mechanism works end-to-end; `effort:` frontmatter loads fine (kills the content-vs-delivery ambiguity
  raised by the questioner lens; cause was delivery only).
- ~~D-R2~~ **DECIDED (Felipe, 2026-07-11): Hybrid** — workflow re-platform for orchestrated waves + fixed
  pinned-agent delivery for ad-hoc dispatch (see Scope).
- ~~D-R3~~ **DECIDED (Felipe, 2026-07-11): Fix → Spend → Workflows**, then always-on (G5) → contract
  (G2/G3) → delegate (G6) → domain-map (G8) → dream (G9) → worktrees (G10).
- ~~D-R4~~ **DECIDED (Felipe, 2026-07-11): genie-spend gaps all ratified** — key = CC settings env +
  config override; on-demand only; Felipe-only CLI consumer; NO doctor burn check. genie-spend DRAFT is
  now wish-ready (see its GAPS section).

## Risks (✅ carried + new)

- All umbrella risks carry (escalation laundering, context fan-out, cheap-orchestrator-accepts-bad-work…).
- NEW: every day the G1 delivery gap persists costs ~$1–4k/day of unpinned burn — the 40%-reduction
  success criterion's 2-week clock never actually started.
- NEW: workflow pivot without measurement (G7) risks re-platforming on vibes — same failure mode the
  umbrella was designed to kill.
- NEW: multi-agent fan-out (ultracode) shifts cost into prompt/cache-read tokens even at cheaper models —
  cache-read fraction from the LangWatch pull is the tell (Decision 5 context diets become MORE load-bearing).

## Criteria (░ — open)

Seed candidates:
- Seven role agents appear as subagent types in a fresh session after `genie update` (the original
  acceptance test, still unmet).
- LangWatch shows Fable token share falling toward gate-only (~11% benchmark) within N days of the fix.
- Re-baselined group sequence written back into the umbrella DESIGN (or successor) with per-group status.
