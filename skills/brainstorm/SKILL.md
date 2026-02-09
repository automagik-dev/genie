---
name: brainstorm
description: "Use when starting creative work - explore ideas through dialogue before committing to a plan. Outputs validated design ready for /wish."
---

# Brainstorm - Ideas Into Designs

## Overview

Collaborative exploration phase: understand the idea, explore approaches, and validate a design. This is the creative space before structured planning.

**Output:** `.genie/brainstorms/<slug>/design.md` — validated design ready for `/wish` to structure into executable tasks.

---

## The Flow

### 1. Understand Context

Enter plan mode (read-only exploration). Check the current project state:
- What files/docs exist?
- What's the recent activity?
- What conventions are in use?

### 2. Resonate with Intent

**One question at a time. Multiple choice when possible.**

Understand what the user actually wants (not just what they said):
- What problem are they solving?
- What would success look like?
- What constraints exist?

Example question format:
```
"Which best describes what you're trying to achieve?
A) Add new feature X for use case Y
B) Improve existing feature X for reason Z
C) Fix bug in X that causes Y
D) Something else"
```

### 3. Explore Approaches

Propose 2-3 different approaches with trade-offs:
- Lead with your recommendation
- Explain why you recommend it
- Present alternatives with pros/cons
- Let the user choose or propose something different

### 4. Align on Scope

Define boundaries before designing:
- What's IN scope?
- What's explicitly OUT of scope?
- What assumptions are we making?

### 5. Present Design (Incremental)

Present the design in small sections (200-300 words each). Check after each section.

**Sections to cover:**
- Summary (what and why, 2-3 sentences)
- Architecture approach
- Key decisions with rationale
- Risks and mitigations

### 6. Finalize and Handoff

Once the user approves the design, choose one of the following options.

**Option A: Write Handoff & Plan with `/wish`**
For most ideas, write the handoff artifact:
1. **Choose a slug** — short, kebab-case name (e.g., `auth-redesign`, `pdf-export`)
2. **Create the directory:** `.genie/brainstorms/<slug>/`
3. **Write `design.md`** using the template at `references/design-template.md`
4. **Fill all sections** — Problem, Solution, Scope IN/OUT, Key Decisions, Risks, Success Definition
5. **Set status to `VALIDATED`**
6. Respond with:
```
"Design written to .genie/brainstorms/<slug>/design.md.
Run /wish to create structured execution plan."
```

**Option B: Write Handoff & Implement Directly**
For small ideas that still warrant a document. Follow steps 1-5 from Option A, then respond:
```
"Design written to .genie/brainstorms/<slug>/design.md.
This is small enough to implement directly. Proceed?"
```

**Option C: Skip Handoff**
For trivial ideas or quick explorations that won't need `/wish`. No document needed:
```
"Design validated verbally. Too small for a formal handoff. Proceed directly?"
```

---

## Key Principles

- **One question at a time** - Never ask multiple questions in one message
- **Multiple choice preferred** - Easier for users to answer
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design in sections, validate each
- **Be flexible** - Go back and clarify when something doesn't make sense
- **Read before proposing** - Understand existing code before designing changes

---

## Never Do

- Ask multiple questions in one message
- Skip context exploration
- Present full design all at once
- Assume requirements without confirming
- Design without exploring alternatives
- Start implementation during brainstorm
