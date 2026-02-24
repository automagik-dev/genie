# SKILL.md Style Guide

Standard structure and conventions for all automagik-genie skills.

## YAML Frontmatter

```yaml
---
name: skill-name
description: "One sentence. Starts with verb or noun. States what it does and when to use it."
---
```

- `name`: lowercase, hyphenated, matches directory name
- `description`: max 120 chars. Must answer "what does this do?" and "when should Claude load it?"

## Document Structure (in order)

```markdown
# /skill-name — Short Tagline

One-liner expanding on the description. Sets context.

## When to Use
- Bullet list of trigger scenarios (when this skill activates)

## Flow
1. Numbered steps — the core execution sequence
2. Keep steps atomic and imperative ("Load wish", "Dispatch agent", not "The wish is loaded")

## [Domain-Specific Sections]
- Tables, formats, rules specific to this skill
- Use tables for structured data (members, routes, mappings)
- Use code blocks for output formats and command examples

## Rules
- Hard constraints as bullet list
- Things the skill must NEVER do
- Escalation and failure behavior
```

## Conventions

### Tone
- Imperative, direct. "Do X" not "You should do X"
- No filler words. No motivation paragraphs
- Technical but accessible — assume the reader is Claude, not a human

### Formatting
- H1 (`#`) for skill title only — exactly one per file
- H2 (`##`) for major sections
- H3 (`###`) for subsections within a section
- Tables over prose for structured mappings
- Code blocks with language tags for commands, formats, templates
- Checkboxes (`- [ ]`) for criteria and checklists

### Content Rules
- Every skill must have: Frontmatter, Title, Flow, Rules
- Optional but encouraged: When to Use, Output Format, Subagent Dispatch
- No duplication — if another skill handles something, reference it (`see /review`)
- No implementation details from source code — skills are prompts, not docs
- Keep total length proportional to complexity:
  - Simple skills (fix, wish): 30-60 lines
  - Medium skills (review, work, brainstorm): 60-100 lines
  - Complex skills (dream, brain): 100-200 lines

### Cross-references
- Reference other skills as `/skillname` (e.g., "hand off to `/fix`")
- Reference files with relative paths from repo root
- Reference agents by name (e.g., "dispatch to `implementor` agent")

### What NOT to Include
- Motivation or "why this exists" paragraphs
- Version history or changelogs
- Redundant restatements of the description
- Platform-specific spawning mechanisms (keep skill logic portable)
