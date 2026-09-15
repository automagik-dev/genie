# Architecture lens

Complexity is anything that makes a system hard to understand or change; it accumulates as dependencies and obscurity. KISS comes first: the simplest complete design that satisfies current user stories, with every added mechanism paying for itself with a present requirement or measurement. Deep modules (small interface, substantial implementation) are good; shallow ones are debt.

## Evidence to collect

- The repo's own stated design: architecture sections in `AGENTS.md`/`CLAUDE.md`, ADRs, documented invariants ("X never imports Y", "state lives in Z"), and the wish or design behind the subsystem. The defect is a violated contract or one the code has outgrown, never the contract's existence.
- The real module graph traced from entry points via imports: layers, cycles, upward imports.
- For each central interface: surface versus what it hides, internals leaked to callers, pass-through methods, two modules that must change together.
- Change amplification: how many places move when the underlying decision changes.

## Traps

- Deliberate separation is not duplication to consolidate; when the docs say two modules must not share code, the finding is a cross-import, not their existence.
- Constraints like "no resident daemon" or "state never in files" are product decisions; reversing them is a scope change to surface, not a finding to assert.
- A readable linear workflow above a complexity budget is not fixed by single-caller helpers; respect the repo's own complexity policy.
- Unjustified stateful machinery (speculative caches, deltas, sharding, retry state machines, configuration knobs) is itself a HIGH finding: the evidence is the absent requirement plus the states and failure modes it adds.

Cite the interface, import, or branch for every finding; name the modification scenario it makes expensive; recommend one structural move, not a survey.
