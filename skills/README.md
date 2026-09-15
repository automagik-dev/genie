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

| Area | Skills |
|------|--------|
| Planning and execution | `brainstorm`, `wish`, `work`, `review`, `fix` |
| Routing and coordination | `genie`, `council`, `dream`, `quick` |
| Supporting workflows | `docs`, `refine`, `report`, `omni`, `genie-hacks` |

The fourteen entrypoints keep distinct workflows. Audits use `review` plus a natural-language focus, such as “review performance”; the relevant lens is loaded only when needed. `refine` has exactly two guidance switches, `--for openai` and `--for claude`, using GPT-6 Astra and Claude Fable 5.1 as documented baselines. These switches do not change the runtime model.

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
