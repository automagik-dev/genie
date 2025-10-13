# 🧞 Genie Init Enhancement Wishes – Summary

**Created:** 2025-10-12
**Status:** Ready for review
**Total Wishes:** 3 active

---

## Changelog

### 2025-10-13: Archived agent-reference-fixes
**Reason:** Completed wish (100/100 on 2025-10-07) superseded by core-template-separation Phase 0.

All fixes for broken wrapper references were incorporated into the ongoing core-template restructuring work. The wish served its purpose and has been moved to `.genie/wishes/.archive/agent-reference-fixes/` for historical reference.

**Evidence:** Wish completion score 100/100, all validation commands passed, work integrated into parent initiative.

---

## Overview

Three comprehensive wishes have been created based on your planning brief, breaking down the init enhancement initiative into independent, parallel-executable work streams:

1. **Backup & Update System** – Enhanced backups + version migration agent
2. **Multi-Template Architecture** – Separate dev from distribution + project-type scaffolds
3. **Provider Runtime Override** – Flexible executor selection with intelligent fallbacks

Each wish is production-ready with:
- ✅ Complete discovery context and assumptions
- ✅ Detailed execution groups with validation commands
- ✅ Evidence storage conventions and approval checkpoints
- ✅ Spec contracts defining scope and success metrics
- ✅ Proposals for refinement addressing your open questions

---

## Wish 1: Enhanced Backup & Update System
**Path:** `.genie/wishes/backup-update-system/backup-update-system-wish.md`

### Scope
- Backup expansion: Include `AGENTS.md` and `CLAUDE.md` in snapshots
- `genie update` command: Automate npm upgrade + trigger update agent
- `update.md` agent: Intelligently merge framework updates with user customizations
- Version-specific update guides: Tailored migration instructions per release

### Execution Groups (4)
- **Group A:** Backup enhancement – Add root docs to snapshots
- **Group B:** Update CLI – Implement `genie update` command flow
- **Group C:** Update agent – Create merge logic with conflict detection
- **Group D:** Update templates – Version-specific migration guide system

### Key Decisions Made (from your clarifications)
1. **Always backup** – Users' `AGENTS.md`/`CLAUDE.md` customizations preserved
2. **Tailored update agent** – Ships per-release with version-specific instructions
3. **Cherry-pick strategy** – Pre-loaded in agent instructions, compares structure automatically
4. **Integration point** – `genie update` triggers agent after npm upgrade

### Next Steps
- Review backup directory structure proposal (`root-docs/` subfolder)
- Approve update agent merge strategies (auto/interactive/preserve modes)
- Validate version-specific guide format

---

## Wish 2: Multi-Template Architecture
**Path:** `.genie/wishes/multi-template-architecture/multi-template-architecture-wish.md`

### Scope
- Template separation: Move `.genie/` → `templates/base/.genie/` (cleaned)
- Project-type scaffolds: Next.js, Rust CLI templates with complete project files
- Template selection: `genie init --template <type>` CLI
- Independent versioning: `template.json` tracks version + framework compatibility

### Execution Groups (5)
- **Group A:** Template restructure – Separate framework dev from distribution
- **Group B:** Next.js template – Complete Next.js 15 + Genie scaffold
- **Group C:** Template selection CLI – Implement discovery and init flow
- **Group D:** Template versioning – Independent semver + compatibility checks
- **Group E:** Rust CLI template – Extensibility demonstration

### Key Decisions Made
4. **Base template cleanup** – Strip Genie-specific context from `.genie/custom/`
5. **Complete scaffolds** – Templates include full project structure (not just `.genie/` overlay)
6. **Template versioning** – Independent semver (e.g., nextjs v1.2.0 on framework v2.0.3)

### Proposals Included
- **CLI structure:** Flags vs subcommands (recommended: flags for simplicity)
- **Version format:** Independent semantic versioning
- **Template scope:** Complete scaffolds (package.json, src/, etc.)
- **Discovery order:** Package-bundled only for v1

### Next Steps
- Approve template restructure plan (symlink for framework dev)
- Review Next.js template structure and dependencies
- Finalize template versioning strategy (semver vs coupled)

---

## Wish 3: Provider Runtime Override
**Path:** `.genie/wishes/provider-runtime-override/provider-runtime-override-wish.md`

### Scope
- CLI flag override: `genie run --provider <type>` forces executor
- State file integration: Read `.genie/state/provider.json` as soft default
- Binary validation: Detect provider availability before execution
- Intelligent fallbacks: Suggest alternatives when primary unavailable

