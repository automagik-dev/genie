# Forge-Genie Integration - Final Decisions
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Date:** 2025-10-18
**Status:** Consolidated from voice interview + additional decisions
**Purpose:** Definitive implementation plan based on Felipe's decisions

---

## Executive Summary

This document consolidates ALL decisions from the comprehensive endpoint interview, plus additional architectural decisions made during follow-up discussion.

**Key Architectural Decisions:**
- ✅ **Workflow:** Plan → Wish → Forge → Review (remains unchanged)
- ✅ **Authentication:** Document in Discovery only (no direct implementation now)
- ✅ **User Data Query:** Discovery-only (catalog/description, no exposure yet)
- ✅ **Notifications:** INCLUDE NOW via existing Omni ↔ Forge integration
- ✅ **Updating Agent:** Centralize under /update with version files showing diffs

---

## Decision Matrix (Complete)

### ✅ YES - Implement Now (30 endpoints approved)

#### Category 1: Health & System
- **healthCheck()** - Pre-flight checks before operations

#### Category 2: Projects
- **listProjects()** - Auto-discover/provision project (internal)
- **createProject()** - Auto-create with approval when missing

#### Category 3: Tasks
- **listTasks()** - CRITICAL: List Genie sessions (replaces sessions.json)
- **createTask()** - Separate creation for "plan now, execute later" scenarios
- **getTask()** - Forge as primary implementer, GNI as fallback
- **updateTask()** - Rename, notes, status updates
- **deleteTask()** - Aligned with GNI stop/delete sessions

#### Category 4: Task Attempts (CRITICAL - Core Replacement)
- **listTaskAttempts()** - Execution history/retries
- **createTaskAttempt()** - Retry and A/B testing between executors/LLMs
- **getTaskAttempt()** - CRITICAL: Session status/details
- **followUpTaskAttempt()** - HIGH PRIORITY: Follow-ups with running process
- **replaceTaskAttemptProcess()** - Switch executor/model mid-session
- **getTaskAttemptBranchStatus()** - Display in Attempt Details with diff
- **mergeTaskAttempt()** - Finalize approved changes
- **pushTaskAttemptBranch()** - Manual and/or integrated with PR
- **abortTaskAttemptConflicts()** - Rollback/cleanup conflicts
- **createTaskAttemptPullRequest()** - Automatic/assisted PR creation
- **attachExistingPullRequest()** - Ideally automatic via naming/hooks
- **getCommitInfo()** - Inspect commits
- **compareCommitToHead()** - Compare commits
- **getTaskAttemptChildren()** - Keep Genie ⇄ Forge state tree synchronized
- **stopTaskAttemptExecution()** - CRITICAL: Stop "hallucinating" execution
- **changeTaskAttemptTargetBranch()** - Retarget when necessary
- **openTaskAttemptInEditor()** - Offer option for local QA/review

---

### ❌ NO - Skip (1 endpoint rejected)

#### Category 2: Projects
- **deleteProject()** - Dangerous operation; leave to Forge UI

---

### 🤔 MAYBE - Discovery First (8 endpoints)

**Decision:** Document in Discovery phase, decide implementation after understanding full scope

#### Category 2: Projects
- **getProject()** - Validate project details; decide after discovery
- **updateProject()** - Only if fields are actually useful
- **listProjectBranches()** - Could help with base branch validation/picker
- **searchProjectFiles()** - Investigate overlap with MCP tools

#### Category 2: Projects (continued)
- **openProjectInEditor()** - Useful; depends on editor matrix/UX

#### Category 4: Task Attempts
- **rebaseTaskAttempt()** - Possibly via Main Genie Orchestrator; advanced mode

---

### ⏰ LATER - Future Features (1 endpoint)

#### Category 3: Tasks
- **createAndStartTask()** - Prefer separate create + start for fine control

---

### ⚙️ TBD - Needs Conditions/Flags (1 endpoint)

#### Category 4: Task Attempts
- **startDevServer()** - Decide conditions/flags later

---

### 📋 DISCOVERY PENDING - Not Yet Decided (60+ endpoints)

**Categories awaiting decisions:**
- Category 5: Execution Processes (3 endpoints)
- Category 6: WebSocket Streaming (6 endpoints) - CRITICAL for real-time
- Category 7: Drafts (4 endpoints)
- Category 8: Approvals (4 endpoints) - Human-in-the-loop
- Category 9: Templates (5 endpoints)
- Category 10: Images (5 endpoints)
- Category 11: Configuration (6 endpoints)
- Category 12-13: Containers & Filesystem (3 endpoints)
- Category 14: Authentication (3 endpoints) - DISCOVERY ONLY
- Category 15: Server-Sent Events (1 endpoint)

---

## Additional Architectural Decisions

### 1. Authentication (Category 14)

**Decision:** Document in Discovery only (no implementation now)

