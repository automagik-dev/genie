# Cognitive-Complexity Hotspots (score > 25)

These are the seven product-code functions that still warn under the new
`maxAllowedComplexity: 25` budget set by this wish. Each row gets one
explicit verdict so future contributors do not need to re-derive whether
the score is "real architecture debt" or "deliberately linear".

| # | Score | Function | Location | Verdict |
|---|------:|----------|----------|---------|
| 1 | 42 | `dbMigrateV1Command` | `src/term-commands/db-migrate-v1.ts:105` | leave linear for now |
| 2 | 37 | `trustAction` | `src/term-commands/hook/trust.ts:69` | simple local refactor candidate |
| 3 | 36 | `dbLsCommand` | `src/term-commands/db-ls.ts:48` | simple local refactor candidate |
| 4 | 31 | `_buildConnection` | `src/lib/db.ts:1554` | needs separate architecture wish |
| 5 | 29 | `checkPrerequisites` | `src/genie-commands/doctor.ts:76` | simple local refactor candidate |
| 6 | 29 | `reapStaleGenieProcesses` | `src/genie-commands/doctor.ts:1387` | simple local refactor candidate |
| 7 | 26 | `ensureSession` | `src/lib/session-capture.ts:333` | leave linear for now |

## Rationale

### 1. `dbMigrateV1Command` — leave linear for now
One-shot v1→v2 migration entrypoint. The branching is per migration sub-step
(port discovery, schema copy, row copy, validation, snapshotting, error rollback).
The whole function is doomed code that will be deleted once v1 is removed in
the field; carving helpers out adds ceremony for code that should not survive
a release cycle. Suppression-with-rationale, not refactor.

### 2. `trustAction` — simple local refactor candidate
`genie hook trust` dispatches three independent verbs (list / add / remove /
clear) that share only the trust file path. A small local refactor that splits
each verb into its own private function would drop the score and read more
cleanly. Worth a focused PR; out of scope for a policy wish.

### 3. `dbLsCommand` — simple local refactor candidate
Presentation logic for `genie db ls` (databases, tables, connections, JSON vs
human output). Each presentation mode is independent. A per-mode helper split
would lower the score without losing the linear narrative.

### 4. `_buildConnection` — needs separate architecture wish
Connection bootstrap: Unix socket vs TCP, daemon vs direct postmaster, retry,
pooling, and observability hooks all live in one body for performance reasons
(see "Mac CPU hook-dispatch fix A" history). Refactoring without a deliberate
contract for `db_authority` semantics is risky. File a separate wish if the
score is to be reduced; do not opportunistically inline or extract.

### 5. `checkPrerequisites` — simple local refactor candidate
`genie doctor` walks a fixed list of binaries (`tmux`, `jq`, `bun`, Claude Code,
…). Each block is independent and shaped identically. A list-driven loop with
per-tool metadata would collapse the score and the line count. Local refactor
candidate.

### 6. `reapStaleGenieProcesses` — simple local refactor candidate
Procfs-walking reaper for the update flow. The branching is mostly platform
guards plus per-process classification. Splitting platform logic into a small
helper would drop the score; local refactor candidate.

### 7. `ensureSession` — leave linear for now
Session-ingest fast path. Score is exactly one above the threshold and the
function is the load-bearing core of session capture. The branching reads as
a state machine over (worker hit/miss, parent inheritance, offset, status).
Refactor would obscure rather than clarify. Suppression-with-rationale if
ever needed; do not refactor speculatively.

## Follow-up

This wish does not perform any of the refactors above. The verdicts exist so
that future contributors picking up `genie doctor` polish, `genie db ls`
ergonomics, or a `db_authority` rework can decide quickly whether to tackle
the score along with their primary change or leave it for an explicit wish.
