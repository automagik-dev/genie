# Genie v2.1.0 Upgrade Guide

Complete step-by-step upgrade process: **npm package update** → **project migration** → **verification**

---

## The Complete Flow

### Step 1: Update NPM Package (Framework Update)

```bash
npm install -g automagik-genie@2.1.0
# OR
pnpm install -g automagik-genie@2.1.0
```

**What this does:**
- Installs new Genie CLI to `/usr/local/bin/genie`
- Installs framework code to `/usr/local/lib/node_modules/automagik-genie/`
- Includes **25 core agents** in the npm package at `.genie/agents/`
- Does NOT touch your project files yet

**Verify:**
```bash
genie --version  # Should show 2.1.0
which genie      # Should show /usr/local/bin/genie
```

---

### Step 2: Update Project (Auto-Migration)

```bash
cd your-project/
genie update
```

**What happens (step-by-step):**

#### 2a. Old Structure Detection
```
╭───────────────────────────────────────────────────────────╮
│ 🔄 Old Genie Structure Detected                          │
│ Migrating to npm-backed architecture...                  │
╰───────────────────────────────────────────────────────────╯
```

CLI detects `.genie/agents/` contains core agents (old v2.0.x structure).

#### 2b. Backup Creation
```
📊 Installation type: old_genie
💾 Creating backup...
   Backup: .genie-backup-20251013-180500
```

Complete backup at `.genie-backup-YYYYMMDD-HHmmss/` (rollback safety).

#### 2c. Agent Analysis
```
🔍 Analyzing agents...
   Core agents: 25
   Custom agents: 3
   Modified: 0
```

- **Core agents**: Framework defaults (will be removed, loaded from npm)
- **Custom agents**: Your project-specific agents (preserved)
- **Modified**: Edited core agents (changes merged inline as "Project Notes"; `custom/` retired)

#### 2d. Migration
```
🗑️  Removing core agents (now in npm package)...
   Removed: plan.md, wish.md, forge.md, review.md
   Removed: core/implementor.md, core/tests.md, core/commit.md, ...

📦 Installing new template structure...
   Updated: .claude/ (npm package references)
   Note: `.genie/custom/` has been retired. Use "Project Notes" sections in agents/spells.
```

#### 2e. Template Update
```
📦 Continuing with template update...

✅ Update complete!
   Files updated: 12
   Files unchanged: 45
```

#### 2f. Summary
```
✅ Migration complete!
   Backup: .genie-backup-20251013-180500
   Custom agents preserved: 3
   Core agents removed: 25
```

---

### Step 3: Verify

```bash
# Should show 25+ agents (npm + your customs)
genie list agents

# Test core agent (from npm)
genie run plan --help

# Check changes
git status
```

---

## Before → After Structure

### Before (v2.0.x)
```
your-project/
└── .genie/
    └── agents/
        ├── plan.md              ← Framework (in repo)
        ├── wish.md              ← Framework (in repo)
        ├── core/
        │   ├── implementor.md   ← Framework (in repo)
        │   ├── commit.md        ← Framework (in repo)
        │   └── tests.md         ← Framework (in repo)
        └── my-agent.md          ← Your agent
```

### After (v2.1.0)
```
your-project/
└── .genie/
    └── agents/
        └── my-agent.md          ← Your agent (preserved)

Core agents loaded from:
/usr/local/lib/node_modules/automagik-genie/.genie/agents/
├── plan.md, wish.md, forge.md, review.md
└── core/
    ├── implementor.md, commit.md, tests.md, ...
```

---

## Agent Resolution (Runtime)

When you run `genie run implementor`:

1. Check `.genie/agents/implementor.md` (your local override)
2. Check `.genie/agents/core/implementor.md` (your local override)
3. **Load from npm:** `/usr/local/lib/.../core/implementor.md` ✅
4. **Project Notes:** Merge any repo-specific guidance into the local agent/spell doc (no `custom/` path)

**Result:** Core agent from npm + your customizations

---

## Real Example: Forge Repository

**Research repo cloned as submodule:** `research/automagik-forge`

### Forge's Old Structure
```
.genie/agents/
├── plan.md, wish.md, forge.md, review.md
├── specialists/      # Old organization
│   ├── implementor.md
│   ├── tests.md
│   └── ... (11 agents)
└── utilities/        # Old organization
    ├── commit.md
    ├── debug.md
    └── ... (18 agents)
```

### Migration Test
```bash
cd research/automagik-forge
genie migrate --dry-run

# Output:
# 🔍 Old Genie installation detected
# Core agents: 4  (plan, wish, forge, review)
# Custom agents: 29 (specialists/* + utilities/*)
```

**Finding:** Forge uses old organizational structure (specialists/, utilities/).
Our migration correctly identifies 33 agents but needs refinement to recognize
old framework agents in subdirectories as "core" not "custom".

---

## Why Two Steps? (NPM + Project)

**Step 1: npm install** → Updates the **framework**
- New CLI with migration capabilities
- Core agents in npm package
- Does not modify project files

**Step 2: genie update** → Updates **your project**
- Uses new CLI to detect old structure
- Migrates project to reference npm agents
- Updates project templates

**Why separate?**
1. NPM package update is global (one installation)
2. Project update is per-repository (each project migrates independently)
3. Allows testing new CLI before migrating projects
4. Follows standard npm global package pattern

---

## Alternative: Manual Migration

```bash
# If you want just migration (no template update):
npm install -g automagik-genie@2.1.0
cd project/
genie migrate

# If you want to force re-init (destructive!):
genie init --yes
```

---

## Future Updates (Post-Migration)

**After migrating to v2.1.0, updates are simple:**

```bash
# Update framework
npm install -g automagik-genie@latest

# Update project templates
cd project/ && genie update

# No migration needed - already on new architecture!
```

---

## Rollback

**If migration fails:**

```bash
# Restore from backup
rm -rf .genie
mv .genie-backup-20251013-180500 .genie

# Downgrade npm
npm install -g automagik-genie@2.0.3
```

---

## Summary

**Complete upgrade in 2 commands:**
```bash
npm install -g automagik-genie@2.1.0  # Step 1: Framework
genie update                           # Step 2: Project (auto-migrates)
```

**Result:**
- ✅ Core agents loaded from npm
- ✅ Custom agents preserved
- ✅ Easy future updates
- ✅ Clean project structure
