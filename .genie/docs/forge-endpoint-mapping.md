# Forge Endpoint Mapping - Complete Integration Guide
**Date:** 2025-10-18
**Project:** automagik-genie ↔ Forge Backend
**Status:** ✅ Mapping Complete - Discovery Items Identified
**Purpose:** Natural integration of all 94+ Forge endpoints into Genie workflow

---

## 📋 Executive Summary

This document defines the **complete integration strategy** for all Forge API endpoints (Categories 1-15) into Genie's natural workflow (Plan → Wish → Forge → Review).

**Key Decisions:**
- ✅ **WebSocket Streaming:** OUT OF SCOPE (not using WS)
- ✅ **Drafts:** DEPRIORITIZED (Discovery phase - validate real need)
- ✅ **Approvals:** SINGLE GATE at end (pre-merge) + Omni notification + CLI confirmation
- ✅ **Templates:** DISCOVERY NEEDED (explore Forge templates vs. current "code/create")
- ✅ **Images:** YES (visual context for planning/review)
- ✅ **Configuration:** PARTIAL EXPOSURE (executor availability visible, internals hidden)
- ✅ **Containers:** INTERNAL/AUTOMATIC (expert mode for read-only diagnostics)
- ✅ **Filesystem:** FORGE-ONLY (Genie does NOT touch Forge worktree)
- ✅ **Auth:** TRANSPARENT (Genie handles, no user friction)
- ✅ **SSE:** YES (global events → automation + Omni integration)

**Implementation Status:**
- **Immediate (can proceed now):** 24 endpoints (Categories 1-4, Health/Projects/Tasks/Task Attempts)
- **Discovery (validation needed):** 60+ endpoints (Categories 6-15)
- **Out of Scope:** WebSocket streaming (Category 6)

---

## Part 1: Natural Workflow Integration (Phase Mapping)

### Genie Workflow: Plan → Wish → Forge → Review + Cross-cutting

| Category | Endpoints (examples) | Natural Phase | Decision/Status |
|----------|---------------------|---------------|-----------------|
| **6. WebSocket** | get*StreamUrl() | — | ❌ **OUT OF SCOPE** (not using WS) |
| **7. Drafts** | saveDraft, getDraft, deleteDraft, queueDraftExecution | **Wish** (optional) **or** **Forge** (checkpoint) | 📋 **DEPRIORITIZED** (Discovery - validate need) |
| **8. Approvals** | createApprovalRequest, getApprovalRequest, respondToApprovalRequest | **Review** (final gate pre-merge) | ✅ **FINAL APPROVAL GATE** (endpoint in Discovery) |
| **9. Templates** | list/get/create/update/delete | **Plan** (setup) **and** **Wish** (agent selection) | 📋 **DISCOVERY** (study Forge templates vs. "code/create") |
| **10. Images** | upload/get/list/delete | **Plan** (visual context) **and** **Review** (evidence) | ✅ **INTEGRATE** (attachments/context) |
| **11. Configuration** | getSystemInfo, listExecutorProfiles, getExecutorProfile, getMcpConfig | **Plan** (pre-checks) **and** **Cross** (diagnostics) | ✅ **PARTIAL CLI** (executor availability visible, rest internal) |
| **12-13. Containers & Filesystem** | list/create/delete containers; read/write/list/delete files | **Forge** | ✅ **Containers:** internal/automatic (expert mode only); **Filesystem:** FORGE-ONLY |
| **14. Auth** | (document only) | **Cross** | ✅ **TRANSPARENT** (document practical scenarios) |
| **15. SSE** | subscribeToEvents | **Cross** | ✅ **YES** (subscription + automation + Omni) |

**Additional Phases:**
- **Ops/Monitoring** (cross-cutting): SSE + Omni + aggregated logs
- **Governance** (cross-cutting): approval policies by risk/branch (post-MVP)

---

## Part 2: User Visibility Model

### Visibility Patterns

**A. User-facing:** Exposed via CLI commands
**B. Internal-only:** Used by Genie orchestrator, hidden from user
**C. Hybrid:** Internal by default, exposed via flags/config