### Execution Groups (4)
- **Group A:** Provider fallback chain – State file integration + resolution logic
- **Group B:** CLI provider flag – Add `--provider` to run/resume commands
- **Group C:** Binary detection – Validate availability with helpful errors
- **Group D:** Persistent override (optional) – `genie config set provider`

### Proposals Included
7. **Fallback precedence:** CLI > Agent > State > Mode > Defaults > Fallback
8. **Binary detection:** Validate by default, `--no-validate` escape hatch
9. **State file update:** Separate ephemeral (CLI flag) from persistent (config command)

### Options Explained (Question #9)
- **Binary detection methods:** Command-line `which`/`where` (cross-platform)
- **Validation timing:** Before every execution (default) with opt-out
- **Error messages:** Actionable format with alternative commands

### Next Steps
- Approve fallback chain precedence order
- Review binary detection strategy (platform compatibility)
- Decide if Group D (persistent override) is required or optional

---

## Cross-Wish Dependencies

### Wish 1 → Wish 2
- Update agent (Wish 1 Group C) can handle template structure migrations
- Template versioning (Wish 2 Group D) uses similar pattern as framework versioning

### Wish 2 → Wish 3
- Template selection affects provider defaults (each template can ship with preferred provider)

### All Independent
- Each wish can be forged and implemented in parallel
- No blocking dependencies between wishes

---

## Recommended Workflow

### Phase 1: Review & Refine (You)
1. Read each wish file thoroughly
2. Review proposals and make decisions:
   - Wish 1: Backup structure, merge modes, conflict handling
   - Wish 2: CLI structure, version format, template scope
   - Wish 3: Fallback order, detection strategy, persistent override
3. Approve or request changes via inline edits

### Phase 2: Forge (Genie)
```bash
# Option A: Sequential forge (safer, one at a time)
/forge @.genie/wishes/backup-update-system/backup-update-system-wish.md
/forge @.genie/wishes/multi-template-architecture/multi-template-architecture-wish.md
/forge @.genie/wishes/provider-runtime-override/provider-runtime-override-wish.md

# Option B: Parallel forge (faster, independent execution)
# Launch all three forge sessions in parallel via MCP
mcp__genie__run with agent="forge" and prompt="@.genie/wishes/backup-update-system/backup-update-system-wish.md"
mcp__genie__run with agent="forge" and prompt="@.genie/wishes/multi-template-architecture/multi-template-architecture-wish.md"
mcp__genie__run with agent="forge" and prompt="@.genie/wishes/provider-runtime-override/provider-runtime-override-wish.md"
```

### Phase 3: Implementation (Agents)
- Forge outputs execution groups with agent assignments
- Spawn implementor, tests, review agents per group
- Each wish tracks separately in `.genie/wishes/<slug>/`

### Phase 4: Integration
- Merge all three features into main after QA
- Update roadmap with completion status
- Ship coordinated release with all enhancements

---

## File Locations

```
.genie/wishes/
├── SUMMARY.md (this file)
├── backup-update-system/
│   ├── backup-update-system-wish.md
│   ├── qa/
│   └── reports/
├── multi-template-architecture/
│   ├── multi-template-architecture-wish.md
│   ├── qa/
│   └── reports/
└── provider-runtime-override/
    ├── provider-runtime-override-wish.md
    ├── qa/
    └── reports/
```

---

## Quality Checklist

Each wish includes:
- ✅ 100-point evaluation matrix (Discovery, Implementation, Verification)
- ✅ Context ledger with source references
- ✅ Discovery summary with assumptions and risks
- ✅ Executive summary and current/target state
- ✅ Detailed execution groups with validation commands
- ✅ Evidence checklist and approval checkpoints
- ✅ Spec contract with explicit scope boundaries
- ✅ Proposals addressing your open questions

---

## Next Actions

**Immediate:**
1. Review all three wish files
2. Make inline edits or flag questions
3. Approve for forge when ready

**After Approval:**
1. Run `/forge` on each wish (sequential or parallel)
2. Capture Forge task IDs in wish tracking sections
3. Launch implementation agents per Forge plan

**Post-Implementation:**
1. Run `/review` on each wish for QA validation
2. Aggregate Done Reports
3. Update roadmap completion status

---

**Status:** Awaiting your review and approval to proceed with forge phase.
