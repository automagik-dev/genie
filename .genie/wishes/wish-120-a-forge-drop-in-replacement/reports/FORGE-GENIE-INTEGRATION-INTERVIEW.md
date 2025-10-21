# Forge-Genie Integration Interview Script
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Date:** 2025-10-18
**Purpose:** Collaborative decision-making for each Forge API endpoint
**Format:** Voice agent interview - Felipe provides input for each endpoint
**Duration:** ~30-45 minutes

---

## Instructions for Use

**How to use this script:**
1. Read this document to Claude via voice agent
2. Go through each endpoint category
3. For each endpoint, provide your decision:
   - **YES** - Use this endpoint
   - **NO** - Skip this endpoint
   - **MAYBE** - Interesting but not critical
   - **LATER** - Future feature
4. Add any notes/ideas for each endpoint
5. Paste the completed interview back to Claude

**Format for responses:**
```
[ENDPOINT NAME]: YES/NO/MAYBE/LATER
Notes: [Your thoughts, use cases, concerns]
```

---

## Interview Script

**Claude:** "Hi Felipe! We're going to review all 90+ Forge API endpoints to decide which ones will truly improve Genie. For each endpoint, I'll describe what it does, how I think it could help Genie, and ask for your decision. Ready to begin?"

---

## Category 1: Health & System (1 endpoint)

### Endpoint 1.1: Health Check

**Claude:** "First endpoint: `healthCheck()` - This does a simple health check on the Forge backend to verify it's running.

**My idea for Genie:** Before any Genie operation (run, resume, stop), we could ping this endpoint to verify Forge is available. If it's down, we show a clear error message instead of cryptic timeout failures.

**Potential use cases:**
- Pre-flight check before spawning sessions
- Status indicator in Genie CLI
- Health monitoring for troubleshooting

**Question:** Should we use this endpoint? If yes, when should Genie check Forge health?"

**Your decision:**
```
healthCheck: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 2: Projects (8 endpoints)

### Endpoint 2.1: List Projects

**Claude:** "Endpoint: `listProjects()` - Gets all projects in the Forge workspace.

**My idea for Genie:** When Genie starts, we need to find or create a 'Genie Sessions' project. This endpoint lets us search for it. We could also let users choose which Forge project to use for Genie sessions.

**Potential use cases:**
- Find 'Genie Sessions' project on first run
- Allow users to pick different projects for different Genie workspaces
- Show available projects in `genie config`

**Question:** Should we use this? How should Genie handle multiple Forge projects?"

**Your decision:**
```
listProjects: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 2.2: Create Project

**Claude:** "Endpoint: `createProject(project)` - Creates a new Forge project.

**My idea for Genie:** If 'Genie Sessions' project doesn't exist, automatically create it on first run. This makes setup automatic instead of requiring manual configuration.

**Potential use cases:**
- Auto-create 'Genie Sessions' project
- Let users create dedicated projects per repo
- One-command Genie setup

**Question:** Should Genie auto-create projects, or ask user first?"

**Your decision:**
```
createProject: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 2.3: Get Project

**Claude:** "Endpoint: `getProject(id)` - Gets details for a specific project.

**My idea for Genie:** Verify that the configured Genie project still exists and is accessible. Useful for troubleshooting if user deleted the project.

**Potential use cases:**
- Validate project on startup
- Show project details in `genie config`
- Troubleshooting 'project not found' errors

**Question:** Is this needed, or is listProjects enough?"

**Your decision:**
```
getProject: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 2.4: Update Project

**Claude:** "Endpoint: `updateProject(id, updates)` - Updates project name, scripts, etc.

**My idea for Genie:** Probably not needed. Genie doesn't manage Forge projects, just uses them.

**Potential use cases:**
- Maybe update project metadata from Genie?
- Probably not necessary

**Question:** Should we skip this one?"

**Your decision:**
```
updateProject: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 2.5: Delete Project

**Claude:** "Endpoint: `deleteProject(id)` - Deletes a Forge project.

**My idea for Genie:** Probably not needed. Deleting projects is risky and users should do this in Forge UI.

**Potential use cases:**
- Cleanup command? Seems dangerous
- Skip this

**Question:** Skip this endpoint?"

**Your decision:**
```
deleteProject: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 2.6: List Project Branches

