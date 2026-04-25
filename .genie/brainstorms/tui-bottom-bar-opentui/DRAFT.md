# Brainstorm Draft — TUI Bottom Bar OpenTUI Upgrade

| Field | Value |
|-------|-------|
| **Slug** | `tui-bottom-bar-opentui` |
| **Date** | 2026-04-25 |
| **WRS** | 20/100 |
| **Adjacent** | `design-system-severance` (palette wish — this brainstorm consumes its tokens) |

## Problem (seed)

`src/tui/components/SystemStats.tsx` renders the bottom of the left nav using **plain ASCII bars** (`[====----]` from a string-padding helper) with **no animation**, **no opentui-native primitives**, and a **content set limited to OS metrics** (CPU, hot cores, RAM, swap, load avg). Now that the `opentui` skill is installed and we have access to `<slider>`, `<ascii-font>`, `FrameBuffer`, `useTimeline` (60fps tweening), and the React-intrinsic component set, the bottom bar can become a **proper genie status surface** — both visually richer (real bars, gauges, sparklines, animated pulses) and content-richer (genie-specific states: active wish, workers, queue depth, heartbeat, etc.).

This brainstorm decides **what content** belongs in the bottom bar and **which opentui primitives** render it, before /wish.

## OpenTUI primitives available (from the skill)

| Primitive | Use case here |
|-----------|---------------|
| `<slider>` | True draggable bar — but works read-only at fixed % for CPU/RAM/load |
| `<ascii-font>` | Big-glyph titles (Lumon-style "GENIE" or refinery counters) |
| `FrameBuffer` | Custom graphics — sparklines, mini gauges, the throbbing "scary numbers" effect |
| `useTimeline` | 60fps tweening — pulse, fade, slide-in animations |
| `<scrollbox>` | If we ever want a horizontally-scrolling event ticker |
| `<box>` + `<text>` + `<span>` | Already in use — semantic layout |

## Candidate content (seeded — to be triaged with Felipe)

### A. OS metrics (current, kept)
- CPU combined % + hot cores + core count
- RAM used/total + %
- Swap used/total + % (only if swap > 0)
- Load avg (1-min) + busy/total cores

### B. Genie-native states (new — pick subset)
- **Active wish** — slug + current phase (Wave N/M) — pulses when a worker is acting
- **Workers running** — live count split by state (`●3 working / ○1 idle / ⊘0 error`)
- **PG connection** — heartbeat pulse (mint when healthy, amber on lag, crimson on disconnect)
- **Mailbox queue depth** — pending messages across all sessions
- **Last event** — `kind` + age (e.g., `event: agent.spawn 3s ago`)
- **Active branch** — git branch + ahead/behind for the focused agent's worktree
- **Token spend (1h window)** — claude / openai cents — sparkline of last 60 minutes
- **Disk** — `~/.genie` GB + % of partition
- **Network** — bytes in/out for active `bridge` sessions
- **Build/test signal** — last `bun test` result + age (green ✓ / red ✗ / spinning if running)
- **Severance flair** — Lumon "Mysterious & Important" rotating subtitle (purely decorative, slow throb)

### C. Visual language (Severance — see adjacent wish)
- Bars in `palette.accent` mint by default; `palette.warning` amber > 70%; `palette.error` crimson > 90% (per `pickColor` recalibration)
- Slow pulse on accent items (using `useTimeline`, ~1Hz, 80–100% opacity) for "alive" indicators
- Sparklines in FrameBuffer using single-cell block characters (`▁▂▃▄▅▆▇█`) with token colors
- Optional CRT-style flicker on the top "GENIE" ascii-font header (rare, ~once per 30s)

## Existing layout constraint

Current bar is **6 lines** at the bottom of a typically narrow left nav (~30-40 cols wide, depending on user split). New widgets must respect:
- Width budget: ~30-40 cols
- Height budget: 4-8 lines (stretching this is a decision point — see Q1 below)
- Refresh rate: currently 3s for stats. Animation tier needs its own RAF loop independent of the polling tick.

## Adjacent wish — `bare-genie-dashboard` (do NOT duplicate)

The full-screen "Clancy" dashboard wish (`bare-genie-dashboard/WISH.md`) already owns: NUMBERS column (agent-hours, tokens, spend, streaks, in-flight), AGENT FEED stream, 8 toggle panels (kanban/tree/bar chart/severity stream/sparkline tail). That's the **headline** surface.

This bar is a **peripheral always-on glance** — think aircraft cockpit warning lights vs. the navigation display. Dashboard tells you *what's happening*; bar tells you *whether anything is wrong*. No overlap.

## Refined content (per Felipe 2026-04-25)

Felipe explicit pivots:
- ❌ DROP the "active wish" framing — he runs many tracks in parallel; singular wish info is misleading.
- ✅ KEEP HW stats (CPU, RAM, swap, load).
- ✅ ADD disk free + **disk I/O latency** (the "is the disk being strangled" signal — `si.disksIO()` exposes `rWaitTime/wWaitTime`).
- ✅ ADD pgserve health + quick-stats so we see "PG isn't drowning" at a glance.
- ✅ Severance flair stays cool — but pick **one scene-stealer**, don't spray flourishes.

