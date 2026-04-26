# Council Report — Invincible Genie Strategy

**Date:** 2026-04-25
**Topic:** Best strategy to make `genie serve stop && genie serve start` a no-op for in-flight work, eliminate manual recovery, and unify the 28-command observability surface.
**Team:** `council-1777155366` (model: opus on all four members)

---

## Executive Summary

The council reached **strong convergence** on a six-group wish that closes the gap between "the state machine has the data" and "the system uses the data." The disagreements that started the deliberation (boot-pass scope, `agents.kind` column, wish-scope size) **dissolved by Round 2** through three architectural insights:

1. **Rehydrate ≠ Re-invoke** (Operator R2). Boot-pass loads identity and registers in `genie ls` for ALL agents where `assignments.outcome IS NULL`. Re-invocation (sending the resume message, consuming API tokens) can be lazy for task-bound, eager for permanent. This dissolves Q4 — Architect changed position to support uniform boot-pass.

2. **One canonical reader, many displays** (Architect / Measurer convergent). `shouldResume(agentId)` is the only function that decides resume; `genie status` is the only display the user reads; derived-signal rule engine is the only place raw audit events become alerts. Eight current consumer sites collapse into one chokepoint.

3. **Deletion blade and emission discipline are the same rule** (Simplifier / Measurer convergent). "No new metric without a defined consumer + steady-state + page condition" applied to *commands* gives "no new command without it deleting redundant ones." 28→8 surface collapse + 12→6 wish-group collapse are not opposing instincts — they are the same discipline.

**The 3am runbook is the primary SLI** (Operator, endorsed by all): `genie serve start && genie status`. Green → sleep. Red → actionable verbs. No SQL forensics. No mental gymnastics.

---

## Council Composition

| Member | Lens | Round 1 anchor |
|--------|------|----------------|
| **architect** | systems thinking, FK invariants, single-reader chokepoint | Data model is right; consumers are wrong; eight sites reinvent the resume decision |
| **operator** | on-call sanity, 3am runbook, install/upgrade story | Telemetry without alerting is theater; runbook IS acceptance criterion |
| **measurer** | observability, methodology, close-the-loop | Emission without observation is the disease; methodology rule is the cure |
| **simplifier** | complexity reduction, deletion-as-feature | 29th command must arrive with 20 deletions; 12 → 5 groups |

---

## Situation Analysis

### Architect — Round 1
The data model (`agents` × `executors` × `assignments`) is structurally sound after PR #1397. The defect is consumer-side: eight sites (scheduler boot, two `genie spawn`, `genie --session`, four `session.ts`) each reinvent the resume decision with a slightly different JOIN. **Until `shouldResume(agentId)` is the canonical chokepoint and every consumer routes through it, we are one new code path away from the next 2-hour SQL forensics session.** Recommended Q1=YES (ENUM kind), Q2=assignment-level outcome, Q4=hybrid boot-pass, Q6=enforce. Locked in scale concern: backfill drift (30/200, 15%) must converge to ~100% so the JSONL fallback returns to the rare-recovery role.

### Architect — Round 2
**Position changed on Q4** — Operator's 3am-runbook test demolishes hybrid. "If `genie serve start` does not converge the world, we replaced manual SQL forensics with memorize-which-subset-is-permanent. Same anti-pattern, fancier hat." Boot-pass everything where `assignments.outcome IS NULL AND auto_resume=true`. **Refined Q1**: `agents.kind` as GENERATED ALWAYS AS column (computed from `id LIKE 'dir:%' OR reports_to IS NULL`). Explicit AND impossible to drift — same chokepoint discipline applied at schema layer. **Endorsed Measurer's methodology rule as universal**: "No new column, event, or JOIN ships without a named canonical reader." That rule survives this wish and prevents the next one. **On wish scope**: Operator and Simplifier are not in tension — auto-fix on `serve start` is one PR's subtraction (delete corpse counter, hide partition rotation, fold `doctor --state` into `status`) AND the runbook win.

### Operator — Round 1
"The audit log is screaming. Nobody is listening." Single most damning line: `genie metrics agents` returns 65 dead, 0 alive, indexed by `process_id` — corpse counter that lies harder every restart. Q4 hybrid is **wrong from a 3am lens** — boot-pass everything, period. **The install/upgrade story is the silent killer**: today's user gets the corpse counter on day one (no watchdog, no partition rotation, no backfill convergence). `genie serve start` must refuse to start dirty OR auto-fix. **The runbook IS the acceptance criterion** — at 3am, `genie serve start && genie status` is the entire script. Q1=YES (operationally readable), Q6=YES (fail loud).

