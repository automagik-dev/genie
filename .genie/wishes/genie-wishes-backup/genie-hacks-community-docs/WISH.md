---
title: "Wish: Genie Hacks + Community-Driven Documentation"
date: 2026-03-24
status: SHIPPED
slug: genie-hacks-community-docs
---

# Wish: Genie Hacks + Community-Driven Documentation

## Summary

Add a `/genie-hacks` skill and `genie/hacks.mdx` page to position Genie as a platform, not just a tool. Enable community contributions with automated PR guidance. Surface real-world patterns: provider switching, multi-team coordination, overnight batch execution, custom skills, hook automation, cost optimization.

## Problem

Users discover clever ways to use Genie but have nowhere to share them. Documentation is static (written by us). We're leaving knowledge on the table.

## Solution

1. **`/genie-hacks` skill** — browse existing hacks, search by problem, contribute new ones with automated PR instructions
2. **`genie/hacks.mdx` page** — community-contributed patterns, indexed by category
3. **Contribution flow** — `/genie-hacks contribute` auto-forks docs repo, guides edit, creates correctly-formatted PR
4. **Hack categories** — providers, teams, skills, hooks, performance, cost, integration, debugging

## Scope

### IN
- `/genie-hacks` skill with `list`, `search`, `show`, `contribute`, `help` commands
- `genie/hacks.mdx` with 8 initial hacks (provider switching, team coordination, overnight batch, custom skills, hooks, cost optimization, integration examples, debugging tips)
- Auto-fork + PR generation logic (GitHub CLI wrapper)
- Update `docs.json` to add `genie/hacks` page
- Update skills list (add `/genie-hacks` to documentation)
- Contribution prompt guidance (correct format, categories, linking)

### OUT
- Actual implementation of hacks themselves (e.g., training domain models, Slack integrations) — only documentation
- Real-time hack leaderboard or voting
- Automated PR merging (human review still required)
- Video tutorials or animated GIFs

## Acceptance Criteria

- [ ] `/genie-hacks` skill created with valid frontmatter (`name: genie-hacks`)
- [ ] Skill supports: `list`, `search <keyword>`, `show <hack-id>`, `contribute`, `help <problem>`
- [ ] `genie/hacks.mdx` exists with all 8 initial hacks (provider switching, teams, skills, hooks, cost, integration, debugging, batch)
- [ ] Each hack has: problem statement, solution, code/commands, benefit, when to use
- [ ] `contribute` command successfully:
  - [ ] Prompts user to describe hack
  - [ ] Forks `automagik-dev/docs` via GitHub CLI
  - [ ] Opens editor for `genie/hacks.mdx` editing
  - [ ] Guides correct formatting (problem → solution → code → benefit → when)
  - [ ] Creates PR with message template (title: "hack: <title>", body: auto-generated)
  - [ ] Shows PR URL when done
- [ ] `docs.json` updated with `genie/hacks` page in navigation
- [ ] All hacks are realistic and tested (not aspirational)
- [ ] Hacks page links to Discord for feedback
- [ ] No broken links in docs

## Execution Groups

### Group 1: Core Skill Implementation
**Deliverable:** `/genie-hacks` skill with full CLI
- Create `skills/genie-hacks/SKILL.md` with all 5 commands
- Implement `list` — read hacks from docs, format as table (title | problem | category)
- Implement `search <keyword>` — grep for keyword in hack titles/problems
- Implement `show <hack-id>` — display full hack with formatting
- Implement `help <problem>` — fuzzy match problem to hacks, suggest solutions
- Test all commands with existing hacks from Group 2

**Acceptance:**
- Skill loads without errors
- All commands return clean, readable output
- Skill has clear `name: genie-hacks` frontmatter

---

### Group 2: Documentation + Initial Hacks
**Deliverable:** `genie/hacks.mdx` with 8 hacks
- Write intro section (what is a hack, when to use, how to browse)
- **Provider Switching Hacks:**
  - Hack 1: Codex for speed, Claude for safety
  - Hack 2: BYOA (custom model) for domain expertise
