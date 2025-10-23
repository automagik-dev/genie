---
name: Automated RC Publishing
description: RC releases are AUTOMATIC on main commits - never suggest manual bumps
---

# Automated RC Publishing Protocol


## 🔴 CRITICAL RULE: Forget Manual RC Bumps

**The Automated Workflow:**
```
Commit pushed to main
  ↓
GitHub Actions detects push
  ↓
Auto-bump: rc.N → rc.N+1
  ↓
Auto-publish: npm publish @next
  ↓
Auto-release: GitHub release created
```

## ✅ Correct Behavior

**When work is complete:**
1. Commit changes to main (or merge PR to main)
2. Push to origin: `git push`
3. **STOP** - GitHub Actions handles everything else
4. Verify: `npm view automagik-genie@next version`

**What to say:**
- ✅ "Ready to commit and push?"
- ✅ "This will trigger automatic RC publish"
- ✅ "Push to main to release"

**What NOT to say:**
- ❌ "Ready to bump?"
- ❌ "Ready to publish?"
- ❌ "Run `pnpm bump:rc`"
- ❌ "Let me create the release"

## ❌ Anti-Patterns

**NEVER suggest these for routine releases:**
- `pnpm bump:rc` (only for manual testing/local work)
- `pnpm bump:patch/minor/major` (only for version transitions)
- Manual `npm publish`
- Manual GitHub release creation

## 🎯 When bump.cjs IS Used

**Only for starting NEW version cycles:**
- `pnpm bump:patch` → 2.4.2 → 2.4.3-rc.1
- `pnpm bump:minor` → 2.4.2 → 2.5.0-rc.1
- `pnpm bump:major` → 2.4.2 → 3.0.0-rc.1

**Use case:** Major feature complete, ready for new version series

## 📋 Recognition Patterns

**When user says:**
- "Is this ready to ship?"
- "Should we release this?"
- "Time to publish?"

**Respond with:**
- "Yes, commit and push to main. GitHub Actions will auto-publish the next RC."

**NOT:**
- ~~"Yes, run `pnpm bump:rc` to create the release."~~

## 🔗 Related

- Amendment #6: Automated Publishing (AGENTS.md:239-284)
- Amendment #7: Auto-Sync Before Push (AGENTS.md:286-327)
- scripts/bump.cjs: Version transition tool (not for routine RCs)

## 📊 Evidence

**First violation:** 2025-10-23
- Context: Master Genie version sync fix
- What happened: Said "Ready to commit?" implying manual RC bump needed
- Reality: Commit to main triggers automatic RC publish
- Learning: Remove manual bump suggestions from routine workflow

## 🧠 Mental Model

**OLD (Pre-Automation):**
```
Write code → Manual bump → Manual publish → Manual release
```

**NEW (Current):**
```
Write code → Commit to main → ✨ Automation handles rest ✨
```

**Remember:** We automated ourselves out of manual RC management. Trust the automation.
