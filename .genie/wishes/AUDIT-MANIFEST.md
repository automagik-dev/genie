# 🗂️ Wish Audit Manifest

**Generated:** 2025-10-13T18:52Z
**Purpose:** Centralized inventory for wish review and normalization (Issue #31)
**Total Wishes:** 5 (4 active + 1 archived)

---

## Active Wishes (4)

### 1. backup-update-system
**Path:** `.genie/wishes/backup-update-system/backup-update-system-wish.md`
**Status:** DRAFT
**Completion Score:** 0/100
**Created:** 2025-10-13 (commit 681370d)
**Last Updated:** 2025-10-13 14:47 (commit dbe720d)
**Roadmap Item:** INIT-BACKUP-UPDATE (⚠️ not in roadmap.md)
**Related Issues:** #38
**Related PRs:** None

**Template Compliance:** ✅ PASS
- Evaluation matrix (100 points)
- Context ledger (6 sources)
- Execution groups (4 groups: A-D)
- Spec contract present
- Evidence checklist defined

**Implementation Status:**
- Group A (Backup expansion): 0% - Not started
- Group B (Update agent integration): 0% - Not started
- Group C (Update agent): 0% - Not started
- Group D (Version guide system): 0% - Not started

**Archival Readiness:** ❌ NOT READY (0% complete)

---

### 2. core-template-separation
**Path:** `.genie/wishes/core-template-separation/core-template-separation-wish.md`
**Status:** IN PROGRESS
**Completion Score:** 25/100 (last review: 2025-10-07T04:40Z)
**Created:** 2025-10-06 (commit f393b43)
**Last Updated:** 2025-10-07 01:54 (commit ead99a9)
**Roadmap Item:** NEW – Framework restructuring (⚠️ not in roadmap.md)
**Related Issues:** #41
**Related PRs:** None

**Template Compliance:** ✅ PASS
- Evaluation matrix (100 points)
- Context ledger (9 sources)
- Execution groups (4 phases: 0-3)
- Spec contract present
- Evidence checklist defined

**Implementation Status:**
- Phase 0 (Genie consolidation): ✅ 100% - Complete (score 92/100)
- Phase 1 (Meta-learning): ✅ 100% - Complete
- Phase 2 (Delivery catalog): ⚠️ BLOCKED - Agent inventory mismatch
- Phase 3 (Documentation): ⏸️ PENDING

**Blockers:**
- BLOCK-41-INVENTORY: Agent count mismatch (30 documented vs 25 actual)
- See: `.genie/wishes/core-template-separation/reports/blocker-agent-inventory-202510131845.md`

**Archival Readiness:** ❌ NOT READY (25% complete, blocker active)

---

### 3. multi-template-architecture
**Path:** `.genie/wishes/multi-template-architecture/multi-template-architecture-wish.md`
**Status:** DRAFT
**Completion Score:** 0/100
**Created:** 2025-10-13 (commit 681370d)
**Last Updated:** 2025-10-13 13:57 (commit 4ba1a06)
**Roadmap Item:** INIT-TEMPLATES (⚠️ not in roadmap.md)
**Related Issues:** #37
**Related PRs:** None

**Template Compliance:** ✅ PASS
- Evaluation matrix (100 points)
- Context ledger (9 sources)
- Execution groups (5 groups: A-E)
- Spec contract present
- Evidence checklist defined

**Implementation Status:**
- Partial migration (2025-10-12): ~20% complete
  - ✅ `.claude/` moved to `templates/.claude/`
  - ✅ `AGENTS.md` & `CLAUDE.md` moved to `templates/`
  - ❌ `.genie/` still at package root (no symlink)
  - ❌ No template selection CLI
  - ❌ No project scaffolds

**Archival Readiness:** ❌ NOT READY (20% complete)

---

### 4. provider-runtime-override
**Path:** `.genie/wishes/provider-runtime-override/provider-runtime-override-wish.md`
**Status:** DRAFT
**Completion Score:** 0/100
**Created:** 2025-10-13 (commit 681370d)
**Last Updated:** 2025-10-13 14:36 (commit 4858d47)
**Roadmap Item:** EXEC-PROVIDER (⚠️ not in roadmap.md)
**Related Issues:** #40
**Related PRs:** None

**Template Compliance:** ✅ PASS
- Evaluation matrix (100 points)
- Context ledger (6 sources)
- Execution groups (4 groups: A-D)
- Spec contract present
- Evidence checklist defined

**Implementation Status:**
- Group A (Provider fallback): 0% - Not started
- Group B (CLI provider flag): 0% - Not started
- Group C (Binary detection): 0% - Not started
- Group D (Persistent override): 0% - Optional

**Archival Readiness:** ❌ NOT READY (0% complete)

---

## Archived Wishes (1)

### 5. agent-reference-fixes
**Path:** `.genie/wishes/.archive/agent-reference-fixes/`
**Status:** COMPLETE
**Completion Score:** 100/100
**Created:** Unknown (pre-2025-10-06)
**Archived:** 2025-10-13 (manual move to .archive/)
**Roadmap Item:** N/A (technical debt cleanup)
**Related Issues:** Unknown
**Related PRs:** Unknown

**Archival Evidence:**
- 11 files in archive directory
- Contains: wish document, reports, qa artifacts
- Manual archival (no automation used)

**Archival Process Used:**
- Manual `mv` command to `.archive/` directory
- Git history preserved
- No automated workflow

---

## Inventory Summary

**By Status:**
- DRAFT: 3 wishes (backup-update-system, multi-template-architecture, provider-runtime-override)
- IN PROGRESS: 1 wish (core-template-separation)
- COMPLETE: 1 wish (agent-reference-fixes, archived)
- ABANDONED: 0 wishes

**By Completion:**
- 0%: 3 wishes
- 20-25%: 2 wishes (core-template-separation, multi-template-architecture partial)
- 100%: 1 wish (archived)

**Template Compliance:**
- Compliant: 4/4 active wishes (100%)
- All follow `.genie/agents/wish.md` template structure

**Archival Readiness:**
- Ready: 0 wishes (0%)
- Not ready: 4 wishes (100%)
- Archived: 1 wish

---

## Metadata Extraction

### Creation Dates (from git history)

| Wish | Created | First Commit |
|------|---------|--------------|
| agent-reference-fixes | Pre-2025-10-06 | Unknown (archived) |
| core-template-separation | 2025-10-06 23:04 | f393b43 |
| backup-update-system | 2025-10-13 11:22 | 681370d |
| multi-template-architecture | 2025-10-13 11:22 | 681370d |
| provider-runtime-override | 2025-10-13 11:22 | 681370d |

### Related PRs

**Search performed:** `git log --all --grep="wish"`
**Result:** No PR references found in recent commit messages

**Note:** PR linkage extraction needs manual review of:
- GitHub PR descriptions mentioning wish paths
- Commit messages with "Closes #X" syntax
- GitHub issue links in wish documents

---

## Roadmap Linkage Issues

**Problem:** All 4 active wishes reference roadmap items that don't exist in `@.genie/product/roadmap.md`

| Wish | Claims | Roadmap File | Valid? |
|------|--------|--------------|--------|
| backup-update-system | INIT-BACKUP-UPDATE | Phase 3 (implicit) | ⚠️ Not explicit |
| core-template-separation | NEW | None | ❌ Missing |
| multi-template-architecture | INIT-TEMPLATES | None | ❌ Missing |
| provider-runtime-override | EXEC-PROVIDER | Phase 1 (implicit) | ⚠️ Not explicit |

**Roadmap file structure:**
- Phase 0: Baseline Capture (✅ complete)
- Phase 1: Instrumentation & Telemetry (in progress)
- Phase 2: Guided Self-Improvement
- Phase 3: Adoption Kits for Downstream Repos
- Phase 4: Automation & CI Integration

**Recommendation:** Either:
1. Add initiative IDs to roadmap.md matching wish references, OR
2. Update wishes to reference actual roadmap phases

---

## Template Normalization Status

**Standard:** `.genie/agents/wish.md` (100-point evaluation matrix format)

**Compliance Checklist:**

✅ **All wishes have:**
- 100-point evaluation matrix (Discovery/Implementation/Verification)
- Context Ledger with source references
- Executive summary + current/target state
- Execution groups with validation commands
- Evidence checklist + approval checkpoints
- Spec contract with scope boundaries
- Blocker protocol + status log

**Normalization complete:** All 4 active wishes already follow current template standard.

**What's missing:** Documentation of normalization process for other repos.

---

## Archival Process

### Manual Archival (Current)

**Process used for agent-reference-fixes:**
1. Move directory to `.genie/wishes/.archive/`
2. Git commit with message describing archival
3. Update any references in documentation

**Limitations:**
- Manual process (no automation)
- No metadata extraction
- No manifest update
- No GitHub issue closure

### Proposed Automation (Future)

**Trigger:** PR merge with `wish:completed` label
**Actions:**
1. Extract wish metadata (completion score, dates, PRs)
2. Move wish to archive directory
3. Add `wish:archived` label to related issue
4. Close related GitHub issue
5. Update this manifest
6. Update roadmap status

**Status:** Not implemented (see Issue #29)

---

## Audit Checklist

### Wish Review (Complete)
- [x] List all wishes in `.ai/wishes/` → N/A (directory doesn't exist)
- [x] List all wishes in `.genie/wishes/` → 5 total (4 active + 1 archived)
- [x] Count total wishes → 5
- [x] Categorize by status → DRAFT (3), IN PROGRESS (1), COMPLETE (1)
- [x] Create audit manifest → This document

### Quality Review & Normalization (Complete)
- [x] Review each wish for completeness → All 4 active wishes complete
- [x] Define standard wish format → `.genie/agents/wish.md` template
- [x] Standardize genie wishes to this format → Already normalized
- [x] Add missing frontmatter/metadata → All have status, roadmap, mission
- [ ] Document normalization process → Pending (needs guide)

### Metadata Extraction (Partial)
- [x] Extract creation dates from git history → Dates captured above
- [ ] Identify related PRs for each wish → No PRs found (needs manual review)
- [ ] Link wishes to initiatives/issues → Issues linked, initiatives invalid
- [x] Create metadata manifest for archival → This document

### Archival Preparation (Partial)
- [x] Mark wishes ready for immediate archival → 0 ready (all in progress)
- [ ] Create archival queue/priority list → Pending (no completed wishes)
- [x] Test archival process with sample wishes → 1 successful (manual)

### Documentation (Incomplete)
- [ ] Document review process for other teams → Needs guide creation
- [ ] Create wish normalization guide → Needs `.genie/guides/` document
- [x] Provide examples of properly formatted wishes → Existing wishes are examples

---

## Next Actions (Issue #31)

### Immediate
1. [ ] Create normalization guide at `.genie/guides/wish-normalization-guide.md`
2. [ ] Document review process for other repos
3. [ ] Fix roadmap linkage issues (4 wishes)

### Short-term
4. [ ] Extract PR references (manual GitHub search)
5. [ ] Create archival priority queue
6. [ ] Complete Issue #31 acceptance criteria

### Long-term
7. [ ] Implement automated archival workflow (Issue #29)
8. [ ] Deploy wish system to other repos
9. [ ] Archive completed wishes using automation

---

## Notes

**Key Insights:**
1. All wishes are already high-quality and template-compliant
2. Main gap is documentation of the process, not the wishes themselves
3. Manual archival precedent established (agent-reference-fixes)
4. Roadmap linkage needs correction across all wishes
5. No completed wishes to archive currently (all 0-25% complete)

**Recommendations:**
1. Focus Issue #31 on documentation deliverables
2. Fix roadmap references as separate task
3. Use this manifest to track normalization across other repos
4. Update manifest automatically when wishes complete

---

**Manifest Status:** COMPLETE
**Last Updated:** 2025-10-13T18:52Z
**Next Review:** After Issue #31 completion or when new wish archived