- **Teams & Coordination:**
  - Hack 3: Pipeline parallelization (max speed)
  - Hack 4: Multi-team coordination (org-scale)
- **Skills & Automation:**
  - Hack 5: Overnight batch execution (`/dream`)
  - Hack 6: Custom skill for workflow
- **Hooks & Integration:**
  - Hack 7: Auto-spawn on wish creation
  - Hack 8: Slack integration (NATS hooks)
- Format each: problem → solution → code → benefit → when to use
- Add "Contributing" section at end with format template

**Acceptance:**
- File exists at `/tmp/automagik-docs/genie/hacks.mdx`
- All 8 hacks are realistic (not aspirational)
- Each hack has problem, solution, code example, benefit, when-to-use
- Links are valid (e.g., `/genie/skills/dream` exists)
- No broken markdown syntax

---

### Group 3: Contribution Flow + PR Automation
**Deliverable:** `/genie-hacks contribute` command works end-to-end
- Implement prompt flow:
  - Ask: "What's your hack title?"
  - Ask: "What problem does it solve?"
  - Ask: "How does it work? (show commands/code)"
  - Ask: "What category? (providers|teams|skills|hooks|cost|integration|debugging|other)"
  - Ask: "Benefits? (one line)"
  - Ask: "When to use? (one line)"
- GitHub CLI logic:
  - Check if `gh` is installed and authenticated
  - Fork `automagik-dev/docs` (if not already forked)
  - Clone fork locally (temp directory)
  - Open editor on `genie/hacks.mdx`
  - Append new hack in correct format
  - Commit: `"hack: <title>"`
  - Push to fork, create PR to `automagik-dev/docs`
  - Display PR URL to user
- Error handling:
  - GitHub CLI not authenticated → guide login
  - Docs repo not cloned → clone it
  - Editor fails → show error, let user edit manually
  - PR creation fails → show error, suggest manual steps

**Acceptance:**
- `/genie-hacks contribute` command runs without crashing
- Successfully creates PR to `automagik-dev/docs` with:
  - Title format: `hack: <your hack title>`
  - Body includes hack metadata (category, problem, solution)
  - PR targets correct branch (`dev`)
- Error messages are helpful and actionable
- Works offline-friendly (caches docs repo locally)

---

### Group 4: Documentation Integration
**Deliverable:** Updated docs.json + links + skill listings
- Update `docs.json` to include `genie/hacks` in navigation:
  - Add to `genie/groups`: `{ "group": "Hacks & Tips", "pages": ["genie/hacks"] }`
- Update `genie/index.mdx`:
  - Add card: "Genie Hacks — community patterns, techniques, cost tips"
  - Link to `/genie/hacks`
- Update skills list (wherever skills are listed):
  - Add `/genie-hacks` to skills reference
  - Link to `genie/hacks.mdx`
- Verify all cross-links work

**Acceptance:**
- `docs.json` valid (no schema errors)
- Genie docs site renders without 404s
- `/genie/hacks` page accessible from navbar
- All internal links working

---

## Success Validation

**Commands to run:**

```bash
# Group 1: Test skill
genie skills list | grep genie-hacks
/genie-hacks list
/genie-hacks search provider
/genie-hacks show provider-switching
/genie-hacks help "I want to use codex"

# Group 2: Verify docs
grep -c "^###" genie/hacks.mdx  # Should be 8+
grep "Problem:" genie/hacks.mdx  # All hacks have problem statement

# Group 3: Test contribute flow (dry-run, don't actually submit)
/genie-hacks contribute  # Walk through, verify prompts work

# Group 4: Validate docs
curl https://docs.automagik.dev/genie/hacks  # Should resolve
jq . docs.json | grep -i hacks  # navigation includes hacks
```

## Notes

- All hacks must be **realistic** (verified, not aspirational)
- Contribution flow should be **frictionless** (one command, auto-handles git)
- Hacks page should **encourage participation** (clear format, easy to extend)
- This is **not** a replacement for official docs — complementary

## Related

- README rewrite (agent-first, BYOA positioning)
- Mintlify docs launch
- /wizard onboarding skill