### Operator — Round 2
**Strongest point: Measurer's discipline rule** — that single rule prevents the next graveyard. Apply retroactively: the corpse counter fails the rule on day one. **Refinement on Q4**: Architect named the real concern (re-invoking task-bound mid-edit on changed files) but it is one decision masquerading as two. **Decoupling rehydrate from re-invoke dissolves the disagreement** — boot-pass always rehydrates; re-invocation is eager for permanent, lazy for task-bound, surfaced in `genie status` for explicit user verb. **Position changed on Q1**: ship as GENERATED column (Architect's mechanism, Simplifier's drift concern satisfied). **Held on Q6** — convention-as-invariant is exactly what produced 2h of forensics.

### Measurer — Round 1
The diagnosis is **emission without observation**. `session.reconciled` event captured the corruption fingerprint 3 hours before Felipe noticed. Zero subscribers. Worse: four watcher metrics never seen — **the measurement infrastructure itself is dark, and we are blind to whether we are blind.** Three tiers: (1) page-worthy SLIs — recovery_anchor_at_risk, partition_health=fail, dead_pane_zombie rate over baseline; (2) status-surface — backfill drift, watchdog uninstalled, watcher silence; (3) on-demand diagnostic. **Methodology rule (the foundation)**: no new metric without defined consumer + steady-state + action threshold. **Three primitives** to close the loop: derived-signal rule engine (subscribes to audit stream, emits second-order events), unified `genie status` surface, liveness on the measurement layer itself.

### Measurer — Round 2
**Strongest point: Simplifier's "every line is a liability."** That is my methodology rule applied at the command level. Same disease, same cure. **Position update**: deletions are a precondition; the alerting tier and `genie status` MUST ship with the deletion of corpse counter, `--v2` fork, `doctor --state` folded in. **Disagreement with Simplifier**: Group 11 (recovery-anchor monitor) is NOT one-line fold into reconciler — that IS what we have today, the reconciler is the emitter, the gap is a *subscriber* component. **Q1=ENUM (sided with Architect)**: explicit invariants are alertable, inference is invisible. **Q4=uniform (sided with Operator)**: hybrid means convergence is unmeasurable until human action. **Corrected wish scope: 6 groups, not 12, not 5.** The deletion blade and alerting tier are the same discipline applied to different surfaces.

### Simplifier — Round 1
The 29th command must arrive with 20 deletions in the same PR. `events list` and `events list --v2` point at *different tables with different schemas* — kill one. `events admin` is a third event model. `metrics agents` is a corpse counter — **delete, don't rewrite (Group 8)**. Drop these wish groups outright: Group 1 (kind column — inference works), Group 5 (`genie agent pause/unpause` — `auto_resume` already exists), Group 6 `doctor --state` (collapse into `status`), Group 8, 10, 11, 12. **From 12 → 5 groups: `shouldResume()`, scheduler boot, 7 call sites, `genie status`, one short doc.** `genie status` itself is reducible — ship 1 default section, `--health` flag adds the rest. **The deletion north-star: 28 → 8 commands.**

### Simplifier — Round 2
**Strongest point: Operator's 3am runbook test.** Cleanest acceptance criterion in the thread. **Position changed on Q4**: now back Operator over Architect — boot-pass everything, no hybrid; Group 9 (backfill convergence) makes the cost a non-issue. **Refined Q1, not flipped**: ergonomic claim conceded (explicit > prefix-match), mechanism rejected (stored ENUM is a second source of truth) — ship as **generated column / typed view / SQL function** so `assignments` row presence stays the single source of truth. **Full agreement with Measurer's rule** — that IS the deletion blade as policy. **Endorse one rule engine**, not two: extend `shouldResume()`-shaped chokepoint to emit observability derived signals; `genie status` is the one consumer. **Operator's install/upgrade is preconditions on `genie serve start`, not a 13th group.** Position holds: **wish stays small** — ship deletions WITH `status` in one PR.

---

## Key Findings

### F1 — The data model is right; the consumers are wrong
PR #1397 closed the four FK-invariant violations. The remaining defect is that no canonical reader exists. Eight consumer sites reinvent the resume decision with subtle JOIN differences. **`shouldResume(agentId)` as the single chokepoint** is the structural cure, endorsed by all four members. (Architect R1, Operator R1, Measurer R1, Simplifier R2)

