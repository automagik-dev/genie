# Design preflight

Run this before creating or changing a wish that links a brainstorm design. It proves the design was reviewed independently and that the reviewed bytes are the bytes on disk today.

```bash
node "<wish-skill-dir>/references/design-review-evidence.mjs" verify ".genie/brainstorms/<slug>/DESIGN.md"
```

Three outcomes, and only three:

- Existing design, verification passes: link `[DESIGN.md](../../brainstorms/<slug>/DESIGN.md)` in the Design row.
- Existing design, verification fails: stop and return to independent design review; the wish card states what may not be done about a failure.
- No design: use the literal `_No brainstorm — direct wish_` in the Design row, with no broken link. A direct wish is valid when a brainstorm would add nothing.
