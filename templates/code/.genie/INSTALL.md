# 🧞 Genie Installation Workflow

**Purpose:** Complete project initialization and setup product documentation for a new or existing codebase.

**When to use:** After running `genie init` when template files have been copied to `.genie/`.

**How to invoke:** The `genie init` command automatically invokes this workflow with the project location.

---

## Overview

This workflow analyzes your repository (existing codebase OR empty/new project), gathers project information through analysis or interview, and creates the foundational product documentation that guides all future Genie workflows.

**Key principle:** Understand first, document second, validate third.

---

## Task Breakdown

<task_breakdown>
1. [Discovery] Analyze repository state
   - Detect if existing codebase or new/empty project
   - Choose installation mode: Codebase Analysis, New Repo Interview, or Hybrid
   - Gather project information via analysis or interactive questions

2. [Implementation] Create product documentation
   - Initialize `.genie/product/` docs (mission.md, tech-stack.md, roadmap.md, environment.md)
   - Populate `.genie/CONTEXT.md` with project and user details
   - Calibrate custom agent configurations if needed (`.genie/custom/*.md`)

3. [Verification] Validate installation
   - Test MCP tools (mcp__genie__list_agents)
   - Confirm all critical files present and properly formatted
   - Create installation summary and suggest next steps
</task_breakdown>

---

## Installation Modes

### Mode 1: Codebase Analysis (Existing Project)

**Trigger:** Existing source files detected (src/, app/, lib/, etc.)

**Process:**
1. **Structure Analysis**
   - Map directory structure and key files
   - Identify programming languages and frameworks
   - Extract dependencies from package.json, requirements.txt, Cargo.toml, etc.
   - Analyze import patterns and architecture

2. **Pattern Recognition**
   - Detect application type (web app, API, CLI tool, library, etc.)
   - Identify data persistence patterns (databases, ORMs)
   - Map external service integrations (APIs, auth providers, payment systems)
   - Extract configuration patterns (env vars, config files)

3. **Implementation Progress**
   - Identify completed features, WIP items, known limitations
   - Document authentication/authorization approach
   - Map API endpoints or CLI commands
   - Note testing approach and coverage

4. **Documentation Extraction**
   - Parse existing README, docs, comments
   - Extract feature lists and capabilities
   - Identify performance requirements or metrics
   - Map deployment and environment needs

**Output:**
- Generates mission.md from discovered patterns
- Creates tech-stack.md from dependencies and code patterns
- Builds environment.md from config files and env vars
- Initializes roadmap.md with discovered features as Phase 1

---

### Mode 2: New Repository Interview (Empty Project)

**Trigger:** Empty repository or minimal placeholder content (README only, etc.)

**Interview Flow:**

```markdown
## Project Basics
- **PROJECT_NAME**: "What's your project name?"
- **DOMAIN**: "What domain/industry is this for? (e.g., 'e-commerce', 'healthcare', 'finance')"
- **PROJECT_TYPE**: "What type of application? (web app, API, CLI, mobile, etc.)"

## Technical Foundation
- **TECH_STACK**: "What technologies do you plan to use? (languages, frameworks, databases)"
- **DEPLOYMENT**: "How will this be deployed? (cloud, on-premise, edge, etc.)"

## Product Vision
- **PRIMARY_FEATURES**: "What are the 3-5 core features this will provide?"
- **SUCCESS_CRITERIA**: "What outcome would make this a win in Phase 1?"
- **USER_STORY**: "Who is this for and what problem does it solve?"

## Technical Requirements
- **METRICS**: "What performance metrics matter most? (latency, throughput, accuracy, etc.)"
- **APIS**: "Any external services you'll integrate? (payment, auth, AI, etc.)"
- **ENVIRONMENT_VARS**: "What configuration will you need? (API keys, database URLs, etc.)"

## Constraints & Inspiration
- **RISKS_CONSTRAINTS**: "Any constraints, deadlines, compliance, or must/never-do items?"
- **TEAM_PREFERENCES**: "Any coding standards, naming, or conventions to enforce?"
- **INSPIRATION**: "Links to similar products, repos, or competitors (for research)?"
```

