# Wish: Fix first-run experience — AGENTS.md scaffold or fail

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fix-first-run` |
| **Date** | 2026-03-24 |
| **Issues** | #717 |

## Summary

Running `genie` in a folder without AGENTS.md produces a vague warning and continues with unpredictable behavior. Fix: detect missing AGENTS.md, prompt "No agent found. Scaffold one? (Y/n)", copy PM template on Y, exit with clear error on N. This is the prerequisite for the `/wizard` onboarding flow (separate wish).

## Scope

### IN
- Detect missing AGENTS.md in `session.ts` before launching Claude Code
- Interactive Y/n prompt when AGENTS.md is missing
- On Y: scaffold SOUL.md, HEARTBEAT.md, AGENTS.md from PM template into cwd
- On N: exit with error "AGENTS.md required. Run `genie` again to scaffold."
- PM template files stored in `src/templates/` (embedded in build)

### OUT
- `/wizard` skill (separate wish `readme-v4-agent-first`)
- Auto-launching `/wizard` after scaffold (future integration)
- Changes to team-lead or agent spawn flows (only interactive session entry)
- Changes to `genie setup`

## Decisions

| Decision | Rationale |
|----------|-----------|
| Fail hard on N (exit 1) | Prevents confusing half-working state. Clear signal: agents are mandatory. |
| Scaffold from PM template | PM has the most complete structure. User customizes later via brainstorm. |
| Templates embedded in src/ | Accessible at runtime after build. No external downloads needed. |
| Only block interactive session entry | `genie spawn`, `genie team create` etc. operate on existing agents — don't gate those |

## Success Criteria

- [ ] `genie` in folder without AGENTS.md shows "No agent found. Scaffold one? (Y/n)"
- [ ] Choosing Y creates SOUL.md, HEARTBEAT.md, AGENTS.md in cwd
- [ ] Choosing N exits with code 1 and clear error message
- [ ] Created files are valid markdown with placeholder content
- [ ] `genie` after scaffolding launches normally
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add scaffold detection + template files + prompt logic |

## Execution Groups

### Group 1: Scaffold detection and template creation

**Goal:** `genie` in a bare folder either scaffolds agent files or exits clearly.

**Deliverables:**
1. Create template files in `src/templates/`:
   - `src/templates/SOUL.md` — agent identity template with placeholders
   - `src/templates/HEARTBEAT.md` — recurring checklist template
   - `src/templates/AGENTS.md` — team roster template
2. In `src/genie-commands/session.ts`:
   - Before the main session launch (around line 150), check `getAgentsFilePath()`
   - If null: prompt using `@inquirer/prompts` confirm: "No agent found in this directory. Scaffold one?"
   - On confirm: copy templates from `src/templates/` to `process.cwd()`, log success
   - On decline: `process.exit(1)` with message "AGENTS.md required. Run `genie` again to scaffold."
3. Tests:
   - Test scaffold creates all 3 files
   - Test decline exits with code 1

**Acceptance Criteria:**
- [ ] Template files exist in `src/templates/`
- [ ] Missing AGENTS.md triggers interactive prompt
- [ ] Y creates 3 files in cwd
- [ ] N exits with code 1
- [ ] Existing AGENTS.md skips prompt entirely

**Validation:**
```bash
bun run typecheck && bun test src/genie-commands/__tests__/session.test.ts
```

**depends-on:** none

---

## Files to Create/Modify

```
src/templates/SOUL.md              — new template
src/templates/HEARTBEAT.md         — new template
src/templates/AGENTS.md            — new template
src/genie-commands/session.ts      — scaffold detection + prompt
src/genie-commands/__tests__/session.test.ts — new tests
```
