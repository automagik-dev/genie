# Wish: WRS Backlog Reorganization and Sofia Co-Triage

**Status:** COMPLETE
**Slug:** wrs-backlog-reorg
**Created:** 2026-02-13
**Completed:** 2026-02-19
**Author:** Genie 🧞
**Brainstorm:** `.genie/brainstorms/wrs-backlog-reorg/design.md`

---

## Summary

Reorganize current work into a single WRS-aligned prioritization model, then publish a shared backlog with Sofia using explicit scoring, triage buckets, and execution gates for large epics.

## Dependencies

- **depends-on:** `forge-resilience` (reference baseline for acceptance rigor and resilience framing)
- **blocks:** `hooks-v2`, `workflow-rebrand`, `omnichannel-agent-platform` (until priority policy + triage order are explicit)

## Scope

### IN
- Define and document one weighted scoring framework for backlog prioritization
- Define triage method (`Now / Next / Later`) and gating rules
- Inventory the current planning set discussed with Felipe/Sofia
- Assign first-pass ranking with short rationale per item
- Mark shipped/residual items clearly (avoid re-planning already-shipped work)
- Create recurring co-ownership cadence (Genie + Sofia) for backlog refresh

### OUT
- Implementing any feature/bug item in the backlog itself
- Redesigning WRS internals or changing skill behavior
- Multi-quarter roadmap expansion beyond current planning set
- Cross-repo delivery execution details (this wish is prioritization/governance only)

## Key Decisions + Rationale

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Use weighted score: Blocking 30, Stability 25, Cross-impact 20, Quick-win 15, Complexity-inverse 10 | Keeps foundation and reliability ahead of cosmetic/isolated work |
| D2 | Triage by policy: P0+blockers first, then foundation/integration, then feature slices, epics decomposed before execution | Prevents queue churn and premature epic execution |
| D3 | Keep first-pass list explicit with `Now/Next/Later` | Produces immediate operator clarity and handoff quality |
| D4 | Treat `upgrade-brainstorm` and `forge-resilience` as status-validation items unless regressions exist | Avoids duplicate work and backlog inflation |
| D5 | Require short rationale tags (`impacto/bloqueio/quick win/estabilidade`) on top-ranked items | Makes prioritization auditable and PM-friendly |

---

## WRS Backlog Scoring (Canonical Policy)

Priority score formula:

```text
PriorityScore =
  (Blocking * 0.30) +
  (Stability * 0.25) +
  (Cross-impact * 0.20) +
  (Quick-win * 0.15) +
  (Complexity-inverse * 0.10)
```

Scale each dimension 0–5.

- **Blocking (30%)**: how much it unblocks downstream work
- **Stability (25%)**: effect on reliability/incident reduction
- **Cross-impact (20%)**: breadth across agents/repos/flows
- **Quick-win (15%)**: value delivery speed (1–3 day slices favored)
- **Complexity-inverse (10%)**: lower execution risk scores higher

### Reusable Template Snippet

```text
Item:
Type: bug|integration|feature|epic|status-check
Scores (0-5): Blocking=?, Stability=?, Cross-impact=?, Quick-win=?, Complexity-inverse=?
Weighted Score: ?/5
Bucket: Now|Next|Later
Rationale tags: impacto|bloqueio|quick win|estabilidade
```

## Triage Rules (Deterministic)

1. **P0 bugs/incidents and hard blockers first**.
2. **Foundation/integration before surface features**.
3. **Medium work must be sliced into 1–3 day shippable chunks**.
4. **Epics are decompose-first** (discovery + task breakdown before queueing execution).
5. **Status-check items are not treated as net-new build** (close/monitor/defer lane).

---

## Inventory Normalization (Current Planning Set)

| Item | Type | Risk | Note |
|---|---|---|---|
| provider-system-refactor | integration/foundation | high | Core provider architecture; unblocker for downstream consistency |
| whatsapp-openclaw-integration-test | integration/test | medium | Validates end-to-end reliability before feature expansion |
| Omni bug #7 | bug | medium | Production bug; stability-first handling |
| Omni bug #8 | bug | medium | Production bug; grouped with bug batch |
| Omni bug #9 | bug | medium | Production bug; likely fast stabilization win |
| telegram-channel-activation | feature/ops | low | Communication redundancy and quick operational value |
| medium-features | feature-batch | medium | Incremental capabilities once base is stable |
| media-drive-download | feature/enablement | medium | Media ingestion/download support for workflows |
| workflow-rebrand | feature/product | medium | Product-facing polish/positioning; non-blocking |
| hooks-v2 | epic | high | High-impact but broad scope; needs decomposition |
| omnichannel-agent-platform | epic | high | Umbrella platform initiative; decompose before build |
| forge-resilience | status-check | low | Already shipped baseline; monitor/hardening lane |
| upgrade-brainstorm | status-check | low | Validate shipped/residual work; avoid duplicate effort |

---

## First-Pass Priority Output

### Now
1. provider-system-refactor — **bloqueio + estabilidade + impacto transversal**
2. whatsapp-openclaw-integration-test — **estabilidade + bloqueio**
3. Omni bug #7 — **estabilidade**
4. Omni bug #8 — **estabilidade**
5. Omni bug #9 — **estabilidade / quick win**
6. telegram-channel-activation — **quick win + redundância operacional**

