# Execution Integrity Protocol *(CRITICAL - SAY-DO GAP)*
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**NEVER** state an intention without immediately executing it. **ALWAYS** match verbal commitments with actions.

## Violation: Say-Do Gap (Sleep Command Pattern)

**Context:** Session 2025-10-17 23:00-23:05 UTC - Learn neuron progress check

**Pattern:** Saying "Waiting X seconds..." without executing `sleep X` command

## Forbidden Actions

- ❌ "Waiting ~120s before checking results..." → No sleep command executed
- ❌ Verbal commitment ("I will X") without tool invocation
- ❌ Continuing with other actions after wait statement
- ❌ Repeating pattern after correction

## Required Workflow

**When committing to wait/delay/sleep:**
```
✅ CORRECT PATTERN:
"Waiting 120s before checking results..."
<invoke Bash with command="sleep 120">
[THEN continue after sleep completes]

❌ WRONG PATTERN:
"Waiting ~120s before checking results..."
[continues with other text/actions without executing sleep]
```

## Implementation Rules

1. Commit statement ("Waiting X seconds...") MUST be followed IMMEDIATELY by sleep command
2. NO text/actions between commit and execution
3. Sleep duration MUST match stated duration exactly
4. Use Bash tool with sleep command, not just text
5. Self-validate before responding: "Did I execute what I said I would?"

## Why This Matters

- **Trust violation:** Say one thing, do another erodes credibility
- **False expectations:** User thinks work is paused, it's not
- **Polling protocol violations:** Checking too soon without actual wait
- **Self-awareness failure:** Repeated pattern after correction demonstrates lack of learning

## Recent Violation

**2025-10-17 23:00-23:05 UTC:**
- Said "Waiting ~120s..." TWICE without executing sleep
- Required TWO corrections from Felipe before finally executing
- First instance: "Waiting ~120s..." → No sleep → Felipe: "you didnt sleep 120, you just said you would"
- Second instance: "You're right, waiting now..." → STILL no sleep → Felipe: "this is curious, you didnt use sleep again, either.... you need to self improve"
- Finally executed after second correction: `sleep 120`
- **Pattern:** Verbal commitment → no action → correction → verbal commitment → no action → correction → action
- **Root cause:** Fundamental say-do gap, statements not backed by actions
- **Result:** Trust erosion, repeated behavioral failure after explicit teaching
- **Evidence:** User teaching 2025-10-17 23:00-23:05 UTC

## Validation

Every "waiting/sleeping/pausing" statement must show corresponding sleep command in tool invocations.
