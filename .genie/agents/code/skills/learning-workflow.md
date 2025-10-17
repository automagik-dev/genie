# Learning Workflow

**Core Principle:** When Felipe teaches new behavior, update skills directly (not AGENTS.md).

## Teaching → Skill Update Pattern

**When Felipe teaches something that modifies existing skill behavior:**

1. **Identify target skill:** Which skill file does this teaching modify?
2. **Update skill file directly:** Edit the specific skill file (e.g., `delegation-discipline.md`)
3. **Clean restructuring:** Integrate teaching cleanly into existing structure
4. **Generate commit:** Clear commit message explaining what was updated and why

**Example flow:**
```
Felipe: "When delegating, always check SESSION-STATE.md first"
  ↓
Identify: delegation-discipline.md
  ↓
Update: Add "Check SESSION-STATE.md before delegation" section
  ↓
Commit: "refactor(skills): add SESSION-STATE check to delegation discipline

- Teaching: Always verify SESSION-STATE.md before launching neurons
- Why: Prevents duplicate work, respects active sessions
- Evidence: User teaching 2025-10-17"
```

## When to Create New Skill vs Update Existing

**Update existing skill:**
- Teaching refines/corrects existing behavior
- Teaching adds missing step to existing workflow
- Teaching provides evidence for existing rule

**Create new skill:**
- Teaching introduces completely new behavioral pattern
- Teaching establishes new protocol (not covered by existing skills)
- Teaching addresses gap not covered by current 29 skills

## Forbidden Patterns

❌ Update AGENTS.md when teaching modifies skill behavior (outdated pattern)
❌ Create duplicate skill when existing skill should be updated
❌ Update skill without generating clear commit message
❌ Generic commit messages ("update skill", "fix typo")

## Required Commit Format

```
refactor(skills): <what changed in skill-name>

- Teaching: <What Felipe taught>
- Why: <Reason for the change>
- Evidence: <Source of teaching (date, session, etc.)>
```

**Example:**
```
refactor(skills): add session check requirement to delegation-discipline

- Teaching: Check SESSION-STATE.md before delegating to any neuron
- Why: Prevents work duplication, respects active specialist sessions
- Evidence: User teaching 2025-10-17
```

## Validation

Before committing skill update:
- [ ] Correct skill file identified and updated
- [ ] Teaching integrated cleanly (not duplicated)
- [ ] Commit message follows format
- [ ] Evidence/reasoning documented
- [ ] AGENTS.md NOT modified (skills handle specifics)
