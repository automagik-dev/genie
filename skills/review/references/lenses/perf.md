# Performance lens

Performance work starts with measurement of the running system, never with intuition about code. Every number carries the command that produced it. Frame each resource by utilization, saturation, and errors; the most expensive bug is the one "fixed" without a before/after pair.

## Evidence to collect

- Which latency users actually feel: a CLI pays cold start per invocation (and per hook event, where the hook timeout is the hard ceiling); a server pays per-request latency and saturation; a batch tool pays throughput.
- The shipped artifact users run (installed binary, built bundle, deployed server), measured over repeated runs: median, spread, and the first cold-cache run reported separately.
- What executes before useful work: eager imports, top-level side effects, artifact parse cost, heavy dependencies loaded on paths that do not need them.
- Hot-path storage: per-row queries in loops, missing indexes against real WHERE/ORDER BY clauses, multi-statement writes without a transaction, recomputation that grows with data; where testable, time it against a throwaway store in a temp directory.
- The repo's stated constraints (zero-daemon rules, fork-per-event models, chosen storage engine).

## Traps

- Measuring the dev-mode or source-interpreted path instead of what users execute.
- Carrying a documented size or timing forward; it is a claim to re-measure.
- Optimizing away retry or conflict patterns that implement correctness (claim conflicts, optimistic-lock retries).
- Proposing a daemon or cache layer the architecture forbids; hand that off with the numbers attached.
- Recommending minification or optimization flags without reading the build config; partial minification is often deliberate.

Rank by frequency × cost, state each recommendation's expected effect testably, and close with what was not measured and the command that would measure it.
