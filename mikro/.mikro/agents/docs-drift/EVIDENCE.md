# EVIDENCE — why `docs-drift` exists

Created **2026-08-16**, active from birth by explicit user directive (the
colony `/goal`). Not scanner-selected: doc-vs-source auditing has no family
in the transcript scanner's taxonomy — the reads it replaces would land in
`repo-exploration`, which the 72h scan of 2026-08-17T00:17Z measured at
~1,045,312 estimated tokens (58.2% of returned context) without being able
to attribute any slice of it to documentation review specifically.

## Why the shape is defensible anyway

- `docs/` in this repo is 11 files up to 61 KB (`docs/parity-explore.md`),
  dense with `path:line` claims — the exact reference style that goes stale
  silently. `docs/agent-yaml-schema.md` alone cites `src/mcp/agents.ts` and
  `src/mcp/server.ts` line numbers that nothing re-checks today.
- Bulk in, summary out: a run reads one large doc plus the source files it
  cites; what returns is a findings list.
- Self-contained: "audit this one file" is one prompt, no follow-up.
- Rotation state is the colony's own committed reports — no new machinery,
  just the `Target:` first line its contract already requires.

## What is not claimed

- **No quality evidence.** Unrun at creation; the first cycle is the first
  data point.
- **No savings claim.** The scan figure above describes a family this agent
  is not equal to; it is context, not justification arithmetic.
- **Coverage is partial by design.** One file per cycle, and within a large
  file the report must state what it did not check.

## Withdraw

```bash
mv .mikro/agents/docs-drift .mikro/agents/docs-drift.proposed
```
