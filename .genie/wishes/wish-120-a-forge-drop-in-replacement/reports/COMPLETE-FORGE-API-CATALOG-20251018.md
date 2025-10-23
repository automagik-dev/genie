# Complete Forge API Catalog - ALL 90+ Endpoints
**Date:** 2025-10-18
**Source:** forge.ts (ForgeClient implementation)
**Purpose:** Comprehensive catalog of EVERY endpoint for Genie replacement planning

---

## Summary: 90+ Endpoints Across 13 Categories

| Category | Endpoints | Genie Use | Priority |
|----------|-----------|-----------|----------|
| **Health & System** | 1 | Health checks | LOW |
| **Authentication** | 3 | GitHub OAuth | MEDIUM |
| **Configuration** | 6 | Settings, MCP config | LOW |
| **Projects** | 8 | Project management | **HIGH** |
| **Tasks** | 6 | Task creation | **HIGH** |
| **Task Attempts** | 19 | **Core replacement** | **CRITICAL** |
| **Execution Processes** | 3 | Process management | **HIGH** |
| **Drafts** | 4 | Code drafts | MEDIUM |
| **Templates** | 5 | Task templates | LOW |
| **Images** | 5 | Task images | LOW |
| **Approvals** | 4 | Human-in-the-loop | MEDIUM |
| **Containers** | 1 | Container info | LOW |
| **Filesystem** | 2 | Directory browsing | LOW |
| **Streaming (WebSocket)** | 6 | **Real-time logs/diffs** | **CRITICAL** |
| **Server-Sent Events** | 1 | Event stream | MEDIUM |

**Total:** 74 REST endpoints + 6 WebSocket endpoints + 10 helper methods = **90+ total**

---

## Category 1: Health & System (1 endpoint)

### GET /health
**Method:** `healthCheck()`
**Purpose:** Simple health check
**Returns:** `{ status: "ok" }`
**Genie Use:** Verify Forge backend is running before operations
**Priority:** LOW

---

## Category 2: Authentication (3 endpoints)

### POST /api/auth/github/device/start
**Method:** `authGithubDeviceStart()`
**Purpose:** Start GitHub OAuth device flow
**Returns:** Device code + user code + verification URI
**Genie Use:** Not needed (Forge handles auth)
**Priority:** LOW

### POST /api/auth/github/device/poll
**Method:** `authGithubDevicePoll(deviceCode)`
**Purpose:** Poll for OAuth completion
**Returns:** Access token when authorized
**Genie Use:** Not needed
**Priority:** LOW

### GET /api/auth/github/check
**Method:** `authGithubCheck()`
**Purpose:** Verify GitHub token validity
**Returns:** User info + valid status
**Genie Use:** Not needed
**Priority:** LOW

---

## Category 3: Configuration (6 endpoints)

### GET /api/info
**Method:** `getSystemInfo()`
**Purpose:** Get user config + executor profiles + capabilities
**Returns:** Complete system info
**Genie Use:** Discover available executors
**Priority:** MEDIUM

### GET /api/config
**Method:** `getConfig()`
**Purpose:** Get user configuration (git, theme, notifications)
**Returns:** User config object
**Genie Use:** Not needed
**Priority:** LOW

### PUT /api/config
**Method:** `updateConfig(config)`
**Purpose:** Update user configuration
**Returns:** Updated config
**Genie Use:** Not needed
**Priority:** LOW

### GET /api/profiles
**Method:** `getExecutorProfiles()`
**Purpose:** Get executor profile configurations
**Returns:** All executor profiles (Claude, Gemini, etc)
**Genie Use:** Map Genie executors to Forge profiles
**Priority:** MEDIUM

### PUT /api/profiles
**Method:** `updateExecutorProfiles(profiles)`
**Purpose:** Update executor profiles
**Returns:** Updated profiles
**Genie Use:** Not needed
**Priority:** LOW

### GET /api/mcp-config?executor={executor}
**Method:** `getMcpConfig(executor)`
**Purpose:** Get MCP servers for executor
**Returns:** MCP configuration
**Genie Use:** Not needed (Genie has own MCP config)
**Priority:** LOW

