# sync.md

## ⚠️ WARNING — known sync implementation bugs (read first)

Current `gog sync` has known issues. Treat it as experimental and do not trust for critical bidirectional sync without manual verification:

1. **Folder collision risk**: duplicate/ambiguous folder naming can map incorrectly and produce wrong remote/local pairing.
2. **Nested subfolder miss**: deep subfolders may be skipped during traversal, causing partial sync.
3. **Conflict resolver not wired**: conflicting edits are not consistently resolved/merged; overwrite behavior may be unsafe.

**Operational guidance:** always test on disposable folders first, run backups before sync, and validate post-sync checksums/file counts.

## Commands
- `gog sync init --drive-folder <folderId|path> <local-path>`
- `gog sync list`
- `gog sync status`
- `gog sync remove <local-path>`
- `gog sync start <local-path>` *(placeholder daemon start)*
- `gog sync stop` *(placeholder daemon stop)*

## Safe pattern
```bash
# 1) initialize mapping (preview first)
gog sync init --drive-folder <driveFolderId> ./local-folder --dry-run

# 2) apply mapping
gog sync init --drive-folder <driveFolderId> ./local-folder

# 3) inspect status repeatedly
gog sync status --read-only
```
