# slides.md

Google Slides: create/copy/export decks, slide CRUD, notes, and markdown-based generation.

## Deck operations
- `gog slides create <title>`
- `gog slides create-from-markdown <title> --in slides.md`
- `gog slides info <presentationId>`
- `gog slides copy <presentationId> <title>`
- `gog slides export <presentationId> --format pdf|pptx`

## Slide-level CRUD
- `gog slides list-slides <presentationId>`
- `gog slides read-slide <presentationId> <slideId>`
- `gog slides add-slide <presentationId> <image> [--notes ...]`
- `gog slides replace-slide <presentationId> <slideId> <image> [--notes ...]`
- `gog slides update-notes <presentationId> <slideId> --notes "..."`
- `gog slides delete-slide <presentationId> <slideId>`

## Batch operations
- Treat repeated slide edits as scripted loops over `list-slides` IDs.

## Template creation pattern
- Maintain a template deck and clone it with `gog slides copy ...`, then mutate target slides.

## Example
```bash
gog slides create-from-markdown 'QBR 2026-02' --in ./qbr.md --dry-run
gog slides update-notes <presentationId> <slideId> --notes 'Talk track v2' --dry-run
```
