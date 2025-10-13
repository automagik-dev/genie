# Language-Specific Code Style

This directory contains language-specific style guides.

## Structure

```
code-style/
├── {{LANGUAGE_1}}.md  # e.g., typescript.md
├── {{LANGUAGE_2}}.md  # e.g., rust.md
├── {{LANGUAGE_3}}.md  # e.g., python.md
└── README.md
```

## Example File

**`typescript.md`:**
```markdown
# TypeScript Style Guide

## Imports
- Use named imports over default imports
- Group imports: external → internal → relative

## Types
- Prefer `interface` over `type` for object shapes
- Use `type` for unions and primitives

## Functions
- Use arrow functions for inline callbacks
- Use function declarations for top-level functions
```

---

**Instructions:** Create separate `.md` files for each language in your stack. Reference from `@.genie/standards/code-style/{{LANGUAGE}}.md`.
