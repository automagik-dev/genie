# Meta-Learn: Amendment #4 Violation - Over-Documenting Automation

**Date:** 2025-10-23 06:46 UTC
**Context:** Implementing timestamp automation for .genie markdown files
**Violation:** Created Amendment #8 to document the automation

## What Happened

1. ✅ Implemented automation correctly (pre-commit hook + script)
2. ❌ Created 60+ line Amendment #8 documenting the automation
3. ❌ Listed "What Genie Must NOT Do" and "What Happens Automatically"
4. ❌ Violated Amendment #4: "When features become automatic, remove instructions—don't document the automation"

## The Learning

**Amendment #4 explicitly states:**
> "NOT documenting automation - absence of instructions IS the documentation"
> "Best documentation for automatic features = no documentation"

**What I did:**
- Implemented automation ✅
- Then wrote extensive documentation about it ❌

**What Amendment #4 says to do:**
- Implement automation ✅
- Remove related manual instructions ✅
- Say nothing - let it work silently ✅
- Absence of instructions = the documentation ✅

## Root Cause

Instinct to document completion. Pattern learned from manual processes: "I did something, I should document it."

But automation reverses this: **Automation serves us by making us FORGET, not remember.**

## The Correction

1. Deleted Amendment #8 entirely
2. Kept working automation (script + hook integration)
3. Let `!date` references get auto-replaced on commit (no manual cleanup)
4. This meta-learn is the ONLY documentation (because it's about the LEARNING, not the automation)

## Pattern Recognition

**When I implement automation, ask:**
1. Does this make something manual automatic? → YES
2. Should I document HOW it works? → NO
3. Should I remove old manual instructions? → YES
4. Should I mention it exists? → NO

**The automation IS the amendment. Writing about it violates the principle.**

## Reinforcement

Next time I automate something:
- ✅ Implement it
- ✅ Remove related manual instructions
- ❌ Don't create an "Amendment" about it
- ❌ Don't write "What Genie Must NOT Do" lists
- ✅ Let silence = success

**Automation makes us forget. Documentation makes us remember. Amendment #4 chooses forget.**

## Evidence

- Commit: 57eb312c (created Amendment #8)
- Commit: [next] (deleted Amendment #8)
- Script: `.genie/scripts/update-genie-markdown-metadata.cjs` (working automation)
- This learn: Meta-documentation about the violation, not the feature

## Felipe's Confirmation

> "good boy"

Translation: "You recognized the violation. Now fix it by embracing silence."