| Category | Visibility Model | CLI (proposal) |
|----------|------------------|----------------|
| **6. WebSocket** | — | — (out of scope) |
| **7. Drafts** | **B. Internal** by default; expose later if demand exists | (future) `genie draft save/restore` *only if Discovery justifies* |
| **8. Approvals** | **C. Hybrid:** Omni + **CLI prompt** to proceed | `genie review <id>` → shows summary + **[Approve/Deny]** (blocking) |
| **9. Templates** | **C. Hybrid:** template selection is user-facing; advanced management can be admin | `genie init --template code\|create\|<forge-template>` |
| **10. Images** | **A. User-facing** (context attachments) | `genie wish attach-image <path> --label "..."` |
| **11. Configuration** | **C. Partial** (user sees available executors) | `genie info executors` / `genie info mcp` (read-only) |
| **12. Containers** | **B. Internal;** **C. expert mode** optional | `genie infra status --expert` (read-only diagnostics) |
| **13. Filesystem** | **B. Internal (Forge-only)** | — |
| **14. Auth** | **B. Transparent** + documentation | `genie info auth` (non-sensitive summary) |
| **15. SSE** | **C. Hybrid:** **always on** for Omni; **on-demand** in CLI | `genie watch --events task,pr,approval` (optional) |

---

## Part 3: Integration Patterns

### Pattern Definitions

**Pattern A: Direct Mapping**
- Forge endpoint → Genie CLI command (1:1)
- Example: `forge.saveDraft()` → `genie draft save`
- **Pros:** Simple, explicit control
- **Cons:** Cluttered CLI, steep learning curve

**Pattern B: Abstracted/Automatic**
- Forge operations happen transparently (no user interaction)
- Example: Drafts auto-saved at checkpoints, SSE subscribed automatically
- **Pros:** Clean UX, minimal user burden
- **Cons:** Less control, "magic" behavior

**Pattern C: Workflow-Embedded**
- Forge operations integrated into existing commands (flags/options)
- Example: `genie view <id>` auto-streams if Forge supports it
- **Pros:** Natural UX, backward compatible
- **Cons:** Command complexity, feature discovery issues

### Pattern Selection by Category

| Category | Pattern | Rationale |
|----------|---------|-----------|
| **6. WebSocket** | — | Out of scope |
| **7. Drafts** | **B. Abstracted** | If implemented: auto-checkpoints |
| **8. Approvals** | **C. Workflow-embedded** | Gate in `review`/pre-merge; Omni + CLI confirmation |
| **9. Templates** | **C. Workflow-embedded** (selection in `init`/`wish`) + **A. Direct** (admin CRUD) | Natural selection + advanced management |
| **10. Images** | **C. Workflow-embedded** | In `wish`/`review` workflows |
| **11. Configuration** | **B. Automatic** (dynamic discovery) + **C. Workflow** (flags/`info`) | Transparent + optional visibility |
| **12. Containers** | **B. Automatic** (Forge manages) + **C. Workflow** (expert read-only) | Minimal user burden |
| **13. Filesystem** | **B. Automatic** (Forge-only) | Genie never touches Forge worktree |
| **14. Auth** | **B. Automatic** (transparent) + documentation | No user friction |
| **15. SSE** | **C. Workflow-embedded** (always for Omni) + `watch` on-demand | Hybrid approach |

---

## Part 4: Detailed Category Analysis

### Category 6: WebSocket Streaming — ❌ OUT OF SCOPE

**Decision:** Do NOT integrate WebSocket streaming.

**Rationale:**
- Complexity not justified for MVP
- SSE (Category 15) covers global events
- Alternative: Polling for specific use cases if needed

**Commands:** N/A

**Status:** ❌ Removed from scope

---

### Category 7: Drafts — 📋 DEPRIORITIZED / DISCOVERY

**Potential Use Case (if ever adopted):**
- Auto-checkpoints during Forge execution
- Restore on demand

**Current Proposal:**
- Do NOT expose commands
- Keep in Discovery until real need emerges

**Commands (future, if Discovery justifies):**
```bash
genie draft save <task-id>      # Manual checkpoint
genie draft restore <draft-id>  # Restore from checkpoint
genie draft list <task-id>      # List checkpoints
```

**Status:** 📋 Discovery phase

**Discovery Questions:**
1. Do we need checkpoints, or are task attempts sufficient?
2. Would auto-checkpoints add value vs. complexity?
3. Are drafts useful for A/B testing approaches?

---

### Category 8: Approvals — ✅ FINAL GATE (PRE-MERGE)

**Decision:** Single approval gate at end of Review phase (pre-merge)

**When:** After Review, before PR creation/merge to main

