# Wish: Detect and abort on consecutive empty LLM responses

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-empty-response-guard` |
| **Date** | 2026-03-27 |
| **Issue** | #14 |

## Summary

When the LLM returns 0-char responses (e.g., context exceeds API token limits), rlmx silently loops through all max-iterations with no output, then forces an empty final answer. No error is raised. This wastes API budget and produces invisible failures. Add detection for consecutive empty responses with early abort and a clear error message.

## Scope

### IN
- Track consecutive 0-char LLM responses in the RLM loop
- After 3 consecutive empty responses, abort with a clear error message to stderr
- Warn on each individual empty response (to stderr, respecting verbose flag)
- Exit with non-zero exit code when aborting due to empty responses

### OUT
- Retrying with smaller context (user responsibility)
- Auto-splitting context when too large
- Changes to LLM provider error handling (that's a separate concern)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Threshold of 3 consecutive empties | 1 could be transient; 3 is a clear pattern. Matches issue suggestion. |
| Always warn on empty (not just --verbose) | Silent failure is the core bug — must surface even without --verbose |
| Abort rather than continue | Burning remaining iterations on empty responses wastes budget with no benefit |

## Success Criteria

- [ ] 3 consecutive 0-char LLM responses → rlmx aborts with "3 consecutive empty LLM responses — aborting. Context may exceed API limits." on stderr
- [ ] Each empty response logs a warning: "LLM returned empty response (iter N). Possible context size limit."
- [ ] Exit code is non-zero on abort
- [ ] Normal runs with non-empty responses are unaffected
- [ ] Stats (if --stats) still emit on abort (partial run stats)

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Implement empty response guard in rlm.ts |

## Execution Groups

### Group 1: Empty response guard

**Goal:** Detect consecutive empty LLM responses and abort early with a clear error.

**Deliverables:**
1. Add `consecutiveEmpty` counter in the iteration loop (rlm.ts ~line 249)
2. After `const responseText = response.text;` (line 284), check if `responseText.length === 0`
3. If empty: increment counter, write warning to stderr via `process.stderr.write()`
4. If `consecutiveEmpty >= 3`: break out of loop with a new `emptyAbort` reason
5. If non-empty: reset `consecutiveEmpty = 0`
6. After loop exit, if abort was due to empty responses, write the abort message to stderr and set `budgetHit` to `"empty_responses"`
7. Ensure exit code is non-zero (cli.ts should check result for empty abort)

**Acceptance Criteria:**
- [ ] Counter resets on any non-empty response
- [ ] Warning printed per empty response (stderr)
- [ ] Abort after 3 consecutive empties
- [ ] Stats still emitted on abort
- [ ] No behavior change for normal runs

**Validation:**
```bash
npx tsc --noEmit && echo "types ok"
```

**depends-on:** none

---

## Files to Create/Modify

```
src/rlm.ts          — add empty response tracking + abort logic
src/cli.ts          — handle empty abort exit code (if needed)
```
