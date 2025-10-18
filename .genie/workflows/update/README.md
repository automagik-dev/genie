# Update Workflows
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
Sequential update migrations for Genie framework.

**How it works:**
- Each file migrates from one version to the next
- Updates run sequentially (e.g., rc.11 → rc.12 → rc.13 → ... → rc.21)
- Each update creates a commit with full audit trail
- Haiku LLM executes migration steps

**Naming convention:**
- `v2.4.0-rc.22.md` - Migrates from rc.21 to rc.22
- `v2.5.0.md` - Migrates from 2.4.0 to 2.5.0

**First update file:**
- Will be created for v2.4.0-rc.22 (next release after rc.21)

**Usage:**
```bash
npx automagik-genie update
```

CLI detects current version and runs all missing updates in sequence.

