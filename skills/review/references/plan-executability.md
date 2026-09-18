# Plan executability

A plan can be internally coherent and still impossible to run. Plan review asks a second question after "do the pieces agree?": can each step actually execute in the repository and environment that exist today, with the permissions, runners, branch protections, identities and ordering that exist with them.

## What to check

- **Trigger and discovery.** The event a step depends on must be able to find its automation on the branch the platform reads it from. A manual fallback the platform cannot discover is not a fallback.
- **Permissions and identity.** Name the account or credential each mutating step runs as, and confirm the provider actually offers that scope. A role nobody can hold is a blocked step, not a footnote.
- **Branch protection and required checks.** Read the effective rules for the target branch. A required check whose producer is disabled is an impossible gate, not a pending one.
- **Ordering in time.** Evidence that can only exist after an effect cannot gate that effect. A step cannot validate a file a later step creates, and a record cannot contain its own commit SHA. Where the order is circular, name the cycle and propose the split that breaks it.
- **Mutation versus readiness.** A successful push, pin, or deploy is not proof that the new thing is serving. Readiness is its own check, and it compares identities rather than exit codes.
- **Process boundaries.** A child process, container exec, or subshell cannot hand environment values back to its parent, so a later assertion on those values proves nothing about the step that set them.
- **Gates that can skip themselves.** A named test that skips when its database, profile, or credential is absent is not a gate. Require the run that cannot skip, or record the coverage as unavailable.
- **One chain per deployable unit.** Each unit needs its own path from source identity to running revision; evidence for one never covers its companion runtime, worker, or bridge.

## Findings

Report an unrunnable step as a blocking gap naming the exact link that fails — the trigger, the permission, the required check, or the ordering — because the author can repair it cheaply before implementation and expensively afterwards. Where a prerequisite is only unproven, name its owner, the check that would prove it, and the disposition when that check fails.
