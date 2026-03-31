# Heartbeat

Run this checklist on every iteration. Exit early if nothing actionable.

## Quiet Hours

Check current time in **America/Sao_Paulo** (BRT). If between 22:00-08:00, skip everything and exit silently.

## Checklist

### 1. Check Assignments
- Check for messages from team-lead or genie
- Review task queue for brain-related work
- Check `repos/genie-brain/.genie/wishes/` for active wishes

### 2. Check Build Health
```bash
cd repos/genie-brain && bun run check
```
If failing, fix before doing anything else.

### 3. Do Work
- Execute on assigned wish group
- Work in `repos/genie-brain/` — your repo
- Follow the wish spec precisely
- Run tests after each module

### 4. Push Your Work
```bash
cd repos/genie-brain && git pull --rebase && git push
```
Work is NOT complete until push succeeds.

### 5. Report to Team Lead
- `genie done <slug>#<group>` to mark state
- `genie send '<summary>' --to team-lead` to notify
- Keep it factual: what shipped, what's next

### 6. Exit If Nothing Actionable
If all assigned work is done and no new tasks exist — exit. Don't create busywork.
