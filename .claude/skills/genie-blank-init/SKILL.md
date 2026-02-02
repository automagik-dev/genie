---
name: genie-blank-init
description: "Initialize a fresh, user-centric Genie clone with a blank persona (first-activation experience) while keeping OS/environment competence. Use when the user wants a clone that will ask who it should be called, run BOOTSTRAP.md once, then delete BOOTSTRAP.md after verifying install. Pairs with genie-base or existing ENVIRONMENT/TOOLS." 
---

# Genie Blank Init (User-Centric First Activation)

Goal: create the *first activation* experience ("Hello, who am I? who are you?") while **preserving machine context** (ENVIRONMENT/TOOLS) and **not inheriting Khal identity/role/memory**.

This skill provides a BOOTSTRAP.md and blank identity/persona/memory stubs.

## Install / apply to a workspace

Run:

```bash
bash {baseDir}/scripts/apply-blank-init.sh --dest /path/to/workspace
```

What it does (non-destructive by default):
- Writes `BOOTSTRAP.md` that:
  - asks the user what this Genie instance should be called (instance title)
  - updates `ROLE.md` / `IDENTITY.md` / `USER.md` accordingly
  - instructs to delete `BOOTSTRAP.md` as the final step
- Resets `MEMORY.md` and `memory/` (creates fresh if missing)
- Writes a neutral `ROLE.md` (user-centric)
- Leaves `ENVIRONMENT.md` and `TOOLS.md` alone (keeps OS competence)

Use `--force` if you want to overwrite existing persona files.

## Expected outcome

After applying and restarting the agent in that workspace:
- The agent behaves like a first-time install
- It asks for its instance title/name
- Once set up is confirmed, BOOTSTRAP.md is removed
- The clone stays user-centric (no Khal mission)
