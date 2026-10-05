/**
 * Prime backend behavior tests — the real spawn machinery against a stub
 * `prime-agent` binary.
 *
 * Every test injects a temp executable shim via `PrimeBackendOptions.binaryPath`
 * (never by mocking child_process). The shim is env-driven: it answers the
 * `--version` pin check, records its argv, emits scripted JSONL events
 * (happy runs, ceiling-breach runs), or hangs forever with a grandchild so a
 * kill test can prove the process TREE died, not just the direct child.
 *
 * Deliberately NOT covered here: the host-visible contract (footer, isError,
 * progress sequence) — that is `tests/backend-contract.test.ts`, which drives
 * every backend through the real server pipeline. This file owns the prime
 * engine's own behavior: argv assembly, event mapping, budget enforcement,
 * and the version pin.
 */
export {};
//# sourceMappingURL=prime-backend.test.d.ts.map