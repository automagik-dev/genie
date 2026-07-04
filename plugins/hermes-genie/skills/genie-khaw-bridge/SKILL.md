---
name: genie-khaw-bridge
description: Bridge contract between KHAW Brain/Purpose Sessions and Genie execution — KHAW stays canonical for purpose, Genie owns execution detail, evidence over vibes.
---

# Genie / KHAW Bridge Contract

## Ownership boundaries

- Brain and Purpose Sessions stay canonical in KHAW: purpose, missions, and
  brain wishes are read from KHAW and never forked into or overwritten by
  Genie.
- Genie owns execution detail: wishes, task groups, boards, worker state, and
  validation evidence live in Genie and are read through the plugin tools.

## Bridge reporting

- The bridge reports mappings plus evidence, not vibes: which KHAW purpose or
  mission maps to which Genie wish and task group, backed by
  `genie_wish_status` / `genie_board` output and the argv that produced it.
- Divergence between KHAW intent and Genie state is reported as a finding
  with evidence from both sides. The bridge never silently reconciles the
  two systems.

## Human gate before mutation

- Any mutation on either side — KHAW purpose updates, Genie spawns or
  launches, task completion — requires explicit human approval before it
  runs. The bridge itself stays read-only.
