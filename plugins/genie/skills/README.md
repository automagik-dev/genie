# Genie Skills

`skills/` is the canonical, runtime-neutral source for Genie's 23 product skills. Each directory contains a
`SKILL.md`, optional bundled resources, and `agents/openai.yaml` for Codex UI metadata.

Shared skill bodies name other skills without a host-specific prefix. Invoke them through the active client:

- Codex: `$brainstorm`, `$wish`, `$review`, `$work`
- Claude Code and Hermes: `/brainstorm`, `/wish`, `/review`, `/work`

The lifecycle is:

```text
brainstorm → wish → review → work → review
```

All runtimes share the same durable contracts:

- plans and evidence are documents under `.genie/`;
- operational task state is in the per-repository `.genie/genie.db`;
- implementation is delegated through the runtime's native named roles;
- the engineer and reviewer are always different agents;
- the orchestrator alone marks a task done after review and validation.

## Distribution contract

`plugins/genie/skills/` is a committed physical mirror of this directory so a source marketplace install and an
extracted release contain the same in-root payload. Never edit the mirror directly.

```bash
bun scripts/sync-plugin-skills.ts --write  # regenerate after canonical edits
bun scripts/sync-plugin-skills.ts --check  # fail on inventory or byte drift
bun run skills:lint                         # validate metadata and command/resource contracts
bun scripts/fresh-install-smoke.ts          # exercise source and copied plugin layouts
```

The build and version paths run the parity check before producing release state. Adding or removing a shipped skill
therefore requires an intentional update to `SHIPPED_SKILL_NAMES` in `scripts/sync-plugin-skills.ts`.

## Shipped inventory

| Area | Skills |
|------|--------|
| Lifecycle | `brainstorm`, `wish`, `review`, `work`, `fix`, `trace` |
| Orchestration | `genie`, `pm`, `dream`, `wizard`, `council`, `omni` |
| Quality lanes | `architecture`, `code-quality`, `dx-docs`, `perf`, `qa`, `repo-hygiene`, `supply-chain` |
| Supporting workflows | `docs`, `refine`, `report`, `genie-hacks` |

Personal specialist-panel/persona skills are intentionally not part of this product payload.