### F2 — Audit log captured the bug; nobody listened
The `session.reconciled` event 3h before Felipe noticed is the smoking gun. Telemetry exists; observation does not. **A derived-signal rule engine** that subscribes to the audit stream and emits second-order events (`observability.recovery_anchor_at_risk`, `agents.zombie_storm`) is the read-side chokepoint, structurally parallel to `shouldResume()` on the write side. (Measurer R1, all R2)

### F3 — Rehydrate ≠ Re-invoke
The Q4 hybrid-vs-uniform disagreement collapses once the council named two distinct operations. Boot-pass ALWAYS rehydrates (load identity, locate recovery anchor, register in `ls`/`status`). Re-invocation (sending the resume message to Claude, consuming API tokens) is eager for permanent, lazy for task-bound, surfaced as actionable verb in `genie status` for the user. **Three-line distinction; entire disagreement dissolved.** (Operator R2, endorsed by Architect R2 and Simplifier R2)

### F4 — Methodology rule = deletion blade
Measurer's "no new metric without consumer + steady-state + action threshold" applied at the *command* level becomes Simplifier's "every new command must delete redundant ones." Same discipline, different surface. **Apply universally going forward**: every new column, event, JOIN, or command answers "what does green look like, and who pages on red." If we cannot answer both, we are adding debt, not signal. (Measurer R1, all R2)

### F5 — Install/upgrade story is the silent killer
A new user gets Felipe's incident on day one: no watchdog, no partition rotation, no backfill convergence, no auto-resume on permanent. Auto-fix on `genie serve start` (or refuse to start dirty) is **part of the boot-pass group, not a separate wish**. Acceptance criteria stay non-negotiable: today's partition exists or rotates now, watchdog daemon running or auto-installs, backfill drift < 5%, no orphaned `dead_pane_zombie` rows surfacing without explicit user resolution. (Operator R1, Simplifier R2 framing)

### F6 — `agents.kind` as GENERATED column (final form)
Concrete schema decision after R2 convergence:
```sql
ALTER TABLE agents ADD COLUMN kind TEXT
  GENERATED ALWAYS AS (
    CASE WHEN id LIKE 'dir:%' OR reports_to IS NULL
         THEN 'permanent' ELSE 'task' END
  ) STORED;
```
If Postgres version blocks generated columns, fall back to ENUM with CHECK constraint and a single population trigger — **the inference rule is enforced ONCE, not redistributed across consumers**. (Architect R2, Simplifier R2 endorsing mechanism)

---

## Recommendations

### P0 — `shouldResume()` chokepoint + uniform boot-pass
**File:** new `src/lib/should-resume.ts` exporting `shouldResume(agentId): { resume, reason, sessionId? }`.
**Migrate consumers:** scheduler-daemon `defaultListWorkers`, `genie spawn` (×2 sites in `agents.ts`), `genie --session` (`genie.ts:153`), four sites in `session.ts`.
**Boot-pass:** at `serve start`, run `shouldResume()` × every agent where `assignments.outcome IS NULL AND auto_resume=true`; rehydrate all (load identity, register in DB), eager re-invoke for permanent, lazy verb for task-bound.
**Rationale:** F1, F3. **Risk:** at 1000+ agents the rehydrate scan must be parallel; backfill convergence (P1) makes DB read authoritative so JSONL fallback is rare.

### P0 — Derived-signal rule engine + `genie status`
**Component:** subscriber to `genie_runtime_events` that translates raw events into derived signals — `session.reconciled` with non-null oldId → `observability.recovery_anchor_at_risk`; consecutive `resume.missing_session` → `resume.lost_anchor`; `dead_pane_zombie` rate over baseline → `agents.zombie_storm`; partition_health=fail → `observability.partition.missing`.
**Surface:** `genie status` aggregates derived signals + `shouldResume()` results + a small fixed health checklist into a single screen.
**Rationale:** F2, F4. **Risk:** rule-engine over-emission — gate by Measurer's rule (every derived signal has a defined consumer in `genie status`).

### P0 — `agents.kind` as GENERATED column
**Migration:** add the column per F6. Replace inference at consumer sites with `WHERE kind='permanent'`. Add `genie doctor --state` (a debug surface, not a separate command — wired through `genie status --debug`) that asserts `kind` agrees with structural inference.
**Rationale:** F6. **Risk:** Postgres version compatibility — fall back to ENUM + CHECK + trigger if needed.

### P0 — `genie serve start` opinionated preconditions
Auto-fix or refuse: today's partition exists, watchdog daemon running, backfill drift < 5%, no orphaned `dead_pane_zombie` without explicit decision. NOT a new command — preconditions on `serve start`. **The 3am runbook stays one keystroke.**
**Rationale:** F5. **Risk:** auto-fix in production must be idempotent; ship `genie serve start --no-fix` for operators who want manual control.