**Guidance:**
- If the user has only a broad idea, use progressive elaboration:
  - Reframe into 2-3 concrete product directions
  - Ask preference
  - Lock scope for Phase 1
- Encourage examples over abstractions
- If network research permitted, synthesize competitor patterns
- Otherwise request links from user and analyze locally

**Output:**
- Creates mission.md from project vision
- Builds tech-stack.md from planned technologies
- Initializes environment.md from configuration needs
- Drafts roadmap.md with phased feature rollout

---

### Mode 3: Hybrid Analysis (Partial Codebase)

**Trigger:** Some code exists but context is incomplete or unclear

**Process:**
1. Run codebase analysis on available files
2. Identify gaps in extracted information
3. Conduct targeted interview for missing pieces
4. Combine analysis + interview data into docs

**Example scenarios:**
- Code exists but no README or docs
- Project started but goals unclear
- Multiple services but unclear integration
- Features implemented but purpose undefined

---

## Product Documentation Structure

### mission.md
```markdown
# Mission: {{PROJECT_NAME}}

## Pitch
{{ELEVATOR_PITCH}}

## Problem
{{USER_PAIN_POINT}}

## Solution
{{HOW_THIS_SOLVES_IT}}

## Value Proposition
{{KEY_BENEFITS}}

## Target Users
{{WHO_THIS_IS_FOR}}

## Success Metrics
{{WHAT_SUCCESS_LOOKS_LIKE}}
```

### tech-stack.md
```markdown
# Tech Stack: {{PROJECT_NAME}}

## Languages
{{LANGUAGES}}

## Frameworks & Libraries
{{FRAMEWORKS}}

## Data Persistence
{{DATABASES_ORMS}}

## External Services
{{APIS_INTEGRATIONS}}

## Development Tools
{{BUILD_TOOLS_TESTING}}

## Deployment
{{HOSTING_CI_CD}}
```

### environment.md
```markdown
# Environment: {{PROJECT_NAME}}

## Required Environment Variables
{{ENV_VARS_LIST}}

## Configuration Files
{{CONFIG_FILE_PATHS}}

## Local Development Setup
{{DEV_SETUP_STEPS}}

## Deployment Environments
{{STAGING_PRODUCTION_ETC}}
```

### roadmap.md
```markdown
# Roadmap: {{PROJECT_NAME}}

## Phase 1: Foundation
{{CORE_FEATURES}}
**Target:** {{PHASE_1_GOAL}}

## Phase 2: Enhancement
{{NICE_TO_HAVE}}
**Target:** {{PHASE_2_GOAL}}

## Phase 3: Scale
{{FUTURE_VISION}}
**Target:** {{PHASE_3_GOAL}}

## Parking Lot
{{DEFERRED_IDEAS}}
```

---

## CONTEXT.md Initialization

**Purpose:** Enable session continuity and personalized workflows

**Template location:** `.genie/CONTEXT.md`

**Required substitutions:**
- `{{USER_NAME}}`: Ask user for their name/handle
- `{{PROJECT_NAME}}`: Use project name from package.json or interview
- `!command` statements: Already functional (runtime command injection)

**Process:**
1. Read template from `.genie/CONTEXT.md`
2. Replace placeholders with actual values
3. Ask user to verify/edit "User Profile" and "Working Preferences" sections
4. Save updated file (gitignored, per-user)

**Example interaction:**
```
I've initialized your CONTEXT.md file. Here's what I set:

**User:** {{USER_NAME}}
**Project:** {{PROJECT_NAME}}
**Active Since:** 2025-10-14

The file tracks your current focus, decision queue, and working preferences.
Feel free to customize the "User Profile" section to match your workflow!
```

---

## Custom Agent Calibration (Optional)

**When needed:**
- Project uses non-standard build commands
- Specific testing frameworks or patterns
- Unique file structure or naming conventions

**Process:**
1. Create `.genie/custom/<agent>.md` for relevant agents
2. Document project-specific commands, paths, and patterns
3. Examples: `implementor.md`, `tests.md`, `git-workflow.md`

