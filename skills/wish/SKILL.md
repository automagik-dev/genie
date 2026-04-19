---
name: wish
description: "Convert an idea into a structured wish plan with scope, acceptance criteria, and execution groups for /work."
---

# /wish — Plan Before You Build

Convert a validated idea into an executable wish document at `.genie/wishes/<slug>/WISH.md`.

## When to Use
- User describes non-trivial work that needs planning before implementation.
- User wants to scope, decompose, or formalize a feature/change.
- Prior `/brainstorm` output exists and needs to become actionable.

## Shared Worktree

This skill is collaborative and operates on the shared worktree:
- All wish artifacts live in `.genie/wishes/` within the shared worktree
- State group definitions are written to the shared worktree so other agents and skills can read them
- When invoked via dispatch, acknowledges injected context (brainstorm design, file path + extracted section)

## Pre-flight check

Before writing the wish, verify the Design file exists:

```bash
test -f .genie/brainstorms/<slug>/DESIGN.md
```

- **If present:** emit `| **Design** | [DESIGN.md](../../brainstorms/<slug>/DESIGN.md) |` as normal.
- **If absent:** emit `| **Design** | _No brainstorm — direct wish_ |` (no link). This is valid for hotfixes, trivial changes, or cases where the plan is obvious enough that a brainstorm adds no value.

The linter (`scripts/wishes-lint.ts`) treats the literal stub text as valid and skips it. Never emit a bracket-link to a non-existent brainstorm file.

## Flow
1. **Gate check:** if the request is fuzzy (no prior design, unclear scope, vague requirements), auto-trigger `/brainstorm` first. If a brainstorm/design exists, proceed. Otherwise ask: "This needs more clarity. Running `/brainstorm` to refine the idea first."
2. **Align intent:** ask one question at a time until success criteria are clear.
3. **Define scope:** explicit IN and OUT lists. OUT scope cannot be empty.
4. **Decompose into groups:** split into small, loosely coupled execution groups.
5. **Scaffold the wish:** run `genie wish new <slug>` to create `.genie/wishes/<slug>/WISH.md` from `templates/wish-template.md`. Never hand-write the file — the scaffold guarantees the structural skeleton the parser and linter expect.
6. **Fill the scaffold:** replace every `<TODO: …>` marker with real content. Add verification to each group: acceptance criteria + a validation command.
7. **Declare dependencies:** declare `depends-on` between execution groups and cross-wish dependencies.
8. **Handoff:** run `genie wish lint <slug>` first. If the linter reports any error violations (fixable or not), surface them to the user and stop — do **not** hand off to `/review` with a structurally broken wish. Only after lint passes, auto-invoke `/review` (plan review) on the WISH.md. Do not suggest `/work` directly — the review gate must pass first.

## Wish Document Sections

| Section | Required | Notes |
|---------|----------|-------|
| Status / Slug / Date | Yes | Status: DRAFT on creation |
| Summary | Yes | 2-3 sentences: what and why |
| Scope IN / OUT | Yes | OUT cannot be empty |
| Decisions | Yes | Key choices with rationale |
| Success Criteria | Yes | Checkboxes, each testable |
| Execution Strategy | Yes | Wave-based parallel/sequential execution plan |
| Execution Groups | Yes | Goal, deliverables, acceptance criteria, validation command |
| Dependencies | No | `depends-on` / `blocks` using slug or `repo/slug` |
| QA Criteria | No | What must be verified on dev after merge |
| Assumptions / Risks | No | Flag what could invalidate the plan |

## Scaffold

The wish scaffold lives at `templates/wish-template.md` in the genie repo — a single source of truth shared by `genie wish new` and `genie wish lint`.

Run `genie wish new <slug>` to materialize `.genie/wishes/<slug>/WISH.md`. The command substitutes `{{slug}}` and `{{date}}` tokens and leaves every other field as a `<TODO: …>` placeholder for you to fill in.

Never write WISH.md by hand. The scaffold guarantees structural correctness by construction; handwritten wishes regularly fail `genie wish lint`.

## Task Lifecycle Integration (v4)

After writing WISH.md, create corresponding PG tasks so the wish is visible in `genie task list`:

### Step 1: Create parent task
```bash
genie task create "<wish title>" --type software
```

### Step 2: Create child tasks per execution group
```bash
genie task create "<group title>" --parent #<parent-seq>
```

### Step 3: Add dependencies between groups
```bash
genie task dep #<child-seq> --depends-on #<dep-seq>
```

### Summary

| Event | Command |
|-------|---------|
| Wish crystallized | `genie task create "<wish title>" --type software` |
| Per execution group | `genie task create "<group title>" --parent #<parent-seq>` |
| Group has dependency | `genie task dep #<child-seq> --depends-on #<dep-seq>` |

**Graceful degradation:** If PG is unavailable or `genie task` commands fail, warn but do not block the wish flow. The WISH.md file is the source of truth — PG tasks are an optional tracking enhancement. The wish must still be usable by `/work` even if no PG tasks were created.

## Rules
- Never write WISH.md by hand — always `genie wish new <slug>` then edit. The scaffold guarantees structural correctness by construction; handwritten wishes regularly fail `genie wish lint`.
- Always run `genie wish lint <slug>` before handing off to `/review`. If lint reports errors, fix them (or run `--fix` for deterministic violations) before the handoff — never hand a structurally broken wish to `/review`.
- Pre-flight the Design link — never emit a bracket-link to a non-existent brainstorm file. Fall back to the `_No brainstorm — direct wish_` stub text.
- No implementation during `/wish` — planning only.
- No vague tasks ("improve everything"). Every task must be testable.
- Keep tasks bite-sized and independently shippable.
- Declare cross-wish dependencies early with `depends-on` / `blocks`.
- OUT scope must contain at least one concrete exclusion.
- Execution Strategy is mandatory — every wish must define waves, even if sequential (single wave). This forces the planner to think about ordering, parallelism, and dependencies upfront.
