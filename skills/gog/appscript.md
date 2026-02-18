# appscript.md

Google Apps Script command guide.

## Commands
- `gog appscript create --title "..."`
- `gog appscript get <scriptId>`
- `gog appscript content <scriptId>`
- `gog appscript run <scriptId> <function> [--params ...]`

## Typical workflow
1. Create project
2. Inspect metadata/content
3. Run deployed function for automation tasks

## Example
```bash
gog appscript create --title 'Daily Ops Automation' --dry-run
gog appscript run <scriptId> syncSheets --params '{"date":"2026-02-18"}' --dry-run
```
