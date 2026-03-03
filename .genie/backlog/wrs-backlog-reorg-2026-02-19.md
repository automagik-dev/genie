# WRS Backlog Cadence — wrs-backlog-reorg (2026-02-19)

**Wish:** `.genie/wishes/wrs-backlog-reorg/wish.md`  
**Cadence owners:** Genie (technical sequencing), Sofia (PM governance)  
**Cadence rhythm:** Tue/Fri (2x weekly lightweight refresh)  
**Next cadence date:** **2026-02-20 (Fri)**

## Ranked Table Snapshot (Scoring Policy Applied)

Scoring formula: `Blocking 30% + Stability 25% + Cross-impact 20% + Quick-win 15% + Complexity-inverse 10%`.

| Rank | Item | Type | Bucket | Score (/5) | Rationale tags |
|---:|---|---|---|---:|---|
| 1 | provider-system-refactor | integration/foundation | Now | 4.50 | bloqueio, estabilidade, impacto |
| 2 | whatsapp-openclaw-integration-test | integration/test | Now | 4.20 | estabilidade, bloqueio |
| 3 | Omni bug #7 | bug | Now | 4.05 | estabilidade |
| 4 | Omni bug #8 | bug | Now | 3.90 | estabilidade |
| 5 | Omni bug #9 | bug | Now | 3.95 | estabilidade, quick win |
| 6 | telegram-channel-activation | feature/ops | Now | 3.70 | quick win, redundância operacional |
| 7 | medium-features | feature-batch | Next | 3.35 | impacto incremental |
| 8 | media-drive-download | feature/enablement | Next | 3.25 | enablement operacional |
| 9 | workflow-rebrand | feature/product | Next | 2.95 | impacto de produto |
| 10 | hooks-v2 | epic | Later (decompose-first) | 2.75 | alto impacto, alto escopo |
| 11 | omnichannel-agent-platform | epic | Later (decompose-first) | 2.45 | épico guarda-chuva, precisa fatiamento |

### Status-check lane (not net-new build)
- forge-resilience — monitor/hardening only if regressions
- upgrade-brainstorm — shipped-state validation + residual closeout only

## Now / Next / Later Deltas (vs APPROVED wish baseline)

Baseline used for comparison: `First-Pass Priority Output` in `.genie/wishes/wrs-backlog-reorg/wish.md` (status APPROVED, created 2026-02-13).

| Bucket | Baseline count | Current count | Delta |
|---|---:|---:|---:|
| Now | 6 | 6 | 0 |
| Next | 3 | 3 | 0 |
| Later | 2 | 2 | 0 |
| Status-check lane | 2 | 2 | 0 |

## Explicit Delta Log (what moved and why)

| Change | What moved | Why |
|---|---|---|
| D-01 | `hooks-v2` and `omnichannel-agent-platform` held in **Later (decompose-first)** gate | Preserve execution discipline: epics require decomposition before implementation queueing |
| D-02 | `forge-resilience` and `upgrade-brainstorm` isolated into **status-check lane** (not net-new build priority) | Prevent backlog inflation and duplicate shipped work |
| D-03 | `provider-system-refactor` + integration test + Omni bug cluster retained at queue front | Stability and unblockers prioritized ahead of broad feature expansion |
| D-04 | No rank changes across 1–11 since APPROVED baseline | Intentional queue stability for handoff consistency with Sofia |

## Owners and Next Cadence Commitments

- **Genie:** verify technical dependencies/blockers and propose reorder only when blockers change.
- **Sofia:** finalize execution queue and enforce PM priority policy.
- **Next review artifact due:** `2026-02-20` backlog refresh with updated ranked table + delta log.

---

## Execution Note (validation + closure evidence)

Validation commands were executed against `.genie/wishes/wrs-backlog-reorg/wish.md`:

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

Observed evidence highlights:
- Group A: weighted formula and dimensions present (lines 54–67).
- Group B: normalized inventory and listed items present (lines 94–104, 113–127).
- Group C: Now/Next/Later, decompose-first, and status-check handling present (lines 85, 105–106, 112–127).
- Group D: owner split, cadence, and delta artifact expectations present (lines 135–147).

Validation output (captured excerpt):
```text
# Group A
40:| D1 | Use weighted score: Blocking 30, Stability 25, Cross-impact 20, Quick-win 15, Complexity-inverse 10 |
54:  (Blocking * 0.30) +
58:  (Complexity-inverse * 0.10)

# Group B
94:| provider-system-refactor | integration/foundation | high |
103:| hooks-v2 | epic | high |
104:| omnichannel-agent-platform | epic | high |

# Group C
85:4. **Epics are decompose-first** (discovery + task breakdown before queueing execution).
112:### Now
120:### Next
125:### Later (decompose-first)

# Group D
135:## Governance and Cadence with Sofia
138:  - Genie: technical sequencing and dependency sanity
139:  - Sofia: PM governance, priority enforcement, delivery framing
```

