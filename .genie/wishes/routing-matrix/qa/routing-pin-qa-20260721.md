# Routing-Matrix Pin — Day-3 QA rerun (2026-07-21)

**Runner:** team-lead orchestrator, Felipe-authorized ("do the still open yourself", 2026-07-21).
**Host state:** Claude Code logged in (`claude.ai` auth) — the sole blocker of the
[2026-07-14 FAIL](routing-pin-qa-2026-07-14.md) is cleared. Installed genie `5.260721.8`;
role files `~/.claude/agents/*` remain the seven genie-managed pins.

## Method

One fresh non-interactive marker per pinned role (`claude -p --agent <role> --output-format json
--no-session-persistence --tools "" --max-budget-usd 0.30`), reading the **resolved model ID**
from the response's `modelUsage` — a stronger source than alias inspection, and exactly what the
07-14 run could not obtain (0 completed invocations).

## Per-role fingerprint — resolved model IDs 7/7

| Role | Expected alias | Resolved model ID | Verdict |
|---|---|---|---|
| `scout` | haiku | `claude-haiku-4-5-20251001` | **PASS** |
| `engineer-trivial` | opus | `claude-opus-4-8` | **PASS** |
| `engineer-standard` | opus | `claude-opus-4-8` | **PASS** |
| `engineer-complex` | opus | `claude-opus-4-8` | **PASS** |
| `fixer` | opus | `claude-opus-4-8` | **PASS** |
| `reviewer` | opus | `claude-opus-4-8` | **PASS** |
| `final-gate` | fable | `claude-fable-5` | **PASS** |

All seven fresh sessions routed to the pinned model families. Marker text echoed back on 5/7;
two (`engineer-trivial`, `final-gate`) returned empty result text under the tight budget but
completed with the correct resolved model in `modelUsage` — the fingerprint source.

## Effort dimension — remains open (key not on host)

The 07-14 methodology's LangWatch pull (shared-project key, `https://langwatch.khal.ai`) would
add per-trace **effort** resolution. No `LANGWATCH_API_KEY` is available in this session's
environment or config; per standing policy the key is supplied only by Felipe at run time. The
effort leg is therefore recorded as **not observed**, not failed. Prior legs already PASS:
mechanical delivery, fresh-client discovery, doctor contract (07-14), shared-project auth (07-14).

## Verdict

**PASS — model-identity fingerprints 7/7.** The day-3 re-run gate's substance (resolved model
IDs from fresh sessions on the live host) is met; routing-matrix QA closes on model identity,
with the effort observation noted as an optional follow-up whenever the shared key is in hand.
