# calendar.md

Google Calendar commands, including focus-time, OOO, and working-location.

## Core reads
- `gog calendar calendars`
- `gog calendar events [calendarId] --from ... --to ...`
- `gog calendar event <calendarId> <eventId>`
- `gog calendar search <query>`
- `gog calendar freebusy <calendarIds>`
- `gog calendar acl <calendarId>`
- `gog calendar colors`
- `gog calendar conflicts --from ... --to ...`
- `gog calendar users` (Workspace)
- `gog calendar team <group-email>`
- `gog calendar time`

## Event CRUD
- `gog calendar create <calendarId> --summary ... --from ... --to ...`
- `gog calendar update <calendarId> <eventId> ...`
- `gog calendar delete <calendarId> <eventId>`
- `gog calendar respond <calendarId> <eventId> --response accepted|declined|tentative`
- `gog calendar propose-time <calendarId> <eventId>`

## Specialized event types
- `gog calendar focus-time --from ... --to ... [calendarId]`
- `gog calendar out-of-office --from ... --to ... [calendarId]`
- `gog calendar working-location --from ... --to ... --type home|office|custom [calendarId]`

## Examples
```bash
gog calendar events primary --from 2026-02-18T09:00:00-03:00 --to 2026-02-18T18:00:00-03:00 --read-only

gog calendar focus-time --from 2026-02-19T13:00:00-03:00 --to 2026-02-19T15:00:00-03:00 primary --dry-run

gog calendar out-of-office --from 2026-03-01T00:00:00-03:00 --to 2026-03-05T23:59:59-03:00 primary --dry-run
```
