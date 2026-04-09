# Wish: Agent-First README + /wizard Onboarding + Mintlify Docs

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `readme-v4-agent-first` |
| **Date** | 2026-03-24 |
| **Design** | [DESIGN.md](../../brainstorms/readme-v4-agent-first/DESIGN.md) |
| **Supersedes** | `deps-bump-readme-rewrite` |

## Summary

Rewrite README as a ~50-line viral landing page with a single "paste to your agent" CTA. Create a `/wizard` skill for guided onboarding (scaffold → brainstorm → first wish → ship). Build complete Genie v4 documentation on Mintlify (`automagik-dev/docs`) with emulated terminal screenshots, one page per skill, full CLI reference, and v4 architecture docs. Omni gets a placeholder product entry.

## Scope

### IN
- **README.md rewrite** — ~50 lines, agent-first, one paste CTA (`automagik-dev/genie`)
- **`/wizard` skill** — new skill: scaffold → brainstorm identity → first wish → work → review (`automagik-dev/genie`)
- **Bootstrap script update** — install.sh outputs agent instructions to stdout (`automagik-dev/genie`)
- **Mintlify docs site** — complete Genie v4 docs with emulated terminals (`automagik-dev/docs`)
- **Omni placeholder** — blank product entry in docs.json (`automagik-dev/docs`)
- **docs.json configuration** — Automagik branding, multi-product navigation, Genie color scheme

### OUT
- Omni documentation content (placeholder only)
- Video/GIF/demo recording
- Dependency bumps (already done)
- Changes to existing skills (brainstorm, wish, work, review stay as-is)
- Changes to v4 features (pgserve, NATS, scheduler, etc.)
- Scaffold detection in session.ts (covered by `fix-first-run` wish)
- Hosted custom domain setup (Mintlify default subdomain is fine for now)

## Decisions

| Decision | Rationale |
|----------|-----------|
| README ~50 lines, one CTA | Agent-first means no human reads CLI reference. One paste box is the funnel. |
| /wizard is a skill, not hardcoded | Updatable, versionable, same pattern as all other skills |
| One Mintlify site, multi-product | Free tier, one repo, product switcher UI. Scale later without new accounts. |
| Emulated terminal screenshots | Reproducible, version-controlled, always up-to-date. Real screenshots rot. |
| One page per skill | Each skill is complex enough for its own page. Scannable index + deep dives. |
| Separate from fix-first-run | Scaffold detection is a code change (wish `fix-first-run`). This wish does content + docs. |

## Success Criteria

- [ ] README under 60 visible lines (excluding HTML/badges)
- [ ] Single "paste to your agent" CTA with styled code block
- [ ] README links to Mintlify docs (not inline reference)
- [ ] `/wizard` skill exists with valid frontmatter (`name: wizard`)
- [ ] `/wizard` guides through 5 phases (env check → identity → first wish → execute → celebrate)
- [ ] Bootstrap script outputs agent instructions to stdout
- [ ] `docs.json` configured with Genie + Omni products
- [ ] Genie docs: Getting Started (intro, quickstart, install)
- [ ] Genie docs: Core Concepts (wishes, agents, teams, skills)
- [ ] Genie docs: Skills Reference (one page per skill, 14 skills)
- [ ] Genie docs: CLI Reference (all command groups with emulated terminal output)
- [ ] Genie docs: Configuration (setup, config files, worktrees, hooks, tmux)
- [ ] Genie docs: Architecture (pgserve, NATS, scheduler, events, tasks, transcripts, auto-approve)
- [ ] Genie docs: Contributing (dev setup, code style, plugin dev)
- [ ] Omni placeholder product page exists
- [ ] No Mintlify boilerplate remaining ("Mint Starter Kit" etc.)
- [ ] `bun run check` passes (genie repo)

## Execution Strategy

### Wave 1 (parallel — different repos and files)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Mintlify docs.json + navigation + Getting Started + Core Concepts (`docs` repo) |
| 2 | engineer | README.md rewrite ~50 lines (`genie` repo) |