**Claude:** "Endpoint: `listProjectBranches(id)` - Gets all git branches in the project repo.

**My idea for Genie:** Could show available branches when user wants to change base branch. Or validate that specified base branch exists.

**Potential use cases:**
- Branch picker in `genie run --base-branch <tab-complete>`
- Validate base branch before starting session
- Show branch list in `genie status`

**Question:** Is listing branches useful, or overkill?"

**Your decision:**
```
listProjectBranches: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 2.7: Search Project Files

**Claude:** "Endpoint: `searchProjectFiles(id, query, mode)` - Searches for files in the project repo.

**My idea for Genie:** Could be useful for agents to search codebase, but Genie agents already have file search via MCP tools. Probably redundant.

**Potential use cases:**
- Search files before starting session?
- Redundant with MCP file tools

**Question:** Skip this one?"

**Your decision:**
```
searchProjectFiles: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 2.8: Open Project in Editor

**Claude:** "Endpoint: `openProjectInEditor(id, request)` - Opens the project in user's code editor.

**My idea for Genie:** After starting a session, offer to open the session's worktree in the editor. This would be super convenient!

**Example:** `genie run analyze --open` would start session AND open worktree in VSCode.

**Potential use cases:**
- `--open` flag to open editor after session starts
- `genie open <session-id>` command
- Auto-open on resume

**Question:** Would you use this? What editors do you use?"

**Your decision:**
```
openProjectInEditor: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 3: Tasks (6 endpoints)

### Endpoint 3.1: List Tasks

**Claude:** "Endpoint: `listTasks(projectId)` - Lists all tasks in a project.

**My idea for Genie:** THIS IS CRITICAL. This is how we list all Genie sessions. Replaces reading sessions.json file.

**Example:** `genie list` would call this to show all sessions.

**Potential use cases:**
- `genie list` command
- Show recent sessions
- Filter by status (running, completed, failed)

**Question:** This is critical, right? Any specific filtering you need?"

**Your decision:**
```
listTasks: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 3.2: Create Task

**Claude:** "Endpoint: `createTask(projectId, task)` - Creates a task but doesn't start it.

**My idea for Genie:** Probably skip this. We'd use `createAndStartTask` instead (creates + starts in one call). No reason to create a task without starting it.

**Potential use cases:**
- Batch creation? Probably not needed
- Skip this

**Question:** Skip this in favor of createAndStartTask?"

**Your decision:**
```
createTask: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 3.3: Create and Start Task ⭐

**Claude:** "Endpoint: `createAndStartTask(projectId, request)` - Creates task AND starts execution atomically.

**My idea for Genie:** THIS IS THE CORE REPLACEMENT! This replaces background-launcher.ts entirely. One API call, no polling, guaranteed session ID.

**Example:** `genie run analyze 'task'` → one atomic API call, session created instantly.

**Benefits:**
- No 20-second timeout race
- Guaranteed success/failure
- Worktree created automatically
- Branch created automatically

**Question:** This is the most critical endpoint, right? Any concerns?"

**Your decision:**
```
createAndStartTask: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 3.4: Get Task

**Claude:** "Endpoint: `getTask(projectId, taskId)` - Gets details for a specific task.

**My idea for Genie:** Get detailed info about a session, like description, status, when it was created.

**Example:** `genie info <session-id>` would show full session details.

**Potential use cases:**
- `genie info <session-id>` command
- Show session metadata
- Troubleshooting

**Question:** Is this useful, or is listTasks + getTaskAttempt enough?"

**Your decision:**
```
getTask: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 3.5: Update Task

**Claude:** "Endpoint: `updateTask(projectId, taskId, updates)` - Updates task title, description, status.

**My idea for Genie:** Could let users rename sessions, change status, add notes.

**Example:** `genie rename <session-id> 'new name'` or `genie note <session-id> 'added feature X'`

**Potential use cases:**
- Rename sessions
- Add notes/tags to sessions
- Change session status manually

**Question:** Is session metadata management useful?"

**Your decision:**
```
updateTask: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 3.6: Delete Task

**Claude:** "Endpoint: `deleteTask(projectId, taskId)` - Deletes a task (async cleanup).

**My idea for Genie:** Clean up old sessions. Could be part of `genie clean` command to remove completed/failed sessions.

