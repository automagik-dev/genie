# Test quality lens

Tests are a specification and a fear-reduction device. A suite's value is its topology, not its count: whether the behaviors that would hurt most are pinned down. A test that never watched its subject fail proves nothing; a regression that broke once is owned by a test forever. The real question is "what change could I make that no test would catch?"

## Evidence to collect

- How the repo actually tests: runner command, test-file convention (colocated, mirrored, separate), isolation patterns (temp-dir fixtures, env-var redirection of global state, real-resource-versus-mock policy), named regression tests guarding past incidents. The repo's own doctrine ("real git repos, not mocks") is the standard.
- The suite run with real output: pass, fail, skip counts, duration; a second run when flake is suspected.
- A source-to-test map per the repo's convention: tested, untested, partial.
- For each high-blast-radius behavior (entry points, mutated state, money, data, permissions): the owning test read in full, and whether it exercises the failure mode or only the happy path.
- In Genie repos, accepted wishes carry acceptance criteria the suite should own; a criterion no test exercises is a first-class gap.
- Where each expected value comes from: a test that derives its expectation from the code under test has no independent oracle. Shipped artifact, production constant, and test literal are three separate surfaces, so an edit that synchronizes two of them must still turn the suite red.

## Traps

- Crediting a colocated test file as coverage without reading it.
- Recommending mocks "for speed" against a real-database, real-repo doctrine.
- Reporting a product regression from a test wired to a stale built artifact; check the build first.
- Calling exactly-one-winner concurrency assertions flaky; they test correctness.
- Sketching a test that would touch the user's real global state; every sketch includes the repo's isolation pattern.
- Crediting a gate nobody has watched fail. The probe that proves it can fail — mutate one surface, show the suite go red — is evidence the implementor supplies or runs in a throwaway copy; the reviewer reads the result and never mutates the candidate.

Lead with the suite numbers and the single scariest untested behavior; rank gaps by blast radius × likelihood of change, each with an executable test sketch.