**How to Communicate:**
1. **Omni notification:** "🤔 Approval needed: Task #123"
2. **CLI prompt (blocking):** Shows summary + requires explicit approval

**Approval Policies (MVP):**
- PR creation requires approval
- Merge to main requires approval
- Post-MVP: Configurable policies by branch/risk level

**Forge Endpoint:** 📋 **In Discovery**
- Confirm `createApprovalRequest()` semantics
- Validate payloads and behavior
- Design wrapper/service if needed

**CLI Flow (proposal):**
```bash
genie review <task-id>
# Shows:
# - Diffs
# - Test results
# - Static analysis
# - Branch status
# Then prompts:
# [Approve] [Deny]  → blocks until decision
```

**Status:** ✅ Approved for implementation (endpoint validation in Discovery)

---

### Category 9: Templates — 📋 DISCOVERY NEEDED

**Current State:**
- Genie has 2 templates: **"code"** and **"create"** (in `.genie/agents/`)
- Forge has template system (need to inventory)

**Questions for Discovery:**
1. What templates does Forge offer?
2. Are they compatible with Genie's "code/create"?
3. Should we unify (use Forge only) or keep separate systems?
4. If unified: How to map existing agents to Forge templates?

**Proposed CLI (if unified):**
```bash
genie init --template code|create|<forge-template>
genie templates list                    # Show available templates
genie templates show <template-name>    # Show template details
```

**Status:** 📋 Discovery required before implementation

**Dependency:** Related to Wish #110 (Multi-template architecture)

---

### Category 10: Images — ✅ VISUAL CONTEXT

**Decision:** Integrate images as visual context for planning and review

**Where Used:**
- **Plan Phase:** Attach architecture diagrams, mockups, screenshots
- **Wish Phase:** Visual context for desired outcome
- **Review Phase:** Evidence (screenshots of results, visual diffs)

**Commands:**
```bash
genie wish attach-image <path> --label "Architecture v1"
genie review attach-image <path> --label "Screen after change"
genie wish list-images <task-id>
```

**Storage:**
- Images stored via Forge endpoint
- Genie only maintains metadata/catalog in wish/review documents

**Status:** ✅ Approved for implementation

---

### Category 11: Configuration (Executors, MCP, System Info) — ✅ PARTIAL EXPOSURE

**Decision:** Dynamic discovery + partial CLI exposure

**Executors:**
- Discover available executors dynamically from Forge
- Map Forge profile IDs to friendly names
- Show availability status

**Commands:**
```bash
genie info executors
# Output:
# ✅ Claude Code (CLAUDE_CODE) - Available
# ✅ Codex (CODEX) - Available
# ❌ Gemini (GEMINI) - Unavailable
# ✅ Cursor (CURSOR) - Available
```

**MCP:**
- 📋 Discovery: How to unify Genie's MCP server list with Forge's MCPs?
- Consider: Should Forge consume same MCPs as Genie?

**System Info:**
- Keep **hidden** by default
- Show only with `--debug` flag

**Status:** ✅ Executor listing approved; MCP unification in Discovery

---

### Category 12: Containers — ✅ INTERNAL/AUTOMATIC

**Decision:** Forge manages containers internally; expose read-only diagnostics in expert mode only

**Use Cases:**
- Dev servers (automatic startup/shutdown)
- Database containers (automatic provisioning)
- Test environments (automatic isolation)

**Commands (expert mode only):**
```bash
genie infra status --expert
# Output (read-only):
# 🟢 Container: dev-server (port 3000)
# 🟢 Container: postgres (port 5432)
```

**Restrictions:**
- No user commands to create/delete containers (Forge manages lifecycle)
- Expert mode is **diagnostic only** (no mutations)

**Status:** ✅ Internal/automatic approved; expert mode diagnostic optional (post-MVP)

---

### Category 13: Filesystem — ✅ FORGE-ONLY

**Decision:** Forge is the owner of worktree filesystem; Genie does NOT touch it

**Restrictions:**
- Genie must NOT know worktree paths
- Genie must NOT use Read/Write/Edit tools on Forge worktree
- All filesystem effects happen **via Forge tasks**

**Rationale:**
- Worktree isolation is Forge's responsibility
- Genie operates on main workspace, Forge operates on worktree
- Clear boundary prevents conflicts and race conditions

**Audit Required:**
- Review CLI code to ensure no direct worktree access
- Validate that all file operations go through Forge API

