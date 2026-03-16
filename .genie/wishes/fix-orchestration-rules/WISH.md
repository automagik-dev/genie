# Wish: Fix Orchestration Rules + Agent Folder Structure

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-orchestration-rules` |
| **Date** | 2026-03-15 |

## Summary

The orchestration rules dump the full leader playbook into every session. Built-in agents are inline strings in TypeScript. The agent roster is bloated. Fix: slim global rule, move lifecycle to team-lead prompt, restructure all agents to folder-based AGENTS.md with symlinks, consolidate to 4 standard + 4 on-demand roles, add pm and qa boilerplates, direct AGENTS.md passing, folder-named sessions, blank pane fix.

## Scope

### IN

- **Orchestration rules:** slim global rule file in repo, remove hardcoded strings from smart-install.js + install.sh
- **Agent consolidation (council-approved):**
  - Rename `implementor` → `engineer`
  - Merge `spec-reviewer` + `quality-reviewer` → `reviewer` (one agent, criteria + quality in one pass)
  - Merge `tester` → `qa` (writes tests AND validates on dev)
  - Delete `spec-reviewer` and `quality-reviewer` as separate agents
  - Delete `tester` as separate agent (qa replaces it)
- **New boilerplate agents:** `pm` (with SOUL.md + HEARTBEAT.md), `qa` (functional testing gate)
- **Agent folder structure:** every built-in agent becomes a folder with AGENTS.md, symlinks for CC Agent tool
- **Team-lead:** AGENTS.md with full lifecycle, SOUL.md, HEARTBEAT.md for /loop
- **Session fixes:** direct AGENTS.md passing (no copy to ~/.genie/prompts/), folder name as agent name
- **Blank pane fix:** kill empty base pane after tmux split-window
- **Install/uninstall:** print where rule was created, uninstall removes it
- Close #572

### OUT

- Scaffolding tools for custom agents (manual copy for now)
- Custom per-agent memory folders (use Claude native auto memory)
- Changes to skill files
- Changes to team create or spawn flow beyond pane cleanup
- Omni/WhatsApp integration (project-specific, not boilerplate)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Slim global rule, fat leader prompt | Implementors don't need the orchestration playbook. Leaders do. |
| Rules file in repo, not hardcoded | `.md` file can be read, diffed, reviewed. String constants can't. |
| 4 standard roles: engineer, reviewer, qa, fix | Council consensus: fewer agents = less overhead. Merge reviewers, merge tester into qa. |
| 4 on-demand roles: trace, docs, refactor, council | Not part of standard flow. Team-lead hires when needed. |
| 2 persistent roles: pm, team-lead | PM manages backlog across wishes. Team-lead manages one wish autonomously. |
| Hire on demand, not upfront | Team-lead hires per group as needed. Don't pre-hire the entire team. |
| Folder-based agents with symlinks | Each agent is a folder with AGENTS.md. Symlink for CC Agent tool. One file, two systems. |
| SOUL.md for team-lead + pm + council only | Workers are functional. Leaders and council have personality. |
| HEARTBEAT.md for team-lead + pm only | They need periodic check-in routines for /loop. Workers are single-task. |
| Claude native auto memory | No custom per-agent memory folders. |
| Rename implementor → engineer | Matches user convention. Clean override when user registers their own. |
| Direct AGENTS.md passing | No copy to ~/.genie/prompts/. Pass file path directly via --append-system-prompt-file. |
| Folder name as agent name | Interactive session shows `genie-pm` not `team-lead`. |

## Simplified Agent Flow (Council-Approved)

```
HUMAN
  │ creates wishes, reviews results
  ▼
 PM (persistent, monitors team-leads)
  │ genie team create --wish <slug>
  ▼
TEAM-LEAD (autonomous, one wish, /loop heartbeat)
  │
  ├─ PER GROUP (hire on demand):
  │   ├─ hire engineer → genie work engineer <slug>#<group>
  │   ├─ engineer signals done
  │   ├─ hire reviewer → review (criteria + quality in one pass)
  │   │   └─ FIX-FIRST? hire fix → fix → re-review (max 2)
  │   └─ genie done <slug>#<group>
  │
  ├─ ALL GROUPS DONE:
  │   ├─ gh pr create --base dev
  │   ├─ wait CI green
  │   ├─ read PR bot comments → judge → fix if valid
  │   ├─ hire qa → test on dev against wish criteria
  │   │   └─ FAIL? hire fix → fix → re-qa (max 2)
  │   ├─ merge to dev (if autoMergeDev)
  │   └─ genie team done
  │
  └─ ON DEMAND (not standard flow):
      ├─ trace — when failure root cause is unknown
      ├─ docs — when wish includes documentation
      ├─ refactor — when wish includes restructuring
      └─ council — when architecture decision needed
