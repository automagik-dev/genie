# Dream Report Template

This template is used in Phase 4 of the `/dream` skill to produce the wake-up report artifact at `.genie/DREAM-REPORT.md`.

## Format

```markdown
# Dream Report — <date>

## Per-Wish Status

| merge_order | slug | PR link | CI | Review | Merged | QA |
|-------------|------|---------|----|--------|--------|----|
| 1 | slug-1 | #123 | green | SHIP | yes | verified |
| 2 | slug-2 | #124 | green | SHIP | yes | 2/3 criteria |

## Blocked Wishes
- `<slug>`: blocking reason.

## QA Findings
- `<slug>`: criteria X failed — traced to <root cause>, fix PR #125.

## Follow-ups
- Action items requiring human intervention.
```

## Notes

- Always write DREAM-REPORT.md, even if all wishes are blocked.
- The report is the final artifact of the dream session — it should give the human a complete picture of what happened overnight.
