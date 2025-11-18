# Genie CLI Automation Guide

Complete reference for using Genie CLI in automated workflows (cron, CI/CD, scripts).

## Quick Reference Table

| Command | Mode | Output | Use Case |
|---------|------|--------|----------|
| `genie task` | Headless | JSON/Raw | Fire-and-forget tasks |
| `genie run` | Foreground | JSON/Text | Wait for completion |
| `genie run --background` | Headless | URL | Same as task |
| `genie task monitor <id>` | Foreground | Live logs | Monitor background task |
| `genie list tasks` | Query | Table | Task status check |
| `genie view <id>` | Query | Transcript | Get task output |
| `genie resume <id>` | Interactive | JSON | Continue conversation |
| `genie stop <id>` | Control | - | Kill running task |
| `genie status` | Health | Status | System health check |

---

## 1. Fire-and-Forget Tasks (Cron/Background)

**Command:** `genie task`
- Starts task immediately
- Returns task ID
- No browser, no waiting
- Perfect for cron

### Basic Usage
```bash
# Default: JSON output with task info
genie task code/explore "Check system health"

# Output:
{
  "task_id": "abc-123...",
  "task_url": "http://localhost:8887/...",
  "agent": "code/explore",
  "executor": "CLAUDE_CODE:DEFAULT",
  "status": "started"
}
```

### Raw Mode (Scriptable)
```bash
# Just the task ID (for piping/parsing)
genie task --raw code/explore "Daily check"

# Output: abc-123-def-456...
```

### Quiet Mode (No Warnings)
```bash
# Suppress version warnings (clean cron logs)
genie task --quiet code/explore "Silent task"
```

### Cron Examples
```bash
# Every 5 minutes - health check
*/5 * * * * genie task --quiet code/explore "Health check" >> /var/log/genie.log 2>&1

# Daily at 3 AM - cleanup
0 3 * * * genie task --quiet code/code-garbage-collector "Daily cleanup" >> /var/log/cleanup.log 2>&1

# Hourly - save task ID for later monitoring
0 * * * * genie task --quiet --raw code/explore "Hourly scan" > /var/log/last-task-id.txt 2>&1
```

---

## 2. Wait for Completion (Synchronous)

**Command:** `genie run`
- Waits for task to finish
- Returns output when done
- Opens browser (unless --background)

### Basic Usage
```bash
# Wait for completion, see output
genie run code/explore "Analyze codebase"

# Output: Full results JSON with status
```

### Raw Text Output
```bash
# Get just the agent's output (no JSON wrapper)
genie run --raw code/explore "Generate report"

# Output: (raw text from agent)
```

### Background Mode
```bash
# Same as 'genie task' (no waiting)
genie run --background code/explore "Background task"
```

### Automation Examples
```bash
# CI/CD: Run tests and capture results
TEST_RESULT=$(genie run --raw --quiet code/tests "Run all tests")
echo "$TEST_RESULT" > test-results.txt

# Script: Wait for analysis, then act on results
genie run --quiet code/analyze "Check dependencies" > deps.json
if grep -q "vulnerable" deps.json; then
  echo "Security issues found!"
  exit 1
fi
```

---

## 3. Monitor Background Tasks

**Command:** `genie task monitor <task-id>`
- Attach to running task
- Stream live logs
- Wait for completion

### Usage
```bash
# Start task in background
TASK_ID=$(genie task --raw code/explore "Long analysis")

# Monitor it later
genie task monitor $TASK_ID
```

### Automation Example
```bash
# Cron: Start task, then monitor in separate job
# Job 1 (every hour): Start task
0 * * * * genie task --quiet --raw code/explore "Hourly check" > /tmp/task-id.txt

# Job 2 (5 mins later): Monitor completion
5 * * * * genie task monitor $(cat /tmp/task-id.txt) >> /var/log/monitored.log 2>&1
```

---

## 4. Query Task Status

### List All Tasks
```bash
# Show all tasks (table format)
genie list tasks

# Sample output:
| Task ID      | Agent        | Status  | Executor         |
|--------------|--------------|---------|------------------|
| abc-123...   | code/explore | running | CLAUDE_CODE/DEFAULT |
```

### View Task Output
```bash
# Get full transcript
genie view <task-id>

# Live view (auto-refresh)
genie view --live <task-id>

# Full history
genie view --full <task-id>
```

