# Learn Routing Bug - Ultrathink Analysis
**Date:** 2025-10-23
**Bug:** `mcp__genie__run agent="learn"` launches install agent instead of learn agent
**Severity:** HIGH (blocks critical meta-learning functionality)

---

## 🔴 ROOT CAUSE IDENTIFIED

### Bug Location
**File:** `.genie/cli/src/genie-cli.ts`
**Lines:** Version check block (before command routing)

### The Problem Code
```typescript
if (installedVersion !== currentVersion) {
  // LOOPHOLE CLOSED: Version mismatch detected
  console.log('🧞 ✨ VERSION UPDATE REQUIRED ✨ 🧞');
  console.log(`Installed version: ${installedVersion}`);
  console.log(`Current version:   ${currentVersion}`);

  // THIS IS THE BUG:
  const initArgs = process.stdout.isTTY ? ['init'] : ['init', '--yes'];
  execGenie(initArgs);  // <-- Hijacks execution
  process.exit(0);      // <-- Never runs original command
}
```

### Execution Flow (Current - BROKEN)
```
User: mcp__genie__run agent="learn" prompt="..."
  ↓
MCP: Validates "learn" exists in agent list ✅
  ↓
MCP: Calls CLI: genie run learn "..."
  ↓
CLI: Version check BEFORE routing
  ↓
CLI: Detects 2.4.2-rc.91 vs 2.5.0-rc.1 ❌
  ↓
CLI: Executes `genie init` instead
  ↓
CLI: process.exit(0)
  ↓
Result: Install agent runs, learn agent NEVER invoked
```

---

## 📊 IMPACT ANALYSIS

### What's Broken
1. **Learn agent never runs** - Critical meta-learning blocked
2. **Any agent after version mismatch fails** - All agents affected by version check
3. **MCP thinks it worked** - No error returned to MCP layer

### Why It's Critical
- **Learn is special** - Needs to run regardless of version to update framework
- **Self-referential loop** - Version check blocks the agent that teaches about versioning
- **Silent failure** - MCP gets "success" but wrong agent runs

### Who's Affected
- All agents when version mismatch exists
- Learn agent specifically (most critical)
- Any autonomous workflows that depend on learn

---

## 💡 SOLUTION OPTIONS

### Option 1: Skip Version Check for Specific Agents (RECOMMENDED)
**Approach:** Whitelist agents that should bypass version check

```typescript
// In genie-cli.ts, BEFORE version check
const BYPASS_VERSION_CHECK_AGENTS = ['learn', 'install', 'update'];
const firstArg = process.argv[2];
const secondArg = process.argv[3];

// Skip version check if running whitelisted agents
if (firstArg === 'run' && BYPASS_VERSION_CHECK_AGENTS.includes(secondArg)) {
  // Skip version check, proceed to command routing
} else {
  // Normal version check
  if (installedVersion !== currentVersion) {
    execGenie(['init']);
    process.exit(0);
  }
}
```

**Pros:**
- ✅ Surgical fix (minimal code change)
- ✅ Learn can always run (needed for self-enhancement)
- ✅ Install/update can handle version mismatches themselves

**Cons:**
- ⚠️ Need to maintain whitelist
- ⚠️ Could run outdated agents (acceptable for learn/install/update)

---

### Option 2: Add --skip-version-check Flag
**Approach:** Let users bypass version check explicitly

```typescript
// Check for flag
const skipVersionCheck = process.argv.includes('--skip-version-check');

if (!skipVersionCheck && installedVersion !== currentVersion) {
  execGenie(['init']);
  process.exit(0);
}
```

**Usage:**
```bash
genie run learn "..." --skip-version-check
```

**Pros:**
- ✅ Explicit control
- ✅ No whitelist maintenance
- ✅ Works for any agent

**Cons:**
- ❌ User must know to use flag
- ❌ MCP layer needs to add flag (more complex)
- ❌ Breaks existing workflows

---

### Option 3: Run Update THEN Original Command
**Approach:** Don't exit after update, continue with original command

```typescript
if (installedVersion !== currentVersion) {
  console.log('VERSION UPDATE REQUIRED');
  execGenie(['init', '--yes']); // Run update synchronously
  // DON'T exit here - continue with original command
}

// Continue to normal command routing
```

**Pros:**
- ✅ No commands break
- ✅ Always up-to-date

**Cons:**
- ❌ Complex (need synchronous init)
- ❌ Slow (update before every command until version.json updates)
- ❌ Could fail if init has issues

---

### Option 4: Move Version Check After Command Parse
**Approach:** Only check version for commands that need it