### Wave 2 (parallel — different repos)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | /wizard skill SKILL.md + bootstrap script update (`genie` repo) |
| 4 | engineer | Skills Reference + CLI Reference pages (`docs` repo) |

### Wave 3 (parallel — different repos)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Architecture + Configuration + Contributing pages (`docs` repo) |
| 6 | engineer | Emulated terminal screenshots for key workflows (`docs` repo) |

### Wave 4 (after all)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | reviewer | Review all changes across both repos |

## Execution Groups

### Group 1: Mintlify foundation + Getting Started + Core Concepts

**Goal:** Replace Mintlify boilerplate with Genie v4 docs structure and core content.

**Deliverables:**
1. Rewrite `docs.json`:
   - Name: "Automagik", colors: Genie brand (cyan/purple), logos, socials
   - Multi-product navigation with `products` field: Genie (full), Omni (placeholder)
   - Genie product groups: Getting Started, Core Concepts, Skills Reference, CLI Reference, Configuration, Architecture, Contributing
2. Create `genie/index.mdx` — Introduction (what is Genie, agent-first pitch)
3. Create `genie/quickstart.mdx` — Paste to agent → scaffold → first wish (uses Mintlify Steps component)
4. Create `genie/installation.mdx` — Manual install path, requirements, platforms
5. Create `genie/concepts/wishes.mdx` — The pipeline: brainstorm → wish → work → review → ship
6. Create `genie/concepts/agents.mdx` — SOUL.md, HEARTBEAT.md, AGENTS.md, built-in roles
7. Create `genie/concepts/teams.mdx` — team create, team-lead, worktrees, autonomous execution
8. Create `genie/concepts/skills.mdx` — What skills are, how they work, how to invoke
9. Create `omni/index.mdx` — Placeholder page
10. Delete all Mintlify boilerplate files (essentials/, api-reference/, ai-tools/)

**Acceptance Criteria:**
- [ ] `docs.json` has Genie + Omni products
- [ ] Getting Started pages exist and link correctly
- [ ] Core Concepts pages cover wishes, agents, teams, skills
- [ ] No Mintlify boilerplate files remain
- [ ] Omni placeholder page exists

**Validation:**
```bash
cd /tmp/automagik-docs && grep -r "Mint Starter" . && echo "FAIL: boilerplate remains" || echo "PASS"
```

**depends-on:** none

---

### Group 2: README.md rewrite

**Goal:** Transform README from 290-line v3 reference into ~50-line viral agent-first landing page.

**Deliverables:**
1. Rewrite `README.md` in `automagik-dev/genie`:
   - Keep: hero image, badges, "Wishes in, PRs out" tagline
   - New: "What is Genie?" — 3 sentences
   - New: "Get Started" — single paste-to-agent code block CTA
   - New: "What Happens Next" — 4-step flow
   - New: pipeline visualization
   - Footer: Docs link (Mintlify), Discord, GitHub, tagline
   - Remove: features grid, comparison table, CLI reference, configuration, development section
   - All removed content lives in Mintlify docs now

**Acceptance Criteria:**
- [ ] Under 60 visible lines (excluding HTML/badges)
- [ ] Single paste-to-agent CTA
- [ ] Links to Mintlify docs site
- [ ] No CLI reference in body
- [ ] No v3-specific content

**Validation:**
```bash
wc -l README.md  # Should be under 80 total (including HTML)
grep -c "genie tui\|genie --team\|v3" README.md  # Should be 0
```

**depends-on:** none

---

### Group 3: /wizard skill + bootstrap script

**Goal:** Create guided onboarding skill and update bootstrap to output agent instructions.

**Deliverables:**
1. Create `skills/wizard/SKILL.md`:
   - Frontmatter: `name: wizard`, description, triggers
   - Phase 1: Environment check (genie installed? AGENTS.md present?)
   - Phase 2: Agent identity — delegate to `/brainstorm` with seed context
   - Phase 3: First wish — guide through `/brainstorm` → `/wish`
   - Phase 4: Execute — run `/work` on the wish
   - Phase 5: Celebrate — show next steps
   - Each phase has clear entry/exit criteria
