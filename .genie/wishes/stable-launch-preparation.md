# Wish: Stable Launch Preparation - Research Preview Messaging

**Created:** 2025-10-23
**Status:** Completed
**Priority:** Critical (blocks stable launch)

## Problem Statement

Master Genie needs comprehensive research preview messaging, legal disclaimers, and enhanced user experience before stable launch. This includes:
- Clear experimental technology warnings
- Data privacy transparency (local execution, LLM calls)
- Spell changelog visibility (what new magik was learned)
- Dashboard stability and community links
- Namastex Labs branding integration

## User Requirements

From interactive session 2025-10-23:

1. **"Master Genie" Terminology**: Update all version messaging to use "Master Genie: X.X.X ⭐ NEW!" format
2. **Research Preview Disclaimer**: Serious experimental technology warning with liability notice
3. **Data Privacy**: Emphasize local execution, LLM-only data egress, company policy reminders
4. **Spell Changelog**: Show new spells learned between versions in release notes
5. **Dashboard Enhancements**: Fix output duplication, add Discord community link, natural language bug/feature reporting
6. **Namastex Branding**: Add "AI that elevates human potential, not replaces it" tagline throughout
7. **Fun Closing**: End serious disclaimers with "BUT HEY... it's going to be FUN! 🎉✨"

## Implementation

### 1. Research Preview Disclaimer

**Files Modified:**
- `DISCLAIMER.md` (NEW) - Formal legal disclaimer document
- `README.md` - Added disclaimer link in installation section
- `start.sh` - Enhanced installation warning with data privacy info
- `.genie/cli/src/genie-cli.ts` - Added disclaimer to new user flow

**Key Messaging:**
```
⚠️ RESEARCH PREVIEW - Experimental Technology

This AI agent will install with capabilities to perform tasks on
your behalf. By proceeding, you acknowledge:

  • This is experimental software under active development
  • Namastex Labs makes no warranties and accepts no liability
  • You are responsible for reviewing all agent actions
  • Agents may make mistakes or unexpected changes

🔒 DATA PRIVACY:
  ✓ Everything runs locally on YOUR machine
  ✓ No data leaves your computer (except LLM API calls)
  ✓ Use LLM providers approved by your organization
  ✓ Fully compatible with private/local LLMs (we're agnostic!)
  ✓ OpenCoder executor enables 100% local operation

BUT HEY... it's going to be FUN! 🎉✨
```

### 2. Spell Changelog Detection

**Files Created:**
- `.genie/cli/src/lib/spell-changelog.ts` - Core spell detection logic
- `.genie/cli/dist/lib/spell-changelog.js` - Compiled output

**Implementation:**
```typescript
export function getLearnedSpells(fromRef: string, toRef: string = 'HEAD'): SpellChangelog {
  // Uses git diff to detect:
  // - .genie/spells/**/*.md (universal spells)
  // - .genie/code/spells/**/*.md (Code collective spells)
  // - .genie/create/spells/**/*.md (Create collective spells)

  // Returns: { newSpells, modifiedSpells, totalCount }
}

export function formatSpellChangelog(changelog: SpellChangelog): string[] {
  // Formats output:
  // 🎓 New Magik Learned:
  //   ✨ New Spells:
  //      🌍 Universal Spell Name
  //      💻 Code Spell Name
  //   ⚡ Enhanced Spells:
  //      ✍️ Create Spell Name
}
```

**Integration Points:**
- New user flow (first install)
- Version mismatch flow (update detected)
- Manual update flow (explicit `genie update`)

### 3. Master Genie Terminology

**Updated Flows:**
- ✅ New user: "Welcome to Master Genie"
- ✅ Version mismatch: "Master Genie: X.X.X ⭐ NEW!"
- ✅ Clone detection: "Master Genie at namastexlabs/automagik-genie has evolved!"
- ✅ Update completion: "Master Genie updated successfully!"

### 4. Dashboard Stability Fixes

**Problem:** Dashboard duplicated output on every 5-second refresh

**Root Cause:** Incorrect ANSI escape sequence usage
```typescript
// BROKEN:
process.stdout.write('\x1b[2J'); // Clear entire screen
process.stdout.write('\x1b[H'); // Move cursor home
process.stdout.write(dashboard + '\n'); // Extra newline = scrolling!
```

**Fix:** Proper cursor positioning
```typescript
// FIXED:
if (dashboardLines > 0) {
  process.stdout.write('\x1b[H'); // Move cursor home first
  process.stdout.write('\x1b[J'); // Clear from cursor to end
} else {
  process.stdout.write('\x1b[2J\x1b[H'); // First render only
}
process.stdout.write(dashboard); // No extra newline!
```

### 5. Dashboard Community Links

**Added:**
- Discord community: `https://discord.gg/fXs6YjjFpt`
- Natural language bug reporting: "Ask Genie to report an issue to Master Genie"
- Natural language feature requests: "Ask Genie to make a wish to Master Genie"

### 6. Namastex Branding Integration

