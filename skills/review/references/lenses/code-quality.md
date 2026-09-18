# Code quality lens

The type system is the cheapest reviewer on the team: quality is how much correctness the compiler can prove. Escape hatches (`any`, unchecked casts, suppression comments, `unsafe`, `# type: ignore`) mark where the team chose not to know. Gates exist to be run; a quality verdict without executed tooling is an opinion.

## Evidence to collect

- The repo's real gates from its manifest scripts, `Makefile`/`justfile`, CI, and agent instructions: typecheck, lint, dead-code, complexity, formatter. Run them individually so one failure does not mask the rest; quote command, exit code, and output.
- Documented known false positives and complexity-budget policy. A repo that says "tool X flags Y, pre-existing" has told you what not to report.
- Escape hatches at boundaries versus in the interior: a hatch at a runtime-validated system boundary (user input, external API) is correct; an interior hole where the compiler was silenced without runtime backing is a finding.
- Existing hotspot ledgers or baseline files; new violations are drift against them, not discoveries.
- Duplication with at least two cited sites and one proposed home, respecting documented deliberate non-sharing.

## Traps

- Reporting documented false positives as findings.
- Demanding extraction of a readable linear flow to satisfy a warn-level complexity ceiling.
- Proposing the shared-utils layer the repo's docs forbid between deliberately parallel modules.
- Flagging test files without checking the lint overrides that relax rules there.
- Saying "gates pass" from memory or documentation.
- Reading `set -e` as fail-closed in a shell gate. A Bash function reached from `if`, `||`, `&&`, or `!` runs with errexit disabled and continues past a failed step, so a script that must fail closed checks each command's status explicitly on that path.

Rank gate failures first, then interior type holes by blast radius, then ledger drift, then duplication; distinguish "gate is red" (fact) from "discipline is eroding" (trend with examples).
