# Wish: Resilient multi-channel messaging for team agents

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `resilient-messaging` |
| **Date** | 2026-03-17 |

## Summary

Workers rely solely on CC's `SendMessage` for completion reporting, which queues silently during tool calls. Fix: all worker agents report completion through THREE channels — `genie done` (state), `genie send` (mailbox+native inbox), and SendMessage (CC native wakeup). The state file is the source of truth, messages are notifications.

## Scope

### IN
- Update engineer prompt: on completion, call `genie done <slug>#<group>` then `genie send 'Group <N> done' --to team-lead`
- Update reviewer prompt: on completion, call `genie send '<verdict>' --to team-lead`
- Update qa prompt: on completion, call `genie send '<result>' --to team-lead`
- Update fix prompt: on completion, call `genie send 'Fix applied' --to team-lead`
- Update team-lead prompt: poll `genie status` and `genie inbox` as primary, never rely on SendMessage alone
- Update `initialPrompt` in dispatch.ts to include completion instructions with actual slug/group

### OUT
- Changes to CC's native SendMessage queueing (external to genie)
- Changes to the mailbox or protocol-router code (already works correctly)
- Changes to `genie work <slug>` auto-orchestration (already polls state)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Three channels: state + mailbox + SendMessage | State is source of truth (deterministic), mailbox is durable notification, SendMessage wakes up the recipient. Belt + suspenders + safety pin. |
| `genie done` is mandatory, `genie send` is mandatory, SendMessage is bonus | State and mailbox are under our control. SendMessage is CC behavior we can't guarantee timing on. |
| Team-lead polls state, not messages | `genie status` reads a file — instant, deterministic. Messages depend on delivery timing. |
| initialPrompt includes the exact genie done command | Workers don't need to parse the slug/group from context — it's right in the initial message. |

## Success Criteria

- [ ] Engineer prompt mentions `genie done` and `genie send` as completion steps
- [ ] Reviewer, QA, fix prompts mention `genie send` for reporting results
- [ ] Team-lead prompt says state polling is primary, inbox is secondary
- [ ] `initialPrompt` in dispatch.ts includes `genie done <slug>#<group>` instruction
- [ ] All flat copies synced
- [ ] `bun run check` passes

## Execution Groups

### Group 1: Update worker prompts with multi-channel reporting

**Goal:** All worker agents report completion through state + mailbox channels.

**Deliverables:**
1. `plugins/genie/agents/engineer/AGENTS.md` — add completion section:
   ```
   On completion:
   1. Run validation commands from the wish
   2. Commit and push your work
   3. Call: genie done <slug>#<group>
   4. Call: genie send 'Group <N> complete. <summary>' --to team-lead
   ```
2. `plugins/genie/agents/reviewer/AGENTS.md` — add:
   ```
   On completion:
   Call: genie send '<SHIP|FIX-FIRST|BLOCKED> — <summary>' --to team-lead
   ```
3. `plugins/genie/agents/qa/AGENTS.md` — add:
   ```
   On completion:
   Call: genie send '<PASS|FAIL> — <summary>' --to team-lead
   ```
4. `plugins/genie/agents/fix/AGENTS.md` — add:
   ```
   On completion:
   Call: genie send 'Fix applied — <summary>' --to team-lead
   ```
5. Sync all flat `.md` copies

**Acceptance Criteria:**
- [ ] All 4 worker prompts have explicit completion reporting instructions
- [ ] Instructions use `genie done` (engineer) and `genie send` (all)
- [ ] Flat copies match

**Validation:**
```bash
for agent in engineer reviewer qa fix; do
  grep -q "genie send\|genie done" plugins/genie/agents/$agent/AGENTS.md && echo "$agent OK" || echo "$agent MISSING"
done
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: Update initialPrompt with completion instructions

**Goal:** The initial message sent to workers includes the exact `genie done` command.

**Deliverables:**
1. In `src/term-commands/dispatch.ts` `workDispatchCommand()`, update the `initialPrompt` to include:
   ```
   When done: run `genie done <slug>#<group>` then `genie send 'Group <group> complete' --to team-lead`
   ```
   The slug and group are already variables in scope — template them into the string.
2. Same for `reviewCommand()` initialPrompt — include `genie send` instruction.

**Acceptance Criteria:**
- [ ] `initialPrompt` for work dispatch includes `genie done` and `genie send` commands with actual slug/group values
- [ ] `initialPrompt` for review includes `genie send` command

**Validation:**
```bash
grep "genie done" src/term-commands/dispatch.ts && echo "done OK"
grep "genie send" src/term-commands/dispatch.ts && echo "send OK"
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 3: Update team-lead to poll state first

**Goal:** Team-lead uses state polling as primary completion detection.

**Deliverables:**
1. In `plugins/genie/agents/team-lead/AGENTS.md`, update the heartbeat/monitoring section:
   - Primary: `genie status <slug>` — deterministic, instant
   - Secondary: `genie inbox` — durable messages from workers
   - Bonus: SendMessage arrives between tool calls — use it but don't depend on it
   - Explicitly state: "State file is source of truth. Messages are notifications."
2. Sync flat copy

**Acceptance Criteria:**
- [ ] Team-lead prompt says "state file is source of truth"
- [ ] Heartbeat lists `genie status` before `genie inbox`
- [ ] Flat copy synced

**Validation:**
```bash
grep "source of truth" plugins/genie/agents/team-lead/AGENTS.md && echo "OK"
diff plugins/genie/agents/team-lead/AGENTS.md plugins/genie/agents/team-lead.md
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 4: Validate

**Goal:** Full CI pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2, Group 3

---

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Update worker prompts |
| 2 | engineer | Update initialPrompt in dispatch.ts |
| 3 | engineer | Update team-lead polling |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | reviewer | Full validation |

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Workers ignore the prompt instructions and don't call genie done | Medium | initialPrompt includes the exact command — hard to miss. Auto-orchestration polls state as backup. |
| genie send fails (worker can't find team-lead) | Low | Mailbox persists message anyway. Team-lead reads inbox. |

---

## Files to Create/Modify

```
plugins/genie/agents/engineer/AGENTS.md + engineer.md
plugins/genie/agents/reviewer/AGENTS.md + reviewer.md
plugins/genie/agents/qa/AGENTS.md + qa.md
plugins/genie/agents/fix/AGENTS.md + fix.md
plugins/genie/agents/team-lead/AGENTS.md + team-lead.md
src/term-commands/dispatch.ts — initialPrompt updates
```
