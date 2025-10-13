# Migration Guide: Core/Template Separation (v3.0)

**Target:** Users upgrading from Genie v2.x to v3.0+

## What Changed?

### Old Architecture (v2.x)
- **All agents** stored in your project's `.genie/agents/`
- Core framework agents mixed with your custom agents
- Updates required manual merging
- Framework changes could break your customizations

### New Architecture (v3.0+)
- **Core agents** ship in npm package (`automagik-genie`)
- **Your custom agents** stay in `.genie/agents/`
- **Customization injection points** in `.genie/custom/`
- Automatic resolution: local agents override npm agents
- Updates don't touch your customizations

## Agent Inventory

### Shipped with npm (25 agents - DON'T copy to your project)
**Top-level orchestrators (6):**
- plan, wish, forge, review, orchestrator, vibe

**Core delivery agents (13):**
- core/analyze, core/audit, core/commit, core/debug
- core/git-workflow, core/github-workflow, core/implementor
- core/install, core/learn, core/polish, core/prompt
- core/refactor, core/tests

**Orchestrator modes (5):**
- core/modes/challenge, core/modes/consensus, core/modes/docgen
- core/modes/explore, core/modes/tracer

**QA agents (1):**
- qa/genie-qa

### Your Custom Agents
- Any agents YOU created (not framework defaults)
- Stored in `.genie/agents/` (local directory)
- Takes precedence over npm package agents

### Customization Points
- `.genie/custom/<agent>.md` files auto-loaded by core agents
- Add project-specific commands, evidence paths, domain rules
- Never edit core agents directly!

## Migration Scenarios

### Scenario 1: Clean Install (New Project)

```bash
# Install Genie v3.0+
npm install -g automagik-genie@latest

# Initialize in your project
cd your-project/
genie init

# Done! Core agents loaded from npm automatically
genie list agents  # Shows all 25 agents
```

### Scenario 2: Upgrade from v2.x (Existing Project)

**Automatic Migration:**

```bash
# Update to v3.0+
npm install -g automagik-genie@latest

# Run migration (creates backup first)
cd your-project/
genie migrate

# ✅ Backup created at .genie-backup-TIMESTAMP
# ✅ Core agents removed (now from npm)
# ✅ Custom agents preserved
# ✅ Templates updated

# Verify
genie list agents  # Should show all agents (npm + custom)
```

**Manual Migration (if automatic fails):**

```bash
# 1. Backup first!
cp -r .genie .genie-backup-manual

# 2. Identify YOUR custom agents
# (Anything not in the core agent list above)
ls .genie/agents/

# 3. Remove core agents
rm -rf .genie/agents/core/
rm .genie/agents/plan.md
rm .genie/agents/wish.md
rm .genie/agents/forge.md
rm .genie/agents/review.md
rm .genie/agents/orchestrator.md
rm .genie/agents/vibe.md
# (Keep any custom agents you created)

# 4. Copy new templates
npm install -g automagik-genie@latest
genie init --force  # Updates .claude/ and .genie/custom/

# 5. Verify
genie list agents
```

### Scenario 3: Modified Core Agents (Customizations)

If you edited core agents directly in v2.x:

```bash
# 1. Identify modifications
git diff .genie/agents/core/implementor.md  # Example

# 2. Extract your changes
# Copy your custom logic to .genie/custom/implementor.md

# 3. Run migration
genie migrate

# 4. Verify customizations load
genie run implementor --dry-run  # Should include your custom logic
```

## Customization Examples

### Example 1: Project-Specific Commands

**`.genie/custom/tests.md`:**
```markdown
## Project Customization

Test commands for this project:
- Unit tests: `pnpm test:unit`
- Integration tests: `pnpm test:integration`
- E2E tests: `pnpm test:e2e`

Evidence path: `.genie/wishes/<slug>/qa/test-results/`
```

The core `tests` agent automatically loads this file and uses your commands.

### Example 2: Domain-Specific Rules

