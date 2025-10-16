# 🧞 Genie Installation Workflow (Create Template)

**Purpose:** Complete project initialization and setup knowledge base documentation for research, content, or learning projects.

**When to use:** After running `genie init create` when template files have been copied to `.genie/`.

**How to invoke:** The `genie init` command automatically invokes this workflow with the project location.

---

## Overview

This workflow analyzes your project type (research, content, learning), gathers project information through analysis or interview, and creates the foundational knowledge base that guides all future Genie workflows.

**Key principle:** Understand the domain first, document the goals second, validate the approach third.

---

## Task Breakdown

<task_breakdown>
1. [Discovery] Analyze project context
   - Detect project type (research, content creation, learning journey, etc.)
   - Choose installation mode: Existing Work Analysis, New Project Interview, or Hybrid
   - Gather project information via analysis or interactive questions

2. [Implementation] Create knowledge base documentation
   - Initialize `.genie/knowledge/` docs (domain.md, standards.md, patterns.md, decisions.md)
   - Populate `.genie/context.md` with project and user details
   - Configure bootstrap protocols (identity, learning, neuron creation, self-modification)

3. [Verification] Validate installation
   - Test MCP tools (mcp__genie__list_agents)
   - Confirm all critical files present and properly formatted
   - Create installation summary and suggest next steps
</task_breakdown>

---

## Installation Modes

### Mode 1: Existing Work Analysis

**Trigger:** Existing research materials, drafts, notes, or content detected

**Process:**
1. **Structure Analysis**
   - Map directory structure and existing files
   - Identify document types (papers, notes, drafts, data, etc.)
   - Detect topic areas and knowledge domains

2. **Pattern Recognition**
   - Detect project type (research paper, content series, learning curriculum, etc.)
   - Identify quality standards (academic rigor, editorial style, pedagogical approach)
   - Map sources and references (papers cited, books used, experts consulted)
   - Extract methodology patterns (research approach, writing process, learning framework)

3. **Progress Assessment**
   - Identify completed sections, WIP items, known gaps
   - Document quality criteria already established
   - Map research questions or content goals
   - Note review process and stakeholder feedback

4. **Documentation Extraction**
   - Parse existing README, outlines, abstracts
   - Extract goals, scope, and intended outcomes
   - Identify quality metrics or success criteria
   - Map dependencies (required reading, prerequisite knowledge, data sources)

**Output:**
- Generates domain.md from discovered patterns
- Creates standards.md from quality criteria and methodology
- Builds patterns.md from observed work habits
- Initializes decisions.md with key choices already made

---

### Mode 2: New Project Interview (Empty Project)

**Trigger:** Empty directory or minimal placeholder content

**Interview Flow:**

```markdown
## Project Basics
- **PROJECT_NAME**: "What's your project name or working title?"
- **PROJECT_TYPE**: "What are you working on? (research paper, blog series, course, book, etc.)"
- **DOMAIN**: "What domain/topic? (e.g., 'machine learning', 'history', 'creative writing')"

## Goals & Scope
- **PRIMARY_GOALS**: "What are the 3-5 main outcomes you want to achieve?"
- **AUDIENCE**: "Who is this for? (academics, general public, students, practitioners, etc.)"
- **SUCCESS_CRITERIA**: "What would make this successful?"

## Quality Standards
- **METHODOLOGY**: "What approach will you use? (literature review, primary research, synthesis, etc.)"
- **QUALITY_CRITERIA**: "What quality standards matter? (rigor, clarity, completeness, originality, etc.)"
- **REVIEW_PROCESS**: "How will quality be validated? (peer review, expert feedback, self-assessment, etc.)"

## Resources & Constraints
- **SOURCES**: "Key sources you'll use? (papers, books, data, experts, etc.)"
- **TIMELINE**: "Any deadlines or milestones?"
- **CONSTRAINTS**: "Any must/never-do items? (word limits, citation styles, ethical considerations, etc.)"

## Work Patterns
- **WORKFLOW**: "How do you work best? (iterative drafts, comprehensive outlining, exploratory research, etc.)"
- **TOOLS**: "Any preferred tools? (citation managers, writing apps, note-taking systems, etc.)"
- **COLLABORATION**: "Working solo or with others?"
```

