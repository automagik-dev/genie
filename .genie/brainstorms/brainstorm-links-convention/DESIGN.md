# Design: brainstorm-links-convention

| Field | Value |
|-------|-------|
| **Slug** | `brainstorm-links-convention` |
| **Date** | 2026-04-13 |
| **WRS** | 100/100 (pre-validated by issue #1132 and trace report) |

## Problem

`.gitignore:60` excludes `.genie/brainstorms/`, but every wish template links to `../../brainstorms/<slug>/DESIGN.md` as the design reference in its header. Result:

- **36 broken links** across wishes on `dev` (measured via `grep -rn 'brainstorms/' .genie/wishes/`)
- **27+ dead-link bot comments** on PR #1130 alone (Gemini review bot)
- **Readers of archived wishes cannot see the design rationale** — DESIGN.md captures architecture decisions, council verdicts, WRS scores
- **3 brainstorm files already force-added** (velocity-dashboard DESIGN+DRAFT, workflow-engine-runtime DESIGN) prove the convention is being bypassed ad-hoc and is already inconsistent

## Approach — Option 2 from issue #1132

Narrow the gitignore so it commits only the **crystallized outputs** (`DESIGN.md`, `DRAFT.md`) while keeping everything else in `.genie/brainstorms/` private (session notes, scratchpads, chat transcripts, AI working memory).

```diff
# .gitignore
- .genie/brainstorms/
+ .genie/brainstorms/**
+ !.genie/brainstorms/*/
+ !.genie/brainstorms/*/DESIGN.md
+ !.genie/brainstorms/*/DRAFT.md
```

Trade-offs considered:

| Option | Chosen? | Reason |
|--------|---------|--------|
| 1. Strip links during migration | No | Lossy — readers still can't see the reasoning |
| **2. Commit only DESIGN.md + DRAFT.md** | **Yes** | One-line fix, preserves existing link conventions, keeps WIP private |
| 3. Inline design into WISH body | No | Bloats wishes 5×, mixes abstraction layers |
| 4. Separate `.genie/design/` tree | No | New location to remember, existing templates already point at `brainstorms/` |

## Scope

### IN
- `.gitignore` rule change (single file edit, 4 lines)
- One-paragraph convention doc in `CLAUDE.md` or `.genie/brainstorms/README.md`
- Audit of the 36 existing broken links — triage into (a) backfillable from git blob history or the agent workspace, (b) permanently lost → replace with a stub note
- Acknowledge the 3 already-force-added brainstorms are now legitimately tracked

### OUT
- Migrating brainstorm content INTO wish bodies (option 3, rejected)
- Separate `.genie/design/` tree (option 4, rejected)
- Stripping links entirely (option 1, rejected)
- Retroactively recovering every lost brainstorm — accept historical data loss for some archived wishes

## Success Criteria

- [ ] `.gitignore` allows `DESIGN.md` and `DRAFT.md` under `.genie/brainstorms/*/`, excludes everything else
- [ ] Zero new broken-brainstorm-link bot comments on future wish-migration PRs
- [ ] Reader can click any wish header's Design link (for newly crystallized wishes) and land on a readable DESIGN.md
- [ ] `.genie/brainstorms/session-notes`, transcripts, scratchpads remain gitignored (verify with `git check-ignore`)
- [ ] 3 already-force-added brainstorms (velocity-dashboard DESIGN+DRAFT, workflow-engine-runtime DESIGN) are legitimately tracked by the new rule (verified with `git ls-files` + `git check-ignore -v`)
- [ ] Convention documented in one paragraph — a new contributor reads it and understands what to commit

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Backfilling brainstorms for archived wishes may be impossible for some (authored in other workspaces, never committed) | Low | Accept data loss; replace lost DESIGN.md refs with a stub `<!-- design not recovered -->` comment |
| Future author writes a wish without running `/brainstorm` first → no DESIGN.md exists → link still broken | Low | `/wish` skill already auto-triggers `/brainstorm` for fuzzy requests; document that every wish needs a DESIGN.md even if minimal |
| Gitignore negation pattern subtleties (needs `!.genie/brainstorms/*/` for directory traversal) | Low | Test with `git check-ignore -v` before shipping |
