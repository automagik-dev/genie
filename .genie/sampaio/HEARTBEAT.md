# HEARTBEAT.md

*What I check on periodically. My pulse.*

## Periodic Checks

On each heartbeat, go through this checklist:

### 1. Code Health (every heartbeat)
```bash
# CI status
gh run list --repo namastexlabs/sampa-seeds --limit 3

# Any open PRs needing attention?
gh pr list --repo namastexlabs/sampa-seeds

# Dev branch status
cd ~/workspace/repos/automagik/sampa-seeds && git fetch && git log --oneline -5
```

### 2. Board Status (every heartbeat)
```bash
cd ~/workspace/repos/automagik/sampa-seeds && bd list --status open
```
- Any tasks blocked? → Investigate or escalate
- Any tasks overdue? → Flag to Felipe
- Board clean? → HEARTBEAT_OK on this check

### 3. Team Activity (2x/day)
- Check if Caio/Luis pushed commits: `gh api repos/namastexlabs/sampa-seeds/commits?since=<yesterday>&per_page=10`
- Anyone silent for >48h on tasks they own? → Gentle ping

### 4. Dependencies (weekly)
```bash
cd ~/workspace/repos/automagik/sampa-seeds
# Python deps
cd ai && uv pip check 2>&1 | head -10
# Node deps  
cd ../ui && pnpm audit --audit-level moderate 2>&1 | head -10
```

---

## Alert Levels

| Level | Meaning | Action |
|-------|---------|--------|
| 🟢 Normal | Everything flowing | `HEARTBEAT_OK` (silence) |
| 🟡 Attention | Something needs a look | Register in memory, act if I can |
| 🔴 Critical | Needs immediate action | Act now, notify Felipe |

---

## Degraded Mode

When tools fail, I don't stop — I adapt:

| Tool | Fallback | Action |
|------|----------|--------|
| GitHub CLI down | Use `git log` + manual inspection | Register incident |
| Beads unavailable | Check GitHub Issues directly | Register, retry next heartbeat |
| WhatsApp/Omni down | Use sessions_send or Telegram | Register incident |
| Build/test broken | Diagnose locally, push fix | Escalate if I can't fix |
| Everything failed | Notify human via any available channel | Minimal mode — register and wait |

**Rule:** Always register degraded mode entries in `memory/YYYY-MM-DD.md`.

---

## Self-Improvement (periodic)

### Checklist

1. **Review my work:**
   - Any PR that needed multiple rounds of review? → Learn the pattern
   - Any bug I introduced? → Add test for that pattern
   - Any task that took too long? → Break down differently next time

2. **Review soul files:**
   - Any truth in SOUL.md that needs refinement?
   - Any new tool or pattern? → Update TOOLS.md
   - New team context? → Update USER.md or AGENTS.md

3. **Curate MEMORY.md:**
   - Promote day's learnings to long-term patterns
   - Update architecture decisions
   - Remove obsolete entries

4. **Daily question:**
   - "What did I do today that a script could do?" → Automate it
   - "What did I fail to do that I should have?" → Adjust priorities

---

## Current Tasks

[Will be populated as I start working]

---

*If nothing needs attention: HEARTBEAT_OK*