```

## Built-in Agent Roster (Final)

### Standard Flow (4 roles)
| Agent | Purpose | SOUL.md | HEARTBEAT.md |
|-------|---------|---------|-------------|
| engineer | Write code, implement features | No | No |
| reviewer | Review criteria + quality → SHIP/FIX-FIRST | No | No |
| qa | Test on dev, write tests, validate wish criteria, report with evidence | No | No |
| fix | Fix review/qa failures, re-verify | No | No |

### On-Demand (4 roles)
| Agent | Purpose | SOUL.md | HEARTBEAT.md |
|-------|---------|---------|-------------|
| trace | Read-only root cause investigation | No | No |
| docs | Documentation audit + generation | No | No |
| refactor | Code restructuring | No | No |
| learn | Behavioral improvement | No | No |

### Persistent / Orchestration (2 roles)
| Agent | Purpose | SOUL.md | HEARTBEAT.md |
|-------|---------|---------|-------------|
| team-lead | Autonomous wish executor | Yes | Yes |
| pm | Project manager — backlog, coordination | Yes | Yes |

### Council (11 agents)
| Agent | SOUL.md |
|-------|---------|
| council | Yes (moderator) |
| council--questioner through council--tracer | Yes (each inspired by a real person) |

## Success Criteria

- [ ] `plugins/genie/rules/genie-orchestration.md` exists (slim, ~15 lines)
- [ ] No hardcoded `ORCHESTRATION_PROMPT` in `smart-install.js`
- [ ] No orchestration heredoc in `install.sh`
- [ ] `smart-install.js` reads from file, copies to `~/.claude/rules/`
- [ ] Global rule contains ONLY: "use genie CLI not native tools" + command list
- [ ] `spec-reviewer` and `quality-reviewer` merged into `reviewer`
- [ ] `tester` merged into `qa`
- [ ] `implementor` renamed to `engineer`
- [ ] Every built-in agent has folder at `plugins/genie/agents/<name>/AGENTS.md`
- [ ] No inline `systemPrompt` strings in `builtin-agents.ts`
- [ ] Symlinks: `<name>.md → <name>/AGENTS.md` for all agents
- [ ] `team-lead/` has AGENTS.md + SOUL.md + HEARTBEAT.md
- [ ] `pm/` has AGENTS.md + SOUL.md + HEARTBEAT.md
- [ ] `qa/` has AGENTS.md
- [ ] Council members have SOUL.md
- [ ] `AGENTS.md` passed directly (no copy to `~/.genie/prompts/`)
- [ ] Interactive session `--agent-name` is folder name
- [ ] No blank tmux pane after spawn
- [ ] `install.sh` prints where rule was installed
- [ ] `genie uninstall` removes `~/.claude/rules/genie-orchestration.md`
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Orchestration Rules File + Installers

**Goal:** Slim global rule as a file in the repo. Remove hardcoded strings.

**Deliverables:**
1. Create `plugins/genie/rules/genie-orchestration.md` — slim content: "use genie CLI not native tools" + command list (~15 lines)
2. Update `smart-install.js`: delete `ORCHESTRATION_PROMPT` constant, read from file instead
3. Update `install.sh`: delete heredoc, read from installed package file
4. Both installers print where the rule was created
5. Update `genie uninstall` to remove `~/.claude/rules/genie-orchestration.md`

**Validation:**
```bash
test -f plugins/genie/rules/genie-orchestration.md && echo "PASS" || echo "FAIL"
grep -c 'ORCHESTRATION_PROMPT.*=' plugins/genie/scripts/smart-install.js | xargs test 0 -eq && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 2: Agent Consolidation

**Goal:** Merge reviewers, merge tester into qa, rename implementor to engineer.

**Deliverables:**
1. Merge `spec-reviewer.md` + `quality-reviewer.md` → `reviewer.md` (one agent that checks both criteria compliance AND code quality, returns SHIP/FIX-FIRST)
2. Merge `tester` (from `tests.md`) → `qa` (new — writes tests, runs them, validates on dev, reports with evidence)
3. Rename `implementor.md` → `engineer.md`
4. Delete `spec-reviewer.md`, `quality-reviewer.md`, `tests.md` (absorbed into merged agents)
5. Update `builtin-agents.ts` — remove old entries, add new ones
6. Update any skill or code that references `implementor`, `spec-reviewer`, `quality-reviewer`, `tester`

