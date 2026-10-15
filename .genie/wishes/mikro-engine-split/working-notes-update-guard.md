mikro-engine-split/t_muukqrpx618bac1f/7c0eedc01f284bdec1e647f257b83dafa84599db

# G1 standalone-updater authority repair

Claim: native CLI task `t_muukqrpx618bac1f` claimed successfully with worker `G1UpdateGuardRepair`. The supplied `cardt_` spelling was a coordinator brief typo, not a CLI identifier or supported alias; attempts with it found no task. No production/source checkout Git state was moved.

## Root cause and bounded repair

Both `bin/mikro.mjs update` and independently compiled `dist/src/cli.js update` delegate to `bin/install-state.mjs --worker update`. The former check only required a Git worktree, so a nested package selected its enclosing Genie worktree for fetch/reset/clean. The repair compares the canonical Git `--show-toplevel` with the canonical package root before acquiring ownership, reading recovery state, journaling, dependency mutation, or fetch/reset/clean. A mismatch visibly refuses and directs the operator to update the owning Genie checkout explicitly.

The check reuses `canonicalRoot`, `git`, and `failure`; it does not infer standalone status from whether `.git` is a directory. Existing Git environment selection remains in effect for both discovery and mutation; this repair does not introduce unrelated Git-environment sanitization.

## Behavioral proof authored, not executed

- One actual-process/Git nested-package fixture invokes launcher `update --force`, real independently compiled CLI `update --force`, and direct `--worker update --force`. The three cases protect independently bypassable entry points rather than mock echo implementations.
- Each invocation must exit 1 with the actionable authority refusal while preserving parent branch/HEAD, byte-identical staged index, dirty tracked parent bytes, untracked package bytes, updater/package/lock/compiled CLI bytes and dependency symlink. No install-state directory, FETCH_HEAD, or npm/build events may appear.
- The existing direct-CLI success owner now updates an independent standalone linked worktree with a `.git` file. It proves convergence to the remote target, preservation of the sibling checkout HEAD, exactly one install/build transaction, and a runnable launcher. Its old source-text assertion was removed in favor of this observable proof.
- Existing ordinary standalone/concurrency/repair/installer tests and standalone install/update smoke are unchanged.

The tests read the coordinator directly from `ROOT/bin` into their committed Git fixtures, so the shared worker executes the exact changed dependency-free file, not a copied compiled implementation. `fixture(true)` copies the coordinator's current independently compiled CLI distribution; the coordinator must build before running the tests.

## Rulings and limits

- Scope remains two owned files plus these notes; no launcher, CLI source, provider, engine, root config, WISH/DESIGN, or generated distribution changes.
- Repair1/B=2 and quality loop1 inherited from coordinator; no model escalation or paid model invocation.
- No build, test, lint, formatter, smoke, baseline reproduction, or independent review was run by this author. Passing results and pre-fix failure evidence are not claimed.
- Other modes (`repair`, `installer`, `finish`, `verify`) keep their existing contracts. Explicit Git environment overrides and concurrent external Git reconfiguration remain outside this bounded repair; no additional environment policy or external-process coordination is claimed.

## Coordinator validation

From `mikro/`: run `npm run build`, then `node --test dist/tests/install-coordination.test.js`; run the independent package gate (`npm run check`, `npm test`) and `bash scripts/smoke-install-update.sh`, followed by the parent-owned aggregate gate and independent review. If collecting baseline evidence, execute the nested regression in a disposable fixture with the pre-repair coordinator and compiled CLI: expect failure at the actionable-refusal/preservation assertions, never run a source updater against the real Genie checkout. Author has deferred all validation to the coordinator.
