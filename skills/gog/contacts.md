# contacts.md

Google Contacts: personal contacts, other contacts, directory search, and batch operations.

## Contact CRUD
- `gog contacts list`
- `gog contacts search <query...>`
- `gog contacts get <resourceName>`
- `gog contacts create ...`
- `gog contacts update <resourceName> ...`
- `gog contacts delete <resourceName>`

## Batch operations
- `gog contacts batch create --in contacts.json`
- `gog contacts batch delete --ids people/c123,people/c456`

## Directory + other contacts
- `gog contacts directory list`
- `gog contacts directory search <query>`
- `gog contacts other list`
- `gog contacts other search <query>`
- `gog contacts other delete <resourceName>`

## Example
```bash
gog contacts search 'ana silva' --read-only
gog contacts create --given-name Ana --family-name Silva --email ana@acme.com --dry-run
```