**Rationale:**
- Genie uses what Forge already provides
- No need for custom auth endpoints
- Document flow, fields, tokens for reference

**Status:** Discovery-only

---

### 2. User Data Query

**Decision:** Discovery-only (describe contract and purpose)

**Rationale:**
- Catalog available data
- No exposure in this cycle
- Document for future use

**Status:** Discovery-only

---

### 3. Notifications via Omni

**Decision:** INCLUDE NOW using existing Omni ↔ Forge integration

**Key Events to Notify:**
- ✅ Task started
- ✅ Attempt failed
- ✅ PR created
- ✅ Merge completed
- ✅ Execution stopped
- ✅ Conflicts detected

**Implementation:**
- Map events to Omni routing
- Configure notification channels
- Use existing Forge-Omni bridge

**Status:** Approved for implementation

---

### 4. Updating Agent + /update Directory

**Decision:** Centralize updates under /update with version files

**Structure:**
```
/update/
├── version-rc20-to-rc21.md
├── version-rc21-to-rc22.md
└── current-version.txt
```

**Version File Format:**
```markdown
# Changes from RC20 to RC21

## What Changed
- Fixed session lifecycle bug
- Updated branch naming convention
- Added Forge integration

## What You Need to Do
- Run `genie update` to migrate
- Review new session format
- Test existing sessions

## Breaking Changes
- Session ID format changed (migration automatic)
```

**Benefits:**
- Clear change tracking
- User knows what's different
- Migration guidance included

**Status:** Approved for implementation

---

## Implementation Priorities

### Phase 1: Core Replacement (Week 1-2)

**Focus:** Replace background-launcher.ts with Forge API

**Endpoints (10 critical):**
1. healthCheck()
2. listProjects() + createProject()
3. listTasks()
4. createTask()
5. createTaskAttempt()
6. getTaskAttempt()
7. followUpTaskAttempt()
8. stopTaskAttemptExecution()
9. getTask()
10. updateTask()

**Deliverables:**
- Core Genie commands work via Forge
- Session creation atomic (no timeout races)
- Session resume native (follow-ups)
- Session stop reliable

---

### Phase 2: Git Integration (Week 3)

**Focus:** Git operations and PR automation

**Endpoints (7):**
1. getTaskAttemptBranchStatus()
2. pushTaskAttemptBranch()
3. createTaskAttemptPullRequest()
4. mergeTaskAttempt()
5. abortTaskAttemptConflicts()
6. attachExistingPullRequest()
7. changeTaskAttemptTargetBranch()

**Deliverables:**
- Auto-push before PR
- PR creation automated
- Merge workflow integrated
- Conflict handling

---

### Phase 3: Advanced Features (Week 4)

**Focus:** Editor integration, commit inspection, state sync

**Endpoints (10):**
1. openTaskAttemptInEditor()
2. getCommitInfo()
3. compareCommitToHead()
4. getTaskAttemptChildren()
5. replaceTaskAttemptProcess()
6. deleteTask()
7. listTaskAttempts()
8. Notifications via Omni (event mapping)

**Deliverables:**
- Open workspace in editor
- Commit history inspection
- Parent-child task sync
- Executor switching
- Event notifications

---

### Phase 4: Discovery & Refinement (Week 5-6)

**Focus:** Evaluate MAYBE/TBD endpoints, decide on pending categories

**Tasks:**
1. Review all MAYBE endpoints (8 total)
2. Decide on WebSocket streaming (6 endpoints)
3. Decide on Approvals (4 endpoints)
4. Decide on Drafts (4 endpoints)
5. Document Discovery contracts (OpenAPI)
6. Create version files for /update

**Deliverables:**
- Complete endpoint decisions
- OpenAPI documentation
- Discovery catalog
- Version migration guides

---

## OpenAPI Discovery Sample

