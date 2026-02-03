---
name: genie-blank-init
description: "Initialize a fresh Genie clone with blank persona (first-activation experience). Use when the user wants a clone that will ask who it should be called."
---

# Genie Blank Init (User-Centric First Activation)

## Overview

Create the "first activation" experience: a fresh Genie that asks "Hello, who am I? Who are you?" while preserving machine context (ENVIRONMENT/TOOLS).

This skill provides BOOTSTRAP.md and blank identity/persona/memory stubs.

---

## Quick Install

Run the apply script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/genie-blank-init/scripts/apply-blank-init.sh --dest /path/to/workspace
# add --force to overwrite existing files (backs up first)
```

**What it does (non-destructive by default):**

1. Writes `BOOTSTRAP.md` that:
   - Asks the user what this Genie instance should be called
   - Updates `ROLE.md` / `IDENTITY.md` / `USER.md` accordingly
   - Instructs to delete `BOOTSTRAP.md` as final step

2. Resets `MEMORY.md` and `memory/` (creates fresh if missing)

3. Writes a neutral `ROLE.md` (user-centric)

4. **Leaves `ENVIRONMENT.md` and `TOOLS.md` alone** (keeps OS competence)

---

## Expected Outcome

After applying and restarting the agent in that workspace:

1. Agent behaves like first-time install
2. Asks for instance title/name
3. Once setup confirmed, BOOTSTRAP.md is removed
4. Clone stays user-centric (no inherited mission)

---

## When to Use

Use this skill when:
- User wants a clone with blank persona
- User wants first-activation experience
- Creating a new instance that should ask for its identity
- Separating a clone from inherited mission/role

---

## Pairs With

- `genie-base` - For full workspace setup
- Existing `ENVIRONMENT.md` / `TOOLS.md` - For OS competence

---

## Never Do

- Apply without user confirmation
- Overwrite ENVIRONMENT.md or TOOLS.md
- Skip the BOOTSTRAP.md flow
- Keep inherited identity/role from source workspace
