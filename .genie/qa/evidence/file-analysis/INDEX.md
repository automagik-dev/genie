# Per-File Analysis Index

**Generated:** 2025-10-16 12:31 UTC
**Total files:** 132
**Coverage:** 100%

This directory contains individual 6-dimension analysis reports for every `.genie/*.md` file.

## 6-Dimension Analysis Framework

Each file analyzed across:

1. **Redundancy Check** - Line-level duplication, repeated patterns
2. **Excessive @ Usage** - Too many file attachments (>10)
3. **Missing @ References** - File mentions without @ attachment
4. **Knowledge Graph Position** - Hub/Leaf/Loader role, dependencies
5. **! Command Opportunities** - Static data → dynamic patterns
6. **Slash Command Opportunities** - Command invocation patterns

## Quick Access by Category

### Hub Files (Most Referenced)

- [product_mission.md](product_mission.md) - 9 incoming deps
- [standards_best_practices.md](standards_best_practices.md) - 8 incoming deps
- [product_roadmap.md](product_roadmap.md) - 5 incoming deps
- [custom_routing.md](custom_routing.md) - 4 incoming deps

### Heavy Loaders (Most @ Refs)

- [UPDATE.md](UPDATE.md) - 17 outgoing refs
- [wishes_core_template_separation_core_template_separation_wish.md](wishes_core_template_separation_core_template_separation_wish.md) - 15 outgoing refs
- [wishes_provider_runtime_override_provider_runtime_override_wish.md](wishes_provider_runtime_override_provider_runtime_override_wish.md) - 13 outgoing refs
- [wishes_backup_update_system_backup_update_system_wish.md](wishes_backup_update_system_backup_update_system_wish.md) - 12 outgoing refs

### Files with ! Commands

- [CONTEXT.md](CONTEXT.md) - 8 commands
- [agents_neurons_release.md](agents_neurons_release.md) - 4 commands
- [qa_checklist.md](qa_checklist.md) - 1 command
- [reports_01_runtime_command_learn.md](reports_01_runtime_command_learn.md) - 13 commands
- [templates_context_template.md](templates_context_template.md) - 8 commands

### High Priority Issues

**High Redundancy (40 files):**
- [reports_update_agent_analysis_202510132400.md](reports_update_agent_analysis_202510132400.md)
- [agents_neurons_implementor.md](agents_neurons_implementor.md)
- [agents_workflows_wish.md](agents_workflows_wish.md)
- [agents_neurons_install.md](agents_neurons_install.md)
- [agents_neurons_modes_audit.md](agents_neurons_modes_audit.md)
- [agents_neurons_modes_challenge.md](agents_neurons_modes_challenge.md)
- ... (see individual reports)

**Excessive @ Usage (10 files):**
- [wishes__archive_2025_10_natural_routing_skills_natural_routing_skills_wish.md](wishes__archive_2025_10_natural_routing_skills_natural_routing_skills_wish.md)
- [agents_neurons_install.md](agents_neurons_install.md)
- [agents_workflows_forge.md](agents_workflows_forge.md)
- [wishes_backup_update_system_backup_update_system_wish.md](wishes_backup_update_system_backup_update_system_wish.md)
- [UPDATE.md](UPDATE.md)
- ... (see individual reports)

## All Files (Alphabetical)

$(ls -1 .genie/qa/evidence/file-analysis/*.md | grep -v INDEX | sed 's|.genie/qa/evidence/file-analysis/||' | sed 's|^|- [|' | sed 's|\.md$|.md](|' | sed 's|$|&)|')

## Usage

**View specific file analysis:**
```bash
cat .genie/qa/evidence/file-analysis/<filename>.md
```

**Search for specific issues:**
```bash
# Find all high redundancy files
grep -l "Redundancy Check: HIGH" .genie/qa/evidence/file-analysis/*.md

# Find all excessive @ usage
grep -l "Excessive @ Usage: HIGH\|Excessive @ Usage: MEDIUM" .genie/qa/evidence/file-analysis/*.md

# Find ! command opportunities
grep -l "! Command Opportunities: HIGH\|! Command Opportunities: MEDIUM" .genie/qa/evidence/file-analysis/*.md
```

## Related Documents

- **Master Audit Report:** `.genie/qa/evidence/knowledge-graph-audit-20251016123107.md`
- **Visual Dependency Graph:** `.genie/qa/evidence/knowledge-graph-visual.mermaid`
- **Implementation Plan:** See master audit report Phase 1-3

---

*Auto-generated index for knowledge graph audit*
