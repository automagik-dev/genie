# Smoke Test Wish

> **Fixture-only.** This wish exists so `genie team create <name> --wish smoke-test`
> succeeds in dogfood smoke runs without requiring a real wish to be authored.
> It does NOT correspond to a real feature and should never be `genie work`-ed.
> Closes #1471.

## Purpose

Provide a minimal valid `WISH.md` so the dog-fooder default smoke set's
**Step 3 (Team create + disband)** can run end-to-end:

```bash
genie team create smoke-$$ --repo <repo> --wish smoke-test
genie ls --json                                  # lead appears
genie team done smoke-$$                         # teardown clean
```

Before this fixture existed, every smoke run failed at team-create time with
`Error: Wish not found at .../wishes/smoke-test/WISH.md` and the smoke
suite never reached its own step 4+. The fixture is intentionally a no-op
so disband (which now archives, per #1467) leaves no behavioral residue.

## Scope

- IN: nothing — this is a fixture
- OUT: don't ship features under this slug; create a new wish slug instead

## Acceptance

- [x] File exists at `.genie/wishes/smoke-test/WISH.md`
- [x] `genie team create smoke-$$ --repo . --wish smoke-test` exits 0
- [x] `genie ls --json` shows the team's lead
- [x] `genie team done smoke-$$` cleans up

## Discovery contract

If you arrived here from a regression report ("smoke is failing on team-create"):
- DON'T add real content here — this is a fixture
- Investigate the actual failure (probably elsewhere in the dog-fooder smoke
  set or in `team-manager.ts:createTeam`)

If you arrived here looking for the smoke-test logic itself:
- Code lives in the dog-fooder template (`/home/genie/workspace/agents/genie/.genie/agents/dog-fooder/`)
- The smoke set is documented in the dog-fooder system prompt under "Default genie smoke set"