### Next
7. medium-features — **impacto incremental**
8. media-drive-download — **enablement operacional**
9. workflow-rebrand — **impacto de produto, baixo bloqueio técnico**

### Later (decompose-first)
10. hooks-v2 — **alto impacto, alto escopo**
11. omnichannel-agent-platform — **épico guarda-chuva, precisa fatiamento**

### Status-check lane (not net-new build priority)
- forge-resilience — monitor/hardening if regressions
- upgrade-brainstorm — validate shipped state; close residuals only

---

## Governance and Cadence with Sofia

- **Owners:**
  - Genie: technical sequencing and dependency sanity
  - Sofia: PM governance, priority enforcement, delivery framing
- **Cadence:** 2x weekly lightweight backlog refresh (Tue/Fri)
- **Per-cycle artifact:** update this wish (or successor backlog wish) with:
  1) ranked table,
  2) `Now/Next/Later` bucket deltas,
  3) short **delta log** (what moved and why)
- **Decision split:**
  - Genie can propose reorderings based on technical blockers
  - Sofia finalizes queue for execution handoff

---

## Success Criteria

- [x] Scoring framework is documented and reusable for future backlog refreshes
- [x] Triage method is documented with unambiguous ordering rules
- [x] Current item inventory is captured with source labels
- [x] First-pass prioritized list exists with concise rationale per item
- [x] `Now/Next/Later` buckets are published and consistent with scoring
- [x] Epics are flagged with decomposition gate (not directly queued for implementation)
- [x] Shipped/residual items are labeled (close/monitor/defer) to reduce noise
- [x] Sofia + Genie review cadence is defined (owner, frequency, output artifact)

---

## Execution Groups

### Group A — Scoring Policy and Triage Rules
**Goal:** Create the canonical prioritization policy.

**Deliverables:**
- `WRS Backlog Scoring` section with weighted criteria
- `Triage Rules` section with deterministic ordering
- Template snippet for future backlog scoring reuse

**Acceptance Criteria:**
- [ ] Weights sum to 100 and are justified
- [ ] Policy explicitly handles blockers, bugs, foundation, features, epics
- [ ] Rules are understandable in <2 minutes by PM/operator

**Validation Command:**
```bash
rg -n "Blocking|Stability|Cross-impact|Quick-win|Complexity" .genie/wishes/wrs-backlog-reorg/wish.md
```

---

### Group B — Current Inventory Normalization
**Goal:** Normalize and classify all currently discussed items.

**Deliverables:**
- Item table with type (`bug|integration|feature|epic|status-check`)
- Ownership/context notes (where relevant)
- Initial risk flags (`high/medium/low`)

**Acceptance Criteria:**
- [ ] All items listed by Felipe/Sofia are represented once
- [ ] No ambiguous duplicate entries
- [ ] Each item has at least type + one-line note

**Validation Command:**
```bash
rg -n "provider-system-refactor|hooks-v2|workflow-rebrand|omnichannel-agent-platform|Omni bug #7|Omni bug #8|Omni bug #9" .genie/wishes/wrs-backlog-reorg/wish.md
```

---

### Group C — First-Pass Prioritization Output
**Goal:** Publish execution-facing queue order.

**Deliverables:**
- Ranked list with short rationale tags
- `Now / Next / Later` buckets
- Explicit handling of status-check items

**Acceptance Criteria:**
- [ ] Top list starts with foundation + stability items
- [ ] Omni bug cluster is placed before broad feature expansion
- [ ] Epics are marked “decompose-first”
- [ ] Status-check items are not treated as net-new build work

**Validation Command:**
```bash
rg -n "Now|Next|Later|decompose-first|status-check" .genie/wishes/wrs-backlog-reorg/wish.md
```

---

### Group D — Governance and Cadence with Sofia
**Goal:** Keep backlog ordering current and enforceable.

**Deliverables:**
- Owner model: Genie (technical sequencing) + Sofia (PM governance)
- Cadence: lightweight review rhythm
- Output artifact location for each review pass

**Acceptance Criteria:**
- [ ] Cadence frequency is explicit
- [ ] Each cycle has a concrete output (updated ranked table + delta log)
- [ ] Decision ownership split is clear

**Validation Command:**
```bash
rg -n "cadence|owner|Sofia|Genie|delta" .genie/wishes/wrs-backlog-reorg/wish.md
```

---

## Planned Validation

```bash
# Group A
rg -n "Blocking|Stability|Cross-impact|Quick-win|Complexity" .genie/wishes/wrs-backlog-reorg/wish.md

# Group B
rg -n "provider-system-refactor|hooks-v2|workflow-rebrand|omnichannel-agent-platform|Omni bug #7|Omni bug #8|Omni bug #9" .genie/wishes/wrs-backlog-reorg/wish.md

# Group C
rg -n "Now|Next|Later|decompose-first|status-check" .genie/wishes/wrs-backlog-reorg/wish.md

# Group D
rg -n "cadence|owner|Sofia|Genie|delta" .genie/wishes/wrs-backlog-reorg/wish.md
```

---

## Task Tracking Notes

- Use this wish as the source for creating/updating `bd` items and dependency edges in the next step.
- For cross-repo work, keep dependency notation in `repo/slug` form.