2. Update `install.sh`:
   - After successful install, output agent instruction block to stdout
   - Instructions tell the agent to run `genie` and follow `/wizard`

**Acceptance Criteria:**
- [ ] `skills/wizard/SKILL.md` exists with valid frontmatter
- [ ] Skill references `/brainstorm` for identity shaping
- [ ] Five phases documented with clear flow
- [ ] Bootstrap script outputs agent instructions after install

**Validation:**
```bash
[ -f skills/wizard/SKILL.md ] && grep 'name: wizard' skills/wizard/SKILL.md && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 4: Skills Reference + CLI Reference pages

**Goal:** Complete reference documentation for all 14 skills and all CLI commands.

**Deliverables:**
1. Skills Reference pages (one per skill, generated from SKILL.md frontmatter + description):
   - `genie/skills/brainstorm.mdx`
   - `genie/skills/wish.mdx`
   - `genie/skills/work.mdx`
   - `genie/skills/review.mdx`
   - `genie/skills/wizard.mdx`
   - `genie/skills/council.mdx`
   - `genie/skills/trace.mdx`
   - `genie/skills/fix.mdx`
   - `genie/skills/report.mdx`
   - `genie/skills/refine.mdx`
   - `genie/skills/dream.mdx`
   - `genie/skills/learn.mdx`
   - `genie/skills/docs.mdx`
   - `genie/skills/genie.mdx`
2. CLI Reference pages (one per command group):
   - `genie/cli/session.mdx` — genie, genie --session
   - `genie/cli/team.mdx` — team create/hire/fire/ls/done/disband
   - `genie/cli/dispatch.mdx` — brainstorm/wish/work/review/done/reset/status
   - `genie/cli/agents.mdx` — spawn/kill/stop/ls/history/read/answer
   - `genie/cli/messaging.mdx` — send/broadcast/chat/inbox
   - `genie/cli/directory.mdx` — dir add/rm/ls/edit
   - `genie/cli/infrastructure.mdx` — setup/doctor/update/shortcuts
3. Each CLI page includes emulated terminal examples with expected output

**Acceptance Criteria:**
- [ ] 14 skill pages exist
- [ ] 7 CLI reference pages exist
- [ ] Each CLI page has at least one emulated terminal example
- [ ] Pages link correctly in docs.json navigation

**Validation:**
```bash
ls genie/skills/*.mdx | wc -l  # Should be 14
ls genie/cli/*.mdx | wc -l     # Should be 7
```

**depends-on:** Group 1 (navigation structure must exist)

---

### Group 5: Architecture + Configuration + Contributing pages

**Goal:** Document v4 internals and developer setup.

**Deliverables:**
1. Architecture pages:
   - `genie/architecture/overview.mdx` — how components connect (high-level diagram)
   - `genie/architecture/state.mdx` — wish-state, worker registry, teams, mailbox
   - `genie/architecture/postgres.mdx` — pgserve, migrations, task service
   - `genie/architecture/messaging.mdx` — NATS, protocol router, native teams bridge
   - `genie/architecture/scheduler.mdx` — scheduler daemon, cron, events
   - `genie/architecture/transcripts.mdx` — Claude/Codex log parsing
2. Configuration pages:
   - `genie/config/setup.mdx` — setup wizard walkthrough
   - `genie/config/files.mdx` — config.json, settings.json, env vars
   - `genie/config/worktrees.mdx` — isolation, paths, cleanup
   - `genie/config/hooks.mdx` — git hooks, auto-spawn, identity inject
   - `genie/config/tmux.mdx` — sessions, windows, panes, shortcuts
3. Contributing page:
   - `genie/contributing.mdx` — dev setup, code style, quality gates, plugin development

**Acceptance Criteria:**
- [ ] 6 architecture pages documenting all v4 features
- [ ] 5 configuration pages
- [ ] 1 contributing page
- [ ] No placeholder "coming soon" content — all pages have real content

**Validation:**
```bash
ls genie/architecture/*.mdx | wc -l  # Should be 6
ls genie/config/*.mdx | wc -l        # Should be 5
```

**depends-on:** Group 1 (navigation structure must exist)

---

### Group 6: Emulated terminal screenshots

**Goal:** Add polished terminal UI examples for key workflows.

**Deliverables:**
1. Create emulated terminal blocks using Mintlify `<Frame>` + `<CodeGroup>` components for:
   - Scaffold flow: `genie` → "No agent found" → scaffold → success
   - Wish pipeline: `/brainstorm` → `/wish` → `/work` → `/review`
   - Team creation: `genie team create auth-fix --repo . --wish auth-bug`
   - Agent lifecycle: `genie spawn engineer` → `genie ls` → `genie read engineer`
   - Messaging: `genie send 'task' --to engineer` → `genie inbox`
2. Embed these in the relevant Getting Started and CLI Reference pages
3. Use consistent terminal styling (dark background, Genie brand colors for prompts)

**Acceptance Criteria:**
- [ ] At least 5 emulated terminal blocks across the docs
- [ ] Terminal blocks show realistic output (not placeholder)
- [ ] Consistent styling across all terminal examples
- [ ] Each key workflow has visual representation

**Validation:**
```bash
grep -r "Frame\|CodeGroup\|```bash" genie/ | wc -l  # Should be > 20
```

**depends-on:** Group 4, Group 5 (pages must exist to embed screenshots)

---

### Group 7: Review

**Goal:** Review all changes across both repos for quality and consistency.

**Deliverables:**
1. Verify README is under 60 lines, links to docs
2. Verify /wizard skill has complete 5-phase flow
3. Verify Mintlify docs render correctly (no broken links, no boilerplate)
4. Verify emulated terminals show realistic output
5. Verify all v4 features documented in architecture section
6. Verify no Mintlify boilerplate remaining
7. Cross-check CLI reference against actual `genie --help` output

**Acceptance Criteria:**
- [ ] Both repos pass review
- [ ] No broken internal links
- [ ] No boilerplate content
- [ ] CLI reference matches actual commands

**Validation:**
```bash
bun run check  # genie repo
```

**depends-on:** Groups 1-6

---

## QA Criteria

- [ ] README renders correctly on GitHub with agent-first CTA visible
- [ ] `/wizard` skill loads without errors in Claude Code
- [ ] Mintlify site renders with Genie product and navigation
- [ ] All skill reference pages load
- [ ] All CLI reference pages have terminal examples
- [ ] Architecture pages document pgserve, NATS, scheduler, events, tasks, transcripts
- [ ] `bun run check` passes on genie repo

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Docs volume is large (~35 pages) | Medium | Auto-generate from source where possible. Architecture from CLAUDE.md. |
| Two repos touched simultaneously | Medium | Separate PRs. Docs PR has no CI dependency on genie. |
| Mintlify components may need adjustment | Low | Use standard components only (Frame, CodeGroup, Steps, Cards) |
| /wizard skill complexity | Medium | Each phase is a checkpoint. Skill can exit and resume. |
| Emulated terminal output may diverge from real | Low | Generate from actual genie --help output |

---

## Files to Create/Modify

```
# automagik-dev/genie
README.md                          — rewrite to ~50 lines
skills/wizard/SKILL.md             — new /wizard onboarding skill
install.sh                         — output agent instructions

# automagik-dev/docs (30+ new files)
docs.json                          — Automagik config, multi-product nav
genie/index.mdx                    — Introduction
genie/quickstart.mdx               — Quickstart
genie/installation.mdx             — Installation
genie/concepts/wishes.mdx          — Wishes concept
genie/concepts/agents.mdx          — Agents concept
genie/concepts/teams.mdx           — Teams concept
genie/concepts/skills.mdx          — Skills concept
genie/skills/*.mdx                 — 14 skill reference pages
genie/cli/*.mdx                    — 7 CLI reference pages
genie/architecture/*.mdx           — 6 architecture pages
genie/config/*.mdx                 — 5 configuration pages
genie/contributing.mdx             — Contributing guide
omni/index.mdx                     — Omni placeholder
```
