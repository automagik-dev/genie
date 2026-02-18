# forms.md

Google Forms command guide.

## Form CRUD-ish
- `gog forms create --title "..." [--description ...]`
- `gog forms get <formId>`
- `gog forms publish <formId> [--accepting-responses=true|false ...]`

## Responses
- `gog forms responses list <formId>`
- `gog forms responses get <formId> <responseId>`

## Template creation pattern
- Keep a baseline form; clone via Drive copy patterns and then adjust settings/questions externally if needed.

## Example
```bash
gog forms create --title 'Customer Feedback - Q1' --dry-run
gog forms responses list <formId> --read-only
```
