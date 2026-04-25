# Design: TUI Bottom Bar — OpenTUI Upgrade + Genie-Native Status Surface

| Field | Value |
|-------|-------|
| **Slug** | `tui-bottom-bar-opentui` |
| **Date** | 2026-04-25 |
| **WRS** | 100/100 |
| **HARD DEP** | `design-system-severance` Group 1 (token source of truth) — must ship first; this design imports `palette.X` and the recalibrated `pickColor` thresholds from `packages/genie-tokens/` |
| **Soft dep** | `session-cost-extraction` (PG cost source — ccusage adapter is the v1 path; PG is a v2 swap when extraction lands) |
| **Adjacent (non-overlapping)** | `bare-genie-dashboard` (full-screen Clancy dashboard — that's the navigation display; this is the cockpit warning panel) |

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

**§2 — PgServe panel (new)** — full SQL contract for `getServeStats()`:

| Metric | Source | Exact query / source |
|--------|--------|----------------------|
| Health pulse | existing | `lib/db.ts::isAvailable()` (boolean) |
| Active conn | new SQL | `SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND backend_type = 'client backend'` |
| Pool max | client config | Read from genie's pg pool config (`config.json::pgServeMaxConnections`); falls back to `SHOW max_connections` if unset |
| Queue depth | new SQL | `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type IN ('Lock','IO','BufferPin')` (statements waiting on lock or IO — PG has no formal queue, this is the closest proxy) |
| p50 latency | new SQL | `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now() - query_start)) * 1000) FROM pg_stat_activity WHERE state = 'active' AND backend_type = 'client backend' AND query_start IS NOT NULL` (median age of running queries in ms) |

If `pg_stat_statements` extension is installed, prefer `mean_exec_time` from there; otherwise use the active-query-age fallback above. Detect via `SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'`.

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
// Frame rate (animation sample rate) — independent of pulse rate.
// Pulse rate stays 1Hz / 2Hz; only how many samples-per-second changes.
const isRemoteHeuristic =
  Boolean(process.env.SSH_CONNECTION) ||  // standard ssh
  Boolean(process.env.SSH_CLIENT) ||
  Boolean(process.env.SSH_TTY);
const sampleHz =
  process.env.GENIE_TUI_PULSE === 'off' ? 0 :
  process.env.GENIE_TUI_PULSE === 'full' ? 60 :        // user override
  process.env.GENIE_TUI_PULSE === 'low' ? 4 :          // user override
  isRemoteHeuristic ? 4 : 60;
```

**Heuristic limitations** (documented honestly):
- ✅ Detects: openssh, dropbear (any tool that sets `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY`)
- ❌ Misses: `mosh` (clears env vars after handshake), `tmate` (sometimes preserves SSH_CONNECTION, sometimes not), `code-server`/browser terminals (no SSH env), nested tmux sessions over an existing local tmux
- ⛑️ Escape hatches: `GENIE_TUI_PULSE=off` (kill animation), `=low` (force 4Hz), `=full` (force 60fps)

**Frame rate ≠ pulse rate.** A 1Hz mint pulse remains 1Hz at any sample rate; only the smoothness of the opacity tween changes. At 4Hz, a normal-state pulse still completes one full opacity cycle per second — just rendered at 4 keyframes per second instead of 60. Snapshot test enforces this distinction.

### Hysteresis spec (frozen baseline + min hold)

Why "5pp deadband against a 5-min rolling mean" is ambiguous: if the mean drifts upward while in alarm, an unfrozen exit threshold also drifts and you can exit alarm without burn actually decreasing. Spec:

```ts
type AlarmState =
  | { kind: 'normal' }
  | { kind: 'alarm'; enteredAt: number; thresholdAtEntry: number };

function step(currentBurn: number, rolling5min: { mean: number; sigma: number }, state: AlarmState, now: number): AlarmState {
  if (state.kind === 'normal') {
    const enterThreshold = rolling5min.mean + 2 * rolling5min.sigma;
    if (currentBurn > enterThreshold) {
      return { kind: 'alarm', enteredAt: now, thresholdAtEntry: enterThreshold };
    }
    return state;
  }
  // In alarm: must satisfy BOTH conditions to exit
  const minHoldMs = 5_000;
  const heldLongEnough = now - state.enteredAt >= minHoldMs;
  const exitThreshold = state.thresholdAtEntry * 0.85;  // 15% below ENTRY threshold (frozen)
  const burnFellBelow = currentBurn < exitThreshold;
  if (heldLongEnough && burnFellBelow) {
    return { kind: 'normal' };
  }
  return state;
}
```

- **Entry**: burn > (current rolling mean + 2σ).
- **Exit**: requires (a) elapsed ≥ 5s in alarm AND (b) burn < 0.85 × entry-threshold (computed against the **frozen** baseline at entry, not the moving baseline).
- This prevents both rapid flip-flop (min hold) AND spurious exit from baseline drift (frozen threshold).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | SS-1 token-burn meter as the single scene-stealer | The one number that matters across N parallel teams; ties into existing cost language; arresting visual |
| 2 | Top-header layout (Layout A) | Cockpit warning lights philosophy: most-important highest in peripheral vision |
| 3 | One pulsing element only — Severance restraint | Multiple animations look gimmicky; restraint is the aesthetic |
| 4 | ccusage source for v1, PG once `session-cost-extraction` lands | Honest about gap; matches `bare-genie-dashboard` precedent; adapter pattern for swap |
| 5 | Per-section component decomposition (no monolithic rewrite) | Single-purpose units; testable in isolation; easier to ship phased |
| 6 | New `lib/tui-stats/` module owns all polling/baseline math | Keep components pure render-from-props; no data fetching in render path |
| 7 | Hysteresis: **frozen-baseline + min-hold-time** combo | See "Hysteresis spec" below — prevents flicker from both moving baselines and transient noise |
| 8 | SSH detection auto-throttles animation to 4Hz | Remote terminals can't sustain 60fps; flat-cap better than choppy 60fps |
| 9 | Width guard: empirically measure `tiny` font glyph width on first render; fallback if total > nav width | ascii-font glyph width is font-dependent and best confirmed at runtime, not assumed |
| 10 | No "active wish" or single-track framing anywhere | Felipe runs many tracks; singular framing misleads |
| 11 | Calm static at $0 burn (no pulse, no alarm) | Idle ≠ alarm; preserve attention budget |
| 12 | New `getServeStats()` helper (~30 LOC) added to `lib/db.ts` | Small surface; adjacent to existing `isAvailable()`; no new module needed |
| 13 | Snapshot tests use the `design-system-severance` Group 6 visual harness | Reuse the regression infra; one snapshot system across the design system |
| 14 | Backwards-compat: keep current `SystemStats` exported name | Nav.tsx imports stay unchanged; refactor is internal |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| ccusage shell-out adds latency or is missing | Medium | SS-1 degrades to dim `—¢/min` static; `bare-genie-dashboard` already proves the pattern |
| 60fps `useTimeline` thrashes over SSH | Medium | Auto-detect via `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY` (heuristic — see SSH section for known misses); throttle to 4Hz sample rate (pulse rate unchanged); user override via `GENIE_TUI_PULSE={off|low|full}` |
| `ascii-font` overflows narrow terminals | Medium | At first render, query the ascii-font's actual rendered width via opentui's renderable dimensions; if `renderedWidth + sparkline + padding > navWidth`, switch to single-line big-text fallback. Snapshot tests cover three nav widths: 24 (fallback), 30 (target), 40 (luxe). Empirical not assumed — opentui font width is font-dependent. |
| FrameBuffer sparkline cost per tick | Low | Reuse FB instance across renders; only redraw when data changes |
| `getServeStats()` is new (~30 LOC) | Low | Pure SQL: `SELECT count(*) FROM pg_stat_activity` + queue + `now()-query_start` p50 |
| Token-burn baseline needs in-memory ring buffer | Low | 60-sample circular buffer (~few KB); discard on TUI exit |
| "Animated everywhere" feels gimmicky | Medium | Snapshot test enforces single pulse element; reviewer rejects PRs adding more |
| Idle $0 burn creates visual void | Low | Static dim "$0.00/min · idle" — no pulse, no alarm |
| Coupling to `design-system-severance` — needs its tokens | **High** (now hard dep) | Hard prerequisite: `design-system-severance` Group 1 (token source) must merge first. This DESIGN's wish lists it as `depends-on`. If schedule pressure inverts: ship a 50-LOC `genie-tokens` stub from this wish containing only the SS-1 + bar tokens it actually uses, then delete the stub when the full Severance wish merges. |
| ccusage upstream format change | Low | `lib/tui-stats/cost.ts` is the single adapter point |
| Hysteresis still flickers across burn baseline shift | Low | 5pp deadband + 5-min rolling mean smooths short-term spikes |

## Success Criteria

- [ ] Bar renders in ≤12 lines × ≥28 cols; gracefully truncates §3 details (not §4) on narrower nav.
- [ ] SS-1 ascii-font displays live cents/min from ccusage with 1Hz mint pulse in normal state.
- [ ] SS-1 pulses crimson at 2Hz when 60s burn > (5-min mean + 2σ); reverts to mint only after BOTH (a) ≥5s elapsed in alarm AND (b) burn falls below 0.85 × the entry threshold (frozen at alarm entry, NOT recomputed against the moving baseline). Implementation per the `Hysteresis spec` step() function in DESIGN approach.
- [ ] SS-1 falls back to `—¢/min` dim-static when ccusage unavailable (no crash, no error overlay).
- [ ] §1 HW shows CPU/RAM/disk-free/disk-IO-latency, colored via recalibrated `pickColor` (>70/>90 from `design-system-severance`).
- [ ] §2 PgServe shows health + active conn / pool max + queue depth + p50 latency; degrades to "PG offline" when `isAvailable()` returns false.
- [ ] §3 Genie ops shows worker aggregate (across ALL teams), mailbox queue depth, last event kind+age — no singular-wish framing.
- [ ] Animation auto-throttles sample rate to 4Hz under `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY`; pulse rate (1Hz/2Hz) preserved at low sample rate; user override `GENIE_TUI_PULSE={off|low|full}` honored.
- [ ] `getServeStats()` implements the SQL contract in DESIGN §2 PgServe panel table; `pg_stat_statements` extension preferred when present, active-query-age fallback otherwise.
- [ ] Width guard: at first render, query rendered ascii-font width via opentui's renderable dimensions API; fallback to single-line big-text when (renderedWidth + sparkline + padding) > navWidth. Snapshot tests cover nav widths 24 / 30 / 40.
- [ ] Snapshot tests cover: idle/$0, normal burn, alarm burn (full + frozen-baseline drift), alarm exit (5s hold + 0.85 × entry threshold), ccusage-missing, PG-offline, pg_stat_statements-missing, all-healthy, narrow-nav fallback (24 cols), 4Hz SSH sample rate.
- [ ] No regression in nav scroll/keyboard latency vs current ASCII bar.
- [ ] All hex literals in new code reference `genie-tokens` (no raw `#xxx` per `design-system-severance` Group 5 success criterion).
- [ ] `bun run typecheck && bun run lint && bun run test` all green.

## Self-review checklist

- [x] **Placeholder scan** — no TBD, no TODO, no incomplete sections.
- [x] **Internal consistency** — OUT excludes "active wish" framing AND criteria say "no singular-wish framing" (consistent); decision #3 says only one pulse AND animation grammar table shows only SS-1 pulses (consistent); hysteresis spec uses frozen-baseline AND criterion matches (consistent).
- [x] **Scope check** — single cohesive surface (one panel in `SystemStats.tsx`); not multi-subsystem.
- [x] **Ambiguity check** — thresholds quantified (>70/>90, 2σ, ≥5s + 0.85× hold, 24/30/40 col snapshot widths); animation rates split into pulse-rate (1Hz/2Hz, fixed) vs sample-rate (4Hz/60fps, throttled).
- [x] **Dependency clarity** — `design-system-severance` Group 1 is hard dep; `session-cost-extraction` is soft (ccusage v1 is the path); `bare-genie-dashboard` is non-overlapping; stub-token escape hatch documented for schedule pressure.
- [x] **SQL contract** — `getServeStats()` table specifies exact source for each metric (active conn, pool max, queue depth, p50 latency) with `pg_stat_statements` preference + fallback.

## Review responses (2026-04-25, post-/review FIX-FIRST)

| Reviewer gap | Severity | Resolution in this revision |
|--------------|----------|------------------------------|
| Palette token soft-dep ordering undefined | CRITICAL | Header table now lists `design-system-severance` Group 1 as **HARD DEP**; risk row escalated High; stub escape hatch added |
| `getServeStats()` contract under-specified | HIGH | New SQL contract table in §2 PgServe panel — exact queries for each metric + `pg_stat_statements` preference logic |
| SSH throttle detection incomplete | HIGH | Detection now `SSH_CONNECTION`\|\|`SSH_CLIENT`\|\|`SSH_TTY`; mosh/tmate/code-server limitations documented; user override `GENIE_TUI_PULSE={off,low,full}` |
| Hysteresis math ambiguous when baseline drifts | MEDIUM | New "Hysteresis spec" section with executable `step()` function: frozen-baseline at entry + 5s min hold + 0.85× exit threshold |
| Width guard at < 28 cols unvalidated | MEDIUM | Decision #9 + risk row updated: empirical query of ascii-font rendered width at first render, snapshot tests at 24/30/40 cols |
| Transitive hard dep on `session-cost-extraction` | LOW | Soft dep clarified: ccusage adapter is the v1 path; PG cost is a v2 swap, not blocking |
| 60fps→4Hz mapping perceptual ambiguity | LOW | "Frame rate ≠ pulse rate" paragraph added; pulse rate stays 1Hz/2Hz at any sample rate; snapshot test asserts |
