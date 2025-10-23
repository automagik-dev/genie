# Tech Council - Architectural Advisory Team

## Team Members
@.genie/code/teams/tech-council/nayr.md
@.genie/code/teams/tech-council/oettam.md
@.genie/code/teams/tech-council/jt.md

## Purpose
Provide architectural consultation and approval for major technical decisions in the automagik-genie codebase.

## Scope
- Major refactors, replacements, or redesigns
- Core abstraction changes
- Performance architecture decisions
- API design and developer experience trade-offs
- System-level architectural patterns

## Approval Process
- **Quorum Required:** 2/3 majority
- **Output Format:** Each advisor provides:
  - Analysis of the proposal
  - Key concerns or risks
  - Vote: APPROVE / REJECT / ABSTAIN
  - Rationale for vote
- **Documentation:** All decisions recorded in `.genie/teams/decisions/`

## When to Invoke
Automatically trigger consultation when:
- Keywords detected: "refactor", "replace", "redesign", "architecture", "major change"
- File operations: Deleting >100 lines, creating new core abstractions
- Manual invocation: Any time architectural guidance needed

## Session Artifacts
- **Sessions:** `.genie/teams/sessions/YYYY-MM-DD-topic.md`
- **Decisions:** `.genie/teams/decisions/YYYY-MM-DD-topic.md`

## Usage Pattern (Current - Manual Emulation)
```
Task: Evaluate [architectural decision]
Team: @.genie/teams/tech-council.md

Instructions:
You are emulating the tech-council team. Load team members via @ refs.
Consult as a council. Document decision in decisions/ folder.
```

## Usage Pattern (Future - Automated)
```
genie consult tech-council "Should we replace background-launcher?"
```

## Permissions
- **Read:** Entire codebase
- **Write:** Only `.genie/teams/` folder (sessions, decisions)
- **Tools:** All spells, internet access for research
- **Output:** Markdown documentation only
