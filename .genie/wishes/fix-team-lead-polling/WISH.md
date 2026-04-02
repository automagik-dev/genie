# Wish: Fix team-lead infinite polling loop

## Summary
The team-lead agent enters an infinite `sleep 30 && genie status` polling loop when `genie status` returns "No state found". It should recognize "no state" = "not started" and dispatch `genie work` instead of polling forever.

## Scope
- `src/term-commands/state.ts` — Make error message actionable
- `plugins/genie/agents/team-lead/AGENTS.md` — Add recovery path for no-state case
- `plugins/genie/agents/team-lead/HEARTBEAT.md` — Handle no-state = dispatch, not poll

## Decisions
- Fix both the CLI output AND the agent prompts (belt and suspenders)
- Keep changes minimal — no new features, just fix the failure mode
- Related issue: #710

## Acceptance Criteria
- [ ] `genie status` for a non-initialized wish prints "Run: genie work <slug>" in the error output
- [ ] AGENTS.md has explicit recovery path for "No state found"
- [ ] HEARTBEAT.md handles "no state" = dispatch work, not poll
- [ ] `bun test` passes
- [ ] No other behavioral changes

## Execution Groups

### Group 1: Fix genie status output and agent prompts
**depends-on:** none

**Deliverables:**

1. **`src/term-commands/state.ts`** — In `statusCommand` (around line 101), when `!state`, change error output:
```typescript
if (!state) {
  console.error(`❌ No state found for wish "${slug}"`);
  console.error('   This means work has not been dispatched yet.');
  console.error(`   Run: genie work ${slug}`);
  process.exit(1);
}
```

2. **`plugins/genie/agents/team-lead/AGENTS.md`** — In the `<constraints>` section, add this line:
```
- If you ran `genie status` and got "No state found", this means work has NOT been dispatched. Go to Phase 2 immediately and run `genie work <slug>`. Do NOT poll or wait.
```

3. **`plugins/genie/agents/team-lead/HEARTBEAT.md`** — In step 2 "Check Wish Status" (after line 17), add:
```
If `genie status` returns "No state found", work was never dispatched.
Run `genie work <slug>` to initialize and dispatch — do NOT poll.
```

**Validation:**
```bash
bun test
```

## Execution Strategy

### Wave 1

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix status output and agent prompts |
