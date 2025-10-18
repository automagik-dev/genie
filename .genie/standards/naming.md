# Naming Conventions (Template)
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
Consistent naming conventions for {{PROJECT_NAME}}. Customize these patterns for your domain.

## Project Names

### Repository
- **Pattern**: Use your organization's standard
- **Example**: `{{ORG}}-{{PROJECT_NAME}}`

### Product
- **Marketing Name**: {{PROJECT_NAME}}
- **Documentation**: Use consistent casing

### Binary/Package
- **Pattern**: kebab-case
- **Example**: `{{PROJECT_NAME}}-cli`

## Environment Variables

### Prefix
- **Application**: Use a short prefix like `{{PREFIX}}_`
- **Providers**: Keep provider names as-is (e.g., `AWS_`, `GITHUB_`)

### Format
- **Style**: UPPER_SNAKE_CASE
- **Examples**:
  - `{{PREFIX}}_SERVER_PORT`
  - `{{PREFIX}}_LOG_LEVEL`
  - `{{PROVIDER}}_API_KEY`

## File & Directory Names

### Directories
- **Style**: kebab-case
- **Examples**:
  - `.genie/`
  - `docs/`
  - `tests/`

### Markdown Files
- **Style**: kebab-case.md
- **Examples**:
  - `getting-started.md`
  - `environment-config.md`

### Source Files
Follow language conventions:
- **Rust**: snake_case.rs
- **TypeScript**: camelCase.ts or kebab-case.ts
- **Python**: snake_case.py

## Agent Names
- **Pattern**: template-{role}
- **Examples**:
  - `template-implementor`
  - `template-qa`
  - `template-tests`

## Wish & Report Names
- **Wishes**: `<feature-slug>-wish.md`
- **Reports**: `<agent>-<slug>-<YYYYMMDDHHmm>.md`

## Git Conventions
- **Branches**: `feat/<wish-slug>`, `fix/<issue>`, `chore/<task>`
- **Tags**: `v<major>.<minor>.<patch>`

## Timestamps
- **UTC format for reports**: `YYYYMMDDHHmm` (e.g., `20250314T1530Z` → store as `202503141530`)
- **Date format for summaries**: `YYYY-MM-DD`
- **Command examples**:
  - Current UTC timestamp: ``date -u +%Y%m%d%H%M``
  - Current date: ``date -u +%F``
  - Do not infer dates from filenames or branch names

Adapt these conventions to match your organization's standards.