**Example:** `genie clean --older-than 30d` would delete sessions older than 30 days.

**Potential use cases:**
- `genie clean` command
- Auto-cleanup of old sessions
- Disk space management

**Question:** Should Genie have cleanup commands?"

**Your decision:**
```
deleteTask: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 4: Task Attempts (19 endpoints) ⭐ CRITICAL

### Endpoint 4.1: List Task Attempts

**Claude:** "Endpoint: `listTaskAttempts(taskId?)` - Lists all attempts (executions) for a task.

**My idea for Genie:** Show execution history for a session. If user runs the same task multiple times (attempt #1, #2, #3), this shows all attempts.

**Example:** `genie history <session-id>` shows all retry attempts.

**Potential use cases:**
- Show retry history
- Compare different attempts
- Debug why attempt #1 failed but #2 succeeded

**Question:** Is execution history useful, or do you only care about latest attempt?"

**Your decision:**
```
listTaskAttempts: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.2: Create Task Attempt

**Claude:** "Endpoint: `createTaskAttempt(request)` - Creates a new attempt for existing task.

**My idea for Genie:** Alternative to createAndStartTask. Use this when retrying a task that already exists.

**Example:** `genie retry <session-id>` would create attempt #2 for same task.

**Potential use cases:**
- Retry failed sessions
- Run same task with different executor
- A/B testing (same prompt, different models)

**Question:** Is retry functionality needed, or just start new sessions?"

**Your decision:**
```
createTaskAttempt: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.3: Get Task Attempt

**Claude:** "Endpoint: `getTaskAttempt(id)` - Gets details and status for a specific attempt.

**My idea for Genie:** THIS IS CRITICAL. This is how we check session status (running, completed, failed).

**Example:** `genie status <session-id>` shows if session is still running.

**Potential use cases:**
- `genie status <session-id>`
- Show execution state
- Poll for completion

**Question:** This is critical, right? What status info do you need to see?"

**Your decision:**
```
getTaskAttempt: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.4: Follow-Up Task Attempt ⭐

**Claude:** "Endpoint: `followUpTaskAttempt(id, prompt)` - Sends follow-up prompt to running execution.

**My idea for Genie:** THIS IS CRITICAL. This replaces the resume handler. Instead of re-spawning the process, we send a follow-up to the SAME executor.

**Example:** `genie resume <session-id> 'continue with tests'` sends to running executor.

**Benefits:**
- No process re-spawn
- Conversation continuity
- Same context preserved

**Question:** This is critical, right? Any special requirements for follow-ups?"

**Your decision:**
```
followUpTaskAttempt: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.5: Replace Task Attempt Process

**Claude:** "Endpoint: `replaceTaskAttemptProcess(id, request)` - Replaces the executor and sends new prompt.

**My idea for Genie:** Switch executors mid-session. Start with Claude, switch to Gemini if stuck.

**Example:** `genie switch <session-id> --executor gemini 'try different approach'`

**Potential use cases:**
- Switch models mid-task
- Escalate to more powerful model
- Try different executor if one fails

**Question:** Is executor switching useful, or just start new session?"

**Your decision:**
```
replaceTaskAttemptProcess: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.6: Get Task Attempt Branch Status

**Claude:** "Endpoint: `getTaskAttemptBranchStatus(id)` - Gets git branch status (commits ahead/behind, conflicts).

**My idea for Genie:** Show user if session branch has conflicts or needs rebase.

**Example:** `genie status <session-id>` shows 'Branch is 5 commits behind main, has 2 conflicts'.

**Potential use cases:**
- Show branch status in `genie status`
- Warn about conflicts before merge
- Show commits made by agent

**Question:** Is git branch info useful in Genie CLI?"

**Your decision:**
```
getTaskAttemptBranchStatus: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.7: Rebase Task Attempt

**Claude:** "Endpoint: `rebaseTaskAttempt(id, baseBranch)` - Rebases session branch onto new base.

**My idea for Genie:** Keep session branch up-to-date with main. Handle conflicts automatically if possible.

**Example:** `genie rebase <session-id>` rebases on latest main.

**Potential use cases:**
- Keep branch updated during long sessions
- Rebase before creating PR
- Conflict resolution

**Question:** Should Genie handle git operations, or leave to user?"

**Your decision:**
```
rebaseTaskAttempt: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.8: Merge Task Attempt

