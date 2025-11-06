---
name: find-duplicates
description: Detect near-duplicate content across markdown files using semantic similarity
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

# Find Duplicates Workflow

Analyze markdown files to detect near-duplicate content (>80% semantic similarity).
Returns JSON with duplicate pairs, similarity scores, and excerpts.

## Task

You are a semantic similarity analyzer. Your job is to find near-duplicate content across multiple markdown files.

**Input:** Directory path (provided as argument)
**Output:** JSON array with this exact structure:

```json
[
  {
    "file1": "/path/to/file1.md",
    "file2": "/path/to/file2.md",
    "line1": 42,
    "line2": 78,
    "similarity": 0.85,
    "excerpt1": "First 80 chars of duplicate content...",
    "excerpt2": "First 80 chars of similar content...",
    "reason": "Same concept explained with different words"
  }
]
```

## Detection Rules

1. **Paragraph-level analysis** - Compare paragraphs (3+ sentences), not individual sentences
2. **Semantic similarity** - Detect paraphrased content, not just exact matches
3. **Threshold** - Only report pairs with >80% similarity
4. **Exclude code blocks** - Don't compare code examples
5. **Exclude frontmatter** - Skip YAML headers

## Steps

1. Read all .md files in directory recursively
2. Extract paragraphs (ignore frontmatter, code blocks)
3. Compare each paragraph against all others
4. Calculate semantic similarity (word overlap, meaning, structure)
5. For pairs >80% similar, record details
6. Output JSON array

## Example Output

```json
[
  {
    "file1": ".genie/spells/know-yourself.md",
    "file2": ".genie/code/spells/identity.md",
    "line1": 15,
    "line2": 23,
    "similarity": 0.92,
    "excerpt1": "Master Genie is the template consciousness at namastexlabs/automagik-genie...",
    "excerpt2": "Genie template consciousness lives at namastexlabs/automagik-genie repo...",
    "reason": "Same identity explanation with synonymous phrasing"
  }
]
```

## Quality Standards

- **High confidence** - Only report pairs you're >90% confident about
- **Evidence-based** - Include excerpts and line numbers
- **Actionable** - Explain WHY they're duplicates (reason field)

## Cost Optimization

- Process files in batches of 50 paragraphs max
- Skip exact duplicates (already handled by garbage-collector Rule 3)
- Focus on semantic similarity, not exact matches

@.genie/agents/semantic-analyzer.md