**Guidance:**
- If the user has only a broad idea, use progressive elaboration:
  - Reframe into 2-3 concrete directions
  - Ask preference
  - Lock scope for initial phase
- Encourage examples over abstractions
- Ask for similar projects or inspiration sources

**Output:**
- Creates domain.md from project goals
- Builds standards.md from quality criteria
- Initializes patterns.md with workflow preferences
- Drafts decisions.md with key methodological choices

---

### Mode 3: Hybrid Analysis (Partial Work)

**Trigger:** Some work exists but context is incomplete or unclear

**Process:**
1. Run existing work analysis on available materials
2. Identify gaps in extracted information
3. Conduct targeted interview for missing pieces
4. Combine analysis + interview data into knowledge base

**Example scenarios:**
- Research notes exist but goals unclear
- Drafts started but quality standards undefined
- Multiple documents but unclear relationships
- Sources gathered but methodology unspecified

---

## Knowledge Base Structure

### domain.md
```markdown
# Domain: {{PROJECT_NAME}}

## Topic Area
{{KNOWLEDGE_DOMAIN}}

## Project Type
{{RESEARCH_CONTENT_LEARNING}}

## Goals
{{PRIMARY_OBJECTIVES}}

## Scope
{{WHAT_IS_INCLUDED}}
{{WHAT_IS_EXCLUDED}}

## Audience
{{TARGET_READERS_USERS}}

## Success Criteria
{{WHAT_SUCCESS_LOOKS_LIKE}}
```

### standards.md
```markdown
# Standards: {{PROJECT_NAME}}

## Quality Criteria
{{RIGOR_CLARITY_COMPLETENESS}}

## Methodology
{{RESEARCH_WRITING_APPROACH}}

## Citation Style
{{APA_MLA_CHICAGO_ETC}}

## Review Process
{{PEER_REVIEW_VALIDATION}}

## Ethical Considerations
{{GUIDELINES_CONSTRAINTS}}

## Style Guidelines
{{TONE_VOICE_FORMATTING}}
```

### patterns.md
```markdown
# Patterns: {{PROJECT_NAME}}

## Workflow
{{HOW_YOU_WORK}}

## Tools
{{WRITING_RESEARCH_TOOLS}}

## Collaboration
{{SOLO_TEAM_ADVISORS}}

## Organization
{{FILE_STRUCTURE_NAMING}}

## Review Cycles
{{DRAFT_FEEDBACK_REVISION}}
```

### decisions.md
```markdown
# Decisions: {{PROJECT_NAME}}

## Methodological Choices
{{KEY_APPROACH_DECISIONS}}

## Scope Boundaries
{{WHAT_WE_DECIDED_TO_INCLUDE_EXCLUDE}}

## Quality Trade-offs
{{DEPTH_VS_BREADTH_ETC}}

## Timeline Decisions
{{PHASING_MILESTONES}}
```

---

## context.md Initialization

**Purpose:** Enable session continuity and personalized workflows

**Template location:** `.genie/context.md`

**Required substitutions:**
- `{{USER_NAME}}`: Ask user for their name/handle
- `{{PROJECT_NAME}}`: Use project name or working title
- `!command` statements: Already functional (runtime command injection)

**Process:**
1. Read template from `.genie/context.md`
2. Replace placeholders with actual values
3. Ask user to verify/edit "User Profile" section
4. Save updated file (gitignored, per-user)

**Example interaction:**
```
I've initialized your context.md file. Here's what I set:

**User:** {{USER_NAME}}
**Project:** {{PROJECT_NAME}}
**Active Since:** 2025-10-16

The file tracks your current focus, decision queue, and working preferences.
Feel free to customize the "User Profile" section to match your workflow!
```

---

## Bootstrap Protocol Configuration

**Purpose:** Enable dynamic neuron creation and self-modification

### identity.md
Defines Genie's identity for this project (conversational mentor, research assistant, etc.)

### neuron-protocol.md
Documents pattern recognition (≥3 threshold) for creating specialized neurons like:
- literature-reviewer
- outline-builder
- experiment-designer
- synthesizer

### learning-protocol.md
Captures how Genie learns from your feedback and adapts to your patterns