**Status:** ✅ Approved - audit required before implementation

---

### Category 14: Authentication — ✅ TRANSPARENT + DOCUMENTATION

**Decision:** Auth is transparent to user; document scenarios

**User Experience:**
- No additional steps required
- Genie handles auth negotiation automatically
- Errors surfaced clearly with remediation steps

**Scenarios to Document:**
1. **Local Forge** (no auth) - Default for development
2. **Remote Forge** (token-based) - For team collaboration
3. **Multi-user** (SSO/OAuth) - For enterprise deployments

**Documentation Location:**
```
.genie/docs/forge-authentication.md
.genie/docs/configuration-guide.md (references auth doc)
```

**Commands (optional):**
```bash
genie info auth
# Output (non-sensitive):
# Auth Status: ✅ Authenticated
# Backend: http://localhost:3000 (local)
# Token Expiry: N/A (local mode)
```

**Status:** ✅ Approved - documentation-only

---

### Category 15: SSE (Server-Sent Events) — ✅ YES (ALWAYS ON + OMNI)

**Decision:** Subscribe to global events; automate actions + integrate with Omni

**Role:**
- Global events (task lifecycle, PR events, approvals, errors)
- Different from WebSocket (WS = resource streams, SSE = global events)

**Where It Runs:**
1. **Always:** Background listener for Omni integration
2. **On-demand:** CLI `watch` command for terminal monitoring

**Events to Subscribe:**
- ✅ `task_started`, `task_completed`, `task_failed`
- ✅ `pr_created`, `merge_completed`, `approval_requested`
- ✅ `auth_failed` (action: guide re-login/renewal)
- ✅ `system_warning`, `system_error` (action: link to diagnostics)
- 📋 **Discovery:** `file_change_detected`, `container_started/stopped` (if relevant)

**Automation (Discovery):**
- What actions can we trigger automatically on events?
- Examples: Pull logs on `task_completed`, open review on `pr_created`, update wish status
- Must be idempotent and safe (no destructive auto-actions)

**Commands:**
```bash
genie watch                         # Watch all events (terminal output)
genie watch --events task,pr        # Filter specific events
genie watch --omni-only             # Background mode (Omni only, no terminal)
```

**Configuration:**
```yaml
# .genie/config.yml
notifications:
  sse:
    enabled: true
    omni_integration: true
    events:
      - task_started
      - task_completed
      - task_failed
      - pr_created
      - approval_requested
```

**Status:** ✅ Approved - automations in Discovery

---

## Part 5: Omni Integration Strategy

### Events → Omni Notification Mapping

**Already Mapped (from integration analysis):**
- ✅ `task_started` → "🧞 Genie session started: {agent} ({sessionId})"
- ✅ `task_completed` → "✅ Genie session completed: {agent} ({sessionId})"
- ✅ `task_failed` → "❌ Genie session failed: {agent} ({sessionId})"
- ✅ `pr_created` → "🔀 PR created: {url}"
- ✅ `merge_completed` → "🎉 Merge complete: {branch} → {target}"
- ✅ `approval_requested` → "🤔 Approval needed: {message}"

**Additional Events (from final decisions):**
- ✅ `auth_failed` → "⚠️ Authentication failed - please re-login"
- ✅ `system_warning` → "⚠️ System warning: {message}"
- ✅ `system_error` → "❌ System error: {message} - View diagnostics: {link}"
- 📋 `file_change_detected` (optional post-MVP, if diff streaming via SSE)
- 📋 `container_started/stopped` (only if containers become user-relevant)

**Configuration:**
- **Default:** Enabled for all major events
- **Filters:** User can configure which events to receive
- **Quiet Mode:** Option to disable notifications (keep SSE for automation only)

**Omni Configuration:**
```yaml
# .genie/config.yml
notifications:
  enabled: true
  omni:
    instance_name: genie-notifications
    phone: +1234567890
  events:
    - task_started
    - task_completed
    - task_failed
    - pr_created
    - approval_requested
    - auth_failed
    - system_error
```

---

## Part 6: Dependencies on Other Wishes

### Dependency Analysis

**1. Wish #110 (Multi-template architecture) ↔ Templates (Category 9)**
- **Dependency:** Discovery needed to decide unification strategy
- **Options:**
  - Use Forge templates exclusively (deprecate "code/create")
  - Keep both systems separate (Forge for projects, Genie for agents)
  - Unified system (Forge backend, Genie CLI)