**Claude:** "Endpoint: `mergeTaskAttempt(id)` - Merges session branch to target branch.

**My idea for Genie:** Auto-merge session when complete and tests pass.

**Example:** `genie merge <session-id>` merges to main.

**Potential use cases:**
- Auto-merge after session completes
- One-command merge workflow
- Skip PR for simple changes

**Question:** Auto-merge or always create PR first?"

**Your decision:**
```
mergeTaskAttempt: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.9: Push Task Attempt Branch

**Claude:** "Endpoint: `pushTaskAttemptBranch(id)` - Pushes session branch to GitHub.

**My idea for Genie:** Push before creating PR. Could auto-push when session completes.

**Example:** `genie push <session-id>` or auto-push on `genie pr`.

**Potential use cases:**
- Auto-push before PR creation
- Manual push command
- Backup work to remote

**Question:** Auto-push or manual control?"

**Your decision:**
```
pushTaskAttemptBranch: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.10: Abort Task Attempt Conflicts

**Claude:** "Endpoint: `abortTaskAttemptConflicts(id)` - Aborts merge/rebase conflict state.

**My idea for Genie:** Rollback if rebase creates conflicts.

**Example:** `genie abort <session-id>` cancels conflict state.

**Potential use cases:**
- Rollback failed rebase
- Cancel merge conflicts
- Reset to clean state

**Question:** Needed, or let Forge handle conflicts?"

**Your decision:**
```
abortTaskAttemptConflicts: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.11: Create Task Attempt Pull Request ⭐

**Claude:** "Endpoint: `createTaskAttemptPullRequest(id, request)` - Creates GitHub PR for session.

**My idea for Genie:** THIS IS HIGH VALUE! Auto-create PR when session completes.

**Example:** `genie pr <session-id>` or auto-create on session completion.

**Benefits:**
- Zero-click PR workflow
- Session → PR → Review → Merge
- Automatic PR descriptions

**Question:** Auto-create PR on completion, or manual command?"

**Your decision:**
```
createTaskAttemptPullRequest: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.12: Attach Existing Pull Request

**Claude:** "Endpoint: `attachExistingPullRequest(id, prNumber)` - Links existing PR to session.

**My idea for Genie:** Link manual PR to session for tracking.

**Example:** `genie link-pr <session-id> 123` links PR #123.

**Potential use cases:**
- Link PR created manually
- Track PR status in Genie
- Probably not critical

**Question:** Skip this?"

**Your decision:**
```
attachExistingPullRequest: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.13-4.14: Commit Info & Compare

**Claude:** "Endpoints: `getCommitInfo(id, sha)` and `compareCommitToHead(id, sha)` - Get commit details and compare commits.

**My idea for Genie:** Show what changed in specific commits.

**Example:** `genie show <session-id> <commit-sha>` shows commit details.

**Potential use cases:**
- Show commit history
- Compare commits
- Probably not critical for MVP

**Question:** Skip these?"

**Your decision:**
```
getCommitInfo & compareCommitToHead: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.15: Get Task Attempt Children

**Claude:** "Endpoint: `getTaskAttemptChildren(id)` - Gets parent and child tasks (subtasks).

**My idea for Genie:** Genie doesn't use subtasks, so skip this.

**Question:** Skip?"

**Your decision:**
```
getTaskAttemptChildren: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.16: Stop Task Attempt Execution ⭐

**Claude:** "Endpoint: `stopTaskAttemptExecution(id)` - Stops execution process.

**My idea for Genie:** THIS IS CRITICAL. This replaces the stop handler. No more PID tracking!

**Example:** `genie stop <session-id>` stops the agent.

**Benefits:**
- No PID management
- Guaranteed stop
- Backend handles cleanup

**Question:** This is critical, right?"

**Your decision:**
```
stopTaskAttemptExecution: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.17: Change Task Attempt Target Branch

**Claude:** "Endpoint: `changeTaskAttemptTargetBranch(id, targetBranch)` - Changes target branch for PR.

**My idea for Genie:** Change target if main was deleted or needs different target.

**Example:** `genie retarget <session-id> develop`

**Potential use cases:**
- Change PR target branch
- Handle branch renames
- Probably not common

