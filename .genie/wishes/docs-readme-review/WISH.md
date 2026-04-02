# Wish: Docs ↔ README Review — Align Public-Facing Content

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `docs-readme-review` |
| **Date** | 2026-03-25 |
| **Repos** | `automagik-dev/genie` (README), `automagik-dev/docs` (Mintlify) |

## Summary

Audit the genie README and Mintlify docs for consistency, accuracy, and completeness against the current codebase (v4.260325.33). Today's session shipped boards, templates, 15+ new CLI commands, full observability, and DX polish — none of this is reflected in docs. The README is 75 lines. The docs have 40+ pages but may reference old APIs. Produce an audit report with specific gaps, then fix both.

## Scope

### IN
1. **Audit README** against current CLI (`genie --help`) — missing commands, outdated examples, missing features (boards, templates, task ID aliasing, observability)
2. **Audit Mintlify docs** against current codebase — outdated command syntax, missing pages (boards, projects, daily-sync), stale architecture descriptions
3. **Cross-reference** — README claims vs docs claims vs actual CLI behavior. Find contradictions.
4. **Fix README** — update to reflect v4 reality: boards, templates, projects, observability, full command list
5. **Fix docs** — update outdated pages, add missing pages for new features
6. **Verify links** — docs.json navigation matches actual files, no broken links

### OUT
- Omni docs (separate wish — only `omni/index.mdx` exists)
- KhalOS docs (doesn't exist yet)
- Marketing copy / landing page
- Video tutorials

## Decisions

| Decision | Rationale |
|----------|-----------|
| **Audit first, fix second** | Need the gap list before touching files. Audit is Group 1, fixes are Groups 2-3. |
| **README stays concise** | README is a landing page, not docs. Quick overview + link to Mintlify. But it must be accurate. |
| **Docs get new pages for boards + projects** | These are shipped features with no docs. Need at minimum: boards concept page, CLI reference updates, project management page. |
| **Two repos, one PR each** | README fix → PR on `automagik-dev/genie`. Docs fix → PR on `automagik-dev/docs`. |

## Success Criteria

- [ ] Audit report lists every gap between README, docs, and current CLI
- [ ] README reflects all v4 features (boards, templates, projects, observability, task aliasing)
- [ ] Every `genie` subcommand in `--help` has a corresponding docs page or section
- [ ] No docs page references removed/renamed commands
- [ ] `docs.json` navigation is complete — no missing pages
- [ ] Both PRs pass CI

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Audit: diff README + docs against `genie --help` output, flag every gap |

### Wave 2 (parallel, after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Fix README in genie repo |
| 3 | engineer | Fix/add Mintlify docs pages in docs repo |

### Wave 3
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review both PRs |

## Execution Groups

### Group 1: Audit
**Goal:** Produce a complete gap analysis between README, docs, and current CLI.

**Deliverables:**
1. Run `genie --help` and every subcommand `--help` — capture full command tree
2. Compare against README — list missing/outdated commands and features
3. Compare against each Mintlify docs page — list stale syntax, missing pages, broken references
4. Cross-reference: find contradictions between README and docs
5. Output: `AUDIT-REPORT.md` with tables: `| Source | Claim | Reality | Action needed |`

**Acceptance Criteria:**
- [ ] Every `genie` subcommand is accounted for
- [ ] Every docs page is checked against current behavior
- [ ] Report clearly states what's missing, what's wrong, what's fine

**Validation:**
```bash
# Verify audit report exists and covers all commands
genie --help | grep -c "  [a-z]"  # count subcommands
grep -c "| " AUDIT-REPORT.md       # verify table rows exist
```

**depends-on:** none

---

### Group 2: Fix README
**Goal:** Update genie README to reflect v4 reality.

**Deliverables:**
1. Update feature list: boards, templates, projects, observability, task lifecycle
2. Update command examples to current syntax
3. Add boards section or mention
4. Update metrics if stale
5. Ensure quickstart works with current install path

**Acceptance Criteria:**
- [ ] Every major v4 feature mentioned
- [ ] All code examples actually work when copy-pasted
- [ ] Links to Mintlify docs are correct

**Validation:**
```bash
# Verify no broken links
grep -oP 'https?://[^\s\)]+' README.md | head -20
```

**depends-on:** Group 1

---

### Group 3: Fix Mintlify Docs
**Goal:** Update and expand docs to match current codebase.

**Deliverables:**
1. Update CLI reference pages with new commands (board, project, events, metrics, sessions)
2. Add new concept page: `genie/concepts/boards.mdx` — boards, templates, columns, gates
3. Add new concept page: `genie/concepts/projects.mdx` — project-scoped task management
4. Update `genie/architecture/postgres.mdx` with new tables (boards, board_templates, agents, agent_templates)
5. Update `docs.json` navigation to include new pages
6. Fix any stale command syntax flagged in the audit

**Acceptance Criteria:**
- [ ] New pages for boards and projects exist
- [ ] CLI reference covers all current subcommands
- [ ] `docs.json` navigation includes all pages
- [ ] No page references removed commands

**Validation:**
```bash
# Verify all pages in docs.json exist as files
cat docs.json | jq -r '.. | .pages? // empty | .[]' | while read p; do test -f "${p}.mdx" || echo "MISSING: $p"; done
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] `genie --help` output matches README feature claims
- [ ] Every CLI reference page in docs matches actual `--help` output
- [ ] No 404s in Mintlify navigation
- [ ] README quickstart actually works on a fresh install

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Docs repo has different branch conventions | Low | Check default branch before PR. Likely `main`. |
| Mintlify build breaks on new pages | Medium | Validate `docs.json` structure matches Mintlify schema. |
| README changes conflict with other PRs | Low | Small, focused changes. Rebase before merge. |

## Files to Create/Modify

```
# genie repo
README.md                              — update features, examples, commands

# docs repo
genie/concepts/boards.mdx              — NEW: boards + templates concept page
genie/concepts/projects.mdx            — NEW: project management
genie/cli/board.mdx                    — NEW: board CLI reference
genie/cli/project.mdx                  — NEW: project CLI reference
genie/architecture/postgres.mdx        — UPDATE: new tables
genie/cli/*.mdx                        — UPDATE: stale command syntax
docs.json                              — UPDATE: add new pages to navigation
```
