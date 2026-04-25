# Design: TUI Bottom Bar — OpenTUI Upgrade + Genie-Native Status Surface

| Field | Value |
|-------|-------|
| **Slug** | `tui-bottom-bar-opentui` |
| **Date** | 2026-04-25 |
| **WRS** | 100/100 |
| **Adjacent wish** | `design-system-severance` (palette tokens — soft dep) |
| **Adjacent wish** | `bare-genie-dashboard` (full-screen Clancy dashboard — non-overlapping; this is the cockpit warning panel, that is the navigation display) |
| **Adjacent wish** | `session-cost-extraction` (PG cost source — soft dep; ccusage shim until that lands) |

## Problem

`src/tui/components/SystemStats.tsx` renders the bottom of the left nav using **ASCII string bars** (`[====----]` from a string-padding helper) with **no animation**, **no opentui-native primitives**, and a **single-track content set** limited to OS metrics. Now that the `opentui` skill is installed (`<ascii-font>`, `<slider>`, `FrameBuffer`, `useTimeline`), the bar can become a proper **multi-track operations cockpit** — visually rich, parallel-friendly, glanceable, with a single arresting scene-stealer that surfaces the one number that matters across all concurrent work: live token burn rate.

## Scope

### IN

**§1 — System vitals (existing, kept + extended)**
- CPU % (existing)
- RAM used/total (existing)
- Swap (existing — only when > 0)
- Load avg (existing)
- **NEW** Disk free GB + % (`si.fsSize()`)
- **NEW** Disk I/O latency ms (`si.disksIO().rWaitTime/wWaitTime` deltas across ticks)

**§2 — PgServe panel (new)**
- Health pulse: green / amber / crimson — `lib/db.ts::isAvailable()`
- Active connections / pool max — needs new `getServeStats()` (~30 LOC) querying `pg_stat_activity`
- Queue depth (pending statements)
- Last query latency p50

**§3 — Genie operations (new — multi-track friendly)**
- Workers aggregate: `●N working / ○M idle / ⊘K error` across all teams
- Mailbox queue depth (total backpressure across all sessions)
- Last event (kind + age) — system liveness signal

**§4 — SS-1 Token Burn Meter (scene-stealer, top header)**
- Big `<ascii-font>` cents/min (or $/min if > 100¢) using opentui `tiny` font (3-col glyphs, fits 28-col nav)
- Default: slow 1Hz mint pulse via `useTimeline` opacity tween (80→100%)
- Alarm: 2Hz crimson pulse when 60s burn > (5-min rolling mean + 2σ); hysteresis deadband of 5pp prevents oscillation
- Sub-line: "vs 5-min avg ↑X% / ↓X%"
- 60s sparkline rendered via `FrameBuffer` using `▁▂▃▄▅▆▇█` block characters
- Data source: ccusage (v1, matches `bare-genie-dashboard`); swap to PG `sessions.cost_total` when `session-cost-extraction` ships
- Degraded states:
  - ccusage unavailable → `—¢/min` dim-static, no pulse
  - True $0 burn → `$0.00/min · idle` calm static, no alarm

### OUT

- Duplicating the `bare-genie-dashboard` NUMBERS column (agent-hours, streaks, in-flight) — that's the headline surface, not the cockpit panel.
- "Active wish" framing — Felipe is multi-track; singular wish info is misleading.
- Multiple animated elements — Severance restraint: only SS-1 pulses, everything else is static between polls.
- Theme variants (Lumon-MDR / Optics / Breakroom) — deferred per `design-system-severance` OUT.
- New event-stream ingestion — uses existing PG tables only.
- Top-level layout changes to `Nav.tsx` outside the `SystemStats` panel slot.
- Per-team token-burn breakdown — aggregate only in v1 (drill-down is a `bare-genie-dashboard` panel).
- Replacing `systeminformation` with a different metrics lib.
- Configurable layouts / user-toggleable sections — single canonical layout in v1.

## Approach

### Layout (Layout A — top header)

```
┌──────────────────────────────┐
│  $1.23/min          ▁▂▄▆█▆▄▂ │  ← SS-1 ascii-font (4 lines) + 60s sparkline
│  vs 5-min avg ↑12%           │
├──────────────────────────────┤  ← divider in palette.border
│ ●3 working ○2 idle ⊘0        │  §3 Genie ops
│ q4 · last: agent.spawn  3s   │
├──────────────────────────────┤
│ ●healthy  5/20 conn          │  §2 PgServe
│ q0 · p50 12ms                │
├──────────────────────────────┤
│ CPU 24% ▒▒▒▒░░░░  4c         │  §1 HW
│ RAM 4.2/16G ▒▒░░░░░░         │
│ DSK 32/100G ▒▒▒░░░░░  io 8ms │
└──────────────────────────────┘
```