**Question:** Skip this?"

**Your decision:**
```
changeTaskAttemptTargetBranch: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.18: Open Task Attempt in Editor

**Claude:** "Endpoint: `openTaskAttemptInEditor(id, request)` - Opens session worktree in code editor.

**My idea for Genie:** THIS IS HIGH VALUE! Open session workspace in editor.

**Example:** `genie open <session-id>` opens worktree in VSCode.

**Benefits:**
- One command to open workspace
- Review agent's changes
- Continue work manually

**Question:** Would you use this often?"

**Your decision:**
```
openTaskAttemptInEditor: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.19: Start Dev Server

**Claude:** "Endpoint: `startDevServer(id)` - Starts dev server for session.

**My idea for Genie:** Auto-start dev server when agent is working on frontend.

**Example:** `genie dev <session-id>` starts dev server.

**Potential use cases:**
- Preview agent's changes
- Auto-start when agent modifies frontend
- Probably not critical

**Question:** Skip this?"

**Your decision:**
```
startDevServer: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 4.20: Delete Task Attempt File

**Claude:** "Endpoint: `deleteTaskAttemptFile(id, filePath)` - Deletes file from worktree.

**My idea for Genie:** Probably not needed. Agents delete files directly.

**Question:** Skip?"

**Your decision:**
```
deleteTaskAttemptFile: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 5: Execution Processes (3 endpoints)

### Endpoint 5.1: List Execution Processes

**Claude:** "Endpoint: `listExecutionProcesses(taskAttemptId, showSoftDeleted)` - Lists execution processes for a session.

**My idea for Genie:** THIS IS CRITICAL. We need the process ID to stream logs via WebSocket.

**Flow:** Get session → list processes → get process ID → stream logs

**Question:** This is critical for log streaming, right?"

**Your decision:**
```
listExecutionProcesses: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 5.2: Get Execution Process

**Claude:** "Endpoint: `getExecutionProcess(id)` - Gets process details and status.

**My idea for Genie:** Check process status (running, completed, failed).

**Example:** Show process status in `genie status <session-id>`.

**Question:** Needed, or is getTaskAttempt enough?"

**Your decision:**
```
getExecutionProcess: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 5.3: Stop Execution Process

**Claude:** "Endpoint: `stopExecutionProcess(id)` - Stops execution process.

**My idea for Genie:** Alternative to stopTaskAttemptExecution. Probably redundant.

**Question:** Skip this, use stopTaskAttemptExecution instead?"

**Your decision:**
```
stopExecutionProcess: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 6: WebSocket Streaming (6 endpoints) ⭐ CRITICAL

### Endpoint 6.1: Tasks Stream

**Claude:** "Endpoint: `getTasksStreamUrl(projectId)` - WebSocket stream of task updates.

**My idea for Genie:** Live updates when new sessions are created or completed.

**Example:** `genie watch` shows real-time task updates.

**Potential use cases:**
- Live session list updates
- Dashboard showing active sessions
- Not critical for MVP

**Question:** Useful or skip for now?"

**Your decision:**
```
getTasksStreamUrl: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 6.2: Execution Processes Stream

**Claude:** "Endpoint: `getExecutionProcessesStreamUrl(taskAttemptId)` - WebSocket stream of process status.

**My idea for Genie:** Live updates when process starts, stops, fails.

**Example:** `genie status <session-id> --watch` shows live status.

**Potential use cases:**
- Live status monitoring
- Alert when process fails
- Nice to have

**Question:** Useful or skip for now?"

**Your decision:**
```
getExecutionProcessesStreamUrl: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 6.3: Raw Logs Stream ⭐

**Claude:** "Endpoint: `getRawLogsStreamUrl(processId)` - WebSocket stream of raw stdout/stderr.

**My idea for Genie:** THIS IS CRITICAL! Replace file-based log viewing with real-time streaming.

**Example:** `genie view <session-id> --live` streams logs in real-time.

**Benefits:**
- No manual refresh
- < 100ms latency
- See logs as they happen

**Question:** This is critical, right? Any special formatting needed?"

**Your decision:**
```
getRawLogsStreamUrl: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 6.4: Normalized Logs Stream

**Claude:** "Endpoint: `getNormalizedLogsStreamUrl(processId)` - WebSocket stream of parsed/structured logs.

