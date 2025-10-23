# Genie Framework Update Workflow

## Purpose
Automatically upgrade local `.genie/` framework files when new Genie versions are released, while preserving user customizations.

## Trigger
- Manual: `genie update`
- Automatic: On `genie` startup (max once per day check)
- Post-install: After `npm install -g automagik-genie@next`

## Workflow Steps

### 1. Version Detection
```javascript
installed = readFrameworkVersion('.genie/.framework-version')
available = getGlobalPackageVersion('automagik-genie')

if (available > installed) {
  promptUpgrade()
}
```

### 2. User Consent
```bash
🔔 New Genie framework available!
   Installed: v2.5.0-rc.15
   Available: v2.5.0-rc.16

   Would you like to upgrade? (Y/n):
```

### 3. Diff Generation
```bash
# Fetch template repo at old and new versions
git diff ${OLD_COMMIT} ${NEW_COMMIT} -- .genie/**/*.md > upgrade.patch

# Apply framework files only (preserve user files)
git apply --check upgrade.patch
```

### 4. Merge Strategy

**Clean Merge (No Conflicts):**
```bash
git apply upgrade.patch
commit "Upgrade Genie framework v{old} → v{new}"
✅ Upgrade complete!
```

**Conflicts Detected:**
```bash
⚠️ Conflicts in 2 files:
   - .genie/code/AGENTS.md
   - .genie/spells/learn.md

🤖 Launching Update Agent...
   Task: task_abc123
   Monitor: https://forge.namastex.ai/tasks/abc123
```

### 5. Conflict Resolution (via Update Agent)

**Agent Workflow:**
1. Analyze conflicts (3-way merge: base, user, upstream)
2. Categorize changes:
   - **Additive:** Both sides added content → merge both
   - **Deletive:** Upstream removed section → ask user
   - **Conflicting:** Both modified same lines → present options
3. Ask user for guidance (interactive)
4. Apply resolution and commit
5. Report summary

**User Interaction:**
```bash
🤖 Update Agent needs your input:

File: .genie/code/AGENTS.md
Conflict: You added "Custom Workflows" section.
          Upstream restructured file.

Options:
  1. Keep your section (merge after upstream structure)
  2. Move content into upstream's new section
  3. Show me both versions

Your choice (1/2/3): _
```

### 6. Finalization
```bash
# Update version tracking
echo '{"installed_version": "v2.5.0-rc.16", ...}' > .genie/.framework-version

# Clean up temp files
rm -rf /tmp/genie-upgrade-*

# Notify user
✅ Upgrade complete! Genie is now on v2.5.0-rc.16
```

## File Classification

**Framework Files (Upgraded):**
- `.genie/AGENTS.md`
- `.genie/spells/*.md` (official spells)
- `.genie/code/AGENTS.md`
- `.genie/code/agents/*.md` (official agents)
- `.genie/workflows/*.md`
- `.genie/product/**/*.md`
- `.genie/qa/**/*.md`

**User Files (Preserved):**
- `.genie/USERCONTEXT.md`
- `.genie/.session`
- `.genie/reports/**/*.md`
- `.genie/spells/custom-*.md`
- `.genie/code/agents/custom-*.md`

## Rollback Strategy

If upgrade fails:
```bash
# Automatic backup before upgrade
cp -r .genie .genie.backup-{timestamp}

# Rollback on failure
genie update --rollback
# or
mv .genie.backup-{timestamp} .genie
```

## Safety Guarantees

- ✅ Never overwrites user files
- ✅ Always backs up before upgrade
- ✅ Conflicts never auto-resolved (user guidance required)
- ✅ Atomic operations (rollback on failure)
- ✅ Offline mode (cached template repo)

## Success Metrics

- 🎯 <60s for clean merges
- 🎯 100% user customization preservation
- 🎯 Zero data loss
- 🎯 Interactive conflict resolution
- 🎯 Live monitoring for complex upgrades