**Example `.genie/custom/implementor.md`:**
```markdown
# implementor - Project Customization

## Commands
Primary build command: `make build`
Test command: `make test`

## File Paths
Source: `src/`
Tests: `__tests__/`
Config: `tsconfig.json`

## Project-Specific Notes
- Use dependency injection for all services
- Prefer functional patterns over OOP
- Follow naming convention: PascalCase for classes, camelCase for functions
```

---

## Verification Steps

### 1. MCP Tool Test
```bash
# List available agents via MCP
mcp__genie__list_agents

# Expected: Shows all core + custom agents
```

### 2. File Structure Check
```bash
# Verify all critical files exist
ls -la .genie/product/
ls -la .genie/CONTEXT.md
ls -la AGENTS.md CLAUDE.md
ls -la .mcp.json
```

### 3. Documentation Review
- Read each `.genie/product/*.md` file
- Verify content makes sense and is project-specific
- Confirm no placeholder text ({{VARIABLES}}) remains

### 4. Git Ignore Check
```bash
# Verify CONTEXT.md is gitignored
git check-ignore .genie/CONTEXT.md
# Expected: .genie/CONTEXT.md
```

---

## Installation Summary Template

```markdown
# 🎉 Genie Installation Complete

**Project:** {{PROJECT_NAME}}
**Installation Mode:** {{MODE}}
**Date:** {{DATE}}

## What Was Created

### Product Documentation
✅ `.genie/product/mission.md` - Project vision and goals
✅ `.genie/product/tech-stack.md` - Technologies and dependencies
✅ `.genie/product/environment.md` - Configuration and deployment
✅ `.genie/product/roadmap.md` - Phased feature rollout

### User Context
✅ `.genie/CONTEXT.md` - Session continuity and preferences

### Framework Files
✅ `AGENTS.md` - Genie workflow guide
✅ `CLAUDE.md` - Claude Code integration
✅ `.mcp.json` - MCP server configuration

## Next Steps

1. **Review Documentation**
   - Read `.genie/product/mission.md` to confirm vision
   - Verify tech-stack.md matches your plans
   - Adjust roadmap.md phasing as needed

2. **Start Planning**
   ```bash
   /plan
   ```
   Enter product planning mode to create your first wish

3. **Customize (Optional)**
   - Edit `.genie/CONTEXT.md` to personalize your workflow
   - Add custom agent configurations in `.genie/custom/`
   - Adjust standards in `.genie/standards/`

## Validation

- [x] MCP tools functional
- [x] Product docs generated
- [x] Context file initialized
- [x] Git configuration correct

**Genie is ready!** Start with `/plan` to begin your first feature planning session. ✨
```

---

## Completion

After installation, provide the summary above and suggest next steps:

1. **Immediate**: Review generated docs for accuracy
2. **Next session**: Run `/plan` to start product planning workflow
3. **Ongoing**: Use CONTEXT.md to track focus and maintain session continuity

---

## Troubleshooting

### Issue: No package.json or project files detected

**Solution:**
- Switch to Mode 2 (New Repo Interview)
- Ask user for project details
- Generate docs from interview responses

### Issue: Multiple languages/frameworks detected

**Solution:**
- Document all in tech-stack.md
- Ask user which is primary
- Note polyglot architecture in mission.md

### Issue: Existing docs conflict with analysis

**Solution:**
- Prioritize existing README/docs
- Use analysis to fill gaps
- Ask user to resolve conflicts

---

## Cleanup (After Completion)

Once installation is verified and complete, you can optionally delete this workflow guide:

```bash
rm .genie/INSTALL.md
```

**When to delete:**
- ✅ Installation verified complete
- ✅ All product docs created and reviewed
- ✅ MCP tools tested and functional
- ✅ No data loss concerns

**When to keep:**
- ⚠️ Installation incomplete or needs revision
- ⚠️ Team members may need to reference the workflow
- ⚠️ Useful as documentation of installation process

**Note:** This file is NOT tracked in git and won't be updated on `genie update`. It's a one-time installation guide.

---

**Project Customization:** Load additional context from `.genie/custom/install.md` if it exists.