- **Recommendation:** Discovery phase to inventory Forge templates first

**2. Wish #108 (Genie arch rebrand) ↔ Executors (Category 11)**
- **Dependency:** Universal vs. template-specific agents
- **Decision:** Use dynamic discovery of Forge executor profiles
- **Mapping:** Genie-friendly names → Forge profile IDs
- **Status:** Can proceed with dynamic discovery approach

**3. Updating Agent ↔ Version Management**
- **Dependency:** Does Forge have version tracking/history?
- **Discovery:** Investigate Forge's version management capabilities
- **If yes:** Integrate with Review (show baseline → current)
- **If no:** Updating agent remains Genie-only

**Recommendation:** PROCEED with decided items (approvals, images, SSE, auth, containers/filesystem restrictions) and RUN DISCOVERY focused on:
- Approvals endpoint validation
- Templates inventory (Forge vs. Genie)
- Executors/MCP unification
- SSE automations
- Drafts (validate real need)

---

## Part 7: Immediate Implementation Plan

### Can Proceed NOW (no blockers)

**1. Review Gate (Pre-merge Approval)**
- CLI: `genie review <id>` with blocking **[Approve/Deny]** prompt
- Omni notification on approval request
- Implement Genie layer that consults/invokes Forge (exact endpoint in Discovery)

**2. SSE Listener + Omni Integration**
- Background service subscribes to SSE global events
- Minimum viable actions: Update local state + notify Omni for major events
- Commands: `genie watch` (on-demand terminal monitoring)

**3. Images as Context**
- `genie wish attach-image <path> --label "..."` → Forge upload endpoint
- `genie review attach-image <path> --label "..."` → Forge upload endpoint
- Metadata catalog in wish/review documents

**4. Executor Info (Read-only)**
- `genie info executors` → List available executor profiles (friendly names)
- Dynamic discovery from Forge `listExecutorProfiles()`

**5. Filesystem Restrictions Audit**
- Review CLI codebase for any direct worktree access
- Ensure all file operations go through Forge API
- Document restriction in architecture guide

**6. Short Documentation**
- `.genie/docs/forge-authentication.md` (transparent auth scenarios)
- `.genie/docs/forge-architecture.md` (how SSE/Omni/approvals integrate)

---

## Part 8: Discovery Backlog (Objective Validation)

### Discovery Items (Prioritized)

**HIGH PRIORITY (Blocks Core Features):**

1. **Approvals Endpoint Validation**
   - Confirm behavior and payloads of `createApprovalRequest/get/respond`
   - Identify gaps for our final gate use case
   - Design wrapper/service if Forge endpoint doesn't match needs
   - **Estimated:** 1-2 days

2. **Templates Inventory (Forge vs. Genie)**
   - List all Forge templates (names, metadata, purpose)
   - Compare with Genie's "code/create" templates
   - Decide unification strategy (use Forge only? keep both? hybrid?)
   - Map agent types to templates
   - **Estimated:** 2-3 days

3. **Executors/MCP Discovery**
   - Protocol for discovering available executors from Forge
   - Mapping display-names (Genie-friendly) to profile IDs
   - Fallback behavior when executor unavailable
   - MCP configuration: separate or unified?
   - **Estimated:** 2-3 days

**MEDIUM PRIORITY (Enhances Features):**

4. **SSE Automations Catalog**
   - Map events → safe automatic actions
   - Ensure idempotency and retry logic
   - Examples: auto-pull logs on completion, auto-open review on PR
   - **Estimated:** 2-3 days

5. **Drafts Validation**
   - Identify real use cases (if any)
   - Compare with task attempts (is there overlap?)
   - Decide if checkpoint system adds value vs. complexity
   - **Estimated:** 1-2 days

**LOW PRIORITY (Post-MVP):**

6. **Container Management UX**
   - If containers become user-relevant, design expert mode diagnostics
   - Define what information is useful (status, ports, logs access?)
   - **Estimated:** 1 day

7. **Image Management Advanced Features**
   - Gallery view in CLI?
   - Image comparison (visual diffs)?
   - Annotations/markup?
   - **Estimated:** 2 days

---

## Part 9: Implementation Blockers

### MUST COMPLETE BEFORE GROUP A IMPLEMENTATION