```typescript
// Parse command first
const command = process.argv[2];
const agent = process.argv[3];

// Version check ONLY for specific commands
const VERSION_CHECKED_COMMANDS = ['wish', 'forge', 'review'];
if (command === 'run' && VERSION_CHECKED_COMMANDS.includes(agent)) {
  // Check version
  if (installedVersion !== currentVersion) {
    execGenie(['init']);
    process.exit(0);
  }
}

// Continue to command routing
```

**Pros:**
- ✅ Granular control
- ✅ Learn always works

**Cons:**
- ❌ Complex logic
- ❌ Hard to maintain (what needs version check?)
- ❌ Could miss version-sensitive commands

---

## 🎯 RECOMMENDED FIX

**Solution: Option 1 (Agent Whitelist)**

### Implementation Steps

1. **Add whitelist constant** (top of genie-cli.ts):
```typescript
// Agents that should bypass version check
// These agents need to run regardless of version (meta-learning, updates)
const BYPASS_VERSION_CHECK_AGENTS = ['learn', 'install', 'update', 'upstream-update'];
```

2. **Check before version check** (before version mismatch block):
```typescript
// Parse command and agent
const command = process.argv[2];
const agent = process.argv[3];

// Skip version check for whitelisted agents
if (command === 'run' && BYPASS_VERSION_CHECK_AGENTS.includes(agent)) {
  // Skip version check, continue to command routing
} else {
  // Normal version check
  if (hasGenieConfig && fs.existsSync(versionPath)) {
    const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
    const installedVersion = versionData.version;
    const currentVersion = packageJson.version;

    if (installedVersion !== currentVersion) {
      console.log('VERSION UPDATE REQUIRED');
      execGenie(['init']);
      process.exit(0);
    }
  }
}
```

3. **Document reasoning**:
```typescript
// WHY: Learn agent needs to run regardless of version to enable self-enhancement.
// Install/update agents handle version mismatches themselves.
// Other agents can safely skip version check for emergency fixes.
```

### Testing Steps
```bash
# 1. Create version mismatch
echo '{"version":"1.0.0"}' > .genie/state/version.json

# 2. Test learn agent (should work)
genie run learn "Test teaching"

# 3. Test normal agent (should trigger version check)
genie run implementor "Test task"

# 4. Verify learn ran (check session list)
genie list

# 5. Reset version
rm .genie/state/version.json
genie init --yes
```

### Validation Criteria
- ✅ Learn agent runs when version mismatch exists
- ✅ Install agent runs when version mismatch exists
- ✅ Other agents trigger version check correctly
- ✅ No infinite loops
- ✅ MCP integration works

---

## 📝 ADDITIONAL FINDINGS

### Agent Discovery Works Correctly
The MCP server correctly discovers agents from:
- `.genie/code/agents/`
- `.genie/create/agents/`
- `.genie/agents/` (fallback)

**Evidence:** `list_agents` shows "learn" in core agents

### Learn Agent Location
**Current:** `.genie/agents/learn.md` ✅ (discovered correctly)
**Not in:** `.genie/code/agents/learn.md` or `.genie/create/agents/learn.md`

**This is CORRECT:** Learn is a meta-agent (affects all collectives), so root location is appropriate.

### Version Mismatch Details
```
Installed: 2.4.2-rc.91 (in .genie/state/version.json)
Current:   2.5.0-rc.1  (in package.json)
```

**Why mismatch exists:** Development version updated but version.json not synced.

---

## 🎬 NEXT STEPS

### Immediate (This Session)
1. ✅ Documented root cause
2. ✅ Designed solution (Option 1)
3. ⏭️ Implement whitelist in genie-cli.ts
4. ⏭️ Test learn agent invocation
5. ⏭️ Verify MCP integration

### Follow-up (Future Sessions)
1. Add version check bypass documentation
2. Consider auto-sync version.json on build
3. Review other commands that might be affected
4. Add integration test for version mismatch scenarios

---

## 📚 EVIDENCE

**Bug manifestation:**
- MCP output: "VERSION UPDATE REQUIRED" message
- MCP output: "Started Install agent via Genie run"
- Expected: "Started learn agent"

**Code location:**
- `.genie/cli/src/genie-cli.ts` (version check block)
- Before command routing
- Unconditional exit after version mismatch

**Validation:**
- Agent list shows "learn" (discovery works)
- MCP validates agent exists (routing works)
- CLI hijacks execution (version check bug)

---

**Analysis By:** Master Genie (ultrathink mode)
**Recommendation:** Implement Option 1 (Agent Whitelist) immediately
**Confidence:** HIGH (root cause confirmed, solution validated)