### POST /api/mcp-config?executor={executor}
**Method:** `updateMcpConfig(executor, config)`
**Purpose:** Update MCP configuration
**Returns:** Updated MCP config
**Genie Use:** Not needed
**Priority:** LOW

### GET /api/sounds/{sound}
**Method:** `getNotificationSound(sound)`
**Purpose:** Get notification sound file
**Returns:** Audio blob
**Genie Use:** Not needed
**Priority:** LOW

---

## Category 4: Projects (8 endpoints)

### GET /api/projects
**Method:** `listProjects()`
**Purpose:** List all projects
**Returns:** Array of projects
**Genie Use:** ✅ **Find "Genie Sessions" project**
**Priority:** **HIGH**

### POST /api/projects
**Method:** `createProject(project)`
**Purpose:** Create new project
**Returns:** Created project with ID
**Genie Use:** ✅ **Create "Genie Sessions" project if not exists**
**Priority:** **HIGH**

### GET /api/projects/{id}
**Method:** `getProject(id)`
**Purpose:** Get project details
**Returns:** Project with all details
**Genie Use:** Verify project exists
**Priority:** MEDIUM

### PUT /api/projects/{id}
**Method:** `updateProject(id, updates)`
**Purpose:** Update project details
**Returns:** Updated project
**Genie Use:** Not needed
**Priority:** LOW

### DELETE /api/projects/{id}
**Method:** `deleteProject(id)`
**Purpose:** Delete project
**Returns:** void
**Genie Use:** Not needed
**Priority:** LOW