**My idea for Genie:** Structured log streaming with parsing. Better than raw logs for automation.

**Example:** Parse logs to detect errors, warnings, tool calls.

**Potential use cases:**
- Structured log analysis
- Auto-detect errors
- Better than raw logs for scripting

**Question:** Use this instead of raw logs, or both?"

**Your decision:**
```
getNormalizedLogsStreamUrl: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 6.5: Task Diff Stream ⭐

**Claude:** "Endpoint: `getTaskDiffStreamUrl(attemptId, statsOnly)` - WebSocket stream of file diffs.

**My idea for Genie:** THIS IS HIGH VALUE! See file changes as agent makes them.

**Example:** `genie diff <session-id> --live` shows diffs in real-time.

**Benefits:**
- See changes as they happen
- Monitor agent progress
- Review changes live

**Question:** Would you use this? Stats only or full diffs?"

**Your decision:**
```
getTaskDiffStreamUrl: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 6.6: Drafts Stream

**Claude:** "Endpoint: `getDraftsStreamUrl(projectId)` - WebSocket stream of draft updates.

**My idea for Genie:** Live updates when agent saves drafts. Probably not critical.

**Question:** Skip for now?"

**Your decision:**
```
getDraftsStreamUrl: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 7: Drafts (4 endpoints)

### Endpoint 7.1-7.2: Save & Get Draft

**Claude:** "Endpoints: `saveDraft(id, type, content)` and `getDraft(id, type)` - Save and retrieve code drafts.

**My idea for Genie:** Agent saves intermediate work, user can restore it later.

**Example:** Agent saves 3 different approaches, user picks best one.

**Potential use cases:**
- A/B testing (multiple solutions)
- Rollback to earlier version
- Save progress before risky changes

**Question:** Is draft management useful, or just use git commits?"

**Your decision:**
```
saveDraft & getDraft: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 7.3: Delete Draft

**Claude:** "Endpoint: `deleteDraft(id, type)` - Deletes saved draft.

**My idea for Genie:** Clean up drafts. Probably not needed if we use drafts.

**Question:** Skip?"

**Your decision:**
```
deleteDraft: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 7.4: Queue Draft Execution

**Claude:** "Endpoint: `queueDraftExecution(id, type, request)` - Queues draft for execution.

**My idea for Genie:** Batch execution of multiple drafts.

**Example:** Agent creates 3 drafts, execute all in sequence.

**Question:** Skip?"

**Your decision:**
```
queueDraftExecution: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 8: Approvals (4 endpoints)

### Endpoint 8.1-8.2: Create Approval Request & Get Status

**Claude:** "Endpoints: `createApprovalRequest(request)` and `getApprovalStatus(id)` - Request human approval and check status.

**My idea for Genie:** HUMAN-IN-THE-LOOP! Agent pauses and asks for approval before destructive operations.

**Example:** Agent says 'About to delete 100 files, approve?' - Genie shows approval request, user approves/rejects.

**Potential use cases:**
- Confirm destructive operations (file deletion, DB migrations)
- Review code before committing
- Approve external API calls (cost implications)

**Question:** Is human-in-the-loop useful? What operations need approval?"

**Your decision:**
```
createApprovalRequest & getApprovalStatus: YES/NO/MAYBE/LATER
Notes:
```

---

### Endpoint 8.3-8.4: Respond to Approval & Get Pending

**Claude:** "Endpoints: `respondToApprovalRequest(id, approved, comment)` and `getPendingApprovals()` - Respond to approvals and list pending.

**My idea for Genie:** User approves via Genie CLI or Forge UI. List all pending approvals.

**Example:** `genie approvals` shows pending requests, `genie approve <id>` approves.

**Question:** Should Genie handle approvals, or just show in Forge UI?"

**Your decision:**
```
respondToApprovalRequest & getPendingApprovals: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 9: Templates (5 endpoints)

**Claude:** "Category: Task Templates - Reusable task definitions.

All 5 endpoints (`listTaskTemplates`, `createTaskTemplate`, `getTaskTemplate`, `updateTaskTemplate`, `deleteTaskTemplate`).

**My idea for Genie:** Create templates for common agent tasks.

**Example:** Save 'code review' template, reuse for all PRs.

**Potential use cases:**
- Template library for common tasks
- Share templates across team
- Probably not critical for MVP

**Question:** Skip templates for now, or useful?"

**Your decision:**
```
ALL Template endpoints: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 10: Images (5 endpoints)

