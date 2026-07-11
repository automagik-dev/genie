---
name: brainstorm
description: "Explore ambiguous or early-stage ideas interactively — tracks wish-readiness and crystallizes into a design for wish."
---

# brainstorm — Explore Before Planning

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only for a separately installed personal copy. Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Collaborate on fuzzy ideas until they are concrete enough for `wish`.

## When to Use
- User has an idea but unclear scope or approach
- Requirements are ambiguous and need interactive refinement
- User explicitly invokes `brainstorm`

All artifacts live in `.genie/` within the shared worktree. When spawned as a native subagent, the dispatcher curates seed context (file path + extracted section) into your prompt — use it directly; do not re-read what was already provided.

## Flow
1. **Read context:** scan relevant code, docs, conventions. Check the canonical `.genie/INDEX.md` for an existing entry matching this slug/topic — seed from it if found. If the legacy `.genie/brainstorm.md` exists, migrate it first (see Index).
2. **Init persistence:** create `.genie/brainstorms/<slug>/DRAFT.md` immediately; create `.genie/INDEX.md` if missing (see Index).
3. **Scope-size check:** if the request spans multiple independent subsystems, decompose before refining (see Scope Size).
4. **Refine:** fill WRS dimensions. Ask only what an unfilled dimension needs — when the request or context already settles a dimension, mark it filled and move on; never re-litigate decisions the user already made. Prefer concrete options over open questions.
5. **Show the WRS bar** after every exchange; persist DRAFT.md whenever WRS changes.
6. **Propose approaches:** 2-3 options with trade-offs, applying Design for Isolation. Recommend one and proceed when the choice follows from the request.
7. **Crystallize** when WRS = 100 (see Crystallize).

## WRS — Wish Readiness Score

Five dimensions, 20 points each:

| Dimension | Filled when… |
|-----------|-------------|
| **Problem** | One-sentence problem statement is clear |
| **Scope** | IN and OUT boundaries defined |
| **Decisions** | Key technical/design choices made with rationale |
| **Risks** | Assumptions, constraints, failure modes identified |
| **Criteria** | At least one testable acceptance criterion exists |

```
WRS: ██████░░░░ 60/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ░ | Criteria ░
```

✅ = enough info to write that section of a wish; ░ = still needs discussion. Below 100: keep refining. At 100: auto-crystallize. If **Decisions** won't fill, convene domain experts (see Stuck Decisions).

## Stuck Decisions

If **Decisions** stays unfilled after 2+ exchanges, convene **domain experts**: dispatch 2-3 lens subagents in parallel (native delegation surface), each reading a distinct deliberation card from `references/lenses/` relative to the directory containing this loaded `SKILL.md`. When the tradeoff is technical, also read the matching sibling lane skill (`../<lane>/SKILL.md`, resolved from this skill directory) when present. Present their perspectives to the user, then keep refining. Escalate to the full `council` workflow when the decision deserves a durable deliberation record.

## Scope Size

Multi-subsystem requests waste refinement — assumptions for subsystem A rarely hold for B. Signs: 3+ unrelated modules, infrastructure + application layers together, UI + API + data model with no shared interface, parts that could ship or be staffed independently. When detected: stop refining, tell the user the request spans independent subsystems, decompose into sub-projects (purpose, rough scope, dependencies for each), and start a fresh brainstorm for the first one.

## Design for Isolation

Apply to proposed approaches and the DESIGN.md Approach section:
- Single purpose per unit — describable in one sentence.
- Explicit interfaces and dependencies — contracts, not shared mutable state or hidden coupling.
- Independent testability — each unit understandable without loading the whole system.
- File size is a complexity signal — propose splits before a unit becomes unmanageable.

## Index

The single brainstorm/planning index is `.genie/INDEX.md`; auto-create it if missing with sections:

```markdown
# Plans Index
## Raw
## Simmering
## Ready
## Poured
```

Legacy migration is idempotent: if `.genie/brainstorm.md` exists, merge each
unique entry into the matching section of `.genie/INDEX.md`, verify every
legacy entry is present, then remove the legacy file and stage that deletion if
it was tracked. Never update or retain both indexes after a successful merge.

| Event | Action |
|-------|--------|
| Start | Fuzzy-match slug/topic — use as seed context |
| WRS change | Move entry to the matching section (Raw/Simmering/Ready) |
| Design review SHIP | Keep the entry in Ready and invoke `wish` |
| Wish plan review SHIP | Move entry to Poured and link the existing approved wish |

## Crystallize

At WRS = 100:

1. Write `.genie/brainstorms/<slug>/DESIGN.md` from DRAFT.md using `references/design-template.md` (in this skill dir) — fill every placeholder.
2. **Spec self-review** — fix inline before handing off: no TBD/TODO leftovers (fill or mark explicit OUT), no contradictions between sections, scope fits a single wish (split if not), no requirement readable two different ways.
3. Stage the design, draft, and canonical index:
   ```bash
   git add .genie/brainstorms/<slug>/DESIGN.md .genie/brainstorms/<slug>/DRAFT.md .genie/INDEX.md
   ```
   If migration removed a tracked `.genie/brainstorm.md`, stage that deletion too. The genie repo's wish linter fails any wish whose design link doesn't resolve to a real file — uncommitted brainstorms are missing in CI and sibling worktrees, so never skip the stage.
4. Update `.genie/INDEX.md` — keep the entry under Ready and link the staged DESIGN.md. Do not move it to Poured before a WISH.md exists and its plan review is persisted as `APPROVED`.
5. Create a board pointer; if this fails (no `.genie/genie.db` yet, CLI unavailable), warn and continue — DESIGN.md and `.genie/INDEX.md` in git are the source of truth:
   ```bash
   genie task create --title "<brainstorm title>"
   ```
6. Auto-invoke `review` (design review) on the DESIGN.md. The invoking orchestrator receives the verdict; the reviewer remains read-only.

## Output Options

| Complexity | Output |
|-----------|--------|
| Standard | Write DESIGN.md, auto-invoke `review` (plan review) |
| Small but non-trivial | Write design, ask whether to implement directly |
| Trivial | One-liner in `.genie/INDEX.md` (Raw), no design file |

## Handoff

After `review` returns SHIP on the design:

```
Design reviewed and validated (WRS {score}/100). Proceeding to wish.
```

Invoke `wish` to create and review `.genie/wishes/<slug>/WISH.md`. Only after
the invoking orchestrator has persisted plan SHIP as WISH status `APPROVED`
may it move the `.genie/INDEX.md` entry to Poured and link that existing wish. FIX-FIRST or
BLOCKED leaves the brainstorm in Ready with the current design/wish link.

Note cross-repo or cross-agent dependencies — they become `depends-on`/`blocks` fields in the wish.

## Rules
- YAGNI and simplicity first; propose alternatives before recommending.
- No implementation during brainstorm.
- Persist early and often — never wait until the end.
- Never present an unconfirmed assumption as a settled decision — confirm it or list it under Risks.

## Session close (required)

When spawned as a native subagent, your final message IS the completion signal — the dispatcher is notified when you finish; do not poll or emit a separate contract call. End with exactly one terminal outcome as the last word:

- **done** — WRS hit 100, DESIGN.md written and staged, `review` handed off. Report the DESIGN.md path.
- **blocked** — needs human input or an unblocking signal. State exactly what.
- **failed** — aborted or irrecoverable. State why.

`blocked` / `failed` must include a one-line reason.