**Blocker #1: Approvals Endpoint Validation**
- **Why:** Group A includes `createTaskAttemptPullRequest()` which should respect approval gate
- **Discovery Time:** 1-2 days
- **Resolution:** Validate Forge endpoint or design wrapper

**Blocker #2: Filesystem Restrictions Audit**
- **Why:** Ensure Genie never touches Forge worktree (data integrity)
- **Audit Time:** 1 day
- **Resolution:** Code review + documentation

**Blocker #3: SSE Listener Foundation**
- **Why:** Omni notifications depend on SSE subscription
- **Implementation Time:** 2-3 days
- **Resolution:** Background service + basic event routing

### CAN PROCEED IN PARALLEL (Not blocking)

- Templates Discovery (doesn't block core replacement)
- Executors/MCP Discovery (discovery system works with fallback)
- Drafts Validation (not in MVP scope)
- Container UX (internal/automatic, no user exposure needed)

---

## Part 10: Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         GENIE CLI                               │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │   Plan   │→ │   Wish   │→ │  Forge   │→ │  Review  │      │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘      │
│       ↓             ↓              ↓              ↓            │
│  [Templates]   [Images]     [SSE Events]   [Approvals]        │
│  [Executors]   [Drafts?]    [Containers]   [Images]           │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐   │
│  │           Cross-Cutting Services                       │   │
│  ├────────────────────────────────────────────────────────┤   │
│  │  • Authentication (transparent)                        │   │
│  │  • Configuration (dynamic discovery)                   │   │
│  │  • SSE Listener (always-on background)                 │   │
│  │  • Omni Integration (event → notification)             │   │
│  └────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      FORGE BACKEND API                          │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ Projects │  │  Tasks   │  │ Attempts │  │   Git    │      │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘      │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │Templates │  │  Images  │  │Approvals │  │   SSE    │      │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘      │
│                                                                 │
│  ┌──────────────────────────────────────────────────────┐     │
│  │         Forge-Managed (Internal)                     │     │
│  ├──────────────────────────────────────────────────────┤     │
│  │  • Worktree Filesystem (Genie does NOT touch)        │     │
│  │  • Containers (automatic lifecycle)                  │     │
│  │  • Execution Processes (background management)       │     │
│  └──────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    OMNI (Notifications)                         │
│                                                                 │
│  WhatsApp • Slack • Discord                                     │
│                                                                 │
│  Events: task lifecycle, PR, approvals, errors                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 11: Decision Log (Traceability)

| Date | Category | Decision | Rationale |
|------|----------|----------|-----------|
| 2025-10-18 | WebSocket (6) | OUT OF SCOPE | Complexity not justified; SSE covers global events |
| 2025-10-18 | Drafts (7) | DEPRIORITIZED | No clear use case; task attempts may be sufficient |
| 2025-10-18 | Approvals (8) | FINAL GATE (pre-merge) | Simplest MVP; can expand policies post-launch |
| 2025-10-18 | Templates (9) | DISCOVERY | Need Forge template inventory before deciding |
| 2025-10-18 | Images (10) | YES (visual context) | Clear value for planning/review |
| 2025-10-18 | Configuration (11) | PARTIAL EXPOSURE | Executor availability useful; internals hidden |
| 2025-10-18 | Containers (12) | INTERNAL/AUTOMATIC | Forge manages lifecycle; expert mode diagnostic only |
| 2025-10-18 | Filesystem (13) | FORGE-ONLY | Clear boundary prevents conflicts |
| 2025-10-18 | Auth (14) | TRANSPARENT | No user friction; document scenarios |
| 2025-10-18 | SSE (15) | YES (always-on + Omni) | Foundation for automation + notifications |

---

## Part 12: Next Actions

### Immediate (Week 1)

1. **Create Discovery GitHub Issues**
   - Issue #1: Approvals endpoint validation
   - Issue #2: Templates inventory (Forge vs. Genie)
   - Issue #3: Executors/MCP discovery protocol
   - Issue #4: SSE automations catalog
   - Issue #5: Drafts validation (real use cases)

2. **Audit Filesystem Access**
   - Review CLI codebase for worktree paths
   - Document restrictions in architecture guide

3. **Design SSE Listener Service**
   - Architecture for background subscription
   - Event routing to Omni
   - Terminal output for `watch` command

### Near-term (Week 2-3)

4. **Implement Immediate Features**
   - Review gate (approval prompt)
   - Images (attach command)
   - Executor info (read-only listing)
   - SSE listener (basic events)

5. **Run Discovery Investigations**
   - Parallel tracks: approvals, templates, executors
   - Document findings in `.genie/discovery/` directory

### Medium-term (Week 4+)

6. **Integrate Discovery Findings**
   - Update endpoint mapping based on validation
   - Implement templates (if unified approach chosen)
   - Expand SSE automations

7. **Expand Omni Integration**
   - Add new event types based on SSE catalog
   - Implement event filtering

---

## Appendix A: CLI Command Reference (Proposed)

### Core Commands (Already Defined)
```bash
genie run <agent> <prompt>              # Create + start session
genie resume <session-id> <prompt>      # Follow-up to session
genie view <session-id>                 # View session logs
genie stop <session-id>                 # Stop running session
genie list                              # List all sessions
```

### New Commands (From Endpoint Mapping)
```bash
# Review & Approval
genie review <task-id>                  # Review + approval gate
genie review approve <task-id>          # Explicit approval
genie review deny <task-id>             # Explicit denial

# Images
genie wish attach-image <path> --label "..." --task <id>
genie review attach-image <path> --label "..." --task <id>
genie wish list-images <task-id>

# Information
genie info executors                    # List available executors
genie info mcp                          # List MCP servers
genie info auth                         # Auth status (non-sensitive)
genie info system                       # System info (--debug only)

# Monitoring (SSE)
genie watch                             # Watch all events
genie watch --events task,pr,approval   # Filter events
genie watch --omni-only                 # Background mode

# Templates (if unified)
genie init --template <name>            # Initialize with template
genie templates list                    # List available templates
genie templates show <name>             # Show template details

# Expert Mode (optional)
genie infra status --expert             # Container diagnostics
genie debug                             # Full system diagnostics
```

---

## Appendix B: Configuration Schema

```yaml
# .genie/config.yml

# Forge Backend
forge:
  base_url: http://localhost:3000
  token: null  # Optional: for remote Forge
  project_id: null  # Auto-discovered on first run

# Notifications
notifications:
  enabled: true
  omni:
    instance_name: genie-notifications
    phone: +1234567890
  events:
    - task_started
    - task_completed
    - task_failed
    - pr_created
    - merge_completed
    - approval_requested
    - auth_failed
    - system_error

# SSE
sse:
  enabled: true
  reconnect: true
  reconnect_delay_ms: 5000

# Approvals
approvals:
  required_for:
    - pr_creation
    - merge_to_main
  auto_approve: []  # Empty by default; can add patterns

# Templates
templates:
  default: code  # or "create" or "<forge-template>"
  discovery: auto  # or "manual"

# Advanced
advanced:
  expert_mode: false
  filesystem_audit: true  # Enforce Forge-only restriction
  debug: false
```

---

## Appendix C: TypeScript Build Hotfix (from Report)

### Observed Errors
- `TS6059: 'rootDir' is expected to contain all source files`
- `File is CommonJS module because package.json does not have field "type"`
- `TS2307: Cannot find module './shared/types'`

### Recommended Fix: Option A (Move to src)

**Move sources into `.genie/cli/src`:**
```bash
mv forge.ts .genie/cli/src/lib/
mv shared/ .genie/cli/src/
```

**Update imports:**
```typescript
// Before
import { ForgeClient } from '../../forge';

// After
import { ForgeClient } from './lib/forge';
```

**Standardize ESM:**
```json
// package.json
{
  "type": "module"
}

// .genie/cli/tsconfig.json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "./src",
    "outDir": "./dist"
  }
}
```

**Verify:**
```bash
pnpm run build:genie
node tests/genie-cli.test.js
```

---

## Conclusion

This document defines the **complete integration strategy** for all 94+ Forge endpoints into Genie's natural workflow. Key decisions have been made, implementation priorities identified, and Discovery items cataloged.

**Status:**
- ✅ **24 endpoints (Categories 1-4):** Can proceed immediately
- 📋 **60+ endpoints (Categories 6-15):** Discovery validation required
- ❌ **WebSocket streaming:** Out of scope

**Next Step:** Create Discovery GitHub issues and begin immediate implementation.

---

**Document Author:** Genie (forge/120-executor-replacement)
**Version:** 1.0.0
**Last Updated:** 2025-10-18
**Status:** ✅ Complete - Ready for Discovery Phase