### Automation Examples
```bash
# Check if any tasks are still running
if genie list tasks | grep -q "running"; then
  echo "Tasks still in progress"
fi

# Get specific task result
genie view abc-123 > task-output.txt
```

---

## 5. Task Control

### Stop Running Task
```bash
genie stop <task-id>
```

### Resume Conversation
```bash
# Continue from previous task
genie resume <task-id> "Follow-up question"
```

---

## 6. System Health Checks

### Check Genie Status
```bash
genie status

# Output:
🧞 GENIE STATUS
📦 Forge Backend: 🟢 Running
📡 MCP Server: ...
```

### Automation Example
```bash
# Pre-flight check before running tasks
if ! genie status | grep -q "🟢 Running"; then
  echo "Forge not running, starting..."
  genie &  # Start Genie server
  sleep 5
fi

# Now safe to run tasks
genie task code/explore "Check system"
```

---

## 7. Executor Control

### Override Default Executor
```bash
# Use specific executor
genie task -x OPENCODE code/explore "Use OpenCode"
genie task --executor GEMINI code/explore "Use Gemini"

# Use specific model
genie task -m "gpt-4" code/explore "Use GPT-4"
```

### Automation Example
```bash
# Distribute load across executors
for executor in CLAUDE_CODE OPENCODE GEMINI; do
  genie task -x $executor code/explore "Check $executor" &
done
wait  # Wait for all background tasks
```

---

## 8. Advanced Patterns

### Parallel Execution
```bash
# Run multiple tasks simultaneously
genie task code/explore "Task 1" &
genie task code/analyze "Task 2" &
genie task code/tests "Task 3" &
wait  # Wait for all to finish
```

### Error Handling
```bash
# Capture exit code
genie run --quiet code/tests "Run tests"
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Task failed with code $EXIT_CODE"
  # Notify, retry, etc.
fi
```

### Task Chaining
```bash
# Sequential tasks with error checking
TASK1=$(genie task --raw code/explore "Step 1")
genie task monitor $TASK1 || exit 1

TASK2=$(genie task --raw code/analyze "Step 2")
genie task monitor $TASK2 || exit 1

echo "Pipeline complete!"
```

### Retry Logic
```bash
# Retry failed tasks
MAX_RETRIES=3
RETRY=0

while [ $RETRY -lt $MAX_RETRIES ]; do
  genie run --quiet code/tests "Run tests" && break
  RETRY=$((RETRY + 1))
  echo "Retry $RETRY/$MAX_RETRIES"
  sleep 10
done
```

---

## 9. CI/CD Integration

### GitHub Actions Example
```yaml
- name: Run Genie Analysis
  run: |
    genie task --quiet code/analyze "Analyze PR changes" > task.json
    TASK_ID=$(jq -r '.task_id' task.json)
    genie task monitor $TASK_ID
```

### Jenkins Example
```groovy
stage('Genie Quality Check') {
  steps {
    sh 'genie run --quiet code/code-quality "Check code quality" > report.json'
    archiveArtifacts 'report.json'
  }
}
```

---

## 10. Logging & Output

### Structured Logging
```bash
# JSON output for parsing
genie task code/explore "Check" | jq '.task_id'

# Plain text for humans
genie run --raw code/explore "Generate report" | tee report.txt
```

### Log Rotation
```bash
# Cron with log rotation
*/15 * * * * genie task --quiet code/explore "Check" >> /var/log/genie/$(date +\%Y\%m\%d).log 2>&1

# Keep last 7 days
find /var/log/genie/ -name "*.log" -mtime +7 -delete
```

---

## Best Practices

1. **Use `--quiet`** in cron to suppress version warnings
2. **Use `--raw`** when piping to other commands
3. **Check `genie status`** before heavy automation
4. **Save task IDs** for later monitoring/debugging
5. **Use JSON output** for programmatic parsing
6. **Set explicit executor** if you need consistency
7. **Monitor long tasks** via `genie task monitor`
8. **Handle errors** - check exit codes in scripts

---

## Common Issues

**Workspace Version Warning:**
```bash
⚠️  Workspace behind: workspace 2.5.19 ← global 2.5.20
```
Solution: Use `--quiet` flag or run `genie` once to sync.

**Forge Not Running:**
```bash
❌ Forge backend unreachable
```
Solution: Start Forge with `genie` (no args) or check `genie status`.

**Task Stuck:**
```bash
genie stop <task-id>  # Kill stuck task
genie list tasks      # Check status
```

