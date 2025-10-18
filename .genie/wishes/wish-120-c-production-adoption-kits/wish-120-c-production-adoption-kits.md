# Wish #120-C: Production Adoption Kits (Advanced Features)

**Created:** 2025-10-18
**Parent Wish:** #120 (Forge Executor Replacement)
**Previous Wish:** #120-B (Enhanced Autonomous Features)
**GitHub Issue:** #145
**Status:** 📝 Draft (Blocked by #120-B)
**Complexity:** 🔴 HIGH
**Roadmap Alignment:** Phase 3 (Production Adoption Kits) - NEW ITEM

---

## 🎯 Mission Statement

**Deep integration features requiring careful design: Template unification, advanced inspection/audit, migration & updating neuron, and safe SSE automations.**

**Philosophy:** Production-ready adoption kits for downstream repos. These are complex features that require architectural changes but provide very high value for power users and downstream adopters.

---

## 🧩 Context & Problem Statement

### Current Limitations

**Template Fragmentation:**
- Genie has "code" and "create" modes (hardcoded templates)
- Forge has rich template system (rust-cli, nextjs, etc.)
- No unification → users confused which to use
- **User pain:** "How do I init a new project with Genie?"

**Limited Inspection:**
- `genie view <id>` shows logs only (no diffs, commits, comparisons)
- Users must manually check Git for changes
- No side-by-side comparison (before/after)
- **User pain:** "What did Genie actually change?"

**Manual Task Management:**
- Cannot rename tasks after creation
- Cannot delete failed/unwanted tasks
- No visibility into neuron state tree (parent/child relationships)
- **User pain:** "How do I clean up my tasks?"

**No Version Migration System:**
- Breaking changes require manual user action
- No automated migration scripts
- Rollback is manual (restore from backup)
- **User pain:** "Upgrade broke my setup, how do I fix?"

**No SSE Automations:**
- Events happen, but no auto-actions
- Must manually pull logs, review changes, update status
- Potential for automation, but safety concerns (destructive actions)
- **User pain:** "Can Genie just do this for me?"

### What Forge Provides

**Templates API:**
- ✅ `listTemplates()` - Discover all available templates
- ✅ `getTemplate(id)` - Get template details (files, config, setup)
- ✅ `createProjectFromTemplate(template_id)` - Initialize from template

**Advanced Git Inspection:**
- ✅ `getTaskAttemptDiff(id)` - Detailed diff view (file-by-file)
- ✅ `getTaskAttemptCommits(id)` - Commit history with messages
- ✅ `compareTaskAttempt(id, ref)` - Compare to HEAD, main, or tag

**Task Management:**
- ✅ `updateTask(id, title, description, status)` - Update task metadata
- ✅ `deleteTask(id)` - Delete task (with safety checks)
- ✅ `getTaskAttemptChildren(id)` - State tree navigation (neuron coordination)

**Migration Support:**
- Forge backend handles migrations internally
- Can expose migration status/apply endpoints
- Version management system exists

**SSE Events:**
- Already implemented in Wish #120-B
- Can add automation rules (with idempotency guarantees)

### Prior Work

**Investigation Phase (Completed):**
- ✅ All 94+ endpoints mapped (Categories 9-15 relevant for this wish)
- ✅ 3-wish split strategy defined
- ✅ Wish #120-A establishes Forge integration patterns
- ✅ Wish #120-B establishes SSE event handling

**Reference Documents:**
- Parent wish: `.genie/wishes/forge-executor-replacement/forge-executor-replacement-wish.md`
- 3-wish split strategy: `.genie/reports/3-WISH-SPLIT-STRATEGY-20251018.md` (Part 3)
- Complete endpoint mapping: `.genie/docs/forge-endpoint-mapping.md`

---

## 📦 Scope Definition

### In Scope (Advanced Capabilities)

**1. Template Unification (Forge Templates)**

**User Commands (NEW):**
```bash
genie init --template code|create|rust-cli|nextjs|...
genie templates list
genie templates show rust-cli
```

**Endpoints Used:**
| # | Endpoint | Purpose |
|---|----------|---------|
| 1 | `listTemplates()` | Discover templates |
| 2 | `getTemplate(id)` | Get template details |
| 3 | `createProjectFromTemplate(template_id)` | Init from template |

---

**2. Advanced Inspection/Audit**

**User Commands (NEW):**
```bash
genie review <id> --diff          # Show detailed diffs (file-by-file)
genie review <id> --commits       # Inspect commit history
genie review <id> --compare HEAD  # Compare to HEAD, main, or tag
```

**Endpoints Used:**
| # | Endpoint | Purpose |
|---|----------|---------|
| 4 | `getTaskAttemptDiff(id)` | Detailed diff view |
| 5 | `getTaskAttemptCommits(id)` | Commit history |
| 6 | `compareTaskAttempt(id, ref)` | Compare branches |

---

**3. Advanced Task Management**

**User Commands (NEW):**
```bash
genie task update <id> --title "New title"
genie task update <id> --description "New desc"
genie task delete <id>
genie task children <id>   # Show child attempts (neuron tree)
```

**Endpoints Used:**
| # | Endpoint | Purpose |
|---|----------|---------|
| 7 | `updateTask(id, title, description, status)` | Update task |
| 8 | `deleteTask(id)` | Delete task |
| 9 | `getTaskAttemptChildren(id)` | State tree |

---

**4. Migration & Updating Neuron**

**User Commands (NEW):**
```bash
genie update check         # Check for updates
genie update apply         # Apply version migration
genie rollback <version>   # Rollback to previous version
```

**Architecture:**
- `/update` directory with version files (diff-based)
- Updating neuron (specialized agent for migration)
- Migration scripts (data transformation, config updates)
- Rollback capability (restore previous state)

**Endpoints Used (if exposed):**
| # | Endpoint | Purpose |
|---|----------|---------|
| 10 | `getMigrationStatus()` | Check migration requirements |
| 11 | `applyMigration(version)` | Execute migration |
| 12 | `rollbackMigration(version)` | Rollback changes |

---

**5. SSE Automations (Safe Auto-Actions)**

**Automations (NEW):**
- Auto-pull logs on task completion
- Auto-open review on PR creation
- Auto-update wish status on events
- (Requires idempotency + retry logic)

**Examples:**
```yaml
# .genie/automations.yml
automations:
  - event: task_attempt.completed
    action: pull_logs
    idempotent: true

  - event: pull_request.created
    action: open_review
    requires_approval: true

  - event: task_attempt.failed
    action: notify_user
    channels: [omni, cli]
```

**Endpoints Used:**
- Already implemented in Wish #120-B (`subscribeToEvents()`)
- Add automation engine on top of SSE listener

---

### Out of Scope (Future Work)

**NOT in this wish:**
- ❌ Drafts/Checkpoints (needs validation - Discovery #6)
- ❌ MCP unification (Genie MCP vs. Forge MCP coordination)
- ❌ WebSocket streaming (OUT OF SCOPE per decision matrix)
- ❌ Container management (internal-only per decision matrix)

**Principle:** Focus on high-impact features with clear use cases. Defer uncertain features.

---

## 🔍 Discovery Phase (Strategic Investigations)

### Discovery #4: Templates Inventory

**Priority:** 🟠 HIGH
**Blocking:** Template unification
**Complexity:** MEDIUM-HIGH (impacts Wish #110 - Template System)

**Problem:**
- Genie has "code" and "create" modes (hardcoded)
- Forge has template system (rust-cli, nextjs, etc.)
- Need unification strategy: merge, keep separate, or hybrid?

**Investigation Tasks:**
1. Inventory all Forge templates (list + inspect each)
2. Compare with Genie's "code" and "create" modes
3. Identify overlap, gaps, conflicts
4. Design unification strategy (3 options):
   - **Option A:** Replace Genie modes with Forge templates
   - **Option B:** Keep both systems (Genie modes + Forge templates)
   - **Option C:** Merge systems (Genie modes become Forge templates)

**Deliverable:**
- `.genie/discovery/templates-inventory.md`
  - Complete Forge template catalog
  - Genie mode vs. Forge template comparison
  - Unification strategy recommendation (A, B, or C)
  - Migration plan (if merging)

**Success Criteria:**
- [ ] All Forge templates inventoried
- [ ] Comparison complete (overlap, gaps, conflicts)
- [ ] Unification strategy decided
- [ ] Migration plan (if needed)

---

### Discovery #5: MCP Unification

**Priority:** 🟡 MEDIUM
**Blocking:** MCP server coordination
**Complexity:** MEDIUM (coordination between systems)

**Problem:**
- Genie MCP servers (git, genie, implementor, etc.)
- Forge MCP server (forge-mcp-server)
- Need coordination: which MCP server handles what?

**Investigation Tasks:**
1. Inventory all Genie MCP servers (list + capabilities)
2. Document Forge MCP server capabilities
3. Identify overlap, gaps, conflicts
4. Design coordination strategy:
   - **Option A:** Genie MCP servers delegate to Forge MCP
   - **Option B:** Keep separate (Genie MCP for UI, Forge MCP for backend)
   - **Option C:** Merge MCP servers (Genie becomes thin client)

**Deliverable:**
- `.genie/discovery/mcp-unification.md`
  - Genie MCP server inventory
  - Forge MCP server capabilities
  - Overlap/gap analysis
  - Coordination strategy recommendation (A, B, or C)

**Success Criteria:**
- [ ] All MCP servers inventoried
- [ ] Overlap/gap analysis complete
- [ ] Coordination strategy decided

---

### Discovery #6: Drafts Validation

**Priority:** 🟢 LOW
**Blocking:** Drafts feature (low priority)
**Complexity:** LOW (mostly user research)

**Problem:**
- Forge has "drafts" concept (checkpoints during work)
- Unclear if this adds value vs. task attempts
- Need validation: do users want checkpoints?

**Investigation Tasks:**
1. Validate if checkpoints add value (user interviews)
2. Compare drafts vs. Git commits (what's different?)
3. Design use cases (when would users create drafts?)
4. Go/no-go decision on drafts feature

**Deliverable:**
- `.genie/discovery/drafts-validation.md`
  - User research findings
  - Drafts vs. commits comparison
  - Use cases identified (or none)
  - Go/no-go recommendation

**Success Criteria:**
- [ ] User research complete (5+ interviews)
- [ ] Use cases identified (or decision to skip)
- [ ] Go/no-go decision made

---

### Discovery #7: SSE Automations Catalog

**Priority:** 🟠 HIGH
**Blocking:** Safe auto-actions
**Complexity:** MEDIUM-HIGH (safety-critical)

**Problem:**
- SSE events enable automation (Wish #120-B established listener)
- Need catalog of safe auto-actions (avoid destructive actions)
- Idempotency required (retry logic safe)

**Investigation Tasks:**
1. Catalog all potential automations (event → action mapping)
2. Classify by safety (safe, requires-approval, never-automate)
3. Design idempotency logic (ensure retries are safe)
4. Create automation templates (YAML config)

**Deliverable:**
- `.genie/discovery/sse-automations-catalog.md`
  - Complete automation catalog (20+ automations)
  - Safety classification (safe, approval, never)
  - Idempotency logic design
  - Automation templates (YAML)

**Success Criteria:**
- [ ] All automations cataloged and classified
- [ ] Idempotency logic designed (retry-safe)
- [ ] Templates created (YAML config)

---

## 🏗️ Implementation Plan

### Group A: Templates (Unification)

**Tasks:**

1. **Templates discovery investigation**
   - Execute Discovery #4
   - Inventory all Forge templates
   - Compare with Genie modes
   - Decide unification strategy

2. **Design unification strategy**
   - Based on Discovery #4 findings
   - Document architecture (how templates integrate)
   - Plan migration (if merging systems)

3. **Implement template system**
   - Add `genie templates list` command
   - Add `genie templates show <id>` command
   - Add `genie init --template <id>` command
   - Integrate with Forge `listTemplates()`, `getTemplate()`, `createProjectFromTemplate()`

4. **Migration guide (if unified)**
   - Document old Genie modes → new template system
   - Provide conversion scripts (if needed)
   - User communication (deprecation timeline)

---

### Group B: Advanced Inspection

**Tasks:**

5. **Implement detailed diff view**
   - Add `genie review <id> --diff` command
   - Call `getTaskAttemptDiff(id)`
   - Display file-by-file diffs (color-coded)
   - Pagination (for large diffs)

6. **Implement commit inspection**
   - Add `genie review <id> --commits` command
   - Call `getTaskAttemptCommits(id)`
   - Display commit history (table format)
   - Show: SHA, author, date, message

7. **Implement compare to HEAD**
   - Add `genie review <id> --compare <ref>` command
   - Call `compareTaskAttempt(id, ref)` (ref = HEAD, main, tag)
   - Display comparison (files changed, additions, deletions)
   - Side-by-side view (optional)

---

### Group C: Task Management

**Tasks:**

8. **Implement task update**
   - Add `genie task update <id> --title "..." --description "..."` command
   - Call `updateTask(id, title, description, status)`
   - Display confirmation (updated fields)

9. **Implement task delete**
   - Add `genie task delete <id>` command
   - Call `deleteTask(id)` (with safety checks)
   - Confirm before deletion (CLI prompt)
   - Display success message

10. **Implement task children (state tree)**
    - Add `genie task children <id>` command
    - Call `getTaskAttemptChildren(id)`
    - Display neuron state tree (parent → children)
    - Visualize tree structure (ASCII art or table)

---

### Group D: Migration & Updating

**Tasks:**

11. **Design /update directory structure**
    - Create `/update` directory
    - Version files (diff-based): `v2.3.0-to-v2.4.0.diff`
    - Migration scripts: `migrate-v2.3.0-to-v2.4.0.sh`
    - Rollback scripts: `rollback-v2.4.0-to-v2.3.0.sh`

12. **Implement version files (diff-based)**
    - Document structure (YAML with before/after)
    - Include: config changes, file moves, schema updates
    - Validation logic (check version compatibility)

13. **Implement updating neuron**
    - Create `.genie/agents/neurons/updating/updating.md`
    - Specialized agent for migration execution
    - Handles: version check, apply migration, rollback
    - Safety: dry-run mode, backup before migration

14. **Implement migration scripts**
    - `genie update check` - Check for updates
    - `genie update apply` - Apply migration (with dry-run option)
    - `genie rollback <version>` - Rollback to previous version
    - Integrate with updating neuron

15. **Document rollback plan**
    - `.genie/docs/version-migration.md`
    - Rollback procedure (step-by-step)
    - Backup recommendations
    - Common issues + fixes

---

### Group E: SSE Automations

**Tasks:**

16. **SSE automations discovery**
    - Execute Discovery #7
    - Catalog all potential automations
    - Classify by safety (safe, approval, never)

17. **Design idempotency logic**
    - Ensure retries are safe (no duplicate actions)
    - Track automation execution (state management)
    - Timeout logic (cancel if too long)

18. **Implement safe auto-actions (5-10 automations)**
    - Auto-pull logs on completion
    - Auto-open review on PR created
    - Auto-notify on failure
    - (Based on Discovery #7 catalog)

19. **Add user configuration (enable/disable per automation)**
    - Config file: `.genie/automations.yml`
    - Enable/disable per automation
    - Approval requirements (some automations require user approval)
    - Logging (track automation execution)

---

### Group F: Testing

**Tasks:**

20. **Templates tests**
    - List all templates
    - Get template details
    - Init from template (create project)

21. **Inspection tests**
    - Detailed diff view
    - Commit inspection
    - Compare to HEAD/main/tag

22. **Task management tests**
    - Update task (title, description, status)
    - Delete task (with safety checks)
    - Task children (state tree navigation)

23. **Migration tests (critical)**
    - Version check
    - Apply migration (dry-run + real)
    - Rollback (restore previous version)
    - Edge cases (corrupted state, version mismatch)

24. **Automation tests (safety-critical)**
    - Idempotency (retry-safe)
    - Timeout logic
    - User approval flow
    - Logging (execution tracking)

---

## ✅ Success Criteria

### Functional Requirements

- [ ] **Templates:** Unified system working (or decision documented if keeping separate)
- [ ] **Advanced Inspection:** Diff, commits, compare all working
- [ ] **Task Management:** Update, delete, children all working
- [ ] **Migration System:** Version check, apply, rollback all functional (0% data loss)
- [ ] **SSE Automations:** Safe auto-actions working (idempotent, retry-safe)

### User Impact Requirements

- [ ] **Templates:** Users can init projects from Forge templates (adoption > 50%)
- [ ] **Inspection:** Users review changes visually (adoption > 70%)
- [ ] **Task Management:** Users manage tasks via CLI (adoption > 40%)
- [ ] **Seamless Upgrades:** < 5% rollback rate (users upgrade without issues)
- [ ] **Automations:** Users save time (measurable reduction in manual steps)

### Code Quality Requirements

- [ ] **All Tests Passing:** Critical paths tested (templates, migration, automation)
- [ ] **Documentation Complete:** Adoption kits (upgrade guides, migration docs, automation examples)
- [ ] **Downstream Adopters Satisfied:** Feedback from 3+ downstream repos (positive)

---

## 📊 Complexity Assessment

**Overall Complexity:** 🔴 HIGH

**Dimensions:**

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Technical Complexity** | 🔴 HIGH | Architectural changes (templates, migration, automation) |
| **Integration Points** | 🔴 HIGH | ~30 endpoints across 5 features |
| **Discovery Required** | 🟡 MEDIUM | 4 discoveries (2 HIGH, 2 MEDIUM) |
| **Risk Level** | 🟡 MEDIUM-HIGH | Migration has data loss risk (mitigated with rollback) |
| **Dependencies** | 🟡 MEDIUM | Wish #120-A and #120-B must complete first |

**Total Tasks:** 24 (4 templates, 3 inspection, 3 task management, 5 migration, 4 automation, 5 testing)

---

## 🚨 Risks & Mitigations

### Risk #1: Templates Cannot Unify

**Probability:** MEDIUM
**Impact:** MEDIUM (keep separate systems - not ideal but safe)

**Mitigation:**
- Discovery #4 validates if unification is possible
- Keep both systems if unification too complex
- Document decision clearly (why separate)

---

### Risk #2: Migration Breaks Downstream

**Probability:** MEDIUM
**Impact:** HIGH (downstream repos broken)

**Mitigation:**
- Extensive testing (dry-run mode, rollback capability)
- Adoption kits (detailed upgrade guides)
- Communication (deprecation timeline, breaking changes)
- Rollback always available (< 5% rollback rate target)

---

### Risk #3: SSE Automations Destructive

**Probability:** LOW
**Impact:** HIGH (data loss, unwanted actions)

**Mitigation:**
- Idempotency design (retries are safe)
- Dry-run mode (preview actions)
- User approval gates (for risky actions)
- Logging (track all automation execution)
- Kill switch (disable all automations if needed)

---

## 🗺️ Roadmap Alignment

**Phase 3 - Adoption Kits for Downstream Repos:** ✅ Perfect Fit

**How This Wish Aligns:**
- ✅ **Migration tools:** Upgrade notes, migration diffs, rollback guidance
- ✅ **Advanced features:** Template system, updating neuron, automation
- ✅ **Production-ready:** Adoption kits for downstream repos

**Roadmap Item (proposed):**
> **Production Adoption Kits (Wish #120-C)**
> - Unified template system (Forge + Genie templates)
> - Automated version migration with rollback support
> - Advanced inspection and audit tools for code review
> - Safe SSE automations for common workflow tasks
> - Complete upgrade guides and migration scripts for downstream adopters
> - MCP unification strategy (Genie ↔ Forge coordination)

**Deliverables for Roadmap:**
- Template unification (or decision document)
- Migration system (version files, updating neuron, rollback)
- Advanced inspection tools (diff, commits, compare)
- SSE automation engine (safe auto-actions)
- Adoption kits (upgrade guides, migration docs, examples)

---

## 📚 Reference Documents

**Parent Wish:**
- `.genie/wishes/forge-executor-replacement/forge-executor-replacement-wish.md`

**Investigation Reports:**
- `.genie/reports/3-WISH-SPLIT-STRATEGY-20251018.md` (Part 3 - this wish)
- `.genie/reports/FORGE-GENIE-INTEGRATION-ANALYSIS-20251018.md` (endpoint analysis)

**Endpoint Documentation:**
- `.genie/docs/forge-endpoint-mapping.md` (Categories 9-15 relevant)
- `.genie/docs/discovery-checklist.md` (Discoveries #4, #5, #6, #7)

**Dependencies:**
- Wish #120-A (Drop-In Replacement) - MUST complete first
- Wish #120-B (Enhanced Features) - MUST complete first

---

## 🎯 Definition of Done

**This wish is complete when:**

1. ✅ Templates unified (or decision documented)
2. ✅ Advanced inspection working (diff, commits, compare)
3. ✅ Task management complete (update, delete, children)
4. ✅ Migration system functional (check, apply, rollback)
5. ✅ SSE automations safe + valuable (idempotent, retry-safe)
6. ✅ Seamless upgrades (< 5% rollback rate)
7. ✅ Automations save time (measurable)
8. ✅ All tests passing (critical paths validated)
9. ✅ Documentation complete (adoption kits)
10. ✅ Downstream adopters satisfied (3+ positive feedback)
11. ✅ Done report published
12. ✅ PR merged to main

**User Experience Validation:**
```bash
# Templates:
genie init --template rust-cli
# → Project initialized from Forge template

# Advanced Inspection:
genie review <id> --diff
# → File-by-file diffs displayed

# Task Management:
genie task delete <old-failed-session>
# → Task deleted with confirmation

# Migration:
genie update apply
# → Version migrated seamlessly (or rollback available)

# Automations:
# (Session completes) → Logs auto-pulled, review auto-opened
```

**Power users love it!** 🎉

---

## 📈 Success Metrics

**Quantitative:**
- [ ] Template adoption: **> 50%** of new projects use templates
- [ ] Inspection usage: **> 70%** of reviews use advanced inspection
- [ ] Task management: **> 40%** of users manage tasks via CLI
- [ ] Migration success: **< 5%** rollback rate (95%+ smooth upgrades)
- [ ] Automation value: **> 30%** reduction in manual steps (measured)

**Qualitative:**
- [ ] Downstream repos report: "Migration was seamless"
- [ ] Power users report: "Advanced inspection is a game-changer"
- [ ] Users report: "Automations save me 15 minutes per day"

---

## 🚀 Next Steps (After Completion)

**Immediate Follow-Ups:**
- None (final wish in #120 sequence)

**Dependencies Unlocked:**
- Forge executor replacement COMPLETE (all 3 wishes done)
- Templates can be extended (custom templates, community templates)
- Automation engine can be enhanced (custom automations, plugins)
- Migration system becomes foundation for future breaking changes

---

**Document Author:** Genie (forge/120-executor-replacement)
**Version:** 1.0.0
**Last Updated:** 2025-10-18
**Status:** 📝 Draft - Blocked by Wish #120-B (#144)
