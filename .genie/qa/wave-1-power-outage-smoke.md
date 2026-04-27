# Wave 1 Consolidated Smoke — power-outage recovery rehearsal

## Purpose

Validates all three Wave 1 master-aware-spawn surfaces work together against an isolated PG database. Models the wish's QA Criterion #2 ('end-to-end recovery') without touching live infrastructure.

| Surface | Group | What this smoke proves |
|---------|-------|------------------------|
| `resolveResumeSessionId(null, …, recipientId)` falls back to `dir:<recipientId>` chokepoint | 1 | Master agents post-outage are spawned with `--resume <existing-uuid>`, not `--session-id <new>`. Ephemerals still get fresh UUIDs (no false-positive resume). |
| `directory.rm(name)` refuses on `kind='permanent' AND repo_path != ''`; emits `directory.rm.refused` audit event; `--explicit-permanent` bypasses | 3 | Master agents' rows survive reconciler races. The audit-event landing fix (commit `e18aa20e`) keeps the observability contract intact. |
| `recoverSurgery(agentId)` flips `auto_resume`, terminates stale `spawning` executors with `close_reason='recovery_anchor'`, and surfaces the canonical session UUID | 2 | Operator-driven recovery is one shot, idempotent on re-run. |
| End-to-end rehearsal: seed master → simulate restart → surgery → spawn-path picks up UUID | 1+2 | The full chain assembles without manual intervention beyond `genie agent recover`. |

## Prerequisites

* `bun` available on PATH.
* The repo's pgserve test template is built (the preload `src/lib/test-setup.ts` does this on first `bun test` run; subsequent runs reuse it).
* Worktree built: `bun run build` is **not** required — the test imports from source.

## Run

```bash
cd /home/genie/.genie/worktrees/master-aware-spawn   # or wherever the worktree lives
bash .genie/qa/wave-1-power-outage-smoke.sh
```

The launcher invokes `bun test .genie/qa/wave-1-power-outage-smoke.test.ts` and surfaces the verdict at the tail of stdout. Per-step evidence lands at `/tmp/genie-recover/wave-1-consolidated-smoke-evidence.json` whether the run passes or fails (the test writes it from `afterAll`).

## Exit codes

* `0` — every assertion passed. Verdict in evidence file: `GREEN`.
* non-zero — at least one assertion failed. Verdict: `RED`. Inspect the rows[] array in the evidence file for the first `pass: false` entry.

## Evidence schema

```jsonc
{
  "when": "<ISO 8601>",
  "suite": "wave-1-consolidated-smoke",
  "worktree": "<absolute path>",
  "total": <int>,           // total assertions recorded
  "passed": <int>,
  "failed": <int>,
  "verdict": "GREEN" | "RED",
  "rows": [
    {
      "step": "group1.master_with_uuid_returns_session",
      "group": 1,
      "pass": true,
      "detail": { "expected": "...", "got": "..." }
    },
    // …
  ]
}
```

Rows are appended in execution order. The `step` prefix names the wave-1 group (`group1.*`, `group2.*`, `group3.*`, `rehearsal.*`).

## When the qa agent should run this

1. **Pre-merge** — as a final smoke before flipping the PR to mergeable. Twin (genie@genie) runs the live destructive equivalent only if explicitly authorized; this scripted smoke is the safe substitute.
2. **Post-merge on dev** — wish QA Criterion #2 ('end-to-end recovery: simulate power outage … confirm master agents auto-recover'). Run inside a clean container that mirrors production runtime.
3. **CI on every Wave 2/3 PR touching `protocol-router.ts`, `agent-directory.ts`, or `term-commands/agents.ts`** — guards against regressions in the chokepoint, guardrail, or recover-verb call sites.

## What this smoke deliberately does NOT cover

* Real claude process spawn (the test asserts the spawn-path **decision**, not the spawned process behavior). End-to-end pane lifecycle is owned by `src/__tests__/resume.test.ts` and integration runs.
* True pgserve process kill + restart. The test simulates a 'cold start' via `resetConnection()`, exercising the codepath that re-binds the pool. Genuine SIGKILL+restart is out of scope (would require process-supervisor harness).
* Group 14 bare-name shadow cleanup (Wave 2). When a bare-name `<name>` row co-exists with a `dir:<name>` row, `registry.get(<name>)` returns the bare row → worker non-null → Group 1's fallback does not fire. Captured in `/tmp/genie-recover/group-1-shadow-analysis.json`. Add a smoke case here once Group 14 lands.

## Maintenance

If a Wave 2 or Wave 3 group changes the signature of `resolveResumeSessionId`, `directory.rm`, or `recoverSurgery`, update the imports/calls in `wave-1-power-outage-smoke.test.ts` and re-run. Evidence schema is stable; verdict logic (`every(e => e.pass)`) auto-adapts to new rows.