12 lines × 30 cols. SS-1 is the headline; vitals descend below in shrinking visual weight. Eye lands on burn rate first, drifts down to system health.

### Component decomposition

```
src/tui/components/
├── SystemStats.tsx              [REWRITE — orchestrator + section ordering]
├── BottomBar/
│   ├── TokenBurnMeter.tsx       [NEW — SS-1 scene-stealer, ascii-font + sparkline + animation]
│   ├── PgServePanel.tsx         [NEW — §2]
│   ├── GenieOpsPanel.tsx        [NEW — §3]
│   ├── HwPanel.tsx              [NEW — §1, replaces inline OS rendering]
│   ├── Sparkline.tsx            [NEW — reusable FrameBuffer ▁▂▃▄▅▆▇█ helper]
│   ├── PulseRing.tsx            [NEW — useTimeline-driven pulse animation]
│   └── __tests__/               [NEW — per-component snapshot tests]
```

Each panel is a single-purpose unit (per Design-for-Isolation): one section, one data source, one render. They communicate via props only — no shared state, no implicit polling coupling. Polling lives in `SystemStats.tsx`; panels are pure render-from-props.

### Data layer

```
src/lib/
├── tui-stats/
│   ├── hw.ts                    [NEW — wraps systeminformation, exposes deltas + IO latency calc]
│   ├── pg.ts                    [NEW — getServeStats(): conn count, queue depth, p50 latency]
│   ├── ops.ts                   [NEW — workers aggregate, mailbox depth, last event from PG]
│   ├── cost.ts                  [NEW — ccusage adapter; ring buffer for 5-min rolling baseline]
│   └── index.ts                 [NEW — composes all sources, exposes single hook for SystemStats]
```

`cost.ts` owns the rolling baseline + 2σ alarm threshold + hysteresis. Single source of truth for SS-1's color state.

### Animation grammar

| Element | Animates? | Mechanism | Rate |
|---------|-----------|-----------|------|
| SS-1 burn meter | ✅ | `useTimeline` opacity tween | 1Hz normal, 2Hz alarm |
| SS-1 sparkline | ✅ | redraws on data change only | per-tick (3s) |
| §2 PgServe health dot | static | re-render only on state flip | — |
| §3 worker counts | static | re-render only on count change | — |
| §1 HW bars | static | re-render per 3s poll | — |
| Dividers | static | never | — |

Severance restraint: **one element pulses, everything else is calm**. Snapshot test asserts no rogue `useTimeline` calls outside `TokenBurnMeter.tsx` and `Sparkline.tsx`.

### SSH/throttle behavior

```ts
const isRemote = Boolean(process.env.SSH_CONNECTION);
const pulseFps = isRemote ? 4 : 60;
const disablePulse = process.env.GENIE_TUI_PULSE === 'off';
```

