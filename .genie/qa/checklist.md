# QA Checklist
**Living document auto-updated by QA Agent via learn integration**

**Last Update:** !`date -u +"%Y-%m-%d %H:%M UTC"`

---

## MCP Agent Operations

### List Agents
- [ ] **Agent catalog display**
  - **Comando:** `mcp__genie__list_agents`
  - **Evidência:** Table with agent names, descriptions, categories
  - **Status:** ❓ Untested

### Run Agent
- [ ] **Valid agent execution**
  - **Comando:** `mcp__genie__run with agent="plan" and prompt="test"`
  - **Evidência:** Session ID returned, agent starts
  - **Status:** ❓ Untested

- [ ] **Invalid agent error handling**
  - **Comando:** `mcp__genie__run with agent="nonexistent" and prompt="test"`
  - **Evidência:** Clear error message listing available agents
  - **Status:** ❓ Untested

### Session Management
- [ ] **List sessions**
  - **Comando:** `mcp__genie__list_sessions`
  - **Evidência:** Table with session IDs, agents, status, timing
  - **Status:** ❓ Untested

- [ ] **Resume session**
  - **Comando:** `mcp__genie__resume with sessionId="<id>" and prompt="follow-up"`
  - **Evidência:** Session continues with context preserved
  - **Status:** ❓ Untested

- [ ] **View session summary**
  - **Comando:** `mcp__genie__view with sessionId="<id>" and full=false`
  - **Evidência:** Recent messages from session
  - **Status:** ❓ Untested

- [ ] **View full session**
  - **Comando:** `mcp__genie__view with sessionId="<id>" and full=true`
  - **Evidência:** Complete conversation transcript
  - **Status:** ❓ Untested

- [ ] **Stop session**
  - **Comando:** `mcp__genie__stop with sessionId="<id>"`
  - **Evidência:** Session terminated, state preserved
  - **Status:** ❓ Untested

### Error Scenarios
- [ ] **Invalid session resume**
  - **Comando:** `mcp__genie__resume with sessionId="invalid" and prompt="test"`
  - **Evidência:** Clear error message
  - **Status:** ❓ Untested

- [ ] **Nonexistent session view**
  - **Comando:** `mcp__genie__view with sessionId="nonexistent"`
  - **Evidência:** Clear error message
  - **Status:** ❓ Untested

- [ ] **Invalid session stop**
  - **Comando:** `mcp__genie__stop with sessionId="invalid"`
  - **Evidência:** Clear error message
  - **Status:** ❓ Untested

---

## Layout & UI Validation

### Output Formatting
- [ ] **Compact spacing (gap: 0)**
  - **Comando:** Visual inspection of all MCP outputs
  - **Evidência:** No extra blank lines between sections
  - **Status:** ❓ Untested

- [ ] **Table alignment**
  - **Comando:** Inspect `mcp__genie__list_agents` + `mcp__genie__list_sessions`
  - **Evidência:** Columns aligned, badges consistent
  - **Status:** ❓ Untested

- [ ] **Terminal width responsiveness**
  - **Comando:** Test outputs in narrow terminal (80 cols)
  - **Evidência:** Graceful wrapping or truncation
  - **Status:** ❓ Untested

---

## Command Interface

### Help System
- [ ] **Help completeness**
  - **Comando:** Project-specific (define in custom/qa.md)
  - **Evidência:** All commands listed with descriptions
  - **Status:** ❓ Untested

- [ ] **Help accuracy**
  - **Comando:** Project-specific (define in custom/qa.md)
  - **Evidência:** Help text matches actual behavior
  - **Status:** ❓ Untested

### Argument Parsing
- [ ] **Valid arguments**
  - **Comando:** Project-specific (define in custom/qa.md)
  - **Evidência:** Commands execute correctly
  - **Status:** ❓ Untested

- [ ] **Invalid arguments**
  - **Comando:** Project-specific (define in custom/qa.md)
  - **Evidência:** Clear error messages, usage hints
  - **Status:** ❓ Untested

- [ ] **Missing required arguments**
  - **Comando:** Project-specific (define in custom/qa.md)
  - **Evidência:** Clear error identifying missing argument
  - **Status:** ❓ Untested

### Flag Handling
- [ ] **Boolean flags**
  - **Comando:** Project-specific (define in custom/qa.md)
  - **Evidência:** Flags toggle behavior correctly
  - **Status:** ❓ Untested

- [ ] **Value flags**
  - **Comando:** Project-specific (define in custom/qa.md)
  - **Evidência:** Flag values parsed and applied
  - **Status:** ❓ Untested