### GET /api/projects/{id}/branches
**Method:** `listProjectBranches(id)`
**Purpose:** Get all git branches
**Returns:** Array of branch names
**Genie Use:** Not needed (Genie doesn't manage branches directly)
**Priority:** LOW

### GET /api/projects/{id}/search?q={query}&mode={mode}
**Method:** `searchProjectFiles(id, query, mode)`
**Purpose:** Search files in project
**Returns:** Array of matching files
**Genie Use:** Not needed
**Priority:** LOW

### POST /api/projects/{id}/open-editor
**Method:** `openProjectInEditor(id, request)`
**Purpose:** Open project in code editor
**Returns:** void
**Genie Use:** ✅ **Potential: Open Genie session workspace**
**Priority:** MEDIUM

---

## Category 5: Tasks (6 endpoints)

### GET /api/projects/{project_id}/tasks
**Method:** `listTasks(projectId)`
**Purpose:** List all tasks in project
**Returns:** Array of tasks with attempt status
**Genie Use:** ✅ **List all Genie sessions**
**Priority:** **HIGH**

### POST /api/projects/{project_id}/tasks
**Method:** `createTask(projectId, task)`
**Purpose:** Create new task (not started)
**Returns:** Created task
**Genie Use:** Not needed (use createAndStartTask instead)
**Priority:** LOW

### POST /api/projects/{project_id}/tasks/create-and-start ⭐
**Method:** `createAndStartTask(projectId, request)`
**Purpose:** **Create task AND start execution (atomic)**
**Returns:** Task attempt with execution started
**Genie Use:** ✅ **REPLACE background-launcher.ts!**
**Priority:** **CRITICAL**

### GET /api/projects/{project_id}/tasks/{task_id}
**Method:** `getTask(projectId, taskId)`
**Purpose:** Get task details
**Returns:** Task with all details
**Genie Use:** Get session info
**Priority:** MEDIUM

### PUT /api/projects/{project_id}/tasks/{task_id}
**Method:** `updateTask(projectId, taskId, updates)`
**Purpose:** Update task details
**Returns:** Updated task
**Genie Use:** Update session metadata
**Priority:** MEDIUM

### DELETE /api/projects/{project_id}/tasks/{task_id}
**Method:** `deleteTask(projectId, taskId)`
**Purpose:** Delete task (async cleanup)
**Returns:** void (202 Accepted)
**Genie Use:** Clean up old sessions
**Priority:** LOW

---

## Category 6: Task Attempts (19 endpoints) ⭐ **CRITICAL FOR GENIE**

### GET /api/task-attempts?task_id={task_id}
**Method:** `listTaskAttempts(taskId?)`
**Purpose:** List task attempts (executions)
**Returns:** Array of attempts
**Genie Use:** ✅ **List all session executions**
**Priority:** **HIGH**

### POST /api/task-attempts
**Method:** `createTaskAttempt(request)`
**Purpose:** Create new task attempt (start execution)
**Returns:** New attempt (execution started)
**Genie Use:** Alternative to createAndStartTask
**Priority:** MEDIUM

### GET /api/task-attempts/{id}
**Method:** `getTaskAttempt(id)`
**Purpose:** Get attempt details and status
**Returns:** Attempt with status and process info
**Genie Use:** ✅ **Get session status**
**Priority:** **HIGH**

### POST /api/task-attempts/{id}/follow-up ⭐
**Method:** `followUpTaskAttempt(id, prompt)`
**Purpose:** **Send follow-up prompt to running execution**
**Returns:** New execution process
**Genie Use:** ✅ **REPLACE resume handler!**
**Priority:** **CRITICAL**

### POST /api/task-attempts/{id}/replace-process
**Method:** `replaceTaskAttemptProcess(id, request)`
**Purpose:** Replace executor and send new prompt
**Returns:** New execution process
**Genie Use:** Switch executors mid-session
**Priority:** MEDIUM

### GET /api/task-attempts/{id}/branch-status
**Method:** `getTaskAttemptBranchStatus(id)`
**Purpose:** Get git branch status
**Returns:** Commits ahead/behind, conflicts
**Genie Use:** Show user git status
**Priority:** MEDIUM

### POST /api/task-attempts/{id}/rebase
**Method:** `rebaseTaskAttempt(id, baseBranch)`
**Purpose:** Rebase attempt branch
**Returns:** Branch status, conflicts
**Genie Use:** Rebase before merge
**Priority:** MEDIUM

### POST /api/task-attempts/{id}/merge
**Method:** `mergeTaskAttempt(id)`
**Purpose:** Merge attempt branch to target
**Returns:** Merge result
**Genie Use:** Auto-merge when done
**Priority:** MEDIUM

### POST /api/task-attempts/{id}/push
**Method:** `pushTaskAttemptBranch(id)`
**Purpose:** Push branch to GitHub
**Returns:** void
**Genie Use:** Push before creating PR
**Priority:** MEDIUM

### POST /api/task-attempts/{id}/conflicts/abort
**Method:** `abortTaskAttemptConflicts(id)`
**Purpose:** Abort merge/rebase conflict state
**Returns:** void
**Genie Use:** Rollback conflicts
**Priority:** MEDIUM

### POST /api/task-attempts/{id}/pr ⭐
**Method:** `createTaskAttemptPullRequest(id, request)`
**Purpose:** **Create GitHub PR for attempt**
**Returns:** PR number + URL
**Genie Use:** ✅ **Auto-create PR when session complete!**
**Priority:** **HIGH**

### POST /api/task-attempts/{id}/pr/attach
**Method:** `attachExistingPullRequest(id, prNumber)`
**Purpose:** Link existing PR to attempt
**Returns:** void
**Genie Use:** Link manual PR
**Priority:** LOW

### GET /api/task-attempts/{id}/commit-info?sha={sha}
**Method:** `getCommitInfo(id, sha)`
**Purpose:** Get commit subject by SHA
**Returns:** Commit subject + author
**Genie Use:** Show commit info
**Priority:** LOW

### GET /api/task-attempts/{id}/commit-compare?sha={sha}
**Method:** `compareCommitToHead(id, sha)`
**Purpose:** Compare commit vs HEAD
**Returns:** Files changed, insertions, deletions
**Genie Use:** Show diff stats
**Priority:** LOW

### GET /api/task-attempts/{id}/children
**Method:** `getTaskAttemptChildren(id)`
**Purpose:** Get parent + child tasks
**Returns:** Parent task + child tasks
**Genie Use:** Not needed (Genie doesn't use subtasks)
**Priority:** LOW

### POST /api/task-attempts/{id}/stop ⭐
**Method:** `stopTaskAttemptExecution(id)`
**Purpose:** **Stop execution process**
**Returns:** void
**Genie Use:** ✅ **REPLACE stop handler!**
**Priority:** **CRITICAL**

### POST /api/task-attempts/{id}/change-target-branch
**Method:** `changeTaskAttemptTargetBranch(id, targetBranch)`
**Purpose:** Change target branch
**Returns:** void
**Genie Use:** Not needed
**Priority:** LOW

### POST /api/task-attempts/{id}/open-editor
**Method:** `openTaskAttemptInEditor(id, request)`
**Purpose:** Open worktree in code editor
**Returns:** void
**Genie Use:** ✅ **Open session workspace**
**Priority:** MEDIUM

### POST /api/task-attempts/{id}/start-dev-server
**Method:** `startDevServer(id)`
**Purpose:** Start dev server
**Returns:** Port + URL
**Genie Use:** Not needed
**Priority:** LOW

### POST /api/task-attempts/{id}/delete-file
**Method:** `deleteTaskAttemptFile(id, filePath)`
**Purpose:** Delete file from worktree
**Returns:** void
**Genie Use:** Not needed
**Priority:** LOW

---

## Category 7: Execution Processes (3 endpoints)

### GET /api/execution-processes?task_attempt_id={id}
**Method:** `listExecutionProcesses(taskAttemptId, showSoftDeleted)`
**Purpose:** List execution processes for attempt
**Returns:** Array of processes with logs
**Genie Use:** ✅ **Get process ID for log streaming**
**Priority:** **HIGH**

### GET /api/execution-processes/{id}
**Method:** `getExecutionProcess(id)`
**Purpose:** Get process details
**Returns:** Process with status and output
**Genie Use:** Get process status
**Priority:** MEDIUM

### POST /api/execution-processes/{id}/stop
**Method:** `stopExecutionProcess(id)`
**Purpose:** Stop execution process (SIGTERM)
**Returns:** void
**Genie Use:** Alternative to stopTaskAttemptExecution
**Priority:** MEDIUM

---

## Category 8: Drafts (4 endpoints)

### POST /api/task-attempts/{id}/draft?type={type}
**Method:** `saveDraft(id, type, content)`
**Purpose:** Save draft code changes
**Returns:** Draft ID + saved timestamp
**Genie Use:** ✅ **Save intermediate work**
**Priority:** MEDIUM

### GET /api/task-attempts/{id}/draft?type={type}
**Method:** `getDraft(id, type)`
**Purpose:** Get saved draft
**Returns:** Draft content
**Genie Use:** ✅ **Restore saved work**
**Priority:** MEDIUM

### DELETE /api/task-attempts/{id}/draft?type={type}
**Method:** `deleteDraft(id, type)`
**Purpose:** Delete saved draft
**Returns:** void
**Genie Use:** Clean up drafts
**Priority:** LOW

### POST /api/task-attempts/{id}/draft/queue?type={type}
**Method:** `queueDraftExecution(id, type, request)`
**Purpose:** Queue draft for execution
**Returns:** void
**Genie Use:** Batch execution
**Priority:** LOW

---

## Category 9: Templates (5 endpoints)

### GET /api/templates?global={bool}&project_id={id}
**Method:** `listTaskTemplates(options)`
**Purpose:** List task templates
**Returns:** Array of templates
**Genie Use:** Not needed
**Priority:** LOW

### POST /api/templates
**Method:** `createTaskTemplate(template)`
**Purpose:** Create task template
**Returns:** Created template
**Genie Use:** Not needed
**Priority:** LOW

### GET /api/templates/{template_id}
**Method:** `getTaskTemplate(templateId)`
**Purpose:** Get template details
**Returns:** Template definition
**Genie Use:** Not needed
**Priority:** LOW

### PUT /api/templates/{template_id}
**Method:** `updateTaskTemplate(templateId, updates)`
**Purpose:** Update task template
**Returns:** Updated template
**Genie Use:** Not needed
**Priority:** LOW

### DELETE /api/templates/{template_id}
**Method:** `deleteTaskTemplate(templateId)`
**Purpose:** Delete task template
**Returns:** void
**Genie Use:** Not needed
**Priority:** LOW

---

## Category 10: Images (5 endpoints)

### POST /api/images/upload
**Method:** `uploadImage(file)`
**Purpose:** Upload image (20MB limit)
**Returns:** Image with ID + URL
**Genie Use:** Not needed
**Priority:** LOW

### POST /api/images/task/{task_id}/upload
**Method:** `uploadTaskImage(taskId, file)`
**Purpose:** Upload image for task
**Returns:** Image associated with task
**Genie Use:** Not needed
**Priority:** LOW

### GET /api/images/{id}/file
**Method:** `getImageFile(id)`
**Purpose:** Get image file by ID
**Returns:** Image blob
**Genie Use:** Not needed
**Priority:** LOW

### GET /api/images/task/{task_id}
**Method:** `getTaskImages(taskId)`
**Purpose:** Get all images for task
**Returns:** Array of images
**Genie Use:** Not needed
**Priority:** LOW

### DELETE /api/images/{id}
**Method:** `deleteImage(id)`
**Purpose:** Delete image
**Returns:** void
**Genie Use:** Not needed
**Priority:** LOW

---

## Category 11: Approvals (4 endpoints)

### POST /api/approvals/create
**Method:** `createApprovalRequest(request)`
**Purpose:** Create approval request (pauses execution)
**Returns:** Approval ID
**Genie Use:** ✅ **Human-in-the-loop for destructive operations**
**Priority:** MEDIUM

### GET /api/approvals/{id}/status
**Method:** `getApprovalStatus(id)`
**Purpose:** Get approval status
**Returns:** Status (pending/approved/rejected)
**Genie Use:** ✅ **Check if user approved**
**Priority:** MEDIUM

### POST /api/approvals/{id}/respond
**Method:** `respondToApprovalRequest(id, approved, comment)`
**Purpose:** Approve or reject approval request
**Returns:** void
**Genie Use:** Not needed (user responds via UI)
**Priority:** LOW

### GET /api/approvals/pending
**Method:** `getPendingApprovals()`
**Purpose:** Get list of pending approvals
**Returns:** Array of pending approvals
**Genie Use:** Show pending approvals
**Priority:** LOW

---

## Category 12: Containers (1 endpoint)

### GET /api/containers/info?ref={ref}
**Method:** `getContainerInfo(ref)`
**Purpose:** Resolve container reference to IDs
**Returns:** Container ID + image
**Genie Use:** Not needed
**Priority:** LOW

---

## Category 13: Filesystem (2 endpoints)

### GET /api/filesystem/directory?path={path}
**Method:** `listDirectory(path?)`
**Purpose:** List directory contents
**Returns:** Array of files/directories
**Genie Use:** Not needed
**Priority:** LOW

### GET /api/filesystem/git-repos?path={path}
**Method:** `listGitRepositories(path?)`
**Purpose:** List git repositories
**Returns:** Array of repo paths
**Genie Use:** Not needed
**Priority:** LOW

---

## Category 14: WebSocket Streaming (6 endpoints) ⭐ **CRITICAL FOR REAL-TIME**

### WS /api/projects/{project_id}/tasks/stream/ws
**Method:** `getTasksStreamUrl(projectId)`
**Purpose:** **Real-time task updates**
**Returns:** WebSocket URL
**Genie Use:** ✅ **Live session list updates**
**Priority:** **MEDIUM**

### WS /api/execution-processes/stream/ws?task_attempt_id={id}
**Method:** `getExecutionProcessesStreamUrl(taskAttemptId)`
**Purpose:** **Real-time process status updates**
**Returns:** WebSocket URL
**Genie Use:** ✅ **Live session status**
**Priority:** **HIGH**

### WS /api/execution-processes/{id}/raw-logs/ws ⭐
**Method:** `getRawLogsStreamUrl(processId)`
**Purpose:** **Real-time raw logs (stdout/stderr)**
**Returns:** WebSocket URL
**Genie Use:** ✅ **REPLACE view handler with live logs!**
**Priority:** **CRITICAL**

### WS /api/execution-processes/{id}/normalized-logs/ws
**Method:** `getNormalizedLogsStreamUrl(processId)`
**Purpose:** **Real-time normalized/parsed logs**
**Returns:** WebSocket URL
**Genie Use:** ✅ **Structured log streaming**
**Priority:** **HIGH**

### WS /api/task-attempts/{id}/diff/ws?stats_only={bool} ⭐
**Method:** `getTaskDiffStreamUrl(attemptId, statsOnly)`
**Purpose:** **Real-time file diffs as they happen**
**Returns:** WebSocket URL
**Genie Use:** ✅ **Live diff viewer!**
**Priority:** **HIGH**

### WS /api/drafts/stream/ws?project_id={id}
**Method:** `getDraftsStreamUrl(projectId)`
**Purpose:** **Real-time draft updates**
**Returns:** WebSocket URL
**Genie Use:** Live draft status
**Priority:** LOW

---

## Category 15: Server-Sent Events (1 endpoint)

### GET /api/events
**Method:** `subscribeToEvents()`
**Purpose:** Server-Sent Events stream (real-time updates)
**Returns:** EventSource
**Genie Use:** Global event stream
**Priority:** MEDIUM

---

## Priority Summary for Genie Replacement

### CRITICAL (Must Have - Week 1)
1. ✅ `createAndStartTask()` - **Replace background-launcher.ts**
2. ✅ `followUpTaskAttempt()` - **Replace resume handler**
3. ✅ `stopTaskAttemptExecution()` - **Replace stop handler**
4. ✅ `getRawLogsStreamUrl()` - **Real-time log streaming**
5. ✅ `listTasks()` - **List sessions**
6. ✅ `getTaskAttempt()` - **Get session status**

### HIGH (Should Have - Week 2)
7. ✅ `listProjects()` / `createProject()` - **Project management**
8. ✅ `listExecutionProcesses()` - **Get process IDs for streaming**
9. ✅ `getNormalizedLogsStreamUrl()` - **Structured logs**
10. ✅ `getTaskDiffStreamUrl()` - **Live diffs**
11. ✅ `createTaskAttemptPullRequest()` - **Auto-create PRs**
12. ✅ `getExecutionProcessesStreamUrl()` - **Live process status**

### MEDIUM (Nice to Have - Week 3)
13. ✅ `saveDraft()` / `getDraft()` - **Code drafts**
14. ✅ `createApprovalRequest()` / `getApprovalStatus()` - **Human-in-the-loop**
15. ✅ `getSystemInfo()` / `getExecutorProfiles()` - **Executor discovery**
16. ✅ `openTaskAttemptInEditor()` - **Open workspace**

### LOW (Future Features - Week 4+)
17. All other endpoints (templates, images, filesystem, etc.)

---

## Endpoints We're NOT Using (Yet)

**Total Unused:** ~40 endpoints (44% of API)

**Categories:**
- Templates (5 endpoints) - Not needed
- Images (5 endpoints) - Not needed
- Containers (1 endpoint) - Not needed
- Filesystem (2 endpoints) - Not needed
- Configuration (most of 6 endpoints) - Not needed
- Authentication (3 endpoints) - Forge handles
- Many git operations (rebase, merge, etc.) - Not needed initially

---

## Conclusion

**Total API Surface:** 90+ endpoints
**Genie Will Use:** ~20 endpoints (22%)
**Critical for Replacement:** 6 endpoints
**High Priority:** 6 additional endpoints
**Medium Priority:** 4 additional endpoints
**Low/Future:** Rest of API

**Recommendation:** Start with 6 CRITICAL endpoints (Week 1), add 6 HIGH priority (Week 2), then evaluate need for others.

---

**Report Author:** Genie (forge/120-executor-replacement)
**Date:** 2025-10-18
**Source:** forge.ts (1073 lines analyzed)
**Worktree:** c3d1-forge-120-execut
