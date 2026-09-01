# Genie Skills

`skills/` is the canonical, runtime-neutral source for Genie's 25 product skills. Each directory contains a
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

All runtimes share the same durable contracts:

- plans and evidence are documents under `.genie/`;
- operational task state is in the per-repository `.genie/genie.db`;
- implementation is delegated through the runtime's native named roles;
- the engineer and reviewer are always different agents;
- the orchestrator alone marks a task done after review and validation.

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

## Shipped inventory

| Area | Skills |
|------|--------|
| Lifecycle | `brainstorm`, `quick`, `wish`, `review`, `work`, `fix`, `trace` |
| Orchestration | `genie`, `dream`, `council`, `omni` |
| Quality lanes | `architecture`, `code-quality`, `dx-docs`, `perf`, `qa`, `repo-hygiene`, `supply-chain` |
| Orca lane | `genie-orca-wish`, `genie-orca-work`, `genie-orca-review` |
| Supporting workflows | `docs`, `refine`, `report`, `genie-hacks` |

Personal specialist-panel/persona skills are intentionally not part of this product payload.
