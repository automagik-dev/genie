# Live evidence — `jar: index-lane drift` (Group C acceptance)

**Date:** 2026-07-21 · **Runner:** orchestrator (team-lead) · **Build:** local `bun run src/genie.ts`
at Group C commit `afc29ea1` (worktree), against the live shared `.genie/genie.db` after the
orchestrator-executed lane seeding (boards.lanes set to the 6 lifecycle lanes; 13 cards moved via
the real `task move` CLI at Group A commit `9386accc`, 13 `kind='move'` events recorded).

## Result

```
"name":   "jar: index-lane drift"
"status": "pass"          ← warning-level check; never flips doctor ok:false
"detail": "31 INDEX entries: 10 ok, 0 drift, 21 unlinked"
```

Ten entries resolve through the complete slug-join chain (INDEX entry → first
`brainstorms/|wishes/` link → slug → roadmap card `tasks.wish` → lane → section↔lane mapping):

| INDEX section | Slug | Lane | State |
|---|---|---|---|
| Raw | control-plane-contract | Idea | ok |
| Raw | skill-absorbs | Idea | ok |
| Raw | always-on-genie | Idea | ok |
| Raw | genie-spend | Idea | ok |
| Raw | dream-replatform | Idea | ok |
| Simmering | intent-to-wish-compiler | Brainstorm | ok |
| Simmering | brainstorm-domain-map | Brainstorm | ok |
| Simmering | cross-agent-delegate | Brainstorm | ok |
| Poured | stable-release-security-gate | Work | ok |
| Poured | pr-2545-ultra-release-gate | Review | ok |

Zero drift. The 21 `unlinked` are entries without roadmap cards (done/historical wishes) — reported
as `unlinked`, never drift, per design. Acceptance requirement was ≥1 live resolving entry;
observed: 10.

Note: run executed from the Group C worktree whose INDEX.md predates the `boards-first-class`
Poured entry; after merge to `wish/boards-first-class` that entry (lane Work) also resolves.
