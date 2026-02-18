# people.md

Google People API (profile + Workspace directory lookups).

## Commands
- `gog people me`
- `gog people get <userId>`
- `gog people search <query...>`
- `gog people relations [userId]`

## Notes
- `people search` is best for org directory discovery.
- Use `contacts` service for personal address-book CRUD.

## Example
```bash
gog people me --read-only
gog people search 'product manager sao paulo' --read-only
```
