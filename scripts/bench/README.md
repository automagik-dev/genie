# Genie Bench — operator contract

Genie Bench measures whether the stock, visible native client of a coding harness (OMP first) solves
**selected public tasks** more efficiently and more autonomously with the pinned Genie treatment than
without it. Every task keeps its original prompt, environment, verifier and thresholds, and every scheduled
attempt is kept in the denominator, failures included.

The engine is operator tooling, run as `bun scripts/bench/<file>.ts <verb>`. It is not a `genie` command. It
starts no daemon, schedules nothing and records nothing unless an operator invokes a verb.

Design: `.genie/brainstorms/genie-bench/DESIGN.md`. Plan: `.genie/wishes/genie-bench/WISH.md`.

## The "selected public tasks" label

Every result names its population as **selected public tasks**: a frozen, preregistered subset of public
benchmark tasks (DeepSWE, Terminal-Bench, SWE-Atlas, SkillsBench) chosen from an eligibility pool before any
outcome is seen. A score over this subset is never reported as a score on the full upstream suite.

## Contracts

`contracts.ts` holds every boundary shape the engine binds to, as strict zod schemas:

- Persisted documents carry `schemaVersion: 1`, and every object refuses unknown keys.
- The parse helpers (`parseManifest`, `parseConfiguration`, `parsePool`, `parseCapabilityReport`, plus
  `parseEventEnvelope` and `parseNativeRequestRecord`) take `unknown` and return a `Result`. They never throw on
  bad input, and each issue names the offending field path.
- The pool file is a versioned document: `{ "schemaVersion": 1, "entries": [PoolEntry, ...] }`.
- Unknown is `null`, never `0`. No schema defaults a missing number. A request record may claim a known zero
  only when its `presence` entry for that field is `observed`.
- A solver sees a `SolverTask`, which has no verifier, verifier digest or reference solution.
- `ATTEMPT_TRANSITIONS` is the attempt state machine: registered → running → execution-stopped →
  (verified | terminal-failure) → capture-sealed → reconciled → extraction-frozen, plus the pre-running exit
  registered → terminal-failure and the interrupted exit running → terminal-failure.

`adapters/index.ts` exports the injected `ADAPTERS` map. It is empty until a native adapter lands.

## Verbs

Each verb lands with its own group of the wish. Until then the file does not exist.

| File | Verbs | Purpose |
|------|-------|---------|
| `pilot.ts` | `freeze`, `replace`, `schedule`, `verify` | Freeze the eligible pool into a task manifest, replace a task deterministically before any outcome, register the seeded paired schedule, verify a frozen manifest |
| `environment.ts` | `check` | Provision and tear down a task through its source-declared mechanism, and check the instruction digest, the untouched artifact and the reference solution |
| `run.ts` | `preflight`, `attempt`, `recover`, `status` | Prove native capabilities, supervise one finite attempt, recover a journal, report attempt state |

### `--root` is explicit

Every verb requires `--root <dir>`, the operator-named directory for private receipts, journals and captures.
There is no default location. A missing `--root` exits 2 and writes nothing. The same holds for every
endpoint, key name, model route and price table: each arrives through a file or an argument, and a missing
one is a refusal, never a fallback. Secrets are named by environment-variable NAME only and never appear on
argv, in logs or in journals.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | ok |
| 1 | not ok: the verb ran and the result is a failure (a refused preflight, a rejected verification) |
| 2 | refusal that cost nothing: bad or missing arguments, a missing `--root`, an invalid contract document |

## Prerequisites

Each prerequisite blocks the named work. None is ever substituted with a smaller pilot, a headless client or
an altered oracle.

| # | Prerequisite | Blocks |
|---|--------------|--------|
| P1 | Native OMP capability preflight in the actual visible client: every `REQUIRED_CAPABILITIES` entry `proven` for both arms; an `unsupported` entry names its upstream requirement | Native preflight, manifest freeze and both-arm smoke |
| P2 | Original-task and oracle eligibility clearance: an operator-authored pool whose candidates carry source revision, license/provisioning clearance, digests and judge settings, with no `unresolved` entry in the frozen selection | Manifest freeze and smoke |
| P3 | An authenticated route for the requested model and effort, with the observed model and effort recorded for a lead, a child and an auxiliary call in both arms | Native preflight and smoke |
| P4 | The pinned OMP-native Genie treatment contract (resource paths + sha256) from the `genie-omp` wish | The Genie arm |
| P5 | Source-native environment tooling and parity on the operator host, plus a proven way for the native client to act inside a container task | Manifest freeze and smoke |
| P6 | The operator's Phoenix server | Phoenix reconciliation (sibling wish) |
| P7 | The future Automagik website project | The website consumer (sibling wish) |

## What is never claimed

- No intelligence or IQ composite, and no guaranteed superiority.
- No full-suite upstream score from a selected subset.
- No result from a headless, print, RPC or SDK replacement of the actual client.
- No benchmark runtime, scored result or performance gain before the scored attempts have run and their
  analysis is released.
- No improvement from a missing number: an unknown token count, price or origin makes the dependent metric
  unavailable, and a failed significance test is never read as proof of non-regression.