**Claude:** "Category: Image Upload & Management - Upload images for tasks.

All 5 endpoints (`uploadImage`, `uploadTaskImage`, `getImageFile`, `getTaskImages`, `deleteImage`).

**My idea for Genie:** Attach screenshots or diagrams to sessions. Probably not needed for code tasks.

**Example:** Attach mockup to 'implement UI' task.

**Question:** Skip images?"

**Your decision:**
```
ALL Image endpoints: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 11: Configuration (6 endpoints)

**Claude:** "Category: Configuration - System info, executor profiles, MCP config.

**Endpoints:**
- `getSystemInfo()` - Get executor profiles and capabilities
- `getExecutorProfiles()` - Get executor configs
- Others: getConfig, updateConfig, getMcpConfig, updateMcpConfig

**My idea for Genie:** Use getSystemInfo to discover available executors. Map Genie executors to Forge profiles.

**Example:** `genie executors` lists available executors from Forge.

**Question:** Just getSystemInfo + getExecutorProfiles, or skip all?"

**Your decision:**
```
Configuration endpoints: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 12-13: Containers & Filesystem

**Claude:** "Categories: Containers (1 endpoint) and Filesystem (2 endpoints).

**Endpoints:**
- `getContainerInfo(ref)` - Container reference resolution
- `listDirectory(path)` - List directory contents
- `listGitRepositories(path)` - List git repos

**My idea for Genie:** Probably not needed. Genie doesn't manage containers or browse filesystem directly.

**Question:** Skip all of these?"

**Your decision:**
```
Containers & Filesystem endpoints: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 14: Authentication (3 endpoints)

**Claude:** "Category: Authentication - GitHub OAuth device flow.

All 3 endpoints for GitHub OAuth.

**My idea for Genie:** Forge handles auth, Genie doesn't need to manage tokens.

**Question:** Skip all auth endpoints?"

**Your decision:**
```
Authentication endpoints: YES/NO/MAYBE/LATER
Notes:
```

---

## Category 15: Server-Sent Events (1 endpoint)

**Claude:** "Endpoint: `subscribeToEvents()` - Server-Sent Events stream for global updates.

**My idea for Genie:** Alternative to WebSocket. Get real-time updates about all Forge events.

**Example:** Subscribe to all events, show notifications in Genie.

**Question:** Use this for global monitoring, or stick with WebSockets?"

**Your decision:**
```
subscribeToEvents: YES/NO/MAYBE/LATER
Notes:
```

---

## Final Questions

**Claude:** "We've reviewed all 90+ endpoints! A few final questions:

**1. Priority Confirmation:**
Based on your responses, what are your top 5 MUST-HAVE endpoints for Week 1?

**Your answer:**
```
Top 5 MUST-HAVE:
1.
2.
3.
4.
5.
```

**2. New Feature Priorities:**
Which NEW features (not in current Genie) are most exciting?
- Real-time log streaming?
- Live file diffs?
- PR automation?
- Human-in-the-loop approvals?
- Editor integration?
- Other?

**Your answer:**
```
Most exciting new features:
1.
2.
3.
```

**3. Phasing Strategy:**
How should we phase the implementation?
- Week 1: Core replacement only (6 endpoints)?
- Week 2: Core + Streaming (12 endpoints)?
- Week 3: Core + Streaming + Advanced (20 endpoints)?

**Your answer:**
```
Phasing preference:

```

**4. Testing Priority:**
Which endpoints MUST be tested thoroughly before production?

**Your answer:**
```
Critical endpoints for testing:

```

**5. Concerns:**
Any concerns about Forge integration? Performance, reliability, complexity?

**Your answer:**
```
Concerns:

```

---

## Interview Complete!

**Claude:** "Thanks Felipe! Please paste this completed interview back to me. I'll use your decisions to create a refined implementation plan with ONLY the endpoints you approved."

---

**End of Interview Script**
**Total Endpoints Reviewed:** 90+
**Estimated Interview Time:** 30-45 minutes
**Next Step:** Paste completed interview back to Claude for implementation planning
