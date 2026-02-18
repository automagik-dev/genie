# groups.md

> Workspace-only: Google Groups APIs require Workspace admin/domain context.

## Commands
- `gog groups list`
- `gog groups members <groupEmail>`

## Usage
Use for group discovery and membership inspection. For calendar-team scenarios, combine with `gog calendar team <group-email>`.

## Example
```bash
gog groups list --read-only
gog groups members eng@acme.com --read-only
```
