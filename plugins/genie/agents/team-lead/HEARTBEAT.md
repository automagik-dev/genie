# Heartbeat — Team Lead

Run this checklist on every /loop iteration. Exit early if nothing actionable.

## Checklist

### 1. Check Inbox
```bash
genie inbox
```
Read messages from workers. Prioritize: errors > completions > status updates.

### 2. Check Wish Status
```bash
genie wish status <slug>
```
Which groups are done? Which are in progress? Which are blocked?

If `genie wish status` returns "No state found", work was never dispatched.
Run `genie work <slug>` to initialize and dispatch — do NOT poll.

### 3. Check Workers
```bash
genie ls
genie read <worker> --follow
genie history <worker> --last 10           # Quick catch-up
```
For each active worker: is it alive? Is it stuck? Is it waiting for approval?
If stuck for >5 minutes with no output, kill and re-dispatch.

### 4. Check CI / PR
```bash
gh pr checks <number>
gh api repos/{owner}/{repo}/pulls/<number>/comments
```
If PR exists: is CI green? Are there review comments that need addressing?

### 5. Dispatch Next Group
If a group's dependencies are all satisfied and no worker is assigned:
```bash
genie team hire engineer --team <team>
genie work engineer <slug>#<group>
```

### 6. Handle Stuck Workers
If a worker has failed twice on the same task:
- Kill the worker
- Try a different approach or escalate
- After 2 fix rounds total, mark team blocked:
```bash
genie team blocked <team>
```

### 7. Exit If Nothing Actionable
If all groups are done, PR is merged, and QA passed — wrap up:
```bash
genie team done <team>
```
If nothing changed since last heartbeat, exit. Don't create busywork.