**`.genie/custom/implementor.md`:**
```markdown
## Project Customization

Domain: Healthcare (HIPAA-compliant)

Critical rules:
- All PHI must be encrypted at rest
- Audit logs required for all data access
- No console.log in production code
- Input validation mandatory (XSS/SQL injection prevention)

Evidence: Security checklist in wish QA folder
```

### Example 3: Evidence Standards

**`.genie/custom/commit.md`:**
```markdown
## Project Customization

Commit message format:
```
[TYPE-TICKET] Short description

- Detailed change 1
- Detailed change 2

Refs: JIRA-123
```

Pre-commit checks:
- `pnpm run lint`
- `pnpm run type-check`
- `pnpm test --changed`
```

## Verification Checklist

After migration, verify:

- [ ] `genie list agents` shows 25+ agents (core + your customs)
- [ ] `genie run plan --help` works (core agent from npm)
- [ ] Your custom agents still work (test with `genie run <custom-agent>`)
- [ ] Customization stubs exist at `.genie/custom/`
- [ ] `.claude/` directory references npm package (`@.genie/agents/`)
- [ ] Backup created at `.genie-backup-TIMESTAMP/`
- [ ] `git status` shows only expected changes

## Troubleshooting

### Problem: "Agent not found" errors

**Cause:** Core agents still in local `.genie/agents/` conflict with npm package

**Fix:**
```bash
# Remove local core agents
rm -rf .genie/agents/core/
rm .genie/agents/{plan,wish,forge,review,orchestrator,vibe}.md
rm -rf .genie/agents/qa/

# Rebuild CLI index
genie list agents
```

### Problem: Custom agents not working

**Cause:** Customization files not in `.genie/custom/`

**Fix:**
```bash
# Move custom logic to customization stubs
mv .genie/agents/my-custom-agent.md .genie/custom/my-custom-agent.md  # If applicable

# Or keep in .genie/agents/ (local agents directory)
# Local agents take precedence over npm
```

### Problem: Migration failed / corrupted state

**Restore from backup:**
```bash
# Find your backup
ls -la | grep genie-backup

# Restore
rm -rf .genie
mv .genie-backup-TIMESTAMP .genie

# Try migration again or contact support
```

## FAQ

**Q: Will my custom agents still work?**
A: Yes! Local agents in `.genie/agents/` take precedence over npm package agents.

**Q: Can I override core agents?**
A: Yes, copy a core agent to `.genie/agents/` and modify. Your version will be used instead.

**Q: How do I update Genie after v3.0?**
A: `npm install -g automagik-genie@latest` - your customizations are preserved.

**Q: Where do core agents live now?**
A: In the npm package at `/usr/local/lib/node_modules/automagik-genie/.genie/agents/` (example path).

**Q: Can I see core agent source?**
A: Yes! `npm root -g` shows npm package location, then navigate to `.genie/agents/`.

**Q: What if I want the old behavior?**
A: Copy all core agents to `.genie/agents/` - local agents override npm. Not recommended.

## Version Compatibility

| Genie Version | Architecture | Agent Location |
|---------------|--------------|----------------|
| v2.0.x | Old | `.genie/agents/` (all agents) |
| v3.0.0+ | New | npm package (core) + `.genie/agents/` (custom) |

**Breaking Changes in v3.0:**
- Core agents removed from project `.genie/agents/`
- New `.genie/custom/` customization injection system
- `.claude/` aliases reference npm package paths
- Migration required for v2.x projects

## Support

**Issues:**
- GitHub: https://github.com/automagik-genie/genie/issues
- Tag: `migration`, `v3.0`

**Rollback to v2.x (if needed):**
```bash
npm install -g automagik-genie@2.0.3
rm -rf .genie
mv .genie-backup-TIMESTAMP .genie
```

---

**Migration created:** 2025-10-13
**Target users:** v2.x → v3.0 upgraders
**Estimated time:** 5-10 minutes (automatic), 15-30 minutes (manual)
