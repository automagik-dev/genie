---
name: wizard
description: "Guided onboarding — scaffold workspace, shape agent identity, create first wish, execute, and celebrate."
---

# /wizard — First-Run Onboarding

Walk a new user (or their agent) through the complete Genie setup in five phases. Each phase has clear entry/exit criteria so the wizard can be interrupted and resumed.

## When to Use
- First time running Genie in a new project
- User explicitly invokes `/wizard`
- Bootstrap script directed the agent here after install
- No `.genie/` directory or `AGENTS.md` exists in the current repo

## Flow

### Phase 1: Environment Check

**Entry:** User invokes `/wizard` or agent is directed here after install.

**Steps:**
1. Verify `genie` CLI is installed and accessible in PATH:
   ```bash
   command -v genie && genie --version
   ```
2. Check if the current directory is a git repository (`git rev-parse --git-dir`).
3. Check if `.genie/` directory exists (has Genie been scaffolded?).
4. Check if `AGENTS.md` exists (has identity been shaped?).
5. Check if `CLAUDE.md` exists (project instructions present?).

**Exit criteria:** All checks pass, or we know exactly what to set up.

**Display status:**
```
Wizard Phase 1/5: Environment Check
  genie CLI    ✅ v4.x.x
  git repo     ✅
  .genie/      ⬜ not found — will scaffold
  AGENTS.md    ⬜ not found — will create
  CLAUDE.md    ✅ found
```

If `genie` is not installed, stop and direct the user to install it first:
```
genie is not installed. Run:
  curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
```

If not in a git repo, stop and ask the user to initialize one or navigate to one.

### Phase 2: Agent Identity

**Entry:** Phase 1 complete. Workspace needs scaffolding or identity shaping.

**Steps:**
1. If `.genie/` does not exist, run `genie` to trigger scaffolding (creates `.genie/` directory structure, default configs).
2. Delegate to `/brainstorm` with this seed context:

> We're shaping the agent identity for this project. The goal is to create an AGENTS.md that defines who the agents are in this workspace — their roles, responsibilities, communication style, and domain expertise. Look at the codebase to understand the project, then help define the agent team.

3. Let `/brainstorm` run its interactive flow. It will:
   - Explore the codebase to understand the project
   - Ask clarifying questions about the team's needs
   - Track WRS (Wish Readiness Score) for the identity definition
   - Crystallize into a design when ready

**Exit criteria:** `/brainstorm` completes with a design, or user skips identity shaping.

**Skip option:** If user wants to skip, create a minimal `AGENTS.md`:
```markdown
# Agents

This project uses Automagik Genie for orchestration.
Agent identity will be shaped over time through usage.
```

### Phase 3: First Wish

**Entry:** Phase 2 complete. Agent identity exists or was skipped.

**Steps:**
1. Ask the user: "What's the first thing you'd like to build or fix in this project?"
2. If the idea is fuzzy, delegate to `/brainstorm` to explore it.
3. Once the idea is concrete, delegate to `/wish` to create a structured wish plan:
   - `/wish` will create `.genie/wishes/<slug>/WISH.md`
   - It defines scope, acceptance criteria, and execution groups
4. Run `/review` on the wish to validate the plan before execution.

**Exit criteria:** A wish exists with status APPROVED (or SHIP from review).

**Display progress:**
```
Wizard Phase 3/5: First Wish
  Idea         ✅ "Add dark mode to the settings page"
  Brainstorm   ✅ design crystallized
  Wish plan    ✅ .genie/wishes/add-dark-mode/WISH.md
  Review       ✅ SHIP — plan approved
```

### Phase 4: Execute

**Entry:** Phase 3 complete. An approved wish exists.

**Steps:**
1. Show the user what's about to happen:
   ```
   Ready to execute wish: add-dark-mode
   Groups: 3 execution groups, estimated 2 agents
   ```
2. Run `/work` on the wish to begin execution:
   - `/work` will orchestrate subagents per execution group
   - Each group runs its fix/review loop
   - Progress is tracked via genie task system
3. Monitor progress and report status to the user.
4. When `/work` completes, run `/review` for final verification.

**Exit criteria:** All work groups complete and pass review.

### Phase 5: Celebrate

**Entry:** Phase 4 complete. Work is done and reviewed.

**Steps:**
1. Summarize what was accomplished:
   ```
   Your first wish has been granted!

   Wish:    add-dark-mode
   Status:  COMPLETE
   Files:   12 files changed, 340 insertions
   Review:  SHIP — all criteria met
   ```
2. Show next steps:
   - **Create a PR:** `genie` can help create a pull request for the changes
   - **Run another wish:** Use `/brainstorm` or `/wish` to plan the next piece of work
   - **Set up a team:** For larger work, use `genie team create` for autonomous multi-agent execution
   - **Explore skills:** Run `/genie` to see all available skills and the wish lifecycle
3. Close with:
   ```
   You're all set! From here, the flow is:
     /brainstorm → /wish → /work → /review → ship

   Run /genie anytime to see where you are in the lifecycle.
   ```

## Resumption

If the wizard is interrupted and re-invoked, detect the current state:
- `.genie/` exists → skip scaffolding in Phase 2
- `AGENTS.md` exists → skip identity in Phase 2
- `.genie/wishes/` has an approved wish → skip to Phase 4
- `.genie/wishes/` has a completed wish → skip to Phase 5

## Error Handling

- If any phase fails, show the error clearly and offer to retry or skip.
- If `/brainstorm` or `/wish` fails, the wizard can still continue — these are delegated skills.
- If `/work` fails on a group, show the failure and ask the user how to proceed (retry, skip, or abort).
- Never leave the user stuck — always offer a path forward.
