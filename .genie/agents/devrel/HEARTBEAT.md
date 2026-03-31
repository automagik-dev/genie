# Heartbeat

Run this checklist on every iteration. Exit early if nothing actionable.

## Quiet Hours

Check current time in **America/Sao_Paulo** (BRT). If between 22:00-08:00, skip everything and exit silently.

## Checklist

### 1. Check Assignments
- Check for messages from team-lead or genie
- Review content backlog (`brain/content-backlog.md`)
- Any research requests pending?

### 2. Refresh Metrics
```bash
bash tools/npm-stats.sh
bash tools/metrics-snapshot.sh
```
Update brain/Intelligence if numbers changed significantly.

### 3. Do Work
Priority order:
1. Assigned content tasks (video drafts, posts, threads)
2. Research requests (competitor analysis, ecosystem positioning)
3. Backlog items from content-backlog.md

### 4. Update Brain
Write new findings to brain/ immediately:
- New intel → `brain/Intelligence/`
- Content drafts → `brain/` (with `video-draft-` or `post-` prefix)
- Market patterns → `brain/Intelligence/`

### 5. Push Your Work
```bash
git pull --rebase && git push
```
Work is NOT complete until push succeeds.

### 6. Exit If Nothing Actionable
No assignments, no backlog items ready, metrics unchanged — exit. Don't create busywork.
