# Genie Skills

Skill prompt files that drive the plan → build → review lifecycle. Each skill is a `SKILL.md` (plus optional templates/references) invoked by name (`/brainstorm`, `/wish`, `/work`, `/review`, …).

## v5 kept siblings

The v5 "lightweight body" cutover re-plumbs skills onto three primitives — **documents in git**, **operational state via the `genie` CLI** (zero-daemon SQLite), and **dispatch via Claude Code native teams** (the Agent tool). This section is the keep/drop decision for every current skill dir; it is a **list decision, not a set of rewrites** — only the core four are rewritten in this group (v5-foundation Group 3). The rest are ported in their own later groups.

Decision legend:

- **Keep — core (rewritten here):** rewritten free of the v4 runtime in this group.
- **Keep — portable now:** no intrinsic v4-runtime coupling; the only change needed is re-pointing dispatch to the Agent tool and/or state to `genie` — mechanical, no design work.
- **Keep — port deferred:** survives conceptually, but its runtime re-plumbing is scheduled as a later umbrella group (noted).
- **Keep — needs new capability:** the concept survives but depends on a substrate the lightweight body does not yet provide (scheduled/background execution); noted with what it needs.

| Skill | Decision | Rationale |
|-------|----------|-----------|
| `brainstorm` | Keep — core (rewritten here) | Ideation → DESIGN.md. WRS scoring and crystallize are pure methodology; only the tracking-task call moved to `genie task`, artifacts stay in `.genie/`. |
| `wish` | Keep — core (rewritten here) | DESIGN.md → WISH.md with groups + DAG. Scaffold is now a `cp` of `skills/wish/templates/wish-template.md`; per-group tasks via `genie task`; lint via `grep -q '"wishes:lint"' package.json 2>/dev/null && bun run wishes:lint`. |
| `work` | Keep — core (rewritten here) | Wave dispatch + fix loops + validation. Dispatch is now the Agent tool (native team), state via `genie task checkout/done`, completion by notification (no polling). |
| `review` | Keep — core (rewritten here) | SHIP/FIX-FIRST/BLOCKED gate. Verdict is the output (reported, not a task mutation); dispatched as a separate subagent (reviewer ≠ engineer) via the Agent tool. |
| `genie` | Keep — portable now | Natural-language router into the other skills. Routing logic is runtime-agnostic; any command hand-offs re-point to the `genie` namespace during its own port. |
| `wizard` | Keep — portable now | Onboarding flow (scaffold → first wish → execute). No intrinsic PG dependency — its steps map onto git docs + `genie` + native-team dispatch. |
| `learn` | Keep — portable now | Behavioral-correction skill wired to Claude native memory — already runtime-agnostic, no v4 coupling. |
| `refine` | Keep — portable now | Prompt-optimizer transform, pure text in/out. No runtime state; carries over unchanged. |
| `fix` | Keep — portable now | Dispatches a fixer subagent for FIX-FIRST gaps. Dispatch re-points to the Agent tool, but note: it also calls `genie task comment`/`genie task block`, which have no v5 equivalent — its port needs the same drop/reshape decision `review` made (report in output vs mutate task rows), not a pure re-point. |
| `trace` | Keep — portable now | Dispatches a trace subagent to find root cause for `/fix`. Same Agent-tool dispatch port; investigation logic is runtime-agnostic. |
| `council` | Keep — portable now | Ported — no longer a skill dir. `/council` now ships as a native dynamic workflow (`plugins/genie/workflows/council.js`, stamped into `~/.claude/workflows/` at session start): two modes — deliberation + audit — over one lens library (the 7 lane skills + `plugins/genie/references/lenses/`). The native-team dispatch it needed became the workflow engine itself. |
| `docs` | Keep — portable now | Dispatches a docs subagent to audit/generate docs against the codebase. Agent-tool dispatch port; no intrinsic v4 state. |
| `genie-hacks` | Keep — portable now | Browse/search/contribute community hacks — a reference/content skill with no runtime dependency. |
| `report` | Keep — port deferred | Bug-investigation cascade (`/trace` → browser evidence → observability → GitHub issue). The trace and issue-filing paths are portable; the observability pull currently reads v4 OTel/PG event data and must be re-sourced when that data path is ported. |
| `omni` | Keep — port deferred | Wires an agent to an Omni channel. The current command chain is bound to the v4 registry + Omni runner; the concept survives and the runner port is umbrella **Group 5** (global-scope state DB + queue). Its rewrite waits on that group. |
| `pm` | Keep — port deferred | PM playbook (triage/prioritize/assign/track/report). Copilot and pair modes map onto `genie board`/`task` + native-team dispatch and are portable; **autopilot** mode depends on the same background-execution substrate as `dream` (below), so the full port waits on it. |
| `dream` | Keep — needs new capability | Batch-executes SHIP-ready wishes overnight. Depends on **scheduled/background execution** (a resident scheduler or cloud-agent substrate for autonomous, unattended runs) — the zero-daemon lightweight body is on-demand only. Concept survives; blocked until a background-execution capability lands. |

**Coverage:** all 17 current `skills/` dirs are accounted for above (4 core + 9 portable-now + 3 port-deferred + 1 needs-new-capability). No skill is dropped; the split is between "rewritten now," "mechanically portable later," and "waiting on a capability the foundation doesn't yet ship."