---

## Agent System

### Agent Discovery
- [ ] **Core agent listing**
  - **Comando:** `mcp__genie__list_agents`
  - **Evidência:** All core agents displayed
  - **Status:** ❓ Untested

- [ ] **Custom agent discovery**
  - **Comando:** `mcp__genie__list_agents` (with custom agents present)
  - **Evidência:** Custom agents listed alongside core
  - **Status:** ❓ Untested

### Agent Execution
- [ ] **Core agent run**
  - **Comando:** `mcp__genie__run with agent="<core>" and prompt="test"`
  - **Evidência:** Agent executes using core prompt
  - **Status:** ❓ Untested

- [ ] **Custom override loaded**
  - **Comando:** `mcp__genie__run with agent="<agent-with-override>" and prompt="test"`
  - **Evidência:** Custom context loaded alongside core
  - **Status:** ❓ Untested

- [ ] **Mode selection**
  - **Comando:** `mcp__genie__run with agent="orchestrator" and prompt="Mode: analyze. ..."`
  - **Evidência:** Correct mode loaded and executed
  - **Status:** ❓ Untested

---

## Session Lifecycle

### Creation
- [ ] **Session ID generation**
  - **Comando:** `mcp__genie__run with agent="plan" and prompt="test"`
  - **Evidência:** Unique session ID returned
  - **Status:** ❓ Untested

- [ ] **Session tracking**
  - **Comando:** Run agent, then `mcp__genie__list_sessions`
  - **Evidência:** New session appears in list
  - **Status:** ❓ Untested

### Resumption
- [ ] **Context preservation**
  - **Comando:** Resume session with follow-up
  - **Evidência:** Agent recalls previous conversation
  - **Status:** ❓ Untested

- [ ] **Multi-turn conversation**
  - **Comando:** Resume same session 3+ times
  - **Evidência:** Context builds across all turns
  - **Status:** ❓ Untested

### Termination
- [ ] **Graceful stop**
  - **Comando:** `mcp__genie__stop with sessionId="<id>"`
  - **Evidência:** Session marked stopped, state preserved
  - **Status:** ❓ Untested

- [ ] **Post-stop view**
  - **Comando:** View session after stop
  - **Evidência:** Transcript still accessible
  - **Status:** ❓ Untested

---

## Error Handling

### Graceful Degradation
- [ ] **Missing config directory**
  - **Comando:** Run tools in directory without .genie/
  - **Evidência:** Clear error with setup guidance
  - **Status:** ❓ Untested

- [ ] **Corrupted session state**
  - **Comando:** Corrupt sessions.json, run list_sessions
  - **Evidência:** Graceful recovery or clear error
  - **Status:** ❓ Untested

- [ ] **File system errors**
  - **Comando:** Remove write permissions, attempt operations
  - **Evidência:** Clear error messages
  - **Status:** ❓ Untested

### Input Validation
- [ ] **Empty prompt**
  - **Comando:** `mcp__genie__run with agent="plan" and prompt=""`
  - **Evidência:** Error or prompt for input
  - **Status:** ❓ Untested

- [ ] **Malformed input**
  - **Comando:** Special characters, very long strings
  - **Evidência:** Sanitized or rejected with error
  - **Status:** ❓ Untested

---

## Performance

### Response Times
- [ ] **List agents latency**
  - **Comando:** Time `mcp__genie__list_agents`
  - **Evidência:** <100ms response
  - **Status:** ❓ Untested

- [ ] **List sessions latency**
  - **Comando:** Time `mcp__genie__list_sessions`
  - **Evidência:** <100ms response
  - **Status:** ❓ Untested

- [ ] **Agent startup time**
  - **Comando:** Time from run to first output
  - **Evidência:** Within acceptable range (define in custom)
  - **Status:** ❓ Untested

### Scalability
- [ ] **Many sessions handling**
  - **Comando:** Create 50+ sessions, list them
  - **Evidência:** List displays without degradation
  - **Status:** ❓ Untested

- [ ] **Large transcript view**
  - **Comando:** View session with 100+ messages
  - **Evidência:** Renders without timeout
  - **Status:** ❓ Untested

---

## 🆕 New Items

<!-- QA Agent appends discoveries here via learn integration -->

---

**Status Legend:**
- ✅ Pass (with timestamp)
- ⚠️ Partial/Needs improvement (with note)
- ❌ Fail (with bug reference)
- ❓ Untested

**Maintenance:**
- QA Agent updates status + timestamps on each run
- Learn agent adds new items when patterns discovered
- Keep items atomic and reproducible