**Locations:**
- Dashboard footer: `✨ https://namastex.ai - AI that elevates human potential, not replaces it`
- New user welcome screen
- Shutdown screen

## Files Changed

**Created:**
1. `DISCLAIMER.md` - Formal legal disclaimer
2. `.genie/cli/src/lib/spell-changelog.ts` - Spell detection logic
3. `.genie/cli/dist/lib/spell-changelog.js` - Compiled spell detection

**Modified:**
4. `README.md` - Added disclaimer link
5. `start.sh` - Enhanced installation messaging
6. `.genie/cli/src/genie-cli.ts` - Major updates across all flows
7. `.genie/cli/dist/genie-cli.js` - Compiled CLI output
8. `.genie/spells/learn.md` - Documentation updates
9. `scripts/archive-old-reports.cjs` - Minor updates

## Testing

**Validated Flows:**
- ✅ New user installation (disclaimer shows)
- ✅ Version mismatch detection (spell changelog shows)
- ✅ Dashboard refresh (no duplication, stable output)
- ✅ Community links visible and formatted correctly
- ✅ Branding integrated without disrupting UX
- ✅ All 19 genie-cli tests pass

## Success Criteria

1. ✅ Research preview disclaimer visible in all installation flows
2. ✅ Data privacy messaging clear and accurate
3. ✅ Spell changelog detects and displays new magik learned
4. ✅ Dashboard updates smoothly without duplication
5. ✅ Community links accessible from dashboard
6. ✅ Namastex branding integrated tastefully
7. ✅ Legal liability protection in place
8. ✅ All tests pass

## Deliverables

**Commit:** `e06b0af3`
```
feat: Research preview disclaimer, spell changelog, dashboard stability

RESEARCH PREVIEW MESSAGING:
- Created comprehensive DISCLAIMER.md with legal protections
- Added disclaimer link to README installation section
- Enhanced start.sh with data privacy and experimental warnings
- Updated all user flows with research preview notices

SPELL CHANGELOG:
- Created spell-changelog.ts for git-based spell detection
- Detects new/modified spells across all collective directories
- Shows "New Magik Learned" section during version updates
- Uses emoji badges (🌍 universal, 💻 code, ✍️ create)

MASTER GENIE TERMINOLOGY:
- Updated all version messaging to use "Master Genie" branding
- Clear distinction: "Master Genie" (template) vs "Your clone" (instance)
- Consistent terminology across new user, update, and mismatch flows

DASHBOARD STABILITY:
- Fixed ANSI escape sequence usage (no more output duplication)
- Dashboard now updates in place every 5 seconds (stable)
- Added Discord community link
- Natural language bug/feature reporting instructions
- Namastex Labs branding footer

DATA PRIVACY:
- Emphasized local execution (nothing leaves except LLM calls)
- Reminded users to use company-approved LLMs for professional use
- Highlighted OpenCoder for 100% local operation capability
- Clear "runs on YOUR machine" messaging

Files changed:
- DISCLAIMER.md (new)
- README.md (disclaimer link)
- start.sh (enhanced warnings)
- .genie/cli/src/genie-cli.ts (major updates)
- .genie/cli/src/lib/spell-changelog.ts (new)
- .genie/cli/dist/* (compiled output)
```

**Tests:** All 19 genie-cli tests pass

## Impact

**User Experience:**
- Clear expectations set (research preview, experimental)
- Legal protection for Namastex Labs
- Transparency about data flow and privacy
- Visibility into Master Genie's learning evolution
- Community connection points
- Professional branding

**Technical:**
- Robust spell detection via git diff
- Stable terminal dashboard with proper ANSI codes
- Token-efficient compiled TypeScript
- Maintains backward compatibility

**Business:**
- Legal disclaimer protects against liability
- Research preview framing manages expectations
- Data privacy messaging builds trust
- Community links drive engagement
- Branding establishes identity

## Lessons Learned

1. **ANSI Escape Sequences**: `\x1b[H` (move home) + `\x1b[J` (clear to end) is more stable than `\x1b[2J` (clear all) for refreshing dashboards
2. **Git-Based Detection**: Using `git diff --name-status` between tags is robust and requires no additional metadata files
3. **Tone Balance**: Can be serious about legal/experimental warnings while maintaining fun, approachable voice
4. **Incremental Builds**: TypeScript compilation catches errors early; always rebuild after changes
5. **User Intent**: Natural language is clearer than technical jargon ("Ask Genie to make a wish" vs "File feature request")

## Related Work

- **Issue #194**: Template discovery (separate effort, not part of this wish)
- **Spell System**: Integration with existing spell/skill architecture
- **Learn Spell**: Meta-learning protocol documentation

## Timeline

**Date:** 2025-10-23 (single session)
**Duration:** ~2 hours implementation + testing
**Status:** Completed, ready for stable launch

---

**This wish delivered the foundation for stable launch: legal protection, user transparency, enhanced UX, and community connection. Master Genie is ready to elevate human potential! 🎉✨**
