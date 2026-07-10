# Design: /council — Native Workflow Engine (Deliberation + Audit)

| Field | Value |
|-------|-------|
| **Slug** | `council-workflow` |
| **Date** | 2026-07-09 |
| **WRS** | 100/100 |

## Problem

Genie's multi-perspective reasoning is split across two model-driven orchestrators — `skills/council/` (topic deliberation, Agent-tool turn-by-turn) and Felipe's personal `specialist-panel` skill (7-lane repo audit) — which duplicate the same fan-out→synthesize pattern in prompt form: fragile, non-resumable, context-hungry, and (in the panel's case) not shipped with the product at all.

## Scope

### IN
- `council.js` — one native dynamic-workflow script (saved workflow, `meta.name: 'council'`), two modes: `deliberation` (default: `/council <topic>`) and `audit` (`/council audit [focus]`).
- Unified 13-lens library: 7 lane skills (renamed personas, standalone-invocable) + 6 deliberation lens cards at `plugins/genie/references/lenses/`.
- 7 persona skills migrated into `skills/` with domain names — `repo-hygiene`, `architecture`, `code-quality`, `qa`, `perf`, `supply-chain`, `dx-docs` — each body citing "lens inspired by the work of <expert>"; no real person's name as a product identity.
- Distribution: `genie install`/`update` stamps `LENS_ROOT` (absolute installed-plugin path) into the `council.js` template and copies it to `~/.claude/workflows/council.js`; re-stamped on every update.
- Removal of `skills/council/` entirely (SKILL.md, members/routing.md, members/config.md, templates/report.md — all absorbed into the script and lens frontmatter).
- Consumers wired: `/review` gains lens-panel dispatch (multi-lens reviewers by change-type); `/brainstorm` gains a domain-experts step at its Decisions-stuck point that reads lens cards from the library. Both steps are NEW to the repo skills (verified 2026-07-09: neither repo skill mentions lenses/panels today) — the pattern mirrors the global brainstorm skill's lens-subagent step.
- Lints wired into `bun run check`: workflow-script structural lint, lens frontmatter lint, probe-guarded reference lint.
- Docs updates (skills README, plugin docs).

### OUT
- Rewiring other consumers (`/work`, `/fix`, `/pm`) — stays in skill-absorbs G4 follow-ups.
- Codex/Hermes support for the engine — the workflow runtime is Claude Code-only; accepted.
- `genie council` term-command (CLI) — the surface is the saved workflow, not a CLI verb.
- Per-repo `.claude/workflows/` scaffolding via `genie init` — repo-level override is a documented capability, not a deliverable.
- dream/scheduler autonomy, routing-matrix role-agent changes.
- Deleting Felipe's personal `~/.claude/skills/` copies (his local hygiene, outside the repo).

## Approach

`/council` becomes a **saved workflow command**: the model mediates structured `args` (`{mode, topic|focus, membersOverride?}`) at invocation, and the script owns the orchestration. Runtime shape:

```
council.js
  meta { name:'council', phases:[Resolve, Round 1, Round 2, Synthesis, Persist] }
  ROUTING  = keyword→members table   (absorbed from members/routing.md, incl. default trio + --members override)
  LENSES   = lens name → LENS_ROOT-relative path   (LENS_ROOT stamped at install)
  Resolve   : stage-0 agent verifies lens paths, Glob-fallback if stale (self-healing), returns absolute paths
  Round 1   : parallel members/lanes — each agent Reads its lens file; audit lanes get the evidence contract
              (run real commands, findings with severity+evidence, assess-only, return profile updates as data);
              deliberation members get the voice contract (2-4 opinionated paragraphs, positions + assumptions)
  Round 2   : deliberation only — FRESH agents, each fed its own Round-1 position plus the others', returning
              strongest point / challenged point / position change (replaces SendMessage continuation)
  Synthesis : deliberation → consensus, tensions, dissent (preserved verbatim), report per absorbed template;
              audit → cross-lane dedupe, conflict resolution, global re-rank, "not audited" flags
  Persist   : audit only — single writer merges lanes' returned profile updates into .genie/repo-profile.md
  return structured report data; the main loop renders the user-facing report
```

Council invariants preserved in the script: ≥2 members must deliver Round 1 or the run reports failure; silent members recorded as "no response"; advisory-only, no voting; audit stays assess-only with the authority boundary (findings crystallize via `/wish`, never a parallel approval mechanism).

**Alternatives considered:** thin skill launching the Workflow tool via `scriptPath` (rejected by Felipe: keeps an orchestration skill alive; native command is cleaner); two sibling workflows for audit/deliberation (rejected: duplicates the roster→rounds→synthesis pattern); lens-library-only without standalone skills (rejected: loses standalone fix-mode for genie users).

**Distribution constraint (verified 2026-07-09 against the plugins reference):** plugins cannot ship workflows — component fields are skills, commands, agents, hooks, mcpServers, outputStyles, lspServers, experimental.themes/monitors, userConfig, channels, dependencies. Hence the install-time stamp+copy to `~/.claude/workflows/`. Documented precedence (project > personal) makes per-repo overrides possible for free.

## Decisions

| Decision | Rationale |
|----------|-----------|
| One engine, two modes (not audit-only, not two scripts) | Both are the same fan-out→synthesize pattern; one script + mode presets maximizes reuse and honors the skill-absorbs G4 ruling (lens library + preserved /council entry) |
| Personas absorbed as standalone plugin skills | Single source of truth — the workflow reads the same SKILL.md as its lens; fix-mode ("run code-quality and fix") ships to every genie user |
| `/council` is the single entry, audit via `/council audit` | Council is genie lore; keeps the name users know, closes the open G4 naming GAP |
| Consumers (/review, /brainstorm) wired in this wish | Felipe chose delivering the full G4 vision now; both steps are new to the repo skills; sequencing risk handled by waves |
| Lane names, not people names, in the public plugin | Real living experts' names as speaking product personas without consent is a liability; methodology retained, inspiration cited |
| Saved workflow command, no launcher skill | Most native shape; model mediates args; routing lives as data in the script |
| Install-time stamp+copy to `~/.claude/workflows/` | Plugins verifiably cannot ship workflows; smart-install runs with `CLAUDE_PLUGIN_ROOT` so it can stamp `LENS_ROOT` deterministically and re-stamp on update |
| Fresh-agent Socratic Round 2 | Workflows have no SendMessage; feeding each member its own R1 back preserves identity while gaining resumability and parallelism |
| 13 lenses: 7 lanes + 6 deliberation cards | The 4 redundant council lenses (benchmarker, sentinel, ergonomist, architect) map onto perf, supply-chain, dx-docs, architecture; routing table remapped accordingly |
| `skills/council/` deleted whole | Skill-vs-workflow precedence for the same `/council` name is undocumented — do not risk the collision |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| skills-fable5-revamp in flight on the same skill files | HIGH | Wave 1 touches only NEW files (persona skills, council.js, lenses/); council deletion + review/brainstorm edits gated on fable5 MERGED to its base (review-closed insufficient) + rebase onto the post-merge base |
| Stale `LENS_ROOT` stamp (plugin path changes on update; user skips `genie update`) | MEDIUM | Re-stamp wired into the update flow + stage-0 resolver agent with Glob-fallback (self-healing) |
| Cost: audit ≈ 9-10 agents on the session model | MEDIUM | Lane narrowing via `/council audit <focus>`; token visibility in `/workflows`; cost note in docs |
| No mid-run user input — loses the old orchestrator's live supervision | LOW | Schema-validated stage returns; ≥2-members rule enforced in script; failed lanes reported "not audited", never averaged in |
| First run prompts for workflow approval per project | LOW | Documented; "don't ask again" is per-workflow-per-project |
| Workflows need CC ≥ 2.1.154, paid plan, and can be org-disabled (`disableWorkflows`) | LOW | Documented requirement; engine is CC-only by decision — no degraded fallback |

**Assumptions:** the stamp+copy call site is the SessionStart hook (`smart-install.js`, where `CLAUDE_PLUGIN_ROOT` is set — the `genie install`/`update` CLI shell does not have it), placed before the hook's early-exit guards and idempotent via drift-check, so re-stamp happens on the first session after a plugin update; the model reliably mediates `/council <text>` into structured workflow args (documented saved-workflow behavior).

## Execution Groups (seed for /wish)

| Grupo | Entregável | Depende de | Validação |
|-------|-----------|------------|-----------|
| G1 | 7 lane skills (renamed personas, inspiration cited) | none | frontmatter lint + no-real-names grep gate |
| G2 | council.js template (engine, routing data, schemas) + lens cards + stamp/copy in install/update + structural lint | none | ESM parse + banned-API grep + stamp unit test |
| G3 | Cutover: delete skills/council/, purge references | G1, G2, fable5-revamp execution review closed | git grep gates (council orchestrator + specialist-panel = 0 hits) |
| G4 | Consumers: /review lens panels + /brainstorm domain-experts (both steps new to the repo skills) | G3 | probe-guarded reference lint |
| G5 | Lints wired into `bun run check`, docs, live QA (1 deliberation + 1 audit run recorded) | G3, G4 | `bun run check` green + QA evidence files |

## Success Criteria

- [ ] `council.js` structural lint passes: `meta.name === 'council'`, ESM parses, zero `Date.now`/`Math.random`/`new Date()`/`require`/`import`/`fs` occurrences
- [ ] Lens lint passes: every ROUTING member maps to an existing lens file; every lens file has required frontmatter (name, modes, voice)
- [ ] 7 lane skills exist under `skills/` with domain names; grep gate proves no real person's name in any `name:` field; inspiration line present in each body
- [ ] `git grep -il 'specialist-panel'` and old-council references return 0 hits outside `.genie/attic/`, CHANGELOG, and this wish's own artifacts
- [ ] `/review` and `/brainstorm` reference lens-library paths that exist (probe-guarded refs lint, fails on dangling path)
- [ ] `bun run check` green with the new lints wired in
- [ ] Live QA evidence in the wish folder: one real `/council <topic>` deliberation run + one `/council audit` run on the genie repo
