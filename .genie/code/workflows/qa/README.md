# Atomic QA Workflows - Scenario Index

**Purpose:** Specific, reproducible test scenarios complementing the comprehensive checklist
**Relationship:** Deep-dive validation for specific features/bugs (complements broad checklist coverage)
**Master Coordination:** `@.genie/qa/README.md`
**Checklist Reference:** `@.genie/qa/checklist.md`

---

## Philosophy: Vertical Growth

Each QA scenario is atomic, focused, and independently executable. This enables:
- Vertical scaling (add scenarios without touching existing)
- Bug-driven testing (every bug → permanent regression test)
- Feature-specific validation (deep-dive beyond checklist)
- Agent automation (scenarios can be run by QA agent)

---

## How to Use

**For bug regression:**
1. Find `bug-XXX-*.md` file matching GitHub issue number
2. Execute test steps sequentially
3. Capture evidence in `.genie/qa/evidence/`
4. Update status in main checklist at referenced section

**For feature validation:**
1. Find scenario matching feature (e.g., `mcp-operations.md`)
2. Execute all test cases
3. Link results to checklist items
4. Report outcomes to Master Genie for release decision

**For performance benchmarks:**
1. Find latency/timing scenarios (e.g., `agent-listing-latency.md`)
2. Measure and compare against baseline
3. Document in evidence directory
4. Update Performance section in checklist

---

## Scenario Index

### MCP Operations (Core Functionality)
- **mcp-operations.md** - Comprehensive MCP tool testing
  - Coverage: list, run, view, resume, stop
  - Checklist: `@.genie/qa/checklist.md` (MCP Agent Operations section)
  - Status: Active (primary MCP validation)

- **mcp-agent-start-failure.md** - Agent startup error handling
  - Coverage: Invalid agent names, error messages
  - Checklist: MCP Agent Operations → Error Scenarios
  - Status: Active

- **mcp-session-resume-life-cycle.md** - Resume workflow validation
  - Coverage: Session resumption, context preservation
  - Checklist: Session Lifecycle → Resumption
  - Status: Active

### Session Lifecycle
- **session-lifecycle.md** - Complete session workflow testing
  - Coverage: Creation, resumption, termination
  - Checklist: Session Lifecycle (all items)
  - Status: Active (primary session validation)

- **session-id-collision.md** - ID uniqueness validation
  - Coverage: Concurrent session creation, uniqueness checks
  - Checklist: Session Lifecycle → Session ID generation
  - Status: Active

- **session-list-consistency.md** - List accuracy validation
  - Coverage: Session list display, status accuracy
  - Checklist: Session Lifecycle → Session tracking
  - Status: Active

- **session-running-stuck.md** - Stuck session handling
  - Coverage: Timeout, zombie sessions, cleanup
  - Checklist: Session Lifecycle → Termination
  - Status: Active

### Bug Regression Tests
- **bug-66-session-persistence.md** - Session state preservation (GitHub #66)
  - Coverage: Session data persists across restarts
  - Checklist: Session Lifecycle → Context preservation
  - Status: ✅ Fixed (regression test)

- **bug-90-full-transcript.md** - Full transcript truncation (GitHub #90)
  - Coverage: full=true returns complete conversation
  - Checklist: Session Lifecycle → View full session
  - Status: ✅ Fixed (regression test)

- **bug-92-zombie-sessions.md** - Zombie session cleanup (GitHub #92)
  - Coverage: Proper session termination
  - Checklist: Session Lifecycle → Graceful stop
  - Status: ✅ Fixed (regression test)

- **bug-102-session-collision.md** - Session ID collision (GitHub #102)
  - Coverage: Timestamp+random prevents collisions
  - Checklist: Session Lifecycle → Session ID generation
  - Status: ✅ Fixed (regression test)

- **bug-xxx-background-launch.md** - Background launch issues
  - Coverage: Background agent startup
  - Checklist: Agent System → Agent execution
  - Status: Regression test

### CLI & Command Interface
- **cli-commands.md** - CLI command validation
  - Coverage: Help, arguments, flags
  - Checklist: Command Interface (all items)
  - Status: Active

- **cli-output-legacy-commands.md** - Legacy command compatibility
  - Coverage: Backward compatibility checks
  - Checklist: Command Interface → Help accuracy
  - Status: Active

### Installation & Setup
- **installation-flow.md** - Installation workflow testing
  - Coverage: Clean-slate setup, MCP config, Forge integration
  - Checklist: `@.genie/qa/install-simulation.md`
  - Status: Active

### Performance Benchmarks
- **agent-listing-latency.md** - List agents performance
  - Coverage: `mcp__genie__list_agents` latency
  - Checklist: Performance → List agents latency
  - Baseline: <100ms
  - Status: Active

- **background-launch-timeout-argmax.md** - Timeout handling performance
  - Coverage: Agent startup time, timeout behavior
  - Checklist: Performance → Agent startup time
  - Status: Baseline measurement

---

## Scenario Structure Template

```markdown
---
name: qa/<scenario-name>
description: <one-line purpose>
parent: qa
---

# QA Workflow • <Scenario Name>

## Test Scenario
<Description of what's being tested>

## Test Suite

### <Test Case 1>
**Command:**
```
<executable command>
```

**Expected Evidence:**
<what should happen>

**Verification:**
- [ ] <check 1>
- [ ] <check 2>

---

## Execution Notes
**Run via:**
```
mcp__genie__run with agent="qa/<scenario-name>" and prompt="Execute all tests"
```

**Evidence capture:**
- Save to `.genie/qa/evidence/<scenario>-<timestamp>.txt`
```

---

## Adding New Scenarios

**When to create:**
- New feature needs deep-dive validation
- Bug fix requires regression test
- Edge case discovered during QA run
- Performance baseline measurement needed

**How to create:**
1. Copy template structure above
2. Define test cases with executable commands
3. Specify expected evidence
4. Add reference in `@.genie/qa/checklist.md` under appropriate section
5. Link back to this workflow file
6. Update this README index

**Checklist Integration:**
- Every scenario should reference checklist section
- Checklist items should reference atomic workflows for deep-dive
- Bidirectional linking (scenario ↔ checklist)

---

## Execution Patterns

**Individual scenario:**
```
mcp__genie__run with agent="qa/<scenario-name>" and prompt="Execute tests"
```

**Category sweep (e.g., all session tests):**
```
# Run via QA Agent
mcp__genie__run with agent="qa" and prompt="Execute all session lifecycle scenarios"
```

**Regression suite (all bug scenarios):**
```
# Run via QA Agent
mcp__genie__run with agent="qa" and prompt="Execute all bug regression tests (bug-*.md)"
```

---

**Master Genie coordination:** Every scenario is evidence-backed, reproducible, and linked to comprehensive checklist. No duplication, only depth. Quality is guaranteed. 🎯
