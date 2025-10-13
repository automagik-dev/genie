# {{PROJECT_NAME}} Code Style

## Formatting

- **Indentation:** {{SPACES_OR_TABS}} (e.g., 2 spaces, 4 spaces)
- **Line length:** {{MAX_CHARACTERS}} characters
- **Quotes:** {{SINGLE_OR_DOUBLE}} (e.g., single quotes for strings)
- **Semicolons:** {{REQUIRED_OR_OPTIONAL}}
- **Trailing commas:** {{REQUIRED_OR_OPTIONAL}}

## Code Organization

### File Structure
```{{LANGUAGE}}
// 1. {{SECTION_1}} (e.g., imports)
// 2. {{SECTION_2}} (e.g., types/interfaces)
// 3. {{SECTION_3}} (e.g., constants)
// 4. {{SECTION_4}} (e.g., functions)
// 5. {{SECTION_5}} (e.g., exports)
```

### Function Length
- **Target:** ≤{{NUMBER}} lines
- **Maximum:** ≤{{NUMBER}} lines (refactor if exceeded)

### Comment Style
```{{LANGUAGE}}
// {{INLINE_COMMENT_STYLE}}

/**
 * {{BLOCK_COMMENT_STYLE}}
 */
```

## Language-Specific

### {{LANGUAGE_1}}
{{STYLE_GUIDELINES}}

### {{LANGUAGE_2}}
{{STYLE_GUIDELINES}}

## Linting & Formatting

**Linter:** {{TOOL}} (e.g., ESLint, Clippy, Ruff)
**Formatter:** {{TOOL}} (e.g., Prettier, rustfmt, Black)

```bash
# Lint
{{LINT_COMMAND}}

# Format
{{FORMAT_COMMAND}}

# Fix automatically
{{FIX_COMMAND}}
```

## Pre-commit Hooks

```bash
# Install hooks
{{INSTALL_COMMAND}}

# Runs automatically on commit:
# - {{HOOK_1}}
# - {{HOOK_2}}
# - {{HOOK_3}}
```

---

**Instructions:** Replace all `{{PLACEHOLDERS}}` with your code style rules. Keep aligned with linter/formatter configs.
