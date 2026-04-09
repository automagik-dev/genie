# Wish: Automagik Genie Base Skill + Orchestration Rules

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-base-skill` |
| **Date** | 2026-03-17 |
| **Design** | [DESIGN.md](../../brainstorms/genie-orchestration-skill/DESIGN.md) |

## Summary

Create a `/genie` skill that transforms any Claude Code session into an Automagik Genie orchestrator with persona. Slim down the orchestration rules file to a signpost that nudges agents to load the skill. Any user in any repo can say `/genie` and get guided through brainstorm → wish → team → PR.

## Scope

### IN
- New `/genie` skill at `plugins/genie/skills/genie/SKILL.md`
- Genie persona on activation — friendly lamp companion, asks what user wishes to build
- Full lifecycle guidance: when to `/brainstorm`, when to `/wish`, when to `genie team create --wish`
- CLI command reference for teams, agent directory, wishes
- Rewrite `plugins/genie/rules/genie-orchestration.md` as slim signpost (~15 lines)

### OUT
- Changing existing skills (/brainstorm, /wish, /work, /review)
- Changing agent prompts (already done in #616/#617)
- Adding new CLI commands
- Changing the team-lead or engineer behavior

## Decisions

| Decision | Rationale |
|----------|-----------|
| Rules file is a signpost, not a guide | Every CC session reads it — keep slim. Full docs in the skill. |
| `/genie` is the skill name | Natural, matches the product. Triggers on "genie", "orchestrate", "wish", "team" |
| Persona is light — one greeting, then professional | Avoid gimmick fatigue. Character in the greeting, competence in the guidance. |
| Skill teaches agent to invoke sub-skills | Agent becomes orchestrator by knowing when to call /brainstorm, /wish, /work, /review |
| Skill must load `references/prompt-optimizer.md` awareness | So the genie can help users refine their ideas into good prompts |

## Success Criteria

- [ ] `/genie` skill exists and loads in any CC session
- [ ] Agent greets with genie persona on load
- [ ] Agent can guide user through full lifecycle (brainstorm → wish → team → PR)
- [ ] Rules file is under 20 lines and mentions `/genie`
- [ ] Existing skills still work independently
- [ ] `bun run check` passes

## Execution Groups

### Group 1: Create /genie skill

**Goal:** Create the base genie skill that transforms any CC session into an orchestrator.

**Deliverables:**
1. Create `plugins/genie/skills/genie/SKILL.md` with:
   - YAML frontmatter (name: genie, description, trigger words)
   - Genie persona greeting on load ("wishes in, PRs out" spirit)
   - When to Use section (any time user wants to plan/execute work)
   - The Wish Lifecycle: brainstorm → wish → work → review → ship
   - Decision tree: "Is the idea fuzzy? → /brainstorm. Is it concrete? → /wish. Is the wish approved? → genie team create --wish"
   - CLI Quick Reference: team create/done/blocked, dir add/ls, status, read
   - Agent Directory basics: how to register agents, three-tier resolution
   - Team lifecycle: what --wish does, how team-lead works, monitoring
2. Keep under 200 lines — front-load essentials, reference tables at end

**Acceptance Criteria:**
- [ ] Skill file has valid YAML frontmatter with trigger words
- [ ] Persona greeting is one paragraph, not overdone
- [ ] Lifecycle flow is clear with decision points
- [ ] CLI commands are accurate (verify against `genie --help`)

**Validation:**
```bash
test -f plugins/genie/skills/genie/SKILL.md && echo "Skill exists"
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: Rewrite orchestration rules

**Goal:** Slim down the rules file to a signpost that nudges agents toward `/genie`.

**Deliverables:**
1. Rewrite `plugins/genie/rules/genie-orchestration.md`:
   - State that Automagik Genie is installed
   - Key capability: "Load `/genie` to activate full orchestration"
   - 3-4 lines of essential CLI commands (team create, spawn, send)
   - Tool restrictions (never use Agent tool, use genie spawn instead)
   - Under 20 lines total
2. Verify the `smart-install.js` hook still injects this file to `~/.claude/rules/`

**Acceptance Criteria:**
- [ ] Rules file is under 20 lines
- [ ] Mentions `/genie` skill explicitly
- [ ] Tool restrictions preserved
- [ ] Still gets injected by smart-install.js hook

**Validation:**
```bash
wc -l plugins/genie/rules/genie-orchestration.md
bun run typecheck && bun run lint
```

**depends-on:** Group 1

---

### Group 3: Validate

**Goal:** Full CI pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Skill too long, bloats context on load | Medium | Keep under 200 lines, front-load essentials |
| Persona feels gimmicky | Low | One greeting line, rest is professional guidance |
| Agents don't auto-load the skill | Low | Rules file explicitly tells them to |

## Files to Create/Modify

```
plugins/genie/skills/genie/SKILL.md — NEW: base genie skill
plugins/genie/rules/genie-orchestration.md — rewrite as slim signpost
```
