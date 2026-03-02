# Genie-CLI Task List

*Created: 2026-02-04 14:27 GMT-3*
*Status: IN PROGRESS*

---

## Current Session Tasks

### ✅ DONE
- [x] Gather all genie-cli information (context files, skills, agents, repo)
- [x] Check if latest changes are published to main (YES - all wishes 21-25 merged)
- [x] Create consolidated knowledge base (`.genie/GENIE-CLI-KNOWLEDGE-BASE.md`)
- [x] Set up dedicated genie-cli window with split pane (window 5)
- [x] Document Issue 001 (agent splits wrong window)

---

### 🔧 OPEN TASKS

#### Task 1: Verify genie-cli installation is working
- [ ] Run `genie doctor` and check output
- [ ] Test `term workers` command
- [ ] Test `term dashboard` command
- [ ] Test basic workflow: create → work → ship

#### Task 2: Fix discovered QA issues
- [ ] `term tasks` command doesn't exist (should it? or is it `term workers`?)
- [ ] `term panes` command doesn't exist (should it? or use `term pane ls`?)
- [ ] `claudio status` command doesn't exist

#### Task 3: Test new features (wishes 21-25)
- [ ] Test `term events <pane>` (wish-21: event capture)
- [ ] Test worktree enforcement (wish-22)
- [ ] Test `term approve` (wish-23: auto-approve)
- [ ] Test `term dashboard` (wish-24: worker dashboard)
- [ ] Test `term spawn-parallel` (wish-25: parallel spawn)

#### Task 4: Clean up uncommitted changes
- [ ] Check `package.json` and `src/lib/version.ts` changes
- [ ] Decide: commit or revert?

#### Task 5: Sync plugin to Claude Code
- [ ] Run `term sync` to update plugin symlink
- [ ] Verify skills are loaded in Claude Code

---

## Backlog

- wish-18 (backlog): Fix `term spawn` skill prompt handling
- wish-19 (backlog): Compare orchestration approaches (OpenClaw vs term+Claude)
- Document the "don't split user's window" convention

---

## How to Work Together

1. **You (Felipe):** Switch to genie-cli window: `Ctrl+b 5`
2. **Right pane:** Shell for running commands
3. **Left pane:** OpenClaw TUI (agent:guga:genie-cli session)
4. **This session:** Coordination and issue tracking

Let's tackle Task 1 first - verify the installation is working!
