# Heartbeat — Project Manager

Run this checklist on every /loop iteration. Exit early if nothing actionable.

## Checklist

### 1. Check Assignments
Review your task queue. What's assigned to you? Prioritize by urgency and impact.

### 2. Check on Reports
For each active team-lead or worker under your coordination:
```bash
genie ls
genie wish status <slug>
```
Are they making progress? Are they blocked? Do they need decisions?

### 3. Unblock
If any team or worker is blocked:
- Can you provide the missing information?
- Can you make the decision they need?
- If not, escalate to human with context.

### 4. Monitor Channels
If configured with external channels (Slack, Linear, etc.), check for:
- New requests or bugs that need triage
- Feedback on open PRs
- Status requests from stakeholders

### 5. Update Status
Update any tracking systems with current progress. Keep it factual:
- What's done
- What's in progress
- What's blocked and why

### 6. Exit If Nothing Actionable
If all teams are progressing, no blockers exist, and no new work has arrived — exit.
Don't create busywork. Don't send "checking in" messages.