### P0 — Deletions in same PR
- Delete `genie metrics agents` (corpse counter, fails Measurer's rule on day one).
- Collapse `genie events list --v2` into `genie events list --enriched` flag (one schema, one surface).
- Fold `genie doctor --state` into `genie status --debug`.
- Hide partition rotation behind `serve start` preconditions; remove the human-facing warning.
- Quiesce 7 archived `felipe-trace-*` rows + the legacy stringly-typed `felipe` row (cleanup migration).
**Rationale:** F4, Simplifier R1+R2. **Risk:** users scripting against `metrics agents` break — provide a one-release deprecation note in `genie doctor`.

### P1 — Backfill convergence to ~100%
`genie sessions sync` currently captures 30/200 (15%). Make convergence the explicit acceptance criterion of the precondition check. Once authoritative, the JSONL fallback inside `getResumeSessionId` becomes the rare-recovery path it was designed to be — not a per-boot tax.
**Rationale:** Architect R1 scale concern; underpins P0 boot-pass cost.
**Risk:** large backfills on first upgrade; ship as background job with progress indicator.

### P1 — `genie done` rejection on permanent context
Typed error `PermanentAgentDoneRejected`. Database is the only durable enforcer of invariants. **Convention is what produced `team=NULL` rows in the first place.**
**Rationale:** F4 (methodology rule), Operator+Architect R2.
**Risk:** false positives — inference must be tight. Use the `kind` GENERATED column for the check.

### P2 — `state-machine.md` documentation
One file at `docs/state-machine.md`. Three layers (identity / run / task), one chokepoint (`shouldResume`), one surface (`genie status`). 10-minute read for new users. Includes the `kind` GENERATED column rationale, the boot-pass uniform decision, and the rehydrate-vs-re-invoke distinction.
**Rationale:** "buggy and undocumented" was Felipe's own diagnosis.
**Risk:** docs rot — pair with a test that asserts the doc-claimed invariants.

---

## Final Wish Scope (six groups, council-converged)

1. `shouldResume()` chokepoint + 8 consumer migrations + uniform boot-pass
2. Derived-signal rule engine + `genie status` (+ `--debug`, `--health`, `--all` flags)
3. `agents.kind` GENERATED column + migration + read-site replacement
4. `genie serve start` opinionated preconditions (watchdog, partition, backfill, zombie cleanup)
5. **Deletions** (corpse counter, `--v2` fork, `doctor --state`, archived noise)
6. `docs/state-machine.md` + invariant test

**Acceptance:** at 3am, `genie serve start && genie status` is the entire runbook. Green → sleep. Red → actionable verbs. No SQL. No JSONL. No mental gymnastics.

---

## Next Steps (actionable checklist)

- [ ] Promote `.genie/brainstorms/happy-genie-resume/DRAFT.md` to a wish at `.genie/wishes/invincible-genie/WISH.md` with the six execution groups above.
- [ ] Get Felipe's sign-off on the 3am-runbook acceptance criterion as the primary SLI.
- [ ] Confirm Postgres version supports `GENERATED ALWAYS AS … STORED` (fall back path documented).
- [ ] Inventory the 7 spawn-path call sites (Architect R1) and tag each as Group 1 deliverable.
- [ ] Write the deletion list in machine-checkable form (`grep -r genie_metrics_agents` should hit zero post-PR).
- [ ] Decide: `genie doctor --observability` keeps or folds into `genie status --health`? (Council leans fold.)

---

## Dissent

The council reached strong convergence. Two minor positions worth preserving:

- **Simplifier's strict 5-group target** vs the council's final 6-group scope. Simplifier argued the rule engine could be one-line folded into the reconciler; Measurer rebutted that the reconciler is the emitter and the missing piece is the subscriber. Council went with 6 groups (rule engine kept distinct). Simplifier conceded but flagged that any creep beyond 6 must be challenged. **Honor the flag.**

- **Architect's identity-shape inference** (`id LIKE 'dir:%' OR reports_to IS NULL`) vs **Simplifier's assignments-presence inference** (`EXISTS (SELECT 1 FROM assignments WHERE outcome IS NULL)`). Architect noted Simplifier's rule breaks under archived assignments (a task agent that completed becomes "permanent" next boot). Council went with Architect's identity-shape rule. **The CHECK constraint or `genie doctor` audit (Measurer's startup audit) must enforce that no `id LIKE 'dir:%'` row has an active assignment, which closes the gap Simplifier was worried about.**
