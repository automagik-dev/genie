# Genie MCP Quick Start (Claude Desktop)

## 1. Build the MCP Server

```bash
cd /home/namastex/workspace/automagik-genie
pnpm run build:mcp
```

## 2. Verify Server Works

```bash
# Test stdio transport (what Claude Desktop uses)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node .genie/mcp/dist/server.js
```

You should see JSON output with server capabilities.

## 3. Configure Claude Desktop

Your config is already set at:
```
~/.config/Claude/claude_desktop_config.json
```

Current content:
```json
{
  "mcpServers": {
    "genie": {
      "command": "node",
      "args": [
        "/home/namastex/workspace/automagik-genie/.genie/mcp/dist/server.js"
      ]
    }
  }
}
```

**Key Points:**
- ✅ No `MCP_TRANSPORT` env var needed (defaults to stdio)
- ✅ Uses absolute path to server
- ✅ Claude Desktop launches server automatically via stdio

## 4. Restart Claude Desktop

```bash
# Kill any running Claude Desktop instances
pkill -f "claude" || true

# Launch Claude Desktop
# (varies by system - use your normal method)
```

## 5. Verify Connection

In Claude Desktop:
1. Look for 🔌 **plug icon** in the text input area (bottom)
2. Click the plug icon
3. You should see **"genie"** server listed
4. Expand to see **6 tools**:
   - genie_run
   - genie_resume
   - genie_list_agents
   - genie_list_sessions
   - genie_view
   - genie_stop

## 6. Test a Tool

Try asking Claude:
```
"Can you use genie_list_agents to show me what agents are available?"
```

**Expected behavior:**
- Claude invokes `genie_list_agents` tool
- Tool returns stub message (since handler integration is pending)
- You see the tool execution in the conversation

## Troubleshooting

### Tools Not Showing Up

**Check server logs:**
```bash
# Claude Desktop logs location (Linux)
tail -f ~/.config/Claude/logs/mcp*.log
```

**Manually test server:**
```bash
node .genie/mcp/dist/server.js
# (Type Ctrl+D to exit)
```

### "Command not found" Error

**Verify Node.js is in PATH:**
```bash
which node
# Should output: /usr/bin/node or similar

node --version
# Should output: v20.x.x or higher
```

**If using nvm, add to config:**
```json
{
  "mcpServers": {
    "genie": {
      "command": "/home/namastex/.nvm/versions/node/v20.x.x/bin/node",
      "args": [
        "/home/namastex/workspace/automagik-genie/.genie/mcp/dist/server.js"
      ]
    }
  }
}
```

### Server Not Responding

**Check build succeeded:**
```bash
ls -la .genie/mcp/dist/server.js
# File should exist and be recent
```

**Rebuild if needed:**
```bash
pnpm run build:mcp
```

### stdio vs httpStream Confusion

**For Claude Desktop:** Always use **stdio** (default, no env var needed)

**For remote/network access:** Use httpStream:
```bash
MCP_TRANSPORT=httpStream pnpm run start:mcp
# Server runs on http://localhost:8080/mcp
```

**stdio = Claude Desktop talks directly to server via pipes**
**httpStream = External clients connect via HTTP**

## Available Prompts

The Genie MCP server includes **10 prompts** to help you effectively use Genie agents:

### Workflow Prompts (Core 4-Step Process)

#### 1. **plan** - Strategic Planning
Start any new feature, bug fix, or architectural change here.

**Usage in Claude Desktop:**
> "Use the plan prompt to analyze adding authentication to my API"

