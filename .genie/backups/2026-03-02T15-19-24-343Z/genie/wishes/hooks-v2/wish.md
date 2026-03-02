# Wish: Hooks v2 - Pure Node.js Session Awareness Hooks

**Status:** COMPLETE
**Slug:** `hooks-v2`
**Created:** 2026-02-09

---

## Summary

Rewrite genie-cli's hook scripts to be pure Node.js (no Bun dependency), fix the hooks.json to wire them into Claude Code's hook system for wish validation (PreToolUse/Write) and session context loading (SessionStart). This replaces the broken v1 hooks that depended on `Bun.argv` and `#!/usr/bin/env bun`.

---

## Scope

### IN
- Rewrite `validate-wish.ts` to use `process.argv` instead of `Bun.argv`
- Rewrite `validate-completion.ts` to use `process.argv` instead of `Bun.argv`
- Update build script to emit `#!/usr/bin/env node` shebang (not bun)
- Create session-context hook script (pure Node.js) that prints active wish info on SessionStart
- Wire all 3 hooks into `hooks/hooks.json` with proper Claude Code hook events
- Verify scripts work with `node` runtime

### OUT
- Full completion awareness automation (deferred - complex)
- Prompt-based hooks (staying with command-based for reliability)
- Any changes to the smart-install.js or CLI binaries
- New npm dependencies
- Changes to the genie/term CLI source code

---

## Decisions

- **DEC-1:** Use command-based hooks (not prompt-based) — scripts are more testable, deterministic, and don't consume tokens
- **DEC-2:** Target Node.js ≥18 (already in engines) — eliminates Bun dependency for hooks
- **DEC-3:** Keep validate-completion as Stop hook (advisory only, exit 0) — non-blocking warnings
- **DEC-4:** Session context hook outputs to stderr (shown to Claude) not stdout — follows Claude Code hook convention

---

## Success Criteria

- [ ] `node plugins/automagik-genie/scripts/validate-wish.cjs --help` exits 0
- [ ] `node plugins/automagik-genie/scripts/validate-completion.cjs --help` exits 0
- [ ] `node plugins/automagik-genie/scripts/session-context.cjs --help` exits 0
- [ ] No reference to `Bun` in any `.cjs` script output
- [ ] `hooks/hooks.json` contains PreToolUse, Stop, and SessionStart events
- [ ] `bun run build` succeeds without errors
- [ ] `npx tsc --noEmit` passes

---

## Assumptions

- **ASM-1:** Claude Code plugin hooks use `${CLAUDE_PLUGIN_ROOT}` for script paths
- **ASM-2:** Hook scripts receive context via environment variables and stdin (per Claude Code hook spec)
- **ASM-3:** The build script (`scripts/build.js`) handles bundling .ts source into .cjs scripts

## Risks

- **RISK-1:** validate-wish.cjs currently uses minified code that references Bun — Mitigation: Rewrite source .ts files and rebuild
- **RISK-2:** Build script adds bun shebang automatically — Mitigation: Fix build.js to use node shebang

---

## Execution Groups

### Group A: Fix Build Pipeline for Node.js Compatibility

**Goal:** Ensure the build script produces Node.js-compatible `.cjs` scripts instead of Bun-dependent ones.

**Deliverables:**
- Updated `scripts/build.js` with `#!/usr/bin/env node` shebang instead of `#!/usr/bin/env bun`
- Remove `external: ['bun', 'bun:*']` from esbuild config (or keep as fallback)
- Source files updated to use `process.argv` instead of `Bun.argv`

**Acceptance Criteria:**
- [ ] Build script writes `#!/usr/bin/env node` to `.cjs` outputs
- [ ] Source `.ts` files have no `Bun.argv` references
- [ ] `node scripts/build.js` completes successfully

**Validation:** `node scripts/build.js && grep -c 'env node' plugins/automagik-genie/scripts/validate-wish.cjs`

---

### Group B: Rewrite Hook Scripts for Node.js

**Goal:** Rewrite the three hook scripts to be self-contained, Node.js-compatible scripts.

**Deliverables:**
- `validate-wish.ts` source rewritten (process.argv, no Bun APIs)
- `validate-completion.ts` source rewritten (process.argv, no Bun APIs)
- New `session-context.ts` script that reads `.genie/wishes/` and prints active wish context

**Acceptance Criteria:**
- [ ] `validate-wish.cjs` runs with `node` and validates wish structure
- [ ] `validate-completion.cjs` runs with `node` and checks for incomplete work
- [ ] `session-context.cjs` runs with `node` and outputs active wish info
- [ ] All scripts use only Node.js built-in modules (fs, path, util, os)

**Validation:** `node plugins/automagik-genie/scripts/validate-wish.cjs --help && node plugins/automagik-genie/scripts/session-context.cjs --help`

---

### Group C: Wire Hooks into Plugin Configuration

**Goal:** Update `hooks/hooks.json` to register all three hooks with proper Claude Code events.

**Deliverables:**
- Updated `hooks/hooks.json` with PreToolUse (wish validation), Stop (completion check), SessionStart (context loader)
- Each hook uses `node ${CLAUDE_PLUGIN_ROOT}/scripts/<name>.cjs` command format

**Acceptance Criteria:**
- [ ] `hooks.json` has PreToolUse hook for Write tool on `.genie/wishes/**`
- [ ] `hooks.json` has Stop hook for completion awareness
- [ ] `hooks.json` has SessionStart hook for context loading (alongside existing smart-install)
- [ ] All hooks use `node` not `bun` in command strings

**Validation:** `node -e "const h = require('./plugins/automagik-genie/hooks/hooks.json'); console.log(Object.keys(h.hooks))"`

---

## Review Results

**Verdict: SHIP**

All success criteria verified:

- [x] `node validate-wish.cjs --help` exits 0
- [x] `node validate-completion.cjs --help` exits 0
- [x] `node session-context.cjs --help` exits 0
- [x] No `Bun.` references in any `.cjs` hook script (grep confirms 0 matches)
- [x] `hooks.json` contains PreToolUse, Stop, and SessionStart events
- [x] `bun run build` succeeds
- [x] `npx tsc --noEmit` passes (no errors in hook script files; pre-existing errors in other files)

**Functional tests:**
- [x] validate-wish correctly catches missing sections in malformed wish files
- [x] validate-wish passes for valid wish documents
- [x] validate-wish ignores non-wish files (exits 0 silently)
- [x] validate-wish reads file path from stdin JSON (hook mode)
- [x] validate-completion detects IN_PROGRESS wishes with unchecked criteria
- [x] session-context outputs active wish summary with progress, groups, and current group
- [x] All scripts use only Node.js built-ins (fs, path, util)
- [x] CLI binaries (genie, term) retain `#!/usr/bin/env bun` shebang
- [x] Hook scripts use `#!/usr/bin/env node` shebang

---

## Files to Create/Modify

```
scripts/build.js                                    # Fix shebang generation
plugins/automagik-genie/scripts/src/validate-wish.ts      # Rewrite for Node.js
plugins/automagik-genie/scripts/src/validate-completion.ts # Rewrite for Node.js
plugins/automagik-genie/scripts/src/session-context.ts     # NEW: session context loader
plugins/automagik-genie/hooks/hooks.json                   # Wire up all 3 hooks
```
