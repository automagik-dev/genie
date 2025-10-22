/**
 * Automagik Forge Backend Client
 * Type-safe TypeScript client for all Forge API endpoints
 *
 * Complete API documentation for all 80+ endpoints with full parameter details
 */
/**
 * Complete Forge Backend Client
 * Provides type-safe access to all Automagik Forge API endpoints
 */
class ForgeClient {
    constructor(baseUrl, token) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.token = token;
    }
    async request(method, path, options) {
        const url = new URL(`${this.baseUrl}/api${path}`);
        if (options?.query) {
            Object.entries(options.query).forEach(([key, value]) => {
                url.searchParams.append(key, String(value));
            });
        }
        const response = await fetch(url.toString(), {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(this.token && { Authorization: `Bearer ${this.token}` }),
            },
            body: options?.body ? JSON.stringify(options.body) : undefined,
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`[${response.status}] ${response.statusText}: ${errorBody}`);
        }
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.message || 'API request failed');
        }
        // For DELETE operations, data field might not exist
        return result.data !== undefined ? result.data : null;
    }
    // ============================================================================
    // HEALTH & SYSTEM
    // ============================================================================
    /**
     * GET /health
     * Simple health check endpoint
     * @returns 200 OK if service is healthy
     */
    async healthCheck() {
        const url = `${this.baseUrl}/health`;
        const res = await fetch(url);
        return res.json();
    }
    // ============================================================================
    // AUTHENTICATION - GitHub OAuth Device Flow
    // ============================================================================
    /**
     * POST /api/auth/github/device/start
     * Start GitHub device authentication flow
     * Returns device_code and user_code for user to authorize
     * @returns Device code and user code for OAuth
     */
    async authGithubDeviceStart() {
        return this.request('POST', '/auth/github/device/start');
    }
    /**
     * POST /api/auth/github/device/poll
     * Poll for GitHub device flow authorization completion
     * Call this repeatedly until user authorizes or timeout
     * @param deviceCode - Device code from start request
     * @returns GitHub token when authorized
     */
    async authGithubDevicePoll(deviceCode) {
        return this.request('POST', '/auth/github/device/poll', {
            body: { device_code: deviceCode },
        });
    }
    /**
     * GET /api/auth/github/check
     * Verify if GitHub token is valid
     * @returns User info if token is valid
     */
    async authGithubCheck() {
        return this.request('GET', '/auth/github/check');
    }
    // ============================================================================
    // CONFIGURATION - User Preferences & MCP Settings
    // ============================================================================
    /**
     * GET /api/info
     * Get comprehensive user system info including profiles and capabilities
     * @returns User config, executor profiles, and system capabilities
     */
    async getSystemInfo() {
        return this.request('GET', '/info');
    }
    /**
     * GET /api/config
     * Get user configuration (git preferences, theme, notifications, etc)
     * @returns Current user configuration
     */
    async getConfig() {
        return this.request('GET', '/config');
    }
    /**
     * PUT /api/config
     * Update user configuration
     * @param config - Partial config to update
     * @returns Updated configuration
     */
    async updateConfig(config) {
        return this.request('PUT', '/config', { body: config });
    }
    /**
     * GET /api/profiles
     * Get executor profiles configuration (Claude, Gemini, etc)
     * @returns All executor profile configurations
     */
    async getExecutorProfiles() {
        return this.request('GET', '/profiles');
    }
    /**
     * PUT /api/profiles
     * Update executor profiles configuration
     * @param profiles - Raw JSON string of profile configs
     * @returns Updated profiles
     */
    async updateExecutorProfiles(profiles) {
        return this.request('PUT', '/profiles', { body: { profiles } });
    }
    /**
     * GET /api/mcp-config?executor={executor}
     * Get MCP (Model Context Protocol) servers for specific executor
     * @param executor - Executor type (CLAUDE_CODE, GEMINI, CODEX, etc)
     * @returns MCP server configuration for executor
     */
    async getMcpConfig(executor) {
        return this.request('GET', '/mcp-config', { query: { executor } });
    }
    /**
     * POST /api/mcp-config?executor={executor}
     * Update MCP servers configuration for executor
     * @param executor - Executor type
     * @param config - MCP server configuration
     * @returns Updated MCP configuration
     */
    async updateMcpConfig(executor, config) {
        return this.request('POST', '/mcp-config', {
            body: config,
            query: { executor },
        });
    }
    /**
     * GET /api/sounds/{sound}
     * Get notification sound file
     * @param sound - Sound file name (ABSTRACT_SOUND1, ROOSTER, etc)
     * @returns Audio file content
     */
    async getNotificationSound(sound) {
        const url = `${this.baseUrl}/api/sounds/${sound}`;
        return fetch(url).then(r => r.blob());
    }
    // ============================================================================
    // PROJECTS - Create, Read, Update, Delete Projects
    // ============================================================================
    /**
     * GET /api/projects
     * List all projects in the workspace
     * @returns Array of all projects
     */
    async listProjects() {
        return this.request('GET', '/projects');
    }
    /**
     * POST /api/projects
     * Create a new project
     * @param project - Project creation details (name, repo path, scripts)
     * @returns Created project with ID
     */
    async createProject(project) {
        return this.request('POST', '/projects', { body: project });
    }
    /**
     * GET /api/projects/{id}
     * Get project details by ID
     * @param id - Project UUID
     * @returns Project details
     */
    async getProject(id) {
        return this.request('GET', `/projects/${id}`);
    }
    /**
     * PUT /api/projects/{id}
     * Update project details
     * @param id - Project UUID
     * @param updates - Fields to update (name, setup_script, dev_script, etc)
     * @returns Updated project
     */
    async updateProject(id, updates) {
        return this.request('PUT', `/projects/${id}`, { body: updates });
    }
    /**
     * DELETE /api/projects/{id}
     * Delete a project (removes from DB, not filesystem)
     * @param id - Project UUID
     */
    async deleteProject(id) {
        await this.request('DELETE', `/projects/${id}`);
    }
    /**
     * GET /api/projects/{id}/branches
     * Get all git branches in project repository
     * @param id - Project UUID
     * @returns Array of branch names
     */
    async listProjectBranches(id) {
        return this.request('GET', `/projects/${id}/branches`);
    }
    /**
     * GET /api/projects/{id}/search?q={query}&mode={mode}
     * Search files in project repository
     * @param id - Project UUID
     * @param query - Search term (filename, directory name, or full path)
     * @param mode - Search mode: "FileName" | "DirectoryName" | "FullPath"
     * @returns Array of matching files with paths and metadata
     */
    async searchProjectFiles(id, query, mode = 'FileName') {
        return this.request('GET', `/projects/${id}/search`, {
            query: { q: query, mode },
        });
    }
    /**
     * POST /api/projects/{id}/open-editor
     * Open project in user's configured code editor
     * @param id - Project UUID
     * @param request - Optional editor request (file path, line number)
     */
    async openProjectInEditor(id, request) {
        await this.request('POST', `/projects/${id}/open-editor`, { body: request });
    }
    // ============================================================================
    // TASKS - Create, Read, Update, Delete Tasks
    // ============================================================================
    /**
     * GET /api/projects/{project_id}/tasks
     * List all tasks in a project
     * @param projectId - Project UUID
     * @returns Array of tasks with attempt status info
     */
    async listTasks(projectId) {
        return this.request('GET', `/projects/${projectId}/tasks`);
    }
    /**
     * POST /api/projects/{project_id}/tasks
     * Create a new task (not started)
     * @param projectId - Project UUID
     * @param task - Task creation details (title, description)
     * @returns Created task with ID
     */
    async createTask(projectId, task) {
        return this.request('POST', `/projects/${projectId}/tasks`, { body: task });
    }
    /**
     * POST /api/tasks/create-and-start
     * Create a task AND immediately start task attempt (all-in-one)
     * Faster than create + start separately
     * @param request - Full request with task object, executor_profile_id, and base_branch
     * @returns New task with attempt started
     */
    async createAndStartTask(request) {
        return this.request('POST', `/tasks/create-and-start`, {
            body: request,
        });
    }
    /**
     * GET /api/projects/{project_id}/tasks/{task_id}
     * Get task details
     * @param projectId - Project UUID
     * @param taskId - Task UUID
     * @returns Task with all details and attempt status
     */
    async getTask(projectId, taskId) {
        return this.request('GET', `/projects/${projectId}/tasks/${taskId}`);
    }
    /**
     * PUT /api/projects/{project_id}/tasks/{task_id}
     * Update task details (title, description, status, images)
     * @param projectId - Project UUID
     * @param taskId - Task UUID
     * @param updates - Fields to update
     * @returns Updated task
     */
    async updateTask(projectId, taskId, updates) {
        return this.request('PUT', `/projects/${projectId}/tasks/${taskId}`, { body: updates });
    }
    /**
     * DELETE /api/projects/{project_id}/tasks/{task_id}
     * Delete a task (async cleanup)
     * Returns 202 Accepted - deletion happens in background
     * @param projectId - Project UUID
     * @param taskId - Task UUID
     */
    async deleteTask(projectId, taskId) {
        await this.request('DELETE', `/projects/${projectId}/tasks/${taskId}`);
    }
    // ============================================================================
    // TASK ATTEMPTS - AI Agent Execution & Orchestration
    // ============================================================================
    /**
     * GET /api/task-attempts?task_id={task_id}
     * List task attempts (executions) for a task
     * @param taskId - Optional filter by task UUID
     * @returns Array of task attempts
     */
    async listTaskAttempts(taskId) {
        return this.request('GET', '/task-attempts', { query: taskId ? { task_id: taskId } : {} });
    }
    /**
     * POST /api/task-attempts
     * Create a new task attempt (start AI execution)
     * This spawns the selected executor to work on the task
     * @param request - Executor, base branch, task ID
     * @returns New task attempt (execution started)
     */
    async createTaskAttempt(request) {
        return this.request('POST', '/task-attempts', { body: request });
    }
    /**
     * GET /api/task-attempts/{id}
     * Get task attempt details and execution status
     * @param id - Task attempt UUID
     * @returns Task attempt with status and process info
     */
    async getTaskAttempt(id) {
        return this.request('GET', `/task-attempts/${id}`);
    }
    /**
     * POST /api/task-attempts/{id}/follow-up
     * Send follow-up prompt to running/paused execution
     * Executor will use this to continue work
     * @param id - Task attempt UUID
     * @param prompt - Follow-up message for AI agent
     * @returns New execution process
     */
    async followUpTaskAttempt(id, prompt) {
        return this.request('POST', `/task-attempts/${id}/follow-up`, {
            body: { follow_up_prompt: prompt },
        });
    }
    /**
     * POST /api/task-attempts/{id}/replace-process
     * Replace the execution process and send new prompt
     * Use when you want to switch executors or restart with new instructions
     * @param id - Task attempt UUID
     * @param request - New executor and prompt
     * @returns New execution process
     */
    async replaceTaskAttemptProcess(id, request) {
        return this.request('POST', `/task-attempts/${id}/replace-process`, { body: request });
    }
    /**
     * GET /api/task-attempts/{id}/branch-status
     * Get git branch status for task attempt
     * Shows commits ahead/behind, merge conflicts, etc
     * @param id - Task attempt UUID
     * @returns Branch status with commit info
     */
    async getTaskAttemptBranchStatus(id) {
        return this.request('GET', `/task-attempts/${id}/branch-status`);
    }
    /**
     * POST /api/task-attempts/{id}/rebase
     * Rebase task attempt branch onto new base branch
     * Handles merge conflicts automatically if possible
     * @param id - Task attempt UUID
     * @param baseBranch - New base branch to rebase onto
     * @returns Updated branch status
     */
    async rebaseTaskAttempt(id, baseBranch) {
        return this.request('POST', `/task-attempts/${id}/rebase`, {
            body: { base_branch: baseBranch },
        });
    }
    /**
     * POST /api/task-attempts/{id}/merge
     * Merge task attempt branch to target branch
     * @param id - Task attempt UUID
     * @returns Merge result
     */
    async mergeTaskAttempt(id) {
        return this.request('POST', `/task-attempts/${id}/merge`);
    }
    /**
     * POST /api/task-attempts/{id}/push
     * Push task attempt branch to GitHub
     * @param id - Task attempt UUID
     */
    async pushTaskAttemptBranch(id) {
        await this.request('POST', `/task-attempts/${id}/push`);
    }
    /**
     * POST /api/task-attempts/{id}/conflicts/abort
     * Abort rebase/merge conflict state
     * Rolls back to previous clean state
     * @param id - Task attempt UUID
     */
    async abortTaskAttemptConflicts(id) {
        await this.request('POST', `/task-attempts/${id}/conflicts/abort`);
    }
    /**
     * POST /api/task-attempts/{id}/pr
     * Create GitHub PR for task attempt branch
     * @param id - Task attempt UUID
     * @param request - PR title, description, target branch
     * @returns Created PR info (URL, number, etc)
     */
    async createTaskAttemptPullRequest(id, request) {
        return this.request('POST', `/task-attempts/${id}/pr`, { body: request });
    }
    /**
     * POST /api/task-attempts/{id}/pr/attach
     * Attach existing GitHub PR to task attempt
     * Links task execution to ongoing PR
     * @param id - Task attempt UUID
     * @param prNumber - GitHub PR number
     */
    async attachExistingPullRequest(id, prNumber) {
        await this.request('POST', `/task-attempts/${id}/pr/attach`, {
            body: { pr_number: prNumber },
        });
    }
    /**
     * GET /api/task-attempts/{id}/commit-info?sha={sha}
     * Get commit subject by SHA
     * @param id - Task attempt UUID
     * @param sha - Git commit SHA
     * @returns Commit subject and metadata
     */
    async getCommitInfo(id, sha) {
        return this.request('GET', `/task-attempts/${id}/commit-info`, { query: { sha } });
    }
    /**
     * GET /api/task-attempts/{id}/commit-compare?sha={sha}
     * Compare commit against HEAD of task branch
     * Shows what changed between commit and current
     * @param id - Task attempt UUID
     * @param sha - Git commit SHA to compare
     * @returns Diff and comparison results
     */
    async compareCommitToHead(id, sha) {
        return this.request('GET', `/task-attempts/${id}/commit-compare`, { query: { sha } });
    }
    /**
     * GET /api/task-attempts/{id}/children
     * Get parent task and child tasks (subtasks)
     * Task hierarchy relationships
     * @param id - Task attempt UUID
     * @returns Parent task and child task list
     */
    async getTaskAttemptChildren(id) {
        return this.request('GET', `/task-attempts/${id}/children`);
    }
    /**
     * POST /api/task-attempts/{id}/stop
     * Stop execution process for attempt
     * Halts AI agent work
     * @param id - Task attempt UUID
     */
    async stopTaskAttemptExecution(id) {
        await this.request('POST', `/task-attempts/${id}/stop`);
    }
    /**
     * POST /api/task-attempts/{id}/change-target-branch
     * Change target branch for task attempt
     * Useful if target was deleted or needs to change
     * @param id - Task attempt UUID
     * @param targetBranch - New target branch name
     */
    async changeTaskAttemptTargetBranch(id, targetBranch) {
        await this.request('POST', `/task-attempts/${id}/change-target-branch`, {
            body: { target_branch: targetBranch },
        });
    }
    /**
     * POST /api/task-attempts/{id}/open-editor
     * Open task attempt worktree in code editor
     * @param id - Task attempt UUID
     * @param request - Optional editor request (file, line)
     */
    async openTaskAttemptInEditor(id, request) {
        await this.request('POST', `/task-attempts/${id}/open-editor`, { body: request });
    }
    /**
     * POST /api/task-attempts/{id}/start-dev-server
     * Start dev server for project
     * @param id - Task attempt UUID
     */
    async startDevServer(id) {
        return this.request('POST', `/task-attempts/${id}/start-dev-server`);
    }
    /**
     * POST /api/task-attempts/{id}/delete-file
     * Delete file from task attempt worktree
     * @param id - Task attempt UUID
     * @param filePath - File path to delete
     */
    async deleteTaskAttemptFile(id, filePath) {
        await this.request('POST', `/task-attempts/${id}/delete-file`, {
            query: { file_path: filePath },
        });
    }
    // ============================================================================
    // DRAFTS - Save & Manage Draft Code Changes
    // ============================================================================
    /**
     * POST /api/task-attempts/{id}/draft?type={type}
     * Save draft code changes for task attempt
     * Drafts are queued for later execution
     * @param id - Task attempt UUID
     * @param type - Draft type (IMPLEMENTATION | TEST | etc)
     * @param content - Draft content (JSON, code, etc)
     */
    async saveDraft(id, type, content) {
        return this.request('POST', `/task-attempts/${id}/draft`, {
            body: content,
            query: { type },
        });
    }
    /**
     * GET /api/task-attempts/{id}/draft?type={type}
     * Get saved draft for task attempt
     * @param id - Task attempt UUID
     * @param type - Draft type
     * @returns Draft content
     */
    async getDraft(id, type) {
        return this.request('GET', `/task-attempts/${id}/draft`, { query: { type } });
    }
    /**
     * DELETE /api/task-attempts/{id}/draft?type={type}
     * Delete saved draft
     * @param id - Task attempt UUID
     * @param type - Draft type
     */
    async deleteDraft(id, type) {
        await this.request('DELETE', `/task-attempts/${id}/draft`, { query: { type } });
    }
    /**
     * POST /api/task-attempts/{id}/draft/queue?type={type}
     * Queue draft for execution
     * AI agent will execute draft in next follow-up
     * @param id - Task attempt UUID
     * @param type - Draft type
     * @param request - Queue configuration
     */
    async queueDraftExecution(id, type, request) {
        await this.request('POST', `/task-attempts/${id}/draft/queue`, {
            body: request,
            query: { type },
        });
    }
    // ============================================================================
    // EXECUTION PROCESSES - Log Streaming & Process Management
    // ============================================================================
    /**
     * GET /api/execution-processes?task_attempt_id={id}&show_soft_deleted={bool}
     * List execution processes for task attempt
     * @param taskAttemptId - Task attempt UUID
     * @param showSoftDeleted - Include soft-deleted processes
     * @returns Array of execution processes with logs
     */
    async listExecutionProcesses(taskAttemptId, showSoftDeleted = false) {
        return this.request('GET', '/execution-processes', {
            query: { task_attempt_id: taskAttemptId, show_soft_deleted: showSoftDeleted },
        });
    }
    /**
     * GET /api/execution-processes/{id}
     * Get execution process details
     * @param id - Execution process UUID
     * @returns Process with status and output
     */
    async getExecutionProcess(id) {
        return this.request('GET', `/execution-processes/${id}`);
    }
    /**
     * POST /api/execution-processes/{id}/stop
     * Stop execution process
     * Sends SIGTERM to running process
     * @param id - Execution process UUID
     */
    async stopExecutionProcess(id) {
        await this.request('POST', `/execution-processes/${id}/stop`);
    }
    // ============================================================================
    // TASK TEMPLATES - Reusable Task Definitions
    // ============================================================================
    /**
     * GET /api/templates?global={bool}&project_id={id}
     * List task templates (global and project-specific)
     * @param global - Filter by global templates
     * @param projectId - Filter by project
     * @returns Array of task templates
     */
    async listTaskTemplates(options) {
        return this.request('GET', '/templates', { query: options || {} });
    }
    /**
     * POST /api/templates
     * Create a task template
     * Templates can be used to quickly create similar tasks
     * @param template - Template definition
     * @returns Created template
     */
    async createTaskTemplate(template) {
        return this.request('POST', '/templates', { body: template });
    }
    /**
     * GET /api/templates/{template_id}
     * Get task template details
     * @param templateId - Template UUID
     * @returns Template definition
     */
    async getTaskTemplate(templateId) {
        return this.request('GET', `/templates/${templateId}`);
    }
    /**
     * PUT /api/templates/{template_id}
     * Update task template
     * @param templateId - Template UUID
     * @param updates - Template updates
     * @returns Updated template
     */
    async updateTaskTemplate(templateId, updates) {
        return this.request('PUT', `/templates/${templateId}`, { body: updates });
    }
    /**
     * DELETE /api/templates/{template_id}
     * Delete task template
     * @param templateId - Template UUID
     */
    async deleteTaskTemplate(templateId) {
        await this.request('DELETE', `/templates/${templateId}`);
    }
    // ============================================================================
    // IMAGES - Upload & Manage Task Images
    // ============================================================================
    /**
     * POST /api/images/upload
     * Upload image (20MB limit)
     * @param file - Image file to upload
     * @returns Created image with ID and URL
     */
    async uploadImage(file) {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(`${this.baseUrl}/api/images/upload`, {
            method: 'POST',
            headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
            body: formData,
        });
        if (!response.ok)
            throw new Error(`Upload failed: ${response.statusText}`);
        const result = await response.json();
        if (!result.success)
            throw new Error(result.message);
        return result.data;
    }
    /**
     * POST /api/images/task/{task_id}/upload
     * Upload image for specific task
     * @param taskId - Task UUID
     * @param file - Image file
     * @returns Created image associated with task
     */
    async uploadTaskImage(taskId, file) {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(`${this.baseUrl}/api/images/task/${taskId}/upload`, {
            method: 'POST',
            headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
            body: formData,
        });
        if (!response.ok)
            throw new Error(`Upload failed: ${response.statusText}`);
        const result = await response.json();
        if (!result.success)
            throw new Error(result.message);
        return result.data;
    }
    /**
     * GET /api/images/{id}/file
     * Get image file by ID
     * @param id - Image UUID
     * @returns Image blob
     */
    async getImageFile(id) {
        const response = await fetch(`${this.baseUrl}/api/images/${id}/file`, {
            headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        });
        if (!response.ok)
            throw new Error('Failed to fetch image');
        return response.blob();
    }
    /**
     * GET /api/images/task/{task_id}
     * Get all images for a task
     * @param taskId - Task UUID
     * @returns Array of images
     */
    async getTaskImages(taskId) {
        return this.request('GET', `/images/task/${taskId}`);
    }
    /**
     * DELETE /api/images/{id}
     * Delete image
     * @param id - Image UUID
     */
    async deleteImage(id) {
        await this.request('DELETE', `/images/${id}`);
    }
    // ============================================================================
    // APPROVALS - Approval Requests & Responses
    // ============================================================================
    /**
     * POST /api/approvals/create
     * Create approval request
     * Pauses execution waiting for user approval
     * @param request - Approval context and options
     * @returns Approval ID
     */
    async createApprovalRequest(request) {
        return this.request('POST', '/approvals/create', { body: request });
    }
    /**
     * GET /api/approvals/{id}/status
     * Get approval status (pending, approved, rejected)
     * @param id - Approval UUID
     * @returns Approval status
     */
    async getApprovalStatus(id) {
        return this.request('GET', `/approvals/${id}/status`);
    }
    /**
     * POST /api/approvals/{id}/respond
     * Respond to approval request (approve/reject)
     * @param id - Approval UUID
     * @param approved - True to approve, false to reject
     * @param comment - Optional comment
     */
    async respondToApprovalRequest(id, approved, comment) {
        await this.request('POST', `/approvals/${id}/respond`, {
            body: { approved, comment },
        });
    }
    /**
     * GET /api/approvals/pending
     * Get list of pending approvals
     * @returns Array of pending approval requests
     */
    async getPendingApprovals() {
        return this.request('GET', '/approvals/pending');
    }
    // ============================================================================
    // CONTAINERS - Container Reference Resolution
    // ============================================================================
    /**
     * GET /api/containers/info?ref={ref}
     * Resolve container reference to IDs
     * @param ref - Container reference
     * @returns Container IDs and metadata
     */
    async getContainerInfo(ref) {
        return this.request('GET', '/containers/info', { query: { ref } });
    }
    // ============================================================================
    // FILESYSTEM - Directory Browsing & Git Repo Discovery
    // ============================================================================
    /**
     * GET /api/filesystem/directory?path={path}
     * List directory contents
     * @param path - Directory path (optional)
     * @returns Directory contents
     */
    async listDirectory(path) {
        return this.request('GET', '/filesystem/directory', { query: path ? { path } : {} });
    }
    /**
     * GET /api/filesystem/git-repos?path={path}
     * List git repositories in directory
     * @param path - Search path (optional)
     * @returns Array of git repo paths
     */
    async listGitRepositories(path) {
        return this.request('GET', '/filesystem/git-repos', { query: path ? { path } : {} });
    }
    // ============================================================================
    // SERVER-SENT EVENTS - Real-time Updates
    // ============================================================================
    /**
     * GET /api/events
     * Subscribe to Server-Sent Events stream
     * Receive real-time updates about tasks, processes, etc
     * @returns EventSource for streaming updates
     */
    subscribeToEvents() {
        return new EventSource(`${this.baseUrl}/api/events`, {
            withCredentials: !!this.token,
        });
    }
    // ============================================================================
    // WEBSOCKET STREAMING - Real-time Log & Diff Streaming
    // ============================================================================
    /**
     * WS /api/projects/{project_id}/tasks/stream/ws
     * WebSocket stream of tasks in real-time
     * Receive updates when tasks are created, updated, etc
     * @param projectId - Project UUID
     * @returns WebSocket URL for connection
     */
    getTasksStreamUrl(projectId) {
        const protocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
        return `${protocol}://${new URL(this.baseUrl).host}/api/projects/${projectId}/tasks/stream/ws`;
    }
    /**
     * WS /api/execution-processes/stream/ws?task_attempt_id={id}
     * WebSocket stream of execution processes
     * Receive updates about process status, cancellation, etc
     * @param taskAttemptId - Task attempt UUID
     * @returns WebSocket URL for connection
     */
    getExecutionProcessesStreamUrl(taskAttemptId) {
        const protocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
        return `${protocol}://${new URL(this.baseUrl).host}/api/execution-processes/stream/ws?task_attempt_id=${taskAttemptId}`;
    }
    /**
     * WS /api/execution-processes/{id}/raw-logs/ws
     * WebSocket stream of raw process logs (stdout/stderr)
     * @param processId - Execution process UUID
     * @returns WebSocket URL for connection
     */
    getRawLogsStreamUrl(processId) {
        const protocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
        return `${protocol}://${new URL(this.baseUrl).host}/api/execution-processes/${processId}/raw-logs/ws`;
    }
    /**
     * WS /api/execution-processes/{id}/normalized-logs/ws
     * WebSocket stream of normalized/parsed logs
     * @param processId - Execution process UUID
     * @returns WebSocket URL for connection
     */
    getNormalizedLogsStreamUrl(processId) {
        const protocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
        return `${protocol}://${new URL(this.baseUrl).host}/api/execution-processes/${processId}/normalized-logs/ws`;
    }
    /**
     * WS /api/task-attempts/{id}/diff/ws?stats_only={bool}
     * WebSocket stream of task attempt diffs
     * Streams file changes as they happen
     * @param attemptId - Task attempt UUID
     * @param statsOnly - Only show statistics, not full diff
     * @returns WebSocket URL for connection
     */
    getTaskDiffStreamUrl(attemptId, statsOnly = false) {
        const protocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
        return `${protocol}://${new URL(this.baseUrl).host}/api/task-attempts/${attemptId}/diff/ws?stats_only=${statsOnly}`;
    }
    /**
     * WS /api/drafts/stream/ws
     * WebSocket stream of project drafts in real-time
     * @param projectId - Project UUID
     * @returns WebSocket URL for connection
     */
    getDraftsStreamUrl(projectId) {
        const protocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
        return `${protocol}://${new URL(this.baseUrl).host}/api/drafts/stream/ws?project_id=${projectId}`;
    }
}

export { ForgeClient };
export default ForgeClient;
