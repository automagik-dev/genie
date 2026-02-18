# gmail.md

Gmail commands (68 total in schema). Start reads with `--read-only`; start writes with `--dry-run`.

## Search and read
- `gog gmail search <query...>` — thread search
- `gog gmail messages search <query...>` — message search
- `gog gmail get <messageId> [--format full|metadata|raw]`
- `gog gmail thread get <threadId>`
- `gog gmail history [--start-history-id ...]`
- `gog gmail attachment <messageId> <attachmentId> --out file`
- `gog gmail thread attachments <threadId> [--out-dir ...]`
- `gog gmail url <threadId...>`

## Send and compose
- `gog gmail send --to ... --subject ... --body ...`
- `gog gmail send --cc ... --bcc ... --attachments file1,file2`
- `gog gmail send --thread-id <threadId>` (reply-style send)
- `gog gmail drafts create --to ... --subject ... --body ...`
- `gog gmail drafts list`
- `gog gmail drafts get <draftId>`
- `gog gmail drafts update <draftId> ...`
- `gog gmail drafts send <draftId>`
- `gog gmail drafts delete <draftId>`

## Labels and organization
- `gog gmail labels list`
- `gog gmail labels get <labelId>`
- `gog gmail labels create --name ...`
- `gog gmail labels delete <labelId>`
- `gog gmail labels modify <threadId...> --add-labels ... --remove-labels ...`
- `gog gmail thread modify <threadId> --add-labels ... --remove-labels ...`
- `gog gmail batch modify --ids id1,id2 --add-labels ...`
- `gog gmail batch delete --ids id1,id2`

## Filters / forwarding / delegates / send-as
- `gog gmail settings filters list|get|create|delete`
- `gog gmail settings forwarding list|get|create|delete`
- `gog gmail settings delegates list|get|add|remove`
- `gog gmail settings sendas list|get|create|update|delete|verify`
- `gog gmail settings autoforward get|update`
- `gog gmail settings vacation get|update`

## Watch + notifications
- `gog gmail settings watch start`
- `gog gmail settings watch status`
- `gog gmail settings watch renew`
- `gog gmail settings watch serve`
- `gog gmail settings watch stop`

## Tracking subcommands
- `gog gmail track setup`
- `gog gmail track status`
- `gog gmail track opens`

## High-frequency examples
```bash
# Search recent invoices
gog gmail search 'subject:(invoice OR receipt) newer_than:30d' --read-only

# Preview email send
gog gmail send --to ops@acme.com --subject "Daily report" --body "Attached" --attachments ./report.pdf --dry-run

# Create a label then apply to a thread
gog gmail labels create --name "Finance/Reviewed" --dry-run
gog gmail thread modify <threadId> --add-labels Label_123 --dry-run
```

## Command index (30+ notable)
search, messages search, get, thread get, history, attachment, thread attachments, url, send, drafts create/list/get/update/send/delete, labels list/get/create/delete/modify, thread modify, batch modify/delete, settings filters list/get/create/delete, settings forwarding list/get/create/delete, settings delegates list/get/add/remove, settings sendas list/get/create/update/delete/verify, settings autoforward get/update, settings vacation get/update, watch start/status/renew/serve/stop, track setup/status/opens.
