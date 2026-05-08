# Operator Notes — observability-signal-normalization

Authored by `genie` (orchestrator), 2026-05-02. Read this BEFORE or alongside `WISH.md`.

## Context

You are wish 2/5 of the PR-1607 observability roadmap. Wish 1 (`fix-agent-session-linkage`) merged at PR #1611 (`59639b17`). Your `depends-on: fix-agent-session-linkage` is cleared. PR #1614 (TUI auto-disable on pipe) also merged — your CLI subcommand pipe-mode now auto-disables TUI without `--no-tui`.

## Live evidence justifying your wish (right now, this server)

```
$ genie --no-tui db query "select count(*) from audit_events where event_type='resume.found' and created_at > now() - interval '1 hour'"
→ 22,036  (≈ 528k/day projected — exactly what your Group 1 stops)
```

The bleeding is happening live during your dispatch. Group 1's pure-read-paths fix is the highest-leverage delivery.

## Operator orchestration intent

1. **Parallelize within the wish where deps allow.** The wish doc says "Wave 1 (sequential) Group 1-4" but the actual deps are:
   - Group 1: `depends-on: none`
   - Group 2: `depends-on: Group 1`
   - Group 3: `depends-on: Group 1` (NOT Group 2)
   - Group 4: `depends-on: Group 2, Group 3`

   Therefore: Group 1 first, then **Groups 2 and 3 in parallel** (separate engineer dispatches), Group 4 last.

2. **`ssh felipe` is dropped as a hard gate for Group 4.** The wish's validation block contains:
   ```bash
   ssh felipe '... genie --no-tui db query "select sum(cost_usd) from v_claude_usage_events"'
   ```
   That's an example invocation against a richer dataset, NOT a correctness gate. Group 4's acceptance criteria are achievable on local DB:
   - "`resume.found` does not increase from read-only command loops" — verifiable locally
   - "Unknown hook rate drops sharply for new rows" — verifiable locally
   - "Cost totals are non-zero on the remote DB" — restate as local-DB equivalent: cost totals roll up correctly from OTel `claude_code.cost.usage` rows with `details.value`

   Plan local-only Group 4. If `ssh felipe` access lands during execution, fold remote transcript as bonus appendix — not blocking.

3. **Full team flavor.** Spawn engineer + reviewer + qa as needed. Engineer for groups, reviewer at end-of-pipeline + after each merge-worthy boundary, qa for the final validation gate.

4. **No PR until all groups land cleanly.** Stage commits on your branch (`observability-signal-normalization`), run validation at each group boundary. Push + open PR at the end. Append `.genie/wishes/observability-signal-normalization/REPORT.md` with Baseline → Group 1 → Group 2 → Group 3 → Group 4 → QA + Reviewer verdicts (mirror wish 1's REPORT.md shape on dev).

## Sibling parallel team

`complexity-budget-simplification` (wish 5/5) is being dispatched at the same time as a separate autonomous team. Independent of you — different files, different concerns. No coordination needed unless you both touch `biome.json` or shared lint scripts (you shouldn't — they will).

## Hand-off contract back to `genie` orchestrator

When you reach a decision point that needs operator input (e.g. surprise architectural choice, blocker beyond your scope, ssh felipe access lands and you want guidance on Group 4 remote transcript), `genie send --to genie --team genie --bridge` me with a one-paragraph status.

Otherwise, work autonomously through to PR-ready and ping with: `wish 2 PR #N ready for review`.

## Reference: wish 1 quality bar

PR #1611 (just merged) shows the shape:
- Baseline section in REPORT.md with concrete `genie db query` evidence
- Group sections with file:line code-change rationale + acceptance bullets + validation transcripts
- QA + Reviewer verdict sections at end
- Tightening commit if reviewer/qa surface a convergent finding

Match or exceed that bar.

Go.
