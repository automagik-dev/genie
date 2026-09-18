# Code

The code half. The shared method stays in the skill body; this file carries only
what code work adds to it.

## Work within the request

Read the target, the callers that reach it, the project's own instructions, and
the tests that cover it. Before adding a mechanism, check the existing helpers,
the language's native facilities and the dependencies already installed for
equivalent behaviour, and reuse one only where it fits the actual contract.
Prefer clear data flow and names that expose domain purpose. Keep the comments
that explain non-obvious intent and drop the ones narrating obvious syntax.

## Inventory the protection first

Name the concrete benefit of a simplification before making it: less duplicated
policy, clearer ownership, easier failure handling, fewer places to change.
Similar syntax alone is not a benefit.

Then inventory what the apparent overhead protects. Authorization, validation at
trust boundaries, transactions, retries, timeouts, concurrency, compatibility,
diagnostics and accessibility can each justify an abstraction that reads as
redundant from inside one call site.

Learn why a thing exists before you remove it, and the history is the cheapest
source. `git blame` on the line names the change that introduced it; a pickaxe
search — `git log -S '<the exact string>'` — finds the commit that first added
it when blame only shows a later reformat. Read the message and the surrounding
diff. Compatibility shims, staged migrations and isolation around vendored code
are deliberate design that looks like cruft from close range.

Keep valid runtime checks and well-typed boundaries. Replacing validation with a
cast or a suppression to quieten a linter trades a real check for a green one.
The project's own rules and supported versions decide what is valid here; adding
a lint plugin is separate work unless the request includes it.

## Say what each finding costs

Every finding states what the problem costs whoever comes next: a policy
duplicated in two places that will drift, a contract nobody can locate, an error
path that hides its failure, a reader who has to hold four frames at once. A
finding that cannot name its cost is a nit — drop it rather than argue it.

Ask the altitude question of each one: is this the level at which the problem
should be solved? A special case bolted onto a shared path for one caller, a
workaround stacked on an earlier workaround, or a flag routing around a broken
default are all fixes made too shallow. Name the mechanism the change is
dodging, describe the deeper fix, and say plainly when that fix is large enough
to be its own task rather than part of this pass.

## Change and verify

For code that will change, identify the checks that already protect the
behaviour and add a focused regression test only where the pass uncovered a real
risk. Make small cohesive changes, run the checks that cover them, and compare
the result against the original contract on the failure paths as well as the
success path. Weakening a test or dropping an edge case to manufacture
simplicity converts a maintenance problem into a correctness one. Leave
unrelated edits in the tree alone.