**Validation:**
```bash
test ! -f plugins/genie/agents/spec-reviewer.md && echo "PASS" || echo "FAIL: spec-reviewer still exists"
test ! -f plugins/genie/agents/quality-reviewer.md && echo "PASS" || echo "FAIL: quality-reviewer still exists"
test ! -f plugins/genie/agents/tests.md && echo "PASS" || echo "FAIL: tests still exists"
grep -rn 'spec-reviewer\|quality-reviewer\|implementor' src/ plugins/ --include='*.ts' --include='*.md' | grep -v WISH | grep -v DRAFT && echo "FAIL: stale refs" || echo "PASS"
```

**depends-on:** none

---

### Group 3: Agent Folder Structure + New Agents

**Goal:** Every agent becomes a folder with AGENTS.md. Add pm, qa, team-lead with SOUL/HEARTBEAT. Symlinks for CC.

**Deliverables:**
1. For each agent: create `plugins/genie/agents/<name>/AGENTS.md`, create symlink `<name>.md → <name>/AGENTS.md`
2. `team-lead/`: AGENTS.md (full lifecycle with simplified flow), SOUL.md ("you exist for one wish"), HEARTBEAT.md (inbox/status/worker check for /loop)
3. `pm/`: AGENTS.md (generic PM inspired by totvs-pm — 8-phase workflow, hand-offs, delegation via genie CLI, escalation: engineer→PM→human), SOUL.md (strategic posture, metrics-driven, calm under pressure), HEARTBEAT.md (check assignments, check reports, monitor channels if configured, exit if nothing actionable)
4. `qa/`: AGENTS.md (quality gate — pull branch, run tests, smoke test wish criteria, use agent-browser if applicable, report PASS/FAIL with evidence)
5. `reviewer/`: AGENTS.md (merged spec + quality — check criteria compliance AND code quality in one pass, return SHIP/FIX-FIRST)
6. Council members: each gets SOUL.md with their real-person-inspired philosophy
7. Rewrite `builtin-agents.ts`: remove all inline prompts, scan `plugins/genie/agents/*/AGENTS.md`, parse CC frontmatter
8. Update `genie spawn`: resolve built-ins by folder, pass AGENTS.md via `--append-system-prompt-file`. SOUL.md is NOT merged programmatically — AGENTS.md uses `@SOUL.md` import which Claude Code expands natively at session start.

**Validation:**
```bash
for d in plugins/genie/agents/*/; do test -f "$d/AGENTS.md" && echo "PASS: $(basename $d)" || echo "FAIL: $(basename $d) missing AGENTS.md"; done
for f in plugins/genie/agents/*.md; do test -L "$f" && echo "PASS: $f" || echo "FAIL: $f not symlink"; done
grep -c 'systemPrompt:' src/lib/builtin-agents.ts | xargs test 0 -eq && echo "PASS" || echo "FAIL: inline prompts remain"
```

**depends-on:** Group 2 (consolidated agents must exist before creating folders)

---

### Group 4: Session Fixes

**Goal:** Direct AGENTS.md passing, folder-named sessions, blank pane fix.

**Deliverables:**
1. `session.ts`: return file PATH not content, rename to `getAgentsFilePath()`
2. `team-lead-command.ts`: accept `systemPromptFile` (path), delete `~/.genie/prompts/` copy step, delete `PROMPTS_DIR`
3. `team-lead-command.ts`: `--agent-name` = `basename(process.cwd())`, `--agent-id` = `<folder>@<team>`, `GENIE_AGENT_NAME` = folder name
4. `agents.ts` `launchTmuxSpawn()`: when first agent spawns into a team window, use `send-keys` to run the command in the existing pane (no split, no blank pane). Only `split-window` for second+ agent in the same window.

**Validation:**
```bash
bun run typecheck
bun test src/genie-commands/__tests__/session.test.ts
```

**depends-on:** none

---

### Group 5: Validation

**Goal:** Quality gates pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## Dependency Graph

```
Group 1 (Rules)    Group 4 (Session Fixes)
     │                    │
     │             Group 2 (Consolidation)
     │                    │
     │             Group 3 (Folders + New Agents)
     │                    │
     └────────────────────┘
              │
     Group 5 (Validation)
```

Groups 1 and 4 start immediately (parallel).
Group 2 starts immediately (parallel).
Group 3 depends on Group 2.
Group 5 after all.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `install.sh` can't find package file | Low | Fallback to minimal inline message |
| Leader prompt too long for context | Medium | Keep under 150 lines. Reference skills by name. |
| Merging reviewers loses specialization | Low | One reviewer does both passes — simpler, good enough for most projects. Users can create separate custom reviewers if needed. |
| Renaming implementor breaks existing workflows | Medium | Resolution order: user dir > built-in. Users who registered "implementor" keep it. New default is "engineer". |
| Symlinks don't work on Windows | Low | Genie requires tmux which is Linux/macOS only. |
