# keep.md

> Workspace-only service.
>
> Read-only orientation: current command surface is mostly retrieval/search (no full CRUD exposed here).

## Commands
- `gog keep list`
- `gog keep get <noteId>`
- `gog keep search <query>` (client-side text search)
- `gog keep attachment <attachmentName> --out <path>`

## Service-account flags
Keep commands include:
- `--service-account <json-key>`
- `--impersonate <user@domain>`

## Example
```bash
gog keep list --read-only
gog keep get <noteId> --read-only
```
