# tasks.md

Google Tasks command guide.

## Task lists
- `gog tasks lists list`
- `gog tasks lists create --title "..."`

## Tasks CRUD
- `gog tasks list <tasklistId>`
- `gog tasks get <tasklistId> <taskId>`
- `gog tasks add <tasklistId> --title "..." [--notes ...] [--due ...]`
- `gog tasks update <tasklistId> <taskId> ...`
- `gog tasks done <tasklistId> <taskId>`
- `gog tasks undo <tasklistId> <taskId>`
- `gog tasks delete <tasklistId> <taskId>`
- `gog tasks clear <tasklistId>` (clears completed)

## Example
```bash
gog tasks add <tasklistId> --title 'Prepare launch checklist' --due 2026-02-20 --dry-run
gog tasks done <tasklistId> <taskId> --dry-run
```
