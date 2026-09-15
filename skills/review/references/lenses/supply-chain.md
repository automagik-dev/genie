# Security and supply-chain lens

Every artifact a system trusts (a release binary, a dependency, a CI token, an inbound message) needs verifiable provenance; "downloaded over HTTPS" is not provenance. Trust boundaries are enumerated, not assumed, and the question at each is "what does an attacker who controls this input get?" This is a defensive audit of the user's own repository: demonstrate a finding by citing the code path and impact, never by building exploit tooling.

## Evidence to collect

- Every external entry point (listeners, webhook or hook stdin, queues, downloaded artifacts, CLI args crossing privilege levels) with its reach: paths, shell, DB writes, network. Audit the highest-exposure handler first: boundary validation, fail-open versus fail-closed on malformed input, side effects reachable from attacker-shaped payloads.
- Credentials at rest: generation, storage, permissions; never logged, committed, or echoed in errors.
- The update chain: pinned source, checksum or signature verification, time-of-check gaps; state plainly what a compromised update source gets.
- CI: least-privilege permissions per workflow, `pull_request_target`, secrets exposed to forks, submodule checkout trust, actions pinned by SHA versus tag.
- Injection surfaces (shell construction, path joins from user strings, query building), each tainted variable traced to its origin.
- The repo's stated security decisions (fail-closed contracts, trust delegations, accepted risks): do they hold, and has their scope silently widened?

## Traps

- Reporting a documented trust delegation as a hole; the finding is silent scope widening.
- Claiming "errors are swallowed" or "fails open" before finding and running the test that locks the fail-closed behavior.
- Flagging inputs that never cross a privilege boundary, or the user's own local state files.
- Severity inflation: CRITICAL only when attacker, input, and impact fit in one sentence.

Grade each finding confirmed (traced end to end), plausible (taint not fully traced, with what remains), or not assessed; include the verified-safe list, and treat anything actively exploitable as BLOCKED.
