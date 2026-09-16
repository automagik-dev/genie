# Genie Skills

`skills/` is the canonical, runtime-neutral source for Genie's product skills. Each directory contains a
`SKILL.md`, optional bundled resources, and `agents/openai.yaml` for Codex UI metadata.

Shared skill bodies name semantic routes without a host-specific prefix. Skills are installed into each agent's own global skills home by skills.sh (`npx skills add automagik-dev/genie`, or `genie update`), and every runtime discovers them from there. Invoke them the way the active runtime surfaces a discovered skill:

- Codex: `$brainstorm`, `$wish`, `$review`, `$work`
- Claude Code: `/brainstorm`, `/wish`, `/review`, `/work`
- Any runtime: the bare skill name, or plain natural language describing the workflow

The `agents/openai.yaml` starter prompt inside each skill is deliberately selector-free. A starter card already belongs to one discovered physical skill, and repeating any selector — a bare `$<name>` included — inside that card could redirect execution to a different physical copy of the skill. Manual invocation uses the discovery forms above.

The lifecycle is:

```text
brainstorm → design review → wish → plan review → work → implementation review
```

For non-trivial work, `brainstorm` automatically sends the completed design through read-only design review before
handoff to `wish`. The resulting WISH must then pass a distinct plan review before `work`; implementation receives its
own independent review after execution. These are mandatory artifact gates, not interchangeable uses of one generic
review step.

The design gate is durable: DESIGN.md carries reviewer identity, UTC timestamp, verdict, and the SHA-256 of its exact reviewed content (excluding only the bounded evidence block). Editing the design invalidates that evidence; `wish` and lint require a current SHIP digest for linked designs.

The caller owns documents and completion evidence; author and reviewer are different agents. Standalone mode uses the per-repository task DB. Explicit Orca mode uses Orca lifecycle state through the conditional instructions in `wish` and `work`; it never falls back to the local DB on an authority refusal.

## Distribution contract

This directory is the single physical source; there is no committed mirror. The release tarball ships it verbatim, and
`genie install` / `genie update` hand that delivered copy to the pinned skills.sh CLI, which writes it into every
detected agent skills home. Editing a skill here is the only way to change what ships.

```bash
bun run skills:lint                         # metadata, command, resource, vocabulary and directory-shape contracts
bun scripts/fresh-install-smoke.ts          # exercise the tree exactly as a fresh install delivers it
```

CI additionally runs `skills-inventory-parity`, which compares what the pinned skills CLI publishes for this commit
against the top-level `skills/<name>/SKILL.md` set. Adding or removing a shipped skill therefore needs nothing beyond
the directory itself — the inventory is derived from the tree, never hand-listed.

Skills reach a host through exactly one channel: the pinned skills.sh CLI, run for you by `genie update` against the
delivered tree, or run by hand as `npx skills add automagik-dev/genie`. The manual command publishes from the
repository's default branch, so it can be ahead of or behind any release; `genie update` installs the exact delivered
release. Genie writes skills nowhere else, and skills a user installed themselves stay user-owned — the installer
records what it wrote so `genie uninstall` removes only that set. A separately installed personal copy of a skill is
never adopted, refreshed, or removed by Genie.

## Shipped workflows

Every entrypoint keeps a distinct workflow. Audits use `review` plus a natural-language focus, such as “review performance”; the relevant lens is loaded only when needed. `refine` has exactly two guidance switches, `--for openai` and `--for claude`, using GPT-6 Astra and Claude Fable 5.1 as documented baselines. These switches do not change the runtime model.

The table below is generated from the tree, never hand-listed. Regenerate it after adding, removing, or re-labelling a skill:

```bash
bun scripts/skills-inventory-parity.ts --write
```

`bun run skills:lint` fails while the block is stale, so the catalog cannot drift from the directories it describes.

<!-- skills-catalog:start -->

