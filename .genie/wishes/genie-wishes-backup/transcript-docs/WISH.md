# Wish: Update skills and docs for provider-agnostic transcript system

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `transcript-docs` |
| **Date** | 2026-03-19 |
| **Related PR** | [#669](https://github.com/automagik-dev/genie/pull/669) |

## Summary

PR #669 introduced a provider-agnostic transcript system with Codex support and expanded the `genie history` CLI with `--last`, `--type`, `--after`, and `--ndjson` options. The skills, agent docs, and CLAUDE.md still reference the old Claude-only history. This wish updates all documentation surfaces to reflect the new capabilities.

## Scope

### IN
- Update `skills/genie/SKILL.md` history examples with new options
- Update `CLAUDE.md` architecture section to document transcript layer
- Update `plugins/genie/agents/pm.md` and `plugins/genie/agents/pm/AGENTS.md` monitoring commands
- Update `plugins/genie/agents/team-lead/HEARTBEAT.md` to mention history catch-up

### OUT
- No code changes — documentation only
- No new skills or rules
- No changes to council/engineer/reviewer/qa agent docs (they don't monitor other agents)
- No changes to the orchestration rule (doesn't reference history currently)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Only update files that already reference `genie history` or `genie read` | Minimal surface area, avoids scope creep into docs that don't need it |
| Show `--ndjson` in PM/team-lead docs specifically | PM and team-lead are the agents that monitor workers — structured output is most useful to them |
| Add transcript layer to CLAUDE.md architecture table | New module (`src/lib/transcript.ts`, `src/lib/codex-logs.ts`) is significant enough to document |

## Success Criteria

- [ ] `skills/genie/SKILL.md` monitoring section includes `--last`, `--type`, `--ndjson` examples
- [ ] `CLAUDE.md` architecture section mentions transcript layer and codex-logs
- [ ] PM agent docs show `genie history <agent> --ndjson | jq` pattern
- [ ] Team-lead HEARTBEAT mentions `genie history` for session catch-up
- [ ] No existing documentation is broken or removed — additions only

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Update all 5 doc files |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review changes against criteria |

## Execution Groups

### Group 1: Update documentation surfaces

**Goal:** Add transcript system documentation to all files that reference `genie history` or `genie read`.

**Deliverables:**

1. **`skills/genie/SKILL.md`** — Expand monitoring section (around line 79):
   ```
   genie history team-lead                    # Compressed session timeline
   genie history team-lead --last 20          # Last 20 transcript entries
   genie history team-lead --type assistant   # Only assistant messages
   genie history team-lead --ndjson | jq '.text'  # Pipe to jq
   ```

2. **`CLAUDE.md`** — Add to architecture section after `src/lib/` line:
   ```
   src/lib/transcript.ts     Provider-agnostic transcript abstraction (Claude + Codex)
   src/lib/codex-logs.ts     Codex JSONL parsing + SQLite discovery
   src/lib/claude-logs.ts    Claude log parsing + transcript adapter
   ```

3. **`plugins/genie/agents/pm.md`** — Add `genie history` to monitoring commands (lines 51 and 117):
   ```
   genie history <agent> --ndjson | jq '.text'   # Structured session review
   ```

4. **`plugins/genie/agents/pm/AGENTS.md`** — Same update as pm.md

5. **`plugins/genie/agents/team-lead/HEARTBEAT.md`** — Add after `genie read <worker> --follow`:
   ```
   genie history <worker> --last 10               # Quick catch-up
   ```

**Acceptance Criteria:**
- [ ] All 5 files updated with accurate command examples
- [ ] No existing content removed
- [ ] Examples use correct CLI flag syntax matching PR #669

**Validation:**
```bash
# Verify all updated files contain new transcript references
grep -El 'ndjson|--last|--type.*assistant|transcript' \
  skills/genie/SKILL.md \
  CLAUDE.md \
  plugins/genie/agents/pm.md \
  plugins/genie/agents/pm/AGENTS.md \
  plugins/genie/agents/team-lead/HEARTBEAT.md
```

**depends-on:** none

---

## QA Criteria

- [ ] All 5 files contain accurate `genie history` examples with new flags
- [ ] `CLAUDE.md` architecture table includes transcript.ts and codex-logs.ts
- [ ] No broken markdown formatting
- [ ] No references to removed or renamed CLI flags

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| PR #669 not yet merged to main | Low | Wish targets dev branch; docs match code on dev |
| pm.md and pm/AGENTS.md may diverge | Low | Update both in same commit |

---

## Files to Create/Modify

```
skills/genie/SKILL.md
CLAUDE.md
plugins/genie/agents/pm.md
plugins/genie/agents/pm/AGENTS.md
plugins/genie/agents/team-lead/HEARTBEAT.md
```
