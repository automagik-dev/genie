# No Backwards Compatibility
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
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

**Validation:**
- Before suggesting new flags, run: `grep -r "flag_name" .`
- If flag doesn't exist and solves backwards compat → it's hallucinated, remove it