### Confirmed sections

**§1 System (existing, kept + extended)**
- CPU % (from `si.currentLoad()`)
- RAM used/total (from `si.mem()`)
- Swap (only when > 0)
- Load avg (1-min)
- **NEW** Disk free GB + % (from `si.fsSize()`)
- **NEW** Disk I/O latency ms (from `si.disksIO().rWaitTime/wWaitTime` deltas across ticks)

**§2 PgServe (new)**
- Health pulse: green (healthy) / amber (slow) / crimson (unreachable) — `lib/db.ts::isAvailable()` already exists
- Active connections / pool max
- Queue depth (pending statements)
- Last query latency p50

**§3 Genie operations (new — multi-track friendly, no singular "active wish")**
- Workers aggregate: `●N working / ○M idle / ⊘K error` (across ALL teams)
- Mailbox queue depth (total backpressure across all sessions)
- Last event (kind + age) — "is genie alive at all?"
- **Token burn rate** (last 60s, in cents/min) — parallel-friendly because it's the sum across all work; ties into the gamified dashboard's cost language without duplicating its panels

**§4 Scene-stealer — LOCKED 2026-04-25: SS-1 Live token-burn meter**

- Big `<ascii-font>` counter showing live cents/min (or $/min if > 100¢)
- Default mint pulse (slow ~1Hz, opacity 80→100% via `useTimeline`)
- Crimson pulse + sharper rate (~2Hz) when burn spikes > 2σ above 5-min rolling baseline
- Sub-line: "vs avg ↑X% / ↓X%" + 60s sparkline (`FrameBuffer` micro-sparkline using `▁▂▃▄▅▆▇█`)
- Data source: ccusage stream for v1 (already used by `bare-genie-dashboard`); swap to PG `sessions.cost_total` once `session-cost-extraction` lands
- Degraded states:
  - ccusage unavailable → counter shows `—¢/min` in `palette.textDim`, no pulse
  - All-zero burn → calm mint static, no pulse (don't "alarm" on idle)
- Width budget: must fit ~28-30 cols (typical nav width). Use opentui's `tiny` ascii-font (3-col glyphs); "$1.23/min" = 9 chars × 3 = 27 cols — fits.

## Scene-stealer candidates — what steals the show

The bar is small (~30-40 cols × 8-12 lines) but it's *always* visible. The scene-stealer is the **one thing your eye lands on first** when you glance at the TUI. It needs to be Severance-grade (Lumon institutional, calm-but-arresting) and ideally serve a real signal.

| ID | Concept | Visual | OpenTUI primitives | Signal value |
|----|---------|--------|--------------------|--------------|
| **SS-1** | **Live token-burn meter** | Big ASCII-font cents/min counter, slow mint pulse normally, ticks crimson when burn > 2σ | `<ascii-font>` + `useTimeline` color tween | Money awareness across all parallel work — the one number that matters when running 5 teams |
| **SS-2** | **PgServe heartbeat pulse** | Lumon-style throbbing dot + waveform sparkline tracking query rate; visible loss = alarm | `FrameBuffer` (sparkline) + `useTimeline` opacity pulse | Catches PG silently degrading; pulse rate = pulse of system |
| **SS-3** | **Disk-latency tachometer** | Circular gauge (FrameBuffer ASCII-art arc) with redline; needle sweeps as I/O wait climbs | `FrameBuffer` (custom arc renderer) + `useTimeline` needle tween | Catches disk overload before it cascades; rare-but-critical |
| **SS-4** | **Workers parade** | Animated row of mint dots — one per worker — drifting across, brightness = liveness | `FrameBuffer` cell animation | Vibe of "swarm at work"; gamified flavor |
| **SS-5** | **CRT-style refinery counter** | Severance MDR throbbing-numbers panel: `0048` style fixed-width counter, scary numbers (errors, alarms) tremor | `<ascii-font>` + `FrameBuffer` glitch frames | Maximum Severance fidelity; pure aesthetic |
| **SS-6** | **Severance "Mysterious & Important" rotator** | Slow-throbbing Lumon footer subtitle — "Everything is fine. Refinement continues." rotating with system mood | `<text>` + `useTimeline` opacity | Pure decoration; brand moment |

## Data source confirmation (no vaporware)

| Item | Source | Already exists? |
|------|--------|-----------------|
| CPU/RAM/swap/load | `systeminformation` | ✅ used today |
| Disk free | `si.fsSize()` | ✅ available |
| Disk I/O latency | `si.disksIO().rWaitTime/wWaitTime` deltas | ✅ available, needs delta calc |
| PgServe health | `lib/db.ts::isAvailable()` | ✅ exists |
| PgServe conn/queue/latency | new helper `lib/db.ts::getServeStats()` | needs adding (~30 LOC) |
| Workers aggregate | `agent-registry.listAgents()` + state count | ✅ exists |
| Mailbox queue depth | PG mailbox table | ✅ exists |
| Last event | `genie_runtime_events` PG table | ✅ exists |
| Token burn (60s) | ccusage stream OR PG sessions cost (post `session-cost-extraction`) | ⏳ ccusage v1, PG once dependency lands |

## Open questions (closed)

- **Q1 (settled):** §1 + §2 + §3 + §4. Height: ~10-12 lines (was 6).
- **Q2 (settled 2026-04-25):** SS-1 token-burn meter as scene-stealer.
- **Q3 (settled 2026-04-25):** Layout A — SS-1 top header, vitals descending below.

## Final layout (Layout A — top header)

```
┌──────────────────────────────┐
│  $1.23/min          ▁▂▄▆█▆▄▂ │  ← SS-1 ascii-font (4 lines), 60s sparkline
│  vs 5-min avg ↑12%           │
├──────────────────────────────┤  ← thin divider in palette.border
│ ●3 working ○2 idle ⊘0        │  §3 Genie ops
│ q4 · last: agent.spawn  3s   │
├──────────────────────────────┤
│ ●healthy  5/20 conn          │  §2 PgServe
│ q0 · p50 12ms                │
├──────────────────────────────┤
│ CPU 24% ▒▒▒▒░░░░  4c         │  §1 HW (existing + extended)
│ RAM 4.2/16G ▒▒░░░░░░         │
│ DSK 32/100G ▒▒▒░░░░░  io 8ms │
└──────────────────────────────┘
```

12 lines × 30 cols. Each metric uses `palette.accent` (mint) by default; flips to `palette.warning` then `palette.error` per recalibrated `pickColor` (>70/>90 thresholds from the `design-system-severance` wish). Only SS-1 animates by default; vitals are static between 3s polls (no jank on slow terminals).

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| ccusage shell-out adds latency or is missing | Medium | SS-1 degrades to dim `—¢/min` static; dashboard wish already proves the pattern |
| 60fps `useTimeline` animation thrashes over SSH | Medium | Detect `process.env.SSH_CONNECTION`; throttle to 4Hz; expose `GENIE_TUI_PULSE=off` escape hatch |
| `ascii-font` overflows narrow terminals (< 28 cols) | Medium | Width guard: if nav width < 28, fall back to single-line big-text fallback (no ascii-font) |
| FrameBuffer sparkline cost per tick | Low | Reuse FB across renders; only redraw when data changes; static under no-burn |
| Token burn baseline (5-min rolling σ) needs client ring buffer | Low | In-memory circular buffer of last 60 samples (~few KB); discard on TUI exit |
| `getServeStats()` is new — small but unowned | Low | ~30 LOC helper in `lib/db.ts`: `pg_stat_activity` count + queue length + `now()-query_start` p50 |
| "Animated everywhere" feels gimmicky | Medium | Severance restraint: ONLY SS-1 pulses; everything else is calm. Snapshot test enforces it |
| Burn meter at $0/min during idle creates visual void | Low | Static dim "$0.00/min · idle" — no pulse, no alarm |
| Coupling to `design-system-severance` — needs its tokens to ship | Low | Soft dep; this wish blocks until that one merges (or co-ships in same PR train) |
| ccusage parse format changes upstream | Low | Wrap in adapter `lib/cost-source.ts`; one swap point when PG `session-cost-extraction` lands |
| Alert flicker on borderline values (oscillating across threshold) | Low | Hysteresis: enter alarm at >90%, exit at <85% (5-pt deadband) |

## Success Criteria

- [ ] Bar renders in ≤12 lines × ≥28 cols; gracefully truncates §3 details (not §4 SS-1) on narrower nav.
- [ ] SS-1 ascii-font centerpiece displays live cents/min from ccusage with 1Hz mint pulse in normal state.
- [ ] SS-1 pulses crimson at 2Hz when 60s burn > (5-min mean + 2σ); reverts to mint after deadband.
- [ ] SS-1 falls back to `—¢/min` dim-static when ccusage unavailable (no crash, no error overlay).
- [ ] §1 HW shows CPU/RAM/disk-free/disk-IO-latency, all colored via recalibrated `pickColor` (>70 amber, >90 crimson).
- [ ] §2 PgServe shows health pulse + active conn / pool max + queue depth + p50 latency; degrades to "PG offline" when `isAvailable()` returns false.
- [ ] §3 Genie ops shows worker aggregate, mailbox queue depth, last event kind+age — all live across all teams (no "active wish" framing).
- [ ] Animation auto-throttles to 4Hz under SSH; full 60fps locally; opt-out via `GENIE_TUI_PULSE=off`.
- [ ] Snapshot tests cover: idle ($0 burn), normal burn, alarm burn, ccusage-missing, PG-offline, all-healthy.
- [ ] No regression in nav scroll/keyboard nav latency vs current ASCII bar.
- [ ] Lints clean, contrast passes WCAG AA against new Severance bg.

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```