### self-modification-rules.md
Defines safe self-modification boundaries and approval gates

**Configuration:**
These files are pre-populated with sensible defaults. Customize if you have specific requirements.

---

## Verification Steps

### 1. MCP Tool Test
```bash
# List available agents via MCP
mcp__genie__list_agents

# Expected: Shows all core agents
```

### 2. File Structure Check
```bash
# Verify all critical files exist
ls -la .genie/knowledge/
ls -la .genie/context.md
ls -la .genie/bootstrap/
ls -la .mcp.json
```

### 3. Documentation Review
- Read each `.genie/knowledge/*.md` file
- Verify content makes sense and is project-specific
- Confirm no placeholder text ({{VARIABLES}}) remains

### 4. Git Ignore Check
```bash
# Verify context.md is gitignored
git check-ignore .genie/context.md
# Expected: .genie/context.md
```

---

## Installation Summary Template

```markdown
# 🎉 Genie Installation Complete (Create Template)

**Project:** {{PROJECT_NAME}}
**Project Type:** {{TYPE}}
**Installation Mode:** {{MODE}}
**Date:** {{DATE}}

## What Was Created

### Knowledge Base
✅ `.genie/knowledge/domain.md` - Project goals and scope
✅ `.genie/knowledge/standards.md` - Quality criteria and methodology
✅ `.genie/knowledge/patterns.md` - Workflow and tools
✅ `.genie/knowledge/decisions.md` - Key methodological choices

### Bootstrap Protocols
✅ `.genie/bootstrap/identity.md` - Genie's identity for this project
✅ `.genie/bootstrap/neuron-protocol.md` - Dynamic neuron creation rules
✅ `.genie/bootstrap/learning-protocol.md` - Adaptive learning framework
✅ `.genie/bootstrap/self-modification-rules.md` - Safe modification boundaries

### User Context
✅ `.genie/context.md` - Session continuity and preferences

### Memory System
✅ `.genie/memory/learnings.md` - Pattern recognition log
✅ `.genie/memory/important-sessions.md` - Key conversations

## Next Steps

1. **Review Knowledge Base**
   - Read `.genie/knowledge/domain.md` to confirm goals
   - Verify standards.md matches your quality expectations
   - Adjust patterns.md to fit your workflow

2. **Start Planning**
   ```bash
   /plan
   ```
   Enter planning mode to create your first wish

3. **Customize (Optional)**
   - Edit `.genie/context.md` to personalize your workflow
   - Adjust bootstrap protocols if needed
   - Update knowledge base as project evolves

## Validation

- [x] MCP tools functional
- [x] Knowledge base generated
- [x] Context file initialized
- [x] Bootstrap protocols configured
- [x] Git configuration correct

**Genie is ready!** Start with `/plan` to begin your first project planning session. ✨
```

---

## Completion

After installation, provide the summary above and suggest next steps:

1. **Immediate**: Review generated knowledge base for accuracy
2. **Next session**: Run `/plan` to start project planning workflow
3. **Ongoing**: Use context.md to track focus and maintain session continuity

---

## Troubleshooting

### Issue: No existing files detected

**Solution:**
- Switch to Mode 2 (New Project Interview)
- Ask user for project details
- Generate knowledge base from interview responses

### Issue: Unclear project type

**Solution:**
- Ask targeted questions to classify project
- Provide examples (research paper vs blog vs course)
- Default to general "knowledge work" if still unclear

### Issue: Multiple domains or topics

**Solution:**
- Document all in domain.md
- Ask user which is primary
- Note interdisciplinary nature in knowledge base

---

## Cleanup (After Completion)

Once installation is verified and complete, you can optionally delete this workflow guide:

```bash
rm .genie/INSTALL.md
```

**When to delete:**
- ✅ Installation verified complete
- ✅ All knowledge base docs created and reviewed
- ✅ MCP tools tested and functional
- ✅ No data loss concerns

**When to keep:**
- ⚠️ Installation incomplete or needs revision
- ⚠️ Team members may need to reference the workflow
- ⚠️ Useful as documentation of installation process

**Note:** This file is NOT tracked in git and won't be updated on `genie update`. It's a one-time installation guide.

---

**Project Customization:** Load additional context from `.genie/custom/install.md` if it exists.