Default 60fps locally, 4Hz over SSH (still legibly pulsing, no jank). Hard kill with `GENIE_TUI_PULSE=off`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | SS-1 token-burn meter as the single scene-stealer | The one number that matters across N parallel teams; ties into existing cost language; arresting visual |
| 2 | Top-header layout (Layout A) | Cockpit warning lights philosophy: most-important highest in peripheral vision |
| 3 | One pulsing element only — Severance restraint | Multiple animations look gimmicky; restraint is the aesthetic |
| 4 | ccusage source for v1, PG once `session-cost-extraction` lands | Honest about gap; matches `bare-genie-dashboard` precedent; adapter pattern for swap |
| 5 | Per-section component decomposition (no monolithic rewrite) | Single-purpose units; testable in isolation; easier to ship phased |
| 6 | New `lib/tui-stats/` module owns all polling/baseline math | Keep components pure render-from-props; no data fetching in render path |
| 7 | Hysteresis (enter > 90%, exit < 85%) on alarm thresholds | Prevents flicker on borderline values |
| 8 | SSH detection auto-throttles animation to 4Hz | Remote terminals can't sustain 60fps; flat-cap better than choppy 60fps |
| 9 | Width guard: < 28 cols → fallback single-line big-text | ascii-font has hard width minimum; nav can be narrower |
| 10 | No "active wish" or single-track framing anywhere | Felipe runs many tracks; singular framing misleads |
| 11 | Calm static at $0 burn (no pulse, no alarm) | Idle ≠ alarm; preserve attention budget |
| 12 | New `getServeStats()` helper (~30 LOC) added to `lib/db.ts` | Small surface; adjacent to existing `isAvailable()`; no new module needed |
| 13 | Snapshot tests use the `design-system-severance` Group 6 visual harness | Reuse the regression infra; one snapshot system across the design system |
| 14 | Backwards-compat: keep current `SystemStats` exported name | Nav.tsx imports stay unchanged; refactor is internal |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| ccusage shell-out adds latency or is missing | Medium | SS-1 degrades to dim `—¢/min` static; `bare-genie-dashboard` already proves the pattern |
| 60fps `useTimeline` thrashes over SSH | Medium | Auto-detect `SSH_CONNECTION`; throttle to 4Hz; `GENIE_TUI_PULSE=off` escape hatch |
| `ascii-font` overflows narrow terminals (< 28 cols) | Medium | Width guard: fall back to single-line big-text if nav width < 28 |
| FrameBuffer sparkline cost per tick | Low | Reuse FB instance across renders; only redraw when data changes |
| `getServeStats()` is new (~30 LOC) | Low | Pure SQL: `SELECT count(*) FROM pg_stat_activity` + queue + `now()-query_start` p50 |
| Token-burn baseline needs in-memory ring buffer | Low | 60-sample circular buffer (~few KB); discard on TUI exit |
| "Animated everywhere" feels gimmicky | Medium | Snapshot test enforces single pulse element; reviewer rejects PRs adding more |
| Idle $0 burn creates visual void | Low | Static dim "$0.00/min · idle" — no pulse, no alarm |
| Coupling to `design-system-severance` — needs its tokens | Low | Soft dep; can ship token shim if order inverts; ideally co-ship |
| ccusage upstream format change | Low | `lib/tui-stats/cost.ts` is the single adapter point |
| Hysteresis still flickers across burn baseline shift | Low | 5pp deadband + 5-min rolling mean smooths short-term spikes |

## Success Criteria

- [ ] Bar renders in ≤12 lines × ≥28 cols; gracefully truncates §3 details (not §4) on narrower nav.
- [ ] SS-1 ascii-font displays live cents/min from ccusage with 1Hz mint pulse in normal state.
- [ ] SS-1 pulses crimson at 2Hz when 60s burn > (5-min mean + 2σ); reverts to mint after 5pp deadband.
- [ ] SS-1 falls back to `—¢/min` dim-static when ccusage unavailable (no crash, no error overlay).
- [ ] §1 HW shows CPU/RAM/disk-free/disk-IO-latency, colored via recalibrated `pickColor` (>70/>90 from `design-system-severance`).
- [ ] §2 PgServe shows health + active conn / pool max + queue depth + p50 latency; degrades to "PG offline" when `isAvailable()` returns false.
- [ ] §3 Genie ops shows worker aggregate (across ALL teams), mailbox queue depth, last event kind+age — no singular-wish framing.
- [ ] Animation auto-throttles to 4Hz under `SSH_CONNECTION`; opt-out via `GENIE_TUI_PULSE=off`.
- [ ] Snapshot tests cover: idle/$0, normal burn, alarm burn, ccusage-missing, PG-offline, all-healthy, narrow-nav fallback.
- [ ] No regression in nav scroll/keyboard latency vs current ASCII bar.
- [ ] All hex literals in new code reference `genie-tokens` (no raw `#xxx` per `design-system-severance` Group 5 success criterion).
- [ ] `bun run typecheck && bun run lint && bun run test` all green.

## Self-review checklist

- [x] **Placeholder scan** — no TBD, no TODO, no incomplete sections.
- [x] **Internal consistency** — OUT excludes "active wish" framing AND criteria say "no singular-wish framing" (consistent); decision #3 says only one pulse AND animation grammar table shows only SS-1 pulses (consistent).
- [x] **Scope check** — single cohesive surface (one panel in `SystemStats.tsx`); not multi-subsystem.
- [x] **Ambiguity check** — thresholds quantified (>70/>90, 2σ, 5pp deadband, 28 cols); animation rates explicit (1Hz/2Hz/4Hz/60fps).
