# Wish: Team-lead prompt — minimal, zero-optionality script

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `team-lead-minimal` |
| **Date** | 2026-03-17 |

## Summary

The team-lead prompt is 157 lines with primary/fallback/escape-hatch patterns. The LLM ignores primaries, uses sleep despite "NEVER sleep", checks status before dispatch, manually edits state files, and uses the Agent tool. Fix: replace with a ~30-line deterministic script — five steps, zero alternatives. The LLM follows a recipe, not a guidebook.

## Scope

### IN
- Rewrite team-lead AGENTS.md to ~30 lines
- Five sequential phases, no alternatives, no fallbacks
- Remove: heartbeat section, commands reference, fallback dispatch, escape hatch, monitoring instructions
- Keep: `promptMode: system`, tool_usage section, constraints section

### OUT
- Changes to `genie work <slug>` auto-orchestration code
- Changes to other agent prompts
- Changes to CLI commands

## Decisions

| Decision | Rationale |
|----------|-----------|
| ~30 lines max | 157 lines proved too long — the LLM cherry-picks and improvises. Shorter = more compliant. |
| Zero alternatives | "Primary X, fallback Y" causes the LLM to try Y first. Remove Y entirely. |
| No heartbeat/loop section | The team-lead runs once, not in a loop. `genie work <slug>` handles polling. |
| No commands reference | The 5 commands it needs are in the steps. No reference table to browse. |
| Keep tool_usage and constraints | These are essential context the LLM needs regardless of prompt length. |

## Success Criteria

- [ ] Team-lead AGENTS.md is under 50 lines (excluding frontmatter)
- [ ] Prompt has exactly 5 phases, no alternatives within any phase
- [ ] No mention of: sleep, heartbeat, loop, fallback, escape hatch, manual dispatch
- [ ] Team-lead successfully runs `genie work <slug>` and creates a PR on first attempt
- [ ] `bun run check` passes

## Execution Groups

### Group 1: Rewrite team-lead prompt

**Goal:** Replace the 157-line prompt with a ~30-line deterministic script.

**Deliverables:**
1. Rewrite `plugins/genie/agents/team-lead/AGENTS.md` to this structure:
   ```
   frontmatter (name, promptMode: system)

   <mission> — 2 lines: execute one wish, stop

   <tool_usage> — keep as-is (Bash, Read, Write, Edit, Grep, Glob, SendMessage)

   <process>
   Phase 1: Read WISH.md. Parse slug from initial prompt.
   Phase 2: Run `genie work <slug>`. This handles everything — wave parsing, parallel spawning, state polling, completion. Wait for exit code.
   Phase 3: If exit 0, run `gh pr create --base dev`. If exit 1, run `genie team blocked <team>`.
   Phase 4: Check CI with `gh pr checks <number>`. If red, investigate and push fixes.
   Phase 5: Run `genie team done <team>`.
   </process>

   <constraints> — keep the NEVER rules
   ```
2. Sync flat copy `plugins/genie/agents/team-lead.md`
3. Update any tests that reference team-lead prompt content

**Acceptance Criteria:**
- [ ] AGENTS.md under 50 lines
- [ ] Exactly 5 phases
- [ ] No sleep, heartbeat, loop, fallback, or escape hatch
- [ ] `genie work <slug>` is the ONLY dispatch mechanism mentioned
- [ ] Flat copy matches

**Validation:**
```bash
wc -l plugins/genie/agents/team-lead/AGENTS.md
! grep -i "sleep\|heartbeat\|loop\|fallback\|escape" plugins/genie/agents/team-lead/AGENTS.md && echo "No forbidden words"
diff plugins/genie/agents/team-lead/AGENTS.md plugins/genie/agents/team-lead.md
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 2: Validate

**Goal:** Full CI pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1

---

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Rewrite team-lead prompt |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | reviewer | Full validation |

---

## Files to Create/Modify

```
plugins/genie/agents/team-lead/AGENTS.md — radical simplification
plugins/genie/agents/team-lead.md — sync flat copy
```