**What it does:**
- Generates Discovery→Implementation→Verification structure
- Auto-loads mission/roadmap/standards with @ references
- Teaches assumption tracking (ASM-#), decision logging (DEC-#), risk capture (RISK-#)

---

#### 2. **wish** - Convert Plan to Wish Document
After planning is approved, create a formal wish document.

**Usage:**
> "Use the wish prompt to create a wish for the authentication feature we just planned"

**What it does:**
- Converts planning brief into structured wish at `.genie/wishes/<slug>-wish.md`
- Defines execution groups, deliverables, evidence requirements
- Sets up validation hooks and success criteria

---

#### 3. **forge** - Break Wish into Execution Groups
Once wish is approved, break it down for implementation.

**Usage:**
> "Use the forge prompt to break down the auth-wish into execution groups"

**What it does:**
- Analyzes wish complexity and dependencies
- Creates 2-3 focused execution groups
- Assigns delivery agents (implementor, tests, review)
- Defines validation commands and evidence paths

---

#### 4. **review** - Validate Completed Work
After implementation, validate against standards.

**Usage:**
> "Use the review prompt to validate the authentication implementation"

**What it does:**
- Evaluates code quality, security, performance, test coverage
- Checks against @.genie/standards/* files
- Provides severity-tagged issues (CRITICAL/HIGH/MEDIUM/LOW)

---

### Analysis & Reasoning Prompts

#### 5. **twin** - Pressure-Test Decisions (17+ Modes)
Get a second opinion with structured analysis.

**Common modes:** planning, consensus, deep-dive, debug, risk-audit, design-review

**Usage:**
> "Use the twin prompt to evaluate choosing PostgreSQL vs MongoDB for user data"

**What it does:**
- Infers best mode from your goal (e.g., "evaluate" → consensus mode)
- Shows all available modes for awareness
- Generates structured twin command with deliverables
- Requires Twin Verdict + confidence level in output

**Mode inference examples:**
- "evaluate X vs Y" → consensus
- "assess risks" → risk-audit
- "find root cause" → debug
- "plan architecture" → planning

---

#### 6. **consensus** - Build Agreement on Decisions
Evaluate decisions with counterpoints and evidence.

**Usage:**
> "Use the consensus prompt to decide if we should migrate to microservices"

**What it does:**
- Structures decision evaluation framework
- Provides evidence-based counterpoints
- Explores alternatives and trade-offs
- Delivers Go/No-Go/Modify recommendation

---

#### 7. **debug** - Root Cause Investigation
Systematic debugging with hypothesis ranking.

**Usage:**
> "Use the debug prompt for the issue where login fails after password reset"

**What it does:**
- Structures Discovery (symptoms) → Implementation (hypotheses) → Verification (experiments)
- Ranks hypotheses by likelihood
- Proposes minimal experiments to validate top hypothesis
- Delivers root cause + minimal fix + regression test

---

#### 8. **thinkdeep** - Extended Reasoning (Timeboxed)
Deep exploration with focus and time limits.

**Usage:**
> "Use the thinkdeep prompt to explore scaling strategies for 10M users, 10 minute timebox"

**What it does:**
- Scopes exploration to prevent meandering
- Outlines 3-5 reasoning steps
- Delivers top insights + confidence + uncertainties
- Default: 10 minutes (adjustable: 5min=quick, 15min=complex)

---

#### 9. **analyze** - System Architecture Analysis
Map dependencies, find bottlenecks, identify refactoring opportunities.

**Usage:**
> "Use the analyze prompt to review the auth service focusing on dependencies"

**What it does:**
- Maps architecture with @ auto-loading (`@src/auth/` loads directory)
- Finds coupling hotspots, complexity clusters, bottlenecks
- Delivers top 3 refactor opportunities + impact assessment

---

#### 10. **prompt** - Meta-Prompting Helper
Learn to write better prompts using the Genie framework.

**Usage:**
> "Use the prompt helper to improve this: 'Debug the login issue'"

**What it does:**
- Teaches complete Genie prompting framework:
  - Task breakdown (Discovery→Implementation→Verification)
  - @ auto-context loading
  - Success/failure boundaries ([SUCCESS CRITERIA], [NEVER DO])
  - Concrete examples over abstractions
  - Validation checklists
- Provides worked example showing all patterns together

---

### Prompting Tips (Built Into Every Prompt)

All prompts include condensed guidance to teach you effective prompting:

- **@ references:** Auto-load files/docs (`@src/auth/middleware.ts` loads file automatically)
- **Task breakdown:** Use `<task_breakdown>` structure for Discovery→Implementation→Verification
- **Boundaries:** Define success with `[SUCCESS CRITERIA] ✅` and failures with `[NEVER DO] ❌`
- **Concrete examples:** Show code snippets, exact commands, not vague descriptions
- **Validation:** Specify exact validation commands, evidence paths, approval checkpoints

**Example from plan prompt:**
```
💡 Prompting Tips:
• Reference files with @: auto-loads mission/roadmap/standards context
• Capture: ASM-# (assumptions), DEC-# (decisions), Q-# (questions), RISK-#
• Discovery→Implementation→Verification pattern structures thinking
```

---

## Current Limitations

**Tool Stubs:** Tools currently return placeholder messages because handler integration is pending.

**Example stub response:**
```
Tool stub: Would run agent "plan" with prompt "test..."

Full implementation pending cli-core handler completion.
```

**When will tools work fully?**
Follow-up PR will integrate cli-core handlers into tool execute() functions.

## Success Checklist

- [ ] Build succeeded: `pnpm run build:mcp`
- [ ] Config file exists: `~/.config/Claude/claude_desktop_config.json`
- [ ] Absolute path correct in config
- [ ] Claude Desktop restarted
- [ ] 🔌 Plug icon visible in Claude Desktop
- [ ] "genie" server listed when clicking plug
- [ ] 6 tools visible under genie server
- [ ] Tool execution returns stub message (expected for now)

## Next Steps

Once you verify the connection works:
1. Capture screenshots for evidence
2. Document any issues found
3. Proceed with handler integration (follow-up PR)

## Questions?

- **Why no `MCP_TRANSPORT` in config?** Server defaults to stdio when env var not set
- **Why absolute path?** Claude Desktop doesn't know your current directory
- **Why not npm scripts?** Claude Desktop needs direct access to server.js
- **When will tools actually work?** After handler integration (follow-up PR)