```yaml
openapi: 3.0.3
info:
  title: Forge ⇄ Genie Integration API
  version: 0.1.0
  description: |
    Definitive API contracts for Forge-Genie integration based on
    collaborative endpoint decisions from comprehensive interview.

servers:
  - url: http://localhost:8887/api
    description: Local Forge instance

paths:
  /health:
    get:
      operationId: healthCheck
      summary: Verify Forge backend availability
      tags: [Health]
      responses:
        '200':
          description: Service healthy
          content:
            application/json:
              schema:
                type: object
                properties:
                  status:
                    type: string
                    enum: [ok]

  /projects:
    get:
      operationId: listProjects
      summary: List all projects (internal auto-discover)
      tags: [Projects]
      responses:
        '200':
          description: List of projects
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Project'

    post:
      operationId: createProject
      summary: Create new project (auto-create with approval)
      tags: [Projects]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, repo_path]
              properties:
                name:
                  type: string
                repo_path:
                  type: string
      responses:
        '201':
          description: Project created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Project'

  /projects/{projectId}/tasks:
    get:
      operationId: listTasks
      summary: List all tasks (Genie sessions)
      tags: [Tasks]
      parameters:
        - name: projectId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: List of tasks
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Task'

    post:
      operationId: createTask
      summary: Create task (separate for "plan now, execute later")
      tags: [Tasks]
      parameters:
        - name: projectId
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title, description]
              properties:
                title:
                  type: string
                description:
                  type: string
      responses:
        '201':
          description: Task created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Task'

  /task-attempts:
    post:
      operationId: createTaskAttempt
      summary: Create task attempt (retry, A/B testing)
      tags: [TaskAttempts]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [task_id, executor_profile_id, base_branch]
              properties:
                task_id:
                  type: string
                executor_profile_id:
                  type: object
                  properties:
                    executor:
                      type: string
                      enum: [CLAUDE_CODE, GEMINI, CODEX]
                    variant:
                      type: string
                      nullable: true
                base_branch:
                  type: string
      responses:
        '201':
          description: Attempt created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TaskAttempt'

  /task-attempts/{attemptId}:
    get:
      operationId: getTaskAttempt
      summary: Get attempt status/details (CRITICAL)
      tags: [TaskAttempts]
      parameters:
        - name: attemptId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Attempt details
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TaskAttempt'

  /task-attempts/{attemptId}/follow-up:
    post:
      operationId: followUpTaskAttempt
      summary: Send follow-up to running process (HIGH PRIORITY)
      tags: [TaskAttempts]
      parameters:
        - name: attemptId
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [follow_up_prompt]
              properties:
                follow_up_prompt:
                  type: string
      responses:
        '202':
          description: Follow-up accepted
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ExecutionProcess'

  /task-attempts/{attemptId}/stop:
    post:
      operationId: stopTaskAttemptExecution
      summary: Stop execution (CRITICAL)
      tags: [TaskAttempts]
      parameters:
        - name: attemptId
          in: path
          required: true
          schema:
            type: string
      responses:
        '202':
          description: Stop signal sent

  /task-attempts/{attemptId}/pr:
    post:
      operationId: createTaskAttemptPullRequest
      summary: Create PR for attempt
      tags: [TaskAttempts]
      parameters:
        - name: attemptId
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                title:
                  type: string
                description:
                  type: string
                target_branch:
                  type: string
      responses:
        '201':
          description: PR created
          content:
            application/json:
              schema:
                type: object
                properties:
                  pr_number:
                    type: integer
                  pr_url:
                    type: string

components:
  schemas:
    Project:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
        repo_path:
          type: string
        created_at:
          type: string
          format: date-time

    Task:
      type: object
      properties:
        id:
          type: string
        project_id:
          type: string
        title:
          type: string
        description:
          type: string
        status:
          type: string
          enum: [todo, in-progress, in-review, done, cancelled]
        created_at:
          type: string
          format: date-time

    TaskAttempt:
      type: object
      properties:
        id:
          type: string
        task_id:
          type: string
        executor:
          type: string
        status:
          type: string
        branch:
          type: string
        base_branch:
          type: string
        created_at:
          type: string
          format: date-time

    ExecutionProcess:
      type: object
      properties:
        id:
          type: string
        task_attempt_id:
          type: string
        status:
          type: string
        started_at:
          type: string
          format: date-time
```

---

## Summary Statistics

**Total Endpoints Reviewed:** 90+

**Decisions Made:**
- ✅ YES: 30 endpoints (33%)
- ❌ NO: 1 endpoint (1%)
- 🤔 MAYBE: 8 endpoints (9%)
- ⏰ LATER: 1 endpoint (1%)
- ⚙️ TBD: 1 endpoint (1%)
- 📋 DISCOVERY PENDING: 60+ endpoints (56%)

**Implementation Phases:**
- Phase 1 (Core): 10 endpoints - Weeks 1-2
- Phase 2 (Git): 7 endpoints - Week 3
- Phase 3 (Advanced): 10 endpoints - Week 4
- Phase 4 (Discovery): Evaluate remaining - Weeks 5-6

**New Features Confirmed:**
- ✅ Notifications via Omni integration
- ✅ Updating Agent with version files
- ✅ Authentication documented in Discovery
- ✅ User data query cataloged

---

## Next Steps (Options for Felipe)

1. ✅ **Approve** this consolidated plan as official baseline
2. 🔧 **Request adjustments** to specific endpoints or phases
3. 📋 **Provide decisions** for pending categories (6-15)
4. 🚀 **Generate Phase 1 detailed implementation plan**
5. 📝 **Create UX/CLI mockups** for approved endpoints

---

**Report Author:** Genie (forge/120-executor-replacement)
**Date:** 2025-10-18
**Based On:** Comprehensive voice interview + follow-up decisions
**Status:** Ready for implementation planning
**Worktree:** c3d1-forge-120-execut
