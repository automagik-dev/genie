---
name: gog
summary: Router for Google Workspace automation via gog-cli. Load only the relevant service file.
---

# gog skill router

Backup copy: `.genie/skills/gog/` in genie-eva repo.

Use `gog` for Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, Classroom, Tasks, Contacts, People, Keep, Groups, Forms, App Script, and auth/sync setup.

## Safety defaults (always)
- Read/list/query flows: add `--read-only`.
- Any write/send/create/update/delete flow: start with `--dry-run`, then rerun without it after user confirms.
- Prefer `--no-input` in automation/CI.
- For dangerous operations, require explicit confirmation unless user provided it; `--force` only after confirmation.
- Use `--command-tier core|extended|complete` and `--enable-commands` to constrain capability.

Load `safety.md` before risky actions. Load `setup.md` for auth/account setup.

## Keyword → file routing

| User intent / keywords | Load file |
|---|---|
| safety, dry-run, read-only, force, tiers, allowlist | `safety.md` |
| login, oauth, token, account, alias, service account | `setup.md` |
| email, gmail, send, labels, filters, drafts, tracking | `gmail.md` |
| calendar, events, freebusy, focus time, ooo, working location | `calendar.md` |
| drive, files, folders, upload, download, share, permissions | `drive.md` |
| sync, mirror, local folder sync daemon | `sync.md` |
| sheets, spreadsheet, range, tab, batch-update | `sheets.md` |
| docs, document, find-replace, header, footer, template | `docs.md` |
| slides, presentation, markdown deck, speaker notes | `slides.md` |
| chat, spaces, threads, dm, webhook-style message sends | `chat.md` |
| classroom, courses, students, teachers, coursework, submissions | `classroom.md` |
| tasks, task list, due date, complete/undo | `tasks.md` |
| contacts, address book, batch contacts, directory | `contacts.md` |
| people, profile, me, directory relations | `people.md` |
| keep, notes, keep attachments (workspace only) | `keep.md` |
| groups, group members, workspace groups | `groups.md` |
| forms, form responses, publish | `forms.md` |
| appscript, apps script, script run/deploy | `appscript.md` |

## Fast command patterns
- Search/list: `gog <service> ... --read-only --json`
- Preview write: `gog <service> ... --dry-run`
- Execute write after confirmation: `gog <service> ...`
