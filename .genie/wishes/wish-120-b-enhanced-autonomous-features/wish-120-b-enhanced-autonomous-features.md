# Wish #120-B: Enhanced Autonomous Features (High-Value Features)

**Created:** 2025-10-18
**Parent Wish:** #120 (Forge Executor Replacement)
**Previous Wish:** #120-A (Drop-In Replacement)
**Next Wish:** #120-C (Production Adoption Kits)
**GitHub Issue:** #144
**Status:** 📝 Draft (Blocked by #120-A)
**Complexity:** 🟡 MEDIUM
**Roadmap Alignment:** Phase 2 (Enhanced Autonomous MCP Features) - NEW ITEM

---

## 🎯 Mission Statement

**Add high-value features that users will immediately love: PR automation, real-time Omni notifications, visual context via images, and executor visibility.**

**Philosophy:** Low-hanging fruits that provide 80% reduction in manual work with medium implementation effort. Users will immediately notice and appreciate these improvements.

---

## 🧩 Context & Problem Statement

### Current Limitations

**Manual PR Workflow:**
- Users must manually create PRs after Genie completes work
- No automatic PR linking to GitHub issues
- Manual merge process (switch branches, review, merge, cleanup)
- **Time cost:** ~5-10 minutes per task

**No Real-Time Awareness:**
- Users don't know when sessions complete (must poll `genie list`)
- No notifications for important events (PR created, conflicts, completion)
- **User pain:** Context switching, checking terminal repeatedly

**No Visual Context:**
- Cannot attach diagrams, screenshots, or UI mockups to wishes/reviews
- Planning discussions lack visual aids
- **User pain:** "Show, don't tell" not possible

**Executor Opacity:**
- Users don't know which executors are available
- Trial-and-error to discover working executors
- **User pain:** "Why did my session fail?" mystery

### What Forge Provides

**Git Workflow APIs:**
- ✅ `createTaskAttemptPullRequest()` - Automatic PR creation with issue linking
- ✅ `mergeTaskAttempt()` - One-click merge (no branch switching)
- ✅ `pushTaskAttemptBranch()` - Manual/integrated push to remote
- ✅ `abortTaskAttemptConflicts()` - Rollback/cleanup merge conflicts

**SSE + Omni Integration:**
- ✅ `subscribeToEvents()` - Global event stream (task started, completed, PR created, etc.)
- ✅ Omni backend already integrated - WhatsApp/Slack/Discord notifications ready

**Images API:**
- ✅ `uploadImage()` - Upload diagrams, screenshots, UI mockups
- ✅ `listImages()` - List all attachments for task
- ✅ `getImage()` - Retrieve image for display

**Executor Profiles API:**
- ✅ `listExecutorProfiles()` - Discover all available executors
- ✅ `getExecutorProfile()` - Get executor details (name, status, capabilities)

### Prior Work

**Investigation Phase (Completed):**
- ✅ All 94+ endpoints mapped (Categories 5-8 relevant for this wish)
- ✅ 3-wish split strategy defined
- ✅ Wish #120-A establishes Forge integration patterns

**Reference Documents:**
- Parent wish: `.genie/wishes/forge-executor-replacement/forge-executor-replacement-wish.md`
- 3-wish split strategy: `.genie/reports/3-WISH-SPLIT-STRATEGY-20251018.md` (Part 2)
- Complete endpoint mapping: `.genie/docs/forge-endpoint-mapping.md`

---

## 📦 Scope Definition

### In Scope (New Capabilities)

**1. Git Integration (Automatic PR Creation)**

**User Commands (NEW):**
```bash
# After genie completes task, automatically:
# - Creates PR to main
# - Links to GitHub issue
# - Includes all commits with tracing
# - Shows PR URL in terminal

# Manual control available:
genie review <id>          # Review changes + create PR
genie review approve <id>  # Approve + merge
genie review rollback <id> # Abort conflicts, rollback changes
```

**Endpoints Used:**
| # | Endpoint | Purpose |
|---|----------|---------|
| 1 | `createTaskAttemptPullRequest(id, title, body)` | Auto PR creation |
| 2 | `attachExistingPullRequest(id, pr_url)` | Link existing PR (naming convention) |
| 3 | `mergeTaskAttempt(id)` | One-click merge |
| 4 | `pushTaskAttemptBranch(id)` | Push to remote |
| 5 | `abortTaskAttemptConflicts(id)` | Rollback conflicts |

---

**2. Real-Time Notifications (Omni Integration)**

**User Experience (NEW):**
```
# User receives WhatsApp/Slack/Discord notifications:
🧞 "Genie session started: analyze (session-abc123)"
✅ "Genie session completed: analyze (session-abc123)"
🔀 "PR created: https://github.com/.../pull/456"
⚠️ "Merge conflict in session-abc123 - review needed"
```

**Endpoints Used:**
| # | Endpoint | Purpose |
|---|----------|---------|
| 6 | `subscribeToEvents()` (SSE) | Global event stream |
| - | Omni integration | Already exists in Forge (leverage existing) |

**Events Mapped:**
- `task_attempt.started` → 🧞 "Session started"
- `task_attempt.completed` → ✅ "Session completed"
- `pull_request.created` → 🔀 "PR created"
- `task_attempt.conflict` → ⚠️ "Merge conflict"

---

**3. Images as Context (Visual Planning/Review)**

**User Commands (NEW):**
```bash
genie wish attach-image ./diagram.png --label "Architecture"
genie review attach-image ./result.png --label "Final UI"
genie images list <id>
genie images view <id> <image-id>
```

**Endpoints Used:**
| # | Endpoint | Purpose |
|---|----------|---------|
| 7 | `uploadImage(file, label, task_id)` | Upload image |
| 8 | `listImages(task_id)` | List attachments |
| 9 | `getImage(image_id)` | Retrieve image |

---

**4. Executor Visibility (Dynamic Discovery)**

**User Commands (NEW):**
```bash
genie info executors
# Output:
# Available Executors:
# ✅ Claude Code (CLAUDE_CODE) - Available
# ✅ Codex (CODEX) - Available
# ❌ Gemini (GEMINI) - Unavailable (not configured)
# ✅ GPT-4 (GPT4) - Available
```

**Endpoints Used:**
| # | Endpoint | Purpose |
|---|----------|---------|
| 10 | `listExecutorProfiles()` | Discover executors |
| 11 | `getExecutorProfile(id)` | Get executor details |

---

### Out of Scope (Deferred to #120-C)

**NOT in this wish:**
- ❌ Template unification (Wish #120-C)
- ❌ Advanced inspection (detailed diffs, commit history) (Wish #120-C)
- ❌ Migration & updating agent (Wish #120-C)
- ❌ SSE automations (safe auto-actions) (Wish #120-C)
- ❌ Advanced task management (CRUD, state tree) (Wish #120-C)

**Principle:** Focus on user-facing, high-value features that are straightforward to implement.

---

## 🔍 Discovery Phase (Pre-work)

### Discovery #1: Approvals Endpoint Validation

**Priority:** 🟡 MEDIUM
**Blocking:** PR creation workflow
**Complexity:** LOW-MEDIUM (API validation)

**Problem:**
- Need to confirm Forge's approval flow matches Genie's needs
- `createApprovalRequest()` endpoint exists but behavior unclear
- May need approval gate before merging PR

**Investigation Tasks:**
1. Validate `createApprovalRequest()` payload structure
2. Test blocking behavior (wait for response vs. async)
3. Confirm context attachment (diffs, test results, branch status)
4. Design approval workflow (CLI prompt vs. Omni notification)

**Deliverable:**
- `.genie/discovery/approvals-validation.md`
  - Endpoint documentation (request/response schemas)
  - Behavior validation (blocking, timeout, policies)
  - Gap analysis (what Forge doesn't support)
  - Workaround design (if needed)

**Success Criteria:**
- [ ] Approval flow designed (Omni + CLI prompt)
- [ ] Endpoint validated or workaround documented
- [ ] Integration pattern clear (when to trigger approval)

---

### Discovery #2: SSE Event Mapping

**Priority:** 🟡 MEDIUM
**Blocking:** Omni notifications
**Complexity:** LOW (leverage existing Omni integration)

**Problem:**
- Forge emits events via SSE, need to map to Omni messages
- Event catalog unclear (which events exist, payload structure)
- Filtering needed (user config for which events to receive)

**Investigation Tasks:**
1. Document all Forge SSE events (catalog with payload schemas)
2. Map events → Omni message templates
3. Design user configuration (enable/disable per event type)
4. Design routing logic (which Omni channel per event)

**Deliverable:**
- `.genie/discovery/sse-event-mapping.md`
  - Complete event catalog (20+ events)
  - Omni message templates (emoji, text format)
  - User configuration schema
  - Routing logic (event → channel)

**Success Criteria:**
- [ ] All events documented with payloads
- [ ] Omni templates designed (WhatsApp/Slack/Discord)
- [ ] User config schema defined
- [ ] Routing logic clear

---

### Discovery #3: Executor Name Mapping

**Priority:** 🟡 MEDIUM
**Blocking:** Executor visibility
**Complexity:** LOW (simple mapping)

**Problem:**
- Forge uses profile IDs (UUIDs), not user-friendly names
- Need to map `CLAUDE_CODE` → "Claude Code", etc.
- Availability status unclear (how to check if executor is configured)

**Investigation Tasks:**
1. Get all executor profile IDs from Forge
2. Map IDs → Genie-friendly names
3. Design availability check (configured vs. unconfigured)
4. Create name mapping specification

**Deliverable:**
- `.genie/discovery/executor-name-mapping.md`
  - Complete profile ID → name mapping
  - Availability check logic
  - Name mapping specification (config file or hardcoded)

**Success Criteria:**
- [ ] All executor IDs mapped to names
- [ ] Availability logic designed
- [ ] Mapping specification clear

---

## 🏗️ Implementation Plan

### Group A: Git Integration (PR Automation)

**Tasks:**

1. **Implement PR creation workflow**
   - Add `genie review <id>` command (view changes + create PR)
   - Call `createTaskAttemptPullRequest()` with title, body (auto-generated from commits)
   - Link to GitHub issue (parse from branch name or commit messages)
   - Display PR URL in terminal

2. **Implement PR approval gate (pre-merge)**
   - Integrate with `createApprovalRequest()` (Discovery #1 findings)
   - CLI prompt: "Approve merge? [y/N]"
   - Omni notification with approve/reject buttons (if supported)
   - Block merge until approved

3. **Implement merge automation**
   - Add `genie review approve <id>` command
   - Call `mergeTaskAttempt()` (one-click merge)
   - Handle merge conflicts (detect, notify user)
   - Success message with merged commit SHA

4. **Implement conflict rollback**
   - Detect merge conflicts from `mergeTaskAttempt()` response
   - Add `genie review rollback <id>` command
   - Call `abortTaskAttemptConflicts()` (cleanup)
   - Restore branch to pre-merge state

5. **Add `genie review` command suite**
   - `genie review <id>` - View changes + create PR
   - `genie review approve <id>` - Approve + merge
   - `genie review rollback <id>` - Rollback conflicts
   - Tab completion, help text, error handling

---

### Group B: Omni Notifications (Real-Time Awareness)

**Tasks:**

6. **Implement SSE listener (background service)**
   - Call `subscribeToEvents()` on Genie CLI startup
   - Maintain persistent connection (auto-reconnect on disconnect)
   - Parse event payloads, route to handlers
   - Run in background (non-blocking)

7. **Map Forge events → Omni messages**
   - Implement based on Discovery #2 findings
   - Event handlers for: task_attempt.started, completed, PR created, conflict
   - Omni message formatting (emoji, concise text)
   - Route to correct Omni channel (user config)

8. **Add event filtering (user config)**
   - User config file: `.genie/config.json` (or env vars)
   - Enable/disable per event type
   - Configure Omni channels (WhatsApp/Slack/Discord)
   - Debouncing (avoid spam)

9. **Add `genie watch` command (optional terminal output)**
   - Display events in terminal (tail -f style)
   - Filter by session ID or event type
   - Color-coded output (green=completed, red=failed, blue=info)
   - CTRL+C to stop watching

---

### Group C: Images (Visual Context)

**Tasks:**

10. **Implement image upload**
    - Add `genie wish attach-image <path> --label "..."` command
    - Validate file (PNG, JPG, GIF, size < 10MB)
    - Call `uploadImage()` with file + label + task_id
    - Display upload confirmation (image ID, URL)

11. **Implement image listing**
    - Add `genie images list <id>` command
    - Call `listImages(task_id)`
    - Display table: Image ID | Label | Size | Uploaded
    - Color-coded labels

12. **Add `genie wish attach-image` command**
    - During wish creation (integrate with wish agent)
    - Upload image, attach to wish document
    - Markdown reference: `![Architecture](image-id)`

13. **Add `genie review attach-image` command**
    - During review (integrate with review agent)
    - Upload image, attach to review
    - Compare before/after screenshots

---

### Group D: Executor Info (Visibility)

**Tasks:**

14. **Implement dynamic executor discovery**
    - Call `listExecutorProfiles()` on `genie info executors`
    - Map profile IDs → Genie-friendly names (Discovery #3 findings)
    - Check availability (configured vs. unconfigured)
    - Cache results (TTL: 5 minutes)

15. **Add `genie info executors` command**
    - Display table: Name | ID | Status | Capabilities
    - Color-coded status (green=available, red=unavailable)
    - Filter by availability (--available, --all)
    - Help text with setup instructions for unavailable executors

---

### Group E: Testing & Validation

**Tasks:**

16. **Git integration tests**
    - PR creation (auto + manual)
    - Approval flow (approve + reject)
    - Merge automation (success + conflict)
    - Rollback (conflict cleanup)

17. **SSE listener tests**
    - Event subscription (connect + reconnect)
    - Event parsing (all event types)
    - Omni message formatting (WhatsApp/Slack/Discord)
    - Filtering (user config)

18. **Image upload tests**
    - File validation (formats, size limits)
    - Upload success (all formats)
    - Listing (multiple images)
    - Display (Markdown rendering)

19. **Executor discovery tests**
    - List all profiles
    - Name mapping (all executors)
    - Availability check (configured vs. unconfigured)
    - Cache behavior (TTL)

---

## ✅ Success Criteria

### Functional Requirements

- [ ] **PR Creation:** Automatic + manual PR creation working (100% success rate)
- [ ] **Omni Notifications:** Events delivered to WhatsApp/Slack/Discord (< 5s latency)
- [ ] **Images:** Upload, list, display working (all formats: PNG, JPG, GIF)
- [ ] **Executor Info:** Dynamic discovery + availability check working

### User Impact Requirements

- [ ] **PR Automation:** 80% reduction in manual PR steps (measured via user survey)
- [ ] **Real-Time Awareness:** Users notified of session completion without polling
- [ ] **Visual Context:** Users attach images to wishes/reviews (adoption > 30%)
- [ ] **Executor Visibility:** Users discover available executors without trial-and-error

### Code Quality Requirements

- [ ] **Git Tests:** All PR workflows tested (create, approve, merge, rollback)
- [ ] **SSE Listener:** Stable (auto-reconnect, no memory leaks)
- [ ] **Image Validation:** All edge cases handled (size, format, corruption)
- [ ] **Executor Cache:** TTL working (no stale data)

---

## 📊 Complexity Assessment

**Overall Complexity:** 🟡 MEDIUM

**Dimensions:**

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Technical Complexity** | 🟡 MEDIUM | Mostly integration, leveraging existing Forge features |
| **Integration Points** | 🟡 MEDIUM | 4 features × ~3 endpoints each = ~12 integration points |
| **Discovery Required** | 🟢 LOW | 3 discoveries, all low-medium complexity |
| **Risk Level** | 🟢 LOW | No data loss risk, rollback via config/feature flags |
| **Dependencies** | 🟢 LOW | Forge backend (already available), Omni (already integrated) |

**Total Tasks:** 19 (5 Git, 4 Omni, 4 Images, 2 Executor, 4 Testing)

---

## 🚨 Risks & Mitigations

### Risk #1: Approvals Endpoint Insufficient

**Probability:** MEDIUM
**Impact:** MEDIUM (PR workflow less robust)

**Mitigation:**
- Discovery #1 validates endpoint behavior
- Wrapper implementation if needed (manual approval fallback)
- Feature flag (disable approval gate if not working)

---

### Risk #2: SSE Listener Complexity

**Probability:** MEDIUM
**Impact:** MEDIUM (notifications unreliable)

**Mitigation:**
- Use proven libraries (EventSource, axios-sse)
- Start with MVP (basic events only)
- Graceful degradation (polling fallback if SSE fails)
- Auto-reconnect logic (exponential backoff)

---

### Risk #3: Notification Spam

**Probability:** LOW
**Impact:** LOW (user annoyance)

**Mitigation:**
- User config (enable/disable per event type)
- Debouncing (max 1 notification per event per minute)
- Batching (combine multiple events into digest)

---

## 🗺️ Roadmap Alignment

**Phase 2 - Guided Self-Improvement:** ✅ Perfect Fit

**How This Wish Aligns:**
- ✅ **Autonomous MCP features:** SSE automations, PR creation (less manual intervention)
- ✅ **Tight Forge integration:** Leverage Forge Git + Omni capabilities
- ✅ **User delight:** High-value features that users will immediately notice

**Roadmap Item (proposed):**
> **Enhanced Autonomous MCP Features (Wish #120-B)**
> - Real-time notifications via Omni (WhatsApp/Slack/Discord)
> - Automatic PR creation and Git workflow management
> - Visual context support (images in planning/review)
> - Dynamic executor discovery and availability checking
> - Tight integration with Forge backend for seamless operation

**Deliverables for Roadmap:**
- PR automation suite (create, approve, merge, rollback)
- SSE listener + Omni integration (real-time notifications)
- Images API integration (visual context)
- Executor visibility (dynamic discovery)

---

## 📚 Reference Documents

**Parent Wish:**
- `.genie/wishes/forge-executor-replacement/forge-executor-replacement-wish.md`

**Investigation Reports:**
- `.genie/reports/3-WISH-SPLIT-STRATEGY-20251018.md` (Part 2 - this wish)
- `.genie/reports/FORGE-GENIE-INTEGRATION-ANALYSIS-20251018.md` (endpoint analysis)

**Endpoint Documentation:**
- `.genie/docs/forge-endpoint-mapping.md` (Categories 5-8 relevant)
- `.genie/docs/discovery-checklist.md` (Discoveries #3, #4, #5)

**Dependencies:**
- Wish #120-A (Drop-In Replacement) - MUST complete first

---

## 🎯 Definition of Done

**This wish is complete when:**

1. ✅ PR creation working (automatic + manual)
2. ✅ Omni notifications delivered (< 5s latency)
3. ✅ Images attach to wishes/reviews (upload, list, display)
4. ✅ Executor info visible in CLI (dynamic discovery)
5. ✅ 80% reduction in manual PR steps (user survey)
6. ✅ Real-time awareness (no polling needed)
7. ✅ All tests passing (`pnpm run check`)
8. ✅ Documentation complete (user guides + developer docs)
9. ✅ Done report published
10. ✅ PR merged to main

**User Experience Validation:**
```bash
# Before Wish #120-B:
genie run implementor "build feature X"
# ... session completes ...
# User must manually: check status, create PR, merge

# After Wish #120-B:
genie run implementor "build feature X"
# ... session completes ...
# 🧞 WhatsApp: "Session completed: implementor (session-abc)"
# 🔀 WhatsApp: "PR created: https://github.com/.../pull/123"
genie review approve <id>  # One command to merge!
# ✅ WhatsApp: "PR merged successfully!"
```

**Users notice immediately:** Real-time notifications, one-click merge, visual context! 🎉

---

## 📈 Success Metrics

**Quantitative:**
- [ ] PR automation: **80% reduction** in manual steps (5-10 min → 1 min)
- [ ] Notification latency: **< 5s** (event → Omni delivery)
- [ ] Image adoption: **> 30%** of wishes/reviews include images
- [ ] Executor discovery: **100%** success rate (no trial-and-error)

**Qualitative:**
- [ ] Users report: "I love getting notifications on WhatsApp!"
- [ ] Users report: "One-click merge is a game-changer"
- [ ] Users attach images to show UI mockups, diagrams
- [ ] No confusion about available executors

---

## 🚀 Next Steps (After Completion)

**Immediate Follow-Ups:**
1. **Wish #120-C:** Advanced features (templates, migration agent, SSE automations, advanced inspection)

**Dependencies Unlocked:**
- This wish establishes patterns for SSE event handling
- Images API can be extended (annotations, comparisons)
- PR automation can be enhanced (custom approval policies)

---

**Document Author:** Genie (forge/120-executor-replacement)
**Version:** 1.0.0
**Status:** 📝 Draft - Blocked by Wish #120-A (#143)
