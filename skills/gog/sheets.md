# sheets.md

Google Sheets: range CRUD, formatting, tabs, exports, and batch updates.

## CRUD on ranges
- `gog sheets get <spreadsheetId> <range>`
- `gog sheets update <spreadsheetId> <range> <values...>`
- `gog sheets append <spreadsheetId> <range> <values...>`
- `gog sheets clear <spreadsheetId> <range>`
- `gog sheets notes <spreadsheetId> <range>`

## Structure and metadata
- `gog sheets metadata <spreadsheetId>`
- `gog sheets add-tab <spreadsheetId> <tab-name>`
- `gog sheets format <spreadsheetId> <range> ...`

## File-level operations
- `gog sheets create <title>`
- `gog sheets copy <spreadsheetId> <title>`
- `gog sheets export <spreadsheetId> --format pdf|xlsx|csv`

## Batch ops
- `gog sheets batch-update <spreadsheetId> --requests @requests.json`

## Template creation pattern
- Keep a template sheet in Drive, then duplicate via:
  - `gog sheets copy <templateSpreadsheetId> "New Report - 2026-02"`

## Example
```bash
gog sheets update <sheetId> 'Summary!A1:C1' 'Week' 'Revenue' 'Delta' --dry-run
gog sheets batch-update <sheetId> --requests @batch.json --dry-run
```
