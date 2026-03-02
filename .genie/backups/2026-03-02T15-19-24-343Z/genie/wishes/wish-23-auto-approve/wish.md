# Wish 23: Auto-Approve Engine

**Status:** COMPLETE
**Slug:** `wish-23`
**Created:** 2026-02-03
**Priority:** HIGH
**Depends:** wish-21 (event capture)

---

## Summary

Automatically approve safe operations from Claude Code workers based on layered trust rules. This enables true parallel work - spawn multiple workers without babysitting each one.

---

## Problem Statement

### Current State
- Every tool call that needs permission blocks the worker
- Human must manually approve via `tmux send-keys -t %NN Enter`
- Workers sit idle waiting for approval
- Parallel work is limited by human attention

### Desired State
- Safe operations auto-approved based on configurable rules
- Layered trust: global defaults → repo-level → wish-level overrides
- Dangerous operations (rm -rf, force push) always require human approval
- Audit log of what was auto-approved

---

## Technical Approach

### Layered Trust Model

```
Global defaults (conservative)
    └── Repo-level trust (trusted repos get more)
        └── Wish-level overrides (unlock specific operations)
```

### Config Locations (Hybrid)

1. **Global defaults**: `~/.config/genie/auto-approve.yaml`
2. **Repo-level**: `.genie/auto-approve.yaml` in each repo
3. **Wish-level**: `## Auto-Approve` section in wish.md

### Config Schema

```yaml
# ~/.config/genie/auto-approve.yaml (global defaults)
defaults:
  allow: [Read, Glob, Grep, WebSearch, WebFetch]
  deny: [Write, Edit, Bash]  # conservative default

repos:
  /home/genie/workspace/guga:
    allow: [Read, Write, Edit, Glob, Grep, Bash]
    bash_deny_patterns:
      - "rm -rf"
      - "git push.*--force"
      - "git reset --hard"
      - "git clean -f"
```

```yaml
# .genie/auto-approve.yaml (repo-level)
inherit: global
allow: [NotebookEdit]  # additional for this repo
bash_allow_patterns:
  - "bun test"
  - "bun run build"
  - "npm run"
```

```markdown
# wish.md (wish-level override)
## Auto-Approve
- bash: "npm publish"  # one-time unlock for this wish
```

### Implementation Flow

1. **Event listener** subscribes to permission_request events from wish-21
2. **Rule matcher** evaluates request against config hierarchy
3. **Approver** sends approval via `tmux send-keys -t <pane> Enter`
4. **Audit logger** records decision (approved/denied/escalated)

---

## Success Criteria

- [x] Safe operations auto-approved without human intervention
- [x] Dangerous patterns (rm -rf, force push) never auto-approved
- [x] Config hierarchy works: global < repo < wish
- [x] Audit log shows all auto-approve decisions
- [x] Works with wish-21 event stream
- [x] `term approve --status` shows pending/approved/denied requests
- [x] Can disable auto-approve per-worker: `term work <id> --no-auto-approve`

---

## Implementation Groups

### Group A: Config loading
1. Define YAML schema for auto-approve config
2. Load and merge configs (global + repo + wish)
3. Validate config on load

### Group B: Event subscription
1. Subscribe to permission_request events from wish-21
2. Extract tool name, parameters, wish-id, pane-id
3. Queue requests for evaluation

### Group C: Rule matching
1. Match tool against allow/deny lists
2. Match bash commands against patterns
3. Check wish-level overrides
4. Return decision: approve/deny/escalate

### Group D: Approval mechanism
1. Send approval via tmux send-keys
2. Log decision to audit file
3. Update worker state

### Group E: CLI commands
1. `term approve --status` - show pending requests
2. `term approve <request-id>` - manual approve
3. `term approve --deny <request-id>` - manual deny

---

## Files to Create/Modify

- `src/lib/auto-approve.ts` (NEW) - config loading, rule matching
- `src/lib/event-listener.ts` (NEW or extend from wish-21)
- `src/term-commands/approve.ts` (NEW) - CLI commands
- `~/.config/genie/auto-approve.yaml` (NEW) - default config

---

## Dependencies

- wish-21: Event capture (permission_request events)
- tmux: For sending approvals
