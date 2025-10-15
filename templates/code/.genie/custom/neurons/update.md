## Project Customization

**Project:** automagik-genie
**Update workflow:** Intelligent context analysis + migration + template update

### Project-Specific Detection

```bash
# Check for old structure
if [ -d ".genie/agents/specialists" ] || [ -d ".genie/agents/utilities" ]; then
  echo "OLD: Forge-style organization (specialists/, utilities/)"
fi

if [ -f ".genie/agents/core/implementor.md" ]; then
  echo "OLD: v2.0.x structure (core agents in repo)"
fi
```

### Preserve Always

- `.genie/wishes/` - All wishes
- `.genie/reports/` - All reports
- `.genie/state/` - Session state
- `.genie/product/` - Project docs
- `.genie/standards/` - Project standards
- `.genie/agents/<custom>` - User agents

### Commands

```bash
# Test update
genie update --dry-run

# Force update (bypass checks)
genie update --force

# Rollback
rm -rf .genie && mv .genie-backup-TIMESTAMP .genie
```
