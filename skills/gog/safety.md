# gog safety model

Use this file for guardrails before running any command.

## Core safety flags

### `--read-only`
- Hides write commands and requests read-only OAuth scopes.
- Use for exploration, listing, search, metadata, status.
- Example:
  - `gog drive ls --read-only`
  - `gog gmail search 'from:billing newer_than:30d' --read-only`

### `--dry-run` / `-n`
- Simulates writes; prints intended actions without changing data.
- Required first pass for writes unless user explicitly says to execute immediately.
- Example:
  - `gog gmail send --to user@acme.com --subject "Hello" --body "Test" --dry-run`
  - `gog drive delete <fileId> --dry-run`

### `--command-tier core|extended|complete`
- Restricts visible command surface.
- Use `core` for least privilege in routine automation.
- Example:
  - `gog --command-tier core drive ls --read-only`

### `--enable-commands`
- Allowlist top-level commands only.
- Example:
  - `gog --enable-commands drive,docs,sheets drive ls --read-only`

### `--force` / `-y`
- Skips destructive confirmations.
- Use only after explicit user confirmation.
- Example:
  - `gog drive delete <fileId> --force`

### `--no-input`
- Never prompt; fail fast in CI/automation.
- Pair with explicit flags and deterministic payloads.
- Example:
  - `gog --no-input tasks add <tasklistId> --title "Ship release" --due 2026-02-20`

## Safe execution pattern
1. Read/list phase with `--read-only`.
2. Preview write with `--dry-run`.
3. Confirm intent (target, scope, side effects).
4. Execute actual write.
5. Re-read state to verify result.

## High-risk operations checklist
- Bulk Gmail deletes/modifies (`gmail batch`, thread/message label rewrites)
- Drive permanent deletes / permission changes
- Classroom roster/submission mutations
- Calendar invite responses on behalf of user
- Any operation using `--force`

Always capture identifiers first (messageId, threadId, fileId, eventId) before mutations.
