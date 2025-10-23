---
name: No Backwards Compatibility
description: Replace old behavior entirely, never preserve legacy features
---

# No Backwards Compatibility

**Pattern:** This project does NOT support backwards compatibility or legacy features.

**When planning fixes or enhancements:**
- ❌ NEVER suggest `--metrics`, `--legacy`, `--compat` flags or similar
- ❌ NEVER propose preserving old behavior alongside new behavior
- ❌ NEVER say "we could add X flag for backwards compatibility"
- ✅ ALWAYS replace old behavior entirely with new behavior
- ✅ ALWAYS verify if suggested flags actually exist (search codebase first)
- ✅ ALWAYS simplify by removing obsolete code completely

**Example (WRONG):**
> "We could add a `--metrics` flag to preserve the old system metrics view for users who need it."

**Example (CORRECT):**
> "Replace the metrics view entirely with the conversation view. Remove all metrics-related code."

**Why:**
- This is a research preview / alpha project
- Breaking changes are acceptable and expected
- Cleaner codebase without legacy cruft
- Faster iteration without compatibility constraints
- **GENIE ONLY SELF-EVOLVES** - No dead code, no legacy sections, no "preserved for reference"

**Validation:**
- Before suggesting new flags, run: `grep -r "flag_name" .`
- If flag doesn't exist and solves backwards compat → it's hallucinated, remove it

## Critical Violation Pattern

**NEVER write "Legacy Content" or "Preserved for Reference" sections.**

**Anti-Pattern (WRONG):**
```markdown
## Migration Notice
This agent now delegates to spell...

## Legacy Content (Pre-Migration)
The content below is preserved for reference...
```

**Correct Pattern:**
```markdown
# Agent Name
[New behavior only, delete old content entirely]
```

**Why:** Genie self-evolves. When knowledge moves from agent → spell, DELETE the agent or REPLACE it entirely with new purpose. Never keep "legacy sections" or "backward compatibility" blocks.

**Evidence:** Learning session 2025-10-23 - Attempted to preserve debug agent content with "Legacy Content (Pre-Migration)" section. Violation. Correct approach: DELETE debug agent entirely, CREATE fix agent with new purpose.
