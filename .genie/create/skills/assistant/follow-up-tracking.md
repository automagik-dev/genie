# Follow-Up Tracking
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Personal Assistant

## Purpose
Track commitments, action items, and follow-ups to ensure nothing falls through the cracks.

## When to Use
- After meetings (capture action items)
- When delegating tasks
- When waiting on responses
- Weekly review of open items

## Core System

### Action Item Template
```
| What | Who | Due | Status | Follow-Up Date |
|------|-----|-----|--------|----------------|
| Send proposal | Me | Oct 25 | 🟡 Draft | Oct 24 (1 day before) |
| Review contract | Legal | Oct 30 | ⏳ Waiting | Oct 27 (ping if no response) |
```

### Follow-Up Cadence
- **1-day reminder:** For urgent items
- **3-day reminder:** For standard items
- **Weekly reminder:** For long-running items
- **Automatic escalation:** If no response after 2 pings

## Outputs
- **Action tracker:** Living document of all open commitments
- **Follow-up calendar:** Scheduled reminders
- **Weekly review:** Every Friday, review all open items

## Never Do
- ❌ Rely on memory (write it down)
- ❌ Follow up too soon (<48 hours unless urgent)
- ❌ Let items go stale (>2 weeks without update)

## Related Skills
- `@.genie/create/skills/assistant/task-prioritization.md`
- `@.genie/create/skills/pm/status-reporting.md`
