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
- Execution-group definitions are written into WISH.md (git) so other agents and skills can read them; per-group execution state lives in the zero-daemon state DB via `genie v5 task`
- When spawned as a native-team subagent, the dispatching agent curates the seed context into your prompt (brainstorm design, file path + extracted section) — use it directly

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
5. **Scaffold the wish:** copy the template to materialize `.genie/wishes/<slug>/WISH.md`, then replace the `{{slug}}`/`{{date}}` tokens:
   ```bash
   mkdir -p .genie/wishes/<slug>
   cp templates/wish-template.md .genie/wishes/<slug>/WISH.md
   ```
   Never hand-write the file from scratch — the template guarantees the structural skeleton the parser and linter expect.
6. **Fill the scaffold:** replace every `<TODO: …>` marker (and the `{{slug}}`/`{{date}}` tokens) with real content. Add verification to each group: acceptance criteria + a validation command.
7. **Declare dependencies:** declare `depends-on` between execution groups and cross-wish dependencies in the WISH.md document — the DAG is a planning artifact in git.
8. **Handoff:** run `bun run wishes:lint` first. If the linter reports any error violations (fixable or not), surface them to the user and stop — do **not** hand off to `/review` with a structurally broken wish. Only after lint passes, auto-invoke `/review` (plan review) on the WISH.md. Do not suggest `/work` directly — the review gate must pass first.

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

The wish scaffold lives at `templates/wish-template.md` in the genie repo — the single source of truth for wish structure. It is a plain git document; there is no runtime scaffolder to depend on.

Copy it into place, then substitute the `{{slug}}` and `{{date}}` tokens and fill every `<TODO: …>` placeholder:

```bash
mkdir -p .genie/wishes/<slug>
cp templates/wish-template.md .genie/wishes/<slug>/WISH.md
```

Never write WISH.md from scratch. Copying the template guarantees structural correctness by construction; ad-hoc wishes regularly fail `bun run wishes:lint`.

## Task Lifecycle Integration

After writing WISH.md, create one task per execution group in the zero-daemon state DB so `/work` can claim and complete each group and the board reflects progress. Tasks carry the `--wish <slug>` and `--group <name>` linkage; the dependency DAG stays declared in the WISH.md document (git), not in the task rows.

### Per execution group
```bash
genie v5 task create --title "<group title>" --wish <slug> --group <group-name>
```

### Summary

| Event | Command |
|-------|---------|
| Per execution group | `genie v5 task create --title "<group title>" --wish <slug> --group <group-name>` |
| Inspect what was created | `genie v5 task list --wish <slug>` |

**Graceful degradation:** If `genie v5 task create` fails (no `.genie/genie.db` yet, or the CLI is unavailable), warn but do not block the wish flow. The WISH.md file in git is the source of truth — the task rows are an optional tracking/dispatch enhancement. The wish must still be usable by `/work` even if no tasks were created.

## Rules
- Never write WISH.md from scratch — always `cp templates/wish-template.md` then edit. The template guarantees structural correctness by construction; ad-hoc wishes regularly fail `bun run wishes:lint`.
- Always run `bun run wishes:lint` before handing off to `/review`. If lint reports errors, fix them before the handoff — never hand a structurally broken wish to `/review`.
- Pre-flight the Design link — never emit a bracket-link to a non-existent brainstorm file. Fall back to the `_No brainstorm — direct wish_` stub text.
- No implementation during `/wish` — planning only.
- No vague tasks ("improve everything"). Every task must be testable.
- Keep tasks bite-sized and independently shippable.
- Declare cross-wish dependencies early with `depends-on` / `blocks`.
- OUT scope must contain at least one concrete exclusion.
- Execution Strategy is mandatory — every wish must define waves, even if sequential (single wave). This forces the planner to think about ordering, parallelism, and dependencies upfront.
