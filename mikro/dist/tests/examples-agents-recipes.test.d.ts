/**
 * `examples/agents/` is the single recipe tree: every `agent.yaml` microagent
 * this repository ships lives there and nowhere else. This file is the
 * mechanical half of that claim.
 *
 * Two things are checked, and they fail for different reasons:
 *
 *   1. **Every** directory under `examples/agents/` loads via `loadAgentSpec`.
 *      Enumerated from the filesystem rather than from a list, so a recipe
 *      added later is covered without editing this file, and a recipe that is
 *      committed broken fails here rather than in a user's session.
 *   2. The three **archived** recipes — `changelog`, `codebase-qa`,
 *      `log-triage`, copied out of `~/.mikro/agents/` on 2026-07-27 by wish
 *      `mikro-microagent-plugin` (B5) — load with the exact shape, model and
 *      budget they were archived with. These have no other gate: no smoke
 *      test, no parity arm, no scored suite covers them. Pinning the spec is
 *      the only regression floor they have, and an archive whose contents
 *      drift is not an archive.
 *
 * Deliberately **not** checked: whether any of these agents answers well. That
 * is a model result measured elsewhere (`docs/parity-explore.md`), and the
 * archived three were never measured at all — see `docs/worker-models.md`.
 */
export {};
//# sourceMappingURL=examples-agents-recipes.test.d.ts.map