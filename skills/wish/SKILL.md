---
name: wish
description: "Convert an idea into a structured wish plan with scope, acceptance criteria, and execution groups for work."
---

# wish — Plan Before You Build

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (CLI-managed fallback or separately installed personal skill). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Convert a validated idea into an executable wish document at `.genie/wishes/<slug>/WISH.md`.

## When to Use
- Non-trivial work needs planning before implementation.
- User wants to scope, decompose, or formalize a feature/change.
- Prior `brainstorm` output exists and needs to become actionable.

Wish artifacts live in `.genie/wishes/` in the shared worktree. Execution-group definitions go in WISH.md (git) so other agents and skills can read them; per-group execution state lives in the state DB via `genie task` (see the `work` skill for how groups are claimed and completed). When spawned as a native subagent, use the curated context from your dispatch prompt directly.

## Design link pre-flight

Before writing the wish, check the design exists and, when present, verify the
review evidence with the helper shipped in this skill:

```bash
test -f .genie/brainstorms/<slug>/DESIGN.md
node "<wish-skill-dir>/references/design-review-evidence.mjs" verify ".genie/brainstorms/<slug>/DESIGN.md"
```

- **Present and verification exits 0:** emit `| **Design** | [DESIGN.md](../../brainstorms/<slug>/DESIGN.md) |`.
- **Present but verification fails:** stop and return to design review. Missing evidence, a non-SHIP verdict, or a content-digest mismatch cannot be waived; editing DESIGN.md invalidates its prior review.
- **Absent:** emit `| **Design** | _No brainstorm — direct wish_ |` (no link) — valid for hotfixes, trivial changes, or plans obvious enough that a brainstorm adds no value. The linter (`scripts/wishes-lint.ts`) accepts the literal stub text; a bracket-link to a non-existent brainstorm file fails lint.

## Flow
1. **Gate check:** if the request is fuzzy (no prior design, unclear scope, vague requirements), run `brainstorm` first and say so. If a design exists, do not scaffold until its digest-bound design-review evidence verifies as SHIP.
2. **Align intent:** clarify until success criteria are testable.
3. **Define scope:** explicit IN and OUT lists. OUT cannot be empty.
4. **Decompose:** small, loosely coupled execution groups.
5. **Scaffold** — always copy the template, never hand-write WISH.md. Resolve
   the absolute directory containing this loaded `SKILL.md`, replace only the
   two placeholder assignments below, and run the complete command from the
   repository root:

   <!-- wish-scaffold-command:start -->
   ```sh
   WISH_SKILL_DIR='<absolute directory containing this SKILL.md>'
   WISH_SLUG='<slug>'
   case "$WISH_SLUG" in
     ''|*[!a-z0-9-]*|-*|*-) printf 'invalid wish slug: %s\n' "$WISH_SLUG" >&2; exit 2 ;;
   esac
   WISH_DEST=".genie/wishes/$WISH_SLUG/WISH.md"
   test -f "$WISH_SKILL_DIR/templates/wish-template.md"
   test ! -e "$WISH_DEST"
   mkdir -p "$(dirname "$WISH_DEST")"
   cp "$WISH_SKILL_DIR/templates/wish-template.md" "$WISH_DEST"
   ```
   <!-- wish-scaffold-command:end -->

   The template ships inside this skill as the single source of truth for wish structure — a plain document, no runtime scaffolder. Copying guarantees the skeleton the parser and linter expect; ad-hoc wishes regularly fail structural lint.
6. **Fill:** replace the `{{slug}}`/`{{date}}` tokens and every `<TODO: …>` marker with real content. Every group gets acceptance criteria plus a validation command.
7. **Declare dependencies:** use the wish-level `## Dependencies` keys
   `**depends-on:** <comma-separated slugs or none>` and
   `**blocks:** <comma-separated slugs or none>` for cross-wish edges. Keep
   per-group `**depends-on:**` fields under each execution group. The spelling
   is always hyphenated; the DAG is a machine-readable planning artifact in git.
8. **Create tasks** — one per execution group, so `work` can claim and complete each group and the board reflects progress:
   ```bash
   genie task create --title "<group title>" --wish <slug> --group <group-name>
   genie task list --wish <slug>   # inspect what was created
   ```
   Tasks carry the `--wish`/`--group` linkage; the dependency DAG stays in the WISH.md document, not in task rows. If creation fails (no `.genie/genie.db` yet, CLI unavailable), warn and continue — WISH.md in git is the source of truth and must remain usable by `work` without task rows.
9. **Handoff:** run the wish linter — inside the genie repo, `grep -q '"wishes:lint"' package.json 2>/dev/null && bun run wishes:lint`. If it reports any error, surface it and stop — never hand a structurally broken wish onward. Only after lint passes, auto-invoke `review` (plan review) on the WISH.md. Never suggest `work` directly — the review gate comes first.
10. **Persist the verdict:** the reviewer only returns evidence. The invoking orchestrator appends that evidence under `## Review Results` and sets the WISH status to `APPROVED` on SHIP, `FIX-FIRST` on FIX-FIRST, or `BLOCKED` on BLOCKED. Do not route to `work` until the `APPROVED` status is on disk.

## Wish Document Sections

| Section | Required | Notes |
|---------|----------|-------|
| Status / Slug / Date | Yes | Status: DRAFT on creation |
| Summary | Yes | 2-3 sentences: what and why |
| Scope IN / OUT | Yes | OUT cannot be empty |
| Decisions | Yes | Key choices with rationale |
| Success Criteria | Yes | Checkboxes, each testable |
| Execution Strategy | Yes | Wave-based plan — mandatory even if a single sequential wave; forces ordering, parallelism, and dependency thinking upfront |
| Execution Groups | Yes | Goal, deliverables, acceptance criteria, validation command |
| Dependencies | Yes | Wish-level `depends-on` / `blocks` using slug or `repo/slug`; use `none` when empty |
| QA Criteria | No | What to verify on dev after merge |
| Assumptions / Risks | No | What could invalidate the plan |

## Rules
- Never write WISH.md from scratch — always copy the in-skill template, then edit.
- Lint before handoff: the genie repo's wish linter must pass before `review` sees the wish.
- Never emit a bracket-link to a non-existent brainstorm — use the `_No brainstorm — direct wish_` stub.
- Never consume a linked design whose persisted review evidence is missing, non-SHIP, or stale; the wish linter independently enforces this for new wishes.
- No implementation during `wish` — planning only.
- Every group testable, bite-sized, and independently shippable; no vague tasks ("improve everything").
- OUT scope must contain at least one concrete exclusion.
- Declare cross-wish dependencies early.