| Skill | Category | Mutates | Description |
|---|---|---|---|
| `brainstorm` | lifecycle | documents | Explore an ambiguous idea with the user, settle scope and success criteria, and produce an independently reviewed design for wish. |
| `fix` | lifecycle | repo | Resolve blocking review gaps through bounded repairs and independent re-review; diagnose stalled attempts without expanding scope. |
| `review` | lifecycle | none | Independently assess designs, plans, implementations, PRs, or repository quality; return evidence and SHIP, FIX-FIRST, or BLOCKED without applying fixes. |
| `wish` | lifecycle | documents | Turn a settled idea into a reviewed executable wish with scope, criteria, dependency-ordered groups, and validation. |
| `work` | lifecycle | repo | Execute an approved wish in dependency order with scoped workers, independent review, bounded repairs, and verified completion. |
| `council` | routing | none | Assess a proposal through independent technical, product, risk, and dissenting lenses, then synthesize a decision without mutating unless explicitly requested. |
| `genie` | routing | none | Route Genie questions, operations, bugs, and planned work. Resume related wishes; handle ordinary requests directly unless Genie planning or coordination adds value. |
| `dream` | delivery | external | Batch-execute SHIP-ready wishes overnight — pick wishes, orchestrate workers, review PRs, wake up to results. |
| `merge` | delivery | repo | Resolve an in-progress merge or rebase by the intent of both sides, re-run the full gate on the merged tree, and finish the operation. |
| `quick` | delivery | repo | Ship tiny low-risk changes to dev within one hour. |
| `report` | investigation | documents | Investigate a failure to its root cause with grounded evidence, hand the diagnosis to fix, and create a GitHub issue only when asked. |
| `research` | investigation | documents | Investigate a question against primary sources, cite every claim, and write the findings into the repository's own notes. |
| `authoring` | authoring | none | Write or revise a Genie skill so it survives the shipped contract — frontmatter, house size, starter card, and runtime-neutral voice. |
| `docs` | authoring | repo | Audit documentation and developer experience against the live product — drift, onboarding, error messages — and write or fix docs when asked. |
| `refine` | authoring | documents | Improve a prompt using official OpenAI or Claude guidance. Text or @file mode; --for openai or --for claude selects guidance, not a runtime model. |
| `workfly` | authoring | repo | Discover a procedure and build its saved workflow — dynamic discovery, drafted script, adversarial verification, landed in the catalog. |
| `verify` | verification | none | Prove a completion claim with fresh evidence before making it — the gate's exit code, the real diff, the remote's checks, the reviewer's verdict. |
| `genie-hacks` | integration | external | Browse, search, and contribute community hacks — real-world patterns for provider switching, teams, skills, hooks, cost optimization, and more. |
| `omni` | integration | external | Wire a Genie agent to an Omni channel in one canonical flow — register the host, bind the instance, route chats to a repo, verify the round-trip. |
| `skill-audit` | skill-ops | documents | Audit the shipped skill catalogue for overlap, staleness, and drift against the install record, and propose keep, improve, merge, or retire per skill. |

<!-- skills-catalog:end -->

### Categories

`category` is a closed enum and an optional key — a skill without one is legal, and renders as `—` above.

| Category | What the skill is for |
|---|---|
| `lifecycle` | The brainstorm → wish → work → review spine, and the repairs that unblock it |
| `routing` | Choosing the route or the roster; assessment without execution |
| `delivery` | Getting reviewed work merged, deployed, and read back |
| `investigation` | Finding the root cause of a failure without fixing it |
| `authoring` | Writing prose artifacts — documentation, prompts, skills |
| `verification` | Independent checks against a stated contract |
| `integration` | Wiring Genie to something outside the repository |
| `skill-ops` | Operating the skill corpus itself |

### The advisory `mutates` axis

`mutates` is **advisory metadata**. It records the widest blast radius a skill's body claims, for a reader deciding what a skill may do before invoking it. No code path gates on it: it grants nothing, blocks nothing, and is never consulted at install or run time.

| Value | Claim |
|---|---|
| `none` | Reads and reports only |
| `documents` | Writes `.genie/` documents (designs, wishes, reports) |
| `repo` | Writes tracked source under version control |
| `external` | Writes outside the repository — remotes, hosts, chat platforms |

One rule earns the label rather than asserting it: `bun run skills:lint` fails a `mutates: none` skill whose ``` fences carry a repo-write command (`git commit`/`push`/`merge`/`rebase`, `gh pr create`/`merge`, a mutating `genie task` verb, `rm -rf`, `cp -r`, `mkdir -p`, or `>` redirection into a path). Fences only — inline code in prose describes another agent's write, while a fence is a recipe to run. A `mutates: none` skill that needs to show one of those commands must declare its real value instead.

## Consolidated names

| Previous skill | Current route |
|---|---|
| `architecture` | `review` architecture lens |
| `code-quality` | `review` code-quality lens |
| `dx-docs` | `review` DX lens; `docs` for documentation work |
| `perf` | `review` performance lens |
| `qa` | `review` test-quality lens |
| `repo-hygiene` | `review` repository-hygiene lens |
| `supply-chain` | `review` security/supply-chain lens |
| `trace` | `report` investigation; issue creation remains explicit |
| `genie-orca-wish` | `wish`, Orca mode |
| `genie-orca-work` | `work`, Orca mode |
| `genie-orca-review` | `review`, Orca mode |

On a successful `genie update`, removed skills still matching the prior install record are moved to `~/.genie/state-backups/skills-retirement-*` before the new record is published. User-modified, unverified, or redirected copies remain with a notice for manual review, as do retired copies in a home whose replacement set could not be verified. No verified replacements anywhere, or a backup failure, preserves the previous record for retry; a backup on a different filesystem can require manual relocation. A manual skills.sh install has no Genie retirement record and needs manual review of old names.

Skill and resource instructions are shortened together: no generic vendor blocks outside `refine`, fixed persona panels, numerical readiness rituals, or duplicate escalation tables. Templates, digest verification, ownership boundaries, independent review, and required validation remain. The removed prototype migration/retro scripts are not supported workflows; current Orca guides supply its command interface.
