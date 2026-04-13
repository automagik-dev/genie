# Wish: Crew Simplification

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `crew-simplification` |
| **Date** | 2025-03-25 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |

## Summary

Kill the 4 persistent crew agent directories (genie-pm, genie-engineer, genie-qa-engineer, genie-devrel) that duplicate the genie product's built-in subagents. Distill their useful knowledge into the repo-level CLAUDE.md and a new DevRel skill. Genie stays a lean orchestrator — no role absorption, no context bleed.

## Scope

### IN
- Distill crew SOUL operational guidance into `repos/genie/CLAUDE.md` (engineering patterns, QA checklist, release discipline)
- Create DevRel skill at `~/.claude/skills/devrel/SKILL.md` with Genie voice, content principles, publishing workflow
- Remove persistent crew directories: `genie-pm/`, `genie-engineer/`, `genie-qa-engineer/`, `genie-devrel/`
- Update workspace `.gitignore` if crew dirs were tracked

### OUT
- No changes to Genie's own SOUL.md or AGENTS.md (stays lean orchestrator)
- No changes to genie product built-in subagents (`repos/genie/plugins/genie/agents/`)
- No changes to genie product skills (`repos/genie/skills/`)
- No new built-in devrel subagent in the product — DevRel is special sauce, not generic
- No changes to `metrics-updater/` or `research/`

## Decisions

| Decision | Rationale |
|----------|-----------|
| DevRel as `~/.claude/skills/devrel/` not product built-in | Special sauce — Genie's own voice promoting itself, not a generic feature for all genie users |
| Crew knowledge → repo CLAUDE.md, not Genie SOUL.md | Prevents context bleed. Engineering/QA/release guidance is project knowledge, not identity |
| Delete crew dirs, don't archive to branch | Git history preserves everything. Dead directories on any branch become confusing |
| Keep repo CLAUDE.md focused on conventions, not persona | Voice/tone from crew SOULs goes into DevRel skill, not CLAUDE.md. CLAUDE.md stays technical |

## Success Criteria

- [ ] No `genie-pm/`, `genie-engineer/`, `genie-qa-engineer/`, `genie-devrel/` directories in workspace
- [ ] `repos/genie/CLAUDE.md` contains distilled engineering patterns + QA discipline + release guidance sections
- [ ] `~/.claude/skills/devrel/SKILL.md` exists and is invocable via `/devrel`
- [ ] DevRel skill contains Genie voice guidelines, content creation principles, publishing workflow
- [ ] Genie's SOUL.md and AGENTS.md are unchanged
- [ ] `/work` pipeline still dispatches product subagents (no regression from workspace changes)

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Enrich repo CLAUDE.md with distilled crew knowledge |
| 2 | engineer | Create DevRel skill at ~/.claude/skills/devrel/ |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Remove crew directories and clean up workspace |
| review | reviewer | Review all changes against criteria |

## Execution Groups

### Group 1: Enrich Repo CLAUDE.md

**Goal:** Add operational guidance from crew SOULs to the project-level CLAUDE.md without bloating it.

**Deliverables:**
1. New `## Engineering Discipline` section — distilled from genie-engineer SOUL (type boundaries first, plugin architecture, APIs before implementations, test alongside not after)
2. New `## QA Discipline` section — distilled from genie-qa-engineer SOUL (watch it fail first, edge cases are the real interface, CLI correctness includes exit codes, plugin contracts are sacred)
3. New `## Release Discipline` section — distilled from genie-pm SOUL (shipping cadence, scope freeze before release, breaking changes need deprecation story, DX friction is a product bug)

**Acceptance Criteria:**
- [ ] Three new sections added to CLAUDE.md
- [ ] Each section is ≤15 lines — operational guidance, not persona prose
- [ ] Existing CLAUDE.md content unchanged
- [ ] No voice/tone/persona content — that goes in DevRel skill

**Validation:**
```bash
# Sections exist and file is valid markdown
grep -q "## Engineering Discipline" repos/genie/CLAUDE.md && \
grep -q "## QA Discipline" repos/genie/CLAUDE.md && \
grep -q "## Release Discipline" repos/genie/CLAUDE.md && \
echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 2: Create DevRel Skill

**Goal:** Create the `/devrel` skill as Genie's special sauce for developer relations content.

**Deliverables:**
1. `~/.claude/skills/devrel/SKILL.md` — skill prompt with:
   - Genie voice and tone (from genie-devrel SOUL: direct, code-first, no marketing fluff)
   - Content creation principles (working tutorials > copy, real use cases, 5-minute threshold)
   - Community posture (collaborators not audience, celebrate wins specifically, friction = product bug)
   - Publishing workflow (changelog, social, Discord, npm — adapted per channel)
   - Project context (npm package, GitHub org, Discord link, tagline)

**Acceptance Criteria:**
- [ ] Skill file exists at `~/.claude/skills/devrel/SKILL.md`
- [ ] Skill is invocable (Claude Code discovers it)
- [ ] Contains Genie's authentic voice — not generic DevRel advice
- [ ] Includes project-specific context (automagik-dev/genie, @automagik/genie, Discord link)

**Validation:**
```bash
test -f ~/.claude/skills/devrel/SKILL.md && \
grep -q "automagik" ~/.claude/skills/devrel/SKILL.md && \
echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 3: Remove Crew Directories

**Goal:** Clean delete of persistent crew agent directories from workspace.

**Deliverables:**
1. Delete `genie-pm/` directory and all contents
2. Delete `genie-engineer/` directory and all contents
3. Delete `genie-qa-engineer/` directory and all contents
4. Delete `genie-devrel/` directory and all contents
5. Update `.gitignore` if needed

**Acceptance Criteria:**
- [ ] No crew directories exist in workspace root
- [ ] Git status shows clean deletions (no untracked remnants)
- [ ] Genie's own files (SOUL.md, AGENTS.md, HEARTBEAT.md) untouched

**Validation:**
```bash
! test -d genie-pm && \
! test -d genie-engineer && \
! test -d genie-qa-engineer && \
! test -d genie-devrel && \
test -f SOUL.md && test -f AGENTS.md && test -f HEARTBEAT.md && \
echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1 (knowledge extracted before deletion)

---

## QA Criteria

- [ ] `/devrel` skill loads correctly when invoked
- [ ] `repos/genie/CLAUDE.md` is valid and existing sections unchanged
- [ ] No dangling symlinks or references to deleted crew directories
- [ ] Genie's SOUL.md, AGENTS.md, HEARTBEAT.md are byte-identical to pre-wish state

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Crew directories have uncommitted work | Low | Check git status before deletion — commit or stash first |
| References to crew agents in other files | Low | Grep workspace for "genie-pm", "genie-engineer" etc. before deleting |
| DevRel skill path not discovered by Claude Code | Low | Verify ~/.claude/skills/ is in the skill discovery path |

---

## Files to Create/Modify

```
MODIFY  repos/genie/CLAUDE.md                     (add 3 discipline sections)
CREATE  ~/.claude/skills/devrel/SKILL.md           (new DevRel skill)
DELETE  genie-pm/                                  (entire directory)
DELETE  genie-engineer/                            (entire directory)
DELETE  genie-qa-engineer/                         (entire directory)
DELETE  genie-devrel/                              (entire directory)
```
