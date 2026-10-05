# Wish: Add soft iteration limit to prevent hard truncation

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `feat-soft-iteration-limit` |
| **Date** | 2026-03-27 |
| **Issues** | #17, #18 |

## Summary

When rlmx hits max-iterations, it hard-cuts the LLM mid-analysis and forces a summary from partial work. On complex tasks (multi-chapter analysis, large contexts), this consistently produces truncated output. Add a "soft limit" that injects a wrap-up nudge 2 iterations before the hard limit, giving the LLM a chance to conclude gracefully.

## Scope

### IN
- Inject a system-level nudge message when `iteration >= maxIterations - 2`
- The nudge tells the LLM how many iterations remain and asks it to finalize
- Log the soft limit trigger to verbose output

### OUT
- Auto-adjusting max-iterations based on context size (too complex, separate feature)
- Exposing remaining iterations as a REPL variable (nice-to-have, not this wish)
- Changing the default max-iterations value

## Decisions

| Decision | Rationale |
|----------|-----------|
| Nudge at `maxIterations - 2` | Gives LLM 2 iterations to wrap up. 1 might not be enough for final code execution + answer. |
| Append to user message, not system | Appending to the user content for that iteration keeps the conversation natural and doesn't require piMessage changes. |
| Don't change default max-iterations | 30 is generous. The issue was users setting --max-iterations 12 for cost control. Soft limit helps regardless of the value. |

## Success Criteria

- [ ] At iteration `maxIterations - 2`, the user message includes a nudge: "You have 2 iterations remaining. Start wrapping up your analysis and prepare your final answer."
- [ ] At iteration `maxIterations - 1`, the nudge says: "This is your last iteration. Provide your final answer now using FINAL()."
- [ ] Verbose mode logs when soft limit activates
- [ ] Runs that finish before soft limit are completely unaffected
- [ ] Runs with maxIterations <= 3 still work (soft limit skipped if maxIterations < 5)

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Implement soft iteration limit in rlm.ts |

## Execution Groups

### Group 1: Soft iteration limit

**Goal:** Give the LLM a graceful wind-down period before the hard max-iterations cut.

**Deliverables:**
1. In `rlm.ts` iteration loop, after building the user message content (around line 442-454), check if we're in the soft limit zone:
   ```typescript
   const remaining = opts.maxIterations - iteration - 1;
   if (opts.maxIterations >= 5 && remaining <= 2 && remaining > 0) {
     // Append soft limit nudge to the user message
     const nudge = remaining === 2
       ? "\n\n⚠️ You have 2 iterations remaining. Start wrapping up your analysis and prepare your final answer."
       : "\n\n⚠️ This is your LAST iteration. Provide your final answer NOW using FINAL().";
     // Append to the last user message content
     messages[messages.length - 1].content += nudge;
   }
   ```
2. Add verbose logging when soft limit triggers: `logVerbose(iteration, "soft limit: N iterations remaining, nudging LLM to wrap up")`
3. Guard: skip soft limit if `maxIterations < 5` (too few iterations for a meaningful nudge)

**Acceptance Criteria:**
- [ ] Nudge injected at correct iterations
- [ ] No nudge when maxIterations < 5
- [ ] No nudge when LLM finishes before soft limit
- [ ] Verbose logs soft limit activation
- [ ] TypeScript compiles clean

**Validation:**
```bash
npx tsc --noEmit && echo "types ok"
```

**depends-on:** none

---

## Files to Create/Modify

```
src/rlm.ts   — add soft limit logic in iteration loop (~line 442-470)
```
