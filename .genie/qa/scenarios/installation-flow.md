# Installation Flow QA Workflow

**Purpose:** Validate end-to-end installation experience from `curl | bash` to install agent execution

**Issue:** #201
**Files Changed:**
- `.genie/cli/src/commands/init.ts` - Actually start install agent, show Forge status
- `start.sh` - Comprehensive dependency installation (git, gh, Node.js, pnpm, Homebrew)

---

## Test Scenario 1: Fresh Installation via curl | bash

**Setup:**
```bash
# Create clean test directory
export QA_DIR="/tmp/genie-install-qa-$(date +%s)"
mkdir -p "$QA_DIR" && cd "$QA_DIR"
```

**Execute:**
```bash
bash -c "$(curl -fsSL https://install.namastex.ai/start.sh)"
```

**Expected Behavior:**
1. ✅ Detects operating system (macOS, Linux distro, Windows/WSL)
2. ✅ Installs Homebrew (macOS only, if missing)
3. ✅ Installs git (if missing)
4. ✅ Installs GitHub CLI (gh) (if missing)
5. ✅ Prompts for GitHub authentication (if not authenticated)
6. ✅ Installs Node.js (if missing)
7. ✅ Installs pnpm (if missing)
8. ✅ Checks for Genie updates, installs/updates if needed
9. ✅ Runs `genie init` (interactive wizard)
10. ✅ User selects template (Code/Create)
11. ✅ User selects executor and model
12. ✅ Init completes with summary:
   ```
   ℹ️ Genie initialization complete
   - ✅ Installed Genie template at /path/.genie
   - 🔌 Default executor: claude (model: sonnet)
   - 💾 Backup ID: 2025-10-22T...
   - 📚 Template source: ...
   ```
13. ✅ **NEW:** Shows Forge startup message:
   ```
   🚀 Starting Forge server and Install agent...
   ```
14. ✅ **NEW:** Install agent automatically starts (Forge-backed)
15. ✅ **NEW:** User sees Forge task output:
    ```
    ▸ Creating Forge task for code/agents/install...
    ▸ Task attempt created: <uuid>
    Open in Forge: http://localhost:8887/tasks/<uuid>

      View output:
        npx automagik-genie view <uuid>
      Continue conversation:
        npx automagik-genie resume <uuid> "..."
    ```
16. ✅ User remains in install agent interactive session
17. ✅ Script does NOT exit back to shell

**Failure Modes:**
- ❌ Script exits after init without starting install agent
- ❌ Message says "Started Install agent" but nothing happens
- ❌ No Forge server status shown
- ❌ User left at shell prompt instead of in agent session

---

## Test Scenario 2: Fresh Installation via npx

**Setup:**
```bash
export QA_DIR="/tmp/genie-npx-qa-$(date +%s)"
mkdir -p "$QA_DIR" && cd "$QA_DIR"
```

**Execute:**
```bash
npx automagik-genie@next
```

**Expected Behavior:**
- Same as Scenario 1, steps 4-12

---

## Test Scenario 3: Existing Genie Installation (Upgrade)

**Setup:**
```bash
export QA_DIR="/tmp/genie-upgrade-qa-$(date +%s)"
mkdir -p "$QA_DIR" && cd "$QA_DIR"
# Install old version first
git init -b main
npx automagik-genie@2.4.2-rc.60 init code
# Exit install agent if it starts
```

**Execute:**
```bash
bash -c "$(curl -fsSL https://install.namastex.ai/start.sh)"
```

**Expected Behavior:**
1. ✅ Detects existing installation
2. ✅ Shows update message with version comparison
3. ✅ Updates to latest version
4. ✅ Detects partial installation (templates already present)
5. ✅ Shows:
   ```
   🔍 Detected partial installation
   📦 Templates already copied, resuming setup...
   ```
6. ✅ Configures MCP
7. ✅ **NEW:** Starts Forge and install agent automatically
8. ✅ User remains in session

---

## Test Scenario 4: Forge Server Visibility

**Setup:**
```bash
export QA_DIR="/tmp/genie-forge-qa-$(date +%s)"
mkdir -p "$QA_DIR" && cd "$QA_DIR"
```

**Execute:**
```bash
npx automagik-genie@next init code
```

**Watch for:**
1. ✅ Message: "🚀 Starting Forge server and Install agent..."
2. ✅ Forge task creation output visible
3. ✅ Forge URL shown: `http://localhost:8887/tasks/<uuid>`
4. ✅ Clear instructions for continuing session

**Failure Modes:**
- ❌ No indication Forge is starting
- ❌ Silent Forge startup with no user feedback
- ❌ Forge starts but user doesn't know how to continue

---

## Test Scenario 5: Error Handling

**Setup:**
```bash
export QA_DIR="/tmp/genie-error-qa-$(date +%s)"
mkdir -p "$QA_DIR" && cd "$QA_DIR"
```

**Test 5a: Forge Not Available**
```bash
# Ensure no Forge running on port 8887
npx automagik-genie@next init code --forge-port 9999
```

**Expected:**
- ✅ Clear error message if Forge unavailable
- ✅ User gets actionable error (not silent failure)

**Test 5b: Network Issues**
```bash
# Simulate network issue
export FORGE_BASE_URL="http://invalid-host:8887"
npx automagik-genie@next init code
```

**Expected:**
- ✅ Clear network error
- ✅ Guidance on how to fix

---

## Validation Checklist

After running test scenarios:

- [ ] Install agent starts automatically (no manual `genie` command needed)
- [ ] Forge server status clearly communicated
- [ ] User stays in install agent session (doesn't drop to shell)
- [ ] start.sh script completes without premature exit
- [ ] Forge task URL displayed and clickable
- [ ] MCP configuration successful
- [ ] No misleading "Started Install agent" message without actual execution
- [ ] Error handling graceful and actionable
- [ ] Experience matches QA documentation expectations

---

## Regression Tests

Check that existing functionality still works:

- [ ] `genie --version` shows correct version
- [ ] `genie --help` displays help
- [ ] MCP config files created correctly (`.mcp.json`, `~/.codex/config.toml`)
- [ ] Template files copied correctly
- [ ] Backup system works (`.genie/backups/`)
- [ ] State files created (`.genie/state/version.json`, `.genie/state/provider-status.json`)

---

## Success Criteria

**PASS** if:
1. ✅ All test scenarios complete without manual intervention
2. ✅ Install agent starts automatically every time
3. ✅ User experience matches expected flow documented in issue #201
4. ✅ No regression in existing functionality
5. ✅ Clear, actionable feedback at every step

**FAIL** if:
1. ❌ User must manually run `genie` after `curl | bash`
2. ❌ Install agent doesn't start
3. ❌ Forge status unclear or missing
4. ❌ Script exits prematurely
5. ❌ Silent failures with no user feedback
