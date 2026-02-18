# drive.md

Google Drive file/folder/document management.

## Discover and read
- `gog drive ls [--folder <id>]`
- `gog drive search <query...>`
- `gog drive get <fileId>`
- `gog drive cat <fileId>`
- `gog drive url <fileId...>`
- `gog drive drives` (shared drives)
- `gog drive check-public <fileId>`

## CRUD and movement
- `gog drive upload <localPath> [--parent <folderId>]`
- `gog drive download <fileId> [--out ...]`
- `gog drive mkdir <name> [--parent <folderId>]`
- `gog drive copy <fileId> <name>`
- `gog drive move <fileId> --parent <folderId>`
- `gog drive rename <fileId> <newName>`
- `gog drive delete <fileId> [--permanent]`

## Sharing and permissions
- `gog drive share <fileId> --email user@acme.com --role reader|commenter|writer`
- `gog drive permissions <fileId>`
- `gog drive unshare <fileId> <permissionId>`

## Comments
- `gog drive comments list <fileId>`
- `gog drive comments get <fileId> <commentId>`
- `gog drive comments create <fileId> --text "..."`
- `gog drive comments update <fileId> <commentId> --text "..."`
- `gog drive comments reply <fileId> <commentId> --text "..."`
- `gog drive comments delete <fileId> <commentId>`

## Examples
```bash
# Locate all quarterly reports
gog drive search 'name contains "Q4" and mimeType != "application/vnd.google-apps.folder"' --read-only

# Preview new share permission
gog drive share <fileId> --email analyst@acme.com --role reader --dry-run

# Safe delete preview
gog drive delete <fileId> --dry-run
```
