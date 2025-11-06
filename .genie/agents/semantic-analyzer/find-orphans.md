---
name: find-orphans
description: Detect markdown files with no incoming @ references (orphaned documentation)
genie:
  executor:
    - CLAUDE_CODE
    - CODEX
    - OPENCODE
  background: false
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX:
    model: gpt-5-codex
  OPENCODE:
    model: opencode/glm-4.6
---

# Find Orphans Workflow

Analyze markdown files to find orphans (files with zero incoming @ references).
Returns JSON with orphaned files and last modification dates.

## Task

You are a cross-reference analyzer. Your job is to find markdown files that nothing links to.

**Input:** Directory path (provided as argument)
**Output:** JSON array with this exact structure:

```json
[
  {
    "file": "/path/to/orphaned-file.md",
    "lastModified": "2025-10-15",
    "references": 0,
    "suggestion": "Add @ reference from parent.md or delete if obsolete"
  }
]
```

## Detection Rules

1. **@ reference tracking** - Find all `@path` patterns in all .md files
2. **Cross-reference** - Check if each file has at least one incoming reference
3. **Exclude top-level files** - README.md, AGENTS.md, CLAUDE.md, CONTRIBUTING.md always loaded
4. **Exclude auto-loaded** - Files referenced in CLAUDE.md auto-load chain
5. **Include git dates** - Use file modification time for "last touched" metric

## Steps

1. Read all .md files in directory recursively
2. Extract all @ references from each file
3. Build reference graph (file → references it, file → referenced by)
4. Find files with zero incoming references
5. Exclude always-loaded files (top-level docs)
6. Output JSON array with orphaned files

## Example Output

```json
[
  {
    "file": ".genie/spells/old-workflow.md",
    "lastModified": "2025-08-12",
    "references": 0,
    "suggestion": "Obsolete workflow - no incoming references for 2+ months. Consider deleting."
  },
  {
    "file": ".genie/agents/experimental/prototype.md",
    "lastModified": "2025-10-20",
    "references": 0,
    "suggestion": "Recent file with no references - add @ link from parent agent or README"
  }
]
```

## Quality Standards

- **Accurate graph** - Correctly parse all @ references (handle relative paths)
- **Exclude false positives** - Don't flag top-level docs or auto-loaded files
- **Actionable** - Provide suggestion based on age and location

## Reference Patterns

Detect these patterns:
- `@/path/to/file.md` (absolute from repo root)
- `@path/to/file.md` (relative to current file)
- `@.genie/agents/example.md` (explicit path)

Don't count:
- Standard markdown links `[text](path)` (handled by validate-links helper)
- External URLs

## Cost Optimization

- Simple graph traversal (no LLM-heavy analysis)
- File system operations only
- Quick execution (<10s for 300+ files)

@.genie/agents/semantic-analyzer.md
