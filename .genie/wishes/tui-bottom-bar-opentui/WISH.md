# Wish: TUI Bottom Bar — OpenTUI Upgrade + Genie-Native Status Surface

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `tui-bottom-bar-opentui` |
| **Date** | 2026-04-25 |
| **Author** | Genie (per Felipe directive 2026-04-25: "improve bottom bar with opentui resources, bars, animations, review the contents itself") |
| **Appetite** | medium (~5 engineer-days across 3 waves) |
| **Branch** | `wish/tui-bottom-bar-opentui` (worker creates worktree at dispatch) |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/tui-bottom-bar-opentui/DESIGN.md) |
| **HARD DEP** | [`design-system-severance`](../design-system-severance/WISH.md) Group 1 (token source of truth) — must merge to dev first; this wish imports `palette.X` and the recalibrated `pickColor` thresholds from `packages/genie-tokens/` |
| **Soft dep** | [`session-cost-extraction`](../session-cost-extraction/WISH.md) (PG cost source — ccusage adapter is the v1 path; PG is a v2 swap when extraction lands) |
| **Adjacent (non-overlapping)** | [`bare-genie-dashboard`](../bare-genie-dashboard/WISH.md) — that wish owns the full-screen Clancy dashboard; this wish owns the always-on cockpit warning panel |

## Summary

Replace the ASCII string bars in `src/tui/components/SystemStats.tsx` with proper OpenTUI primitives (`<ascii-font>`, `FrameBuffer`, `useTimeline`) and rebuild the bar around a 4-section, multi-track operations cockpit anchored by a single arresting scene-stealer: the **SS-1 token-burn meter** (live cents/min in a top-header ascii-font with 60s sparkline + 1Hz mint pulse / 2Hz crimson alarm). Sections below it surface what was previously absent — disk free + I/O latency, PgServe health and stats, multi-track Genie operations (workers aggregate, mailbox queue, last event). Felipe is parallel-track; this wish explicitly excludes "active wish" framing and any duplication of the gamified `bare-genie-dashboard` headline panels.

## Scope

### IN

**Wave 0 — Token stub escape hatch (only if the hard dep slips)**
- If `design-system-severance` Group 1 has NOT merged to dev when this wish dispatches: ship a 50-LOC `packages/genie-tokens/` stub containing only the tokens this wish actually uses (`bg`, `bgRaised`, `accent`, `accentDim`, `accentBright`, `warning`, `error`, `text`, `textDim`, `textMuted`, `border`). Stub is deleted in the same PR as the full Severance tokens. Otherwise skip Wave 0 entirely.

**Wave 1 — Data layer (parallelizable)**

Group 1.1 — `lib/tui-stats/hw.ts`
- Wraps `systeminformation`. Exposes `getHwStats()` returning `{cpu, ram, swap, load, diskFree, diskIoMs}`.
- Disk I/O latency derived from delta of `si.disksIO().rWaitTime/wWaitTime` across two consecutive ticks (3s apart). First tick returns `null`.

Group 1.2 — `lib/tui-stats/pg.ts`
- New `getServeStats()` per the SQL contract table in DESIGN §2 PgServe panel:
  - Active conn: `SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND backend_type = 'client backend'`
  - Pool max: `config.json::pgServeMaxConnections` if set; else `SHOW max_connections`
  - Queue depth: `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type IN ('Lock','IO','BufferPin')`
  - p50 latency: prefer `pg_stat_statements.mean_exec_time` if extension installed; fallback to `percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now() - query_start)) * 1000) FROM pg_stat_activity WHERE state = 'active' AND backend_type = 'client backend'`
  - Health: existing `lib/db.ts::isAvailable()`
- Extension probe: `SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'` cached for the TUI session.

Group 1.3 — `lib/tui-stats/ops.ts`
- Workers aggregate: `agent-registry.listAgents()` filtered + counted by state (`working`/`idle`/`error`).
- Mailbox queue depth: PG mailbox table count.
- Last event: most recent `genie_runtime_events` row → `{kind, ageSeconds}`.

Group 1.4 — `lib/tui-stats/cost.ts`
- ccusage adapter: shells out to `ccusage --json --window 60` (or equivalent), parses cents/min.
- 60-sample circular ring buffer (~2KB) for 5-min rolling mean + σ.
- `step()` alarm state machine per DESIGN "Hysteresis spec":
  - Entry: burn > (rolling mean + 2σ).
  - Exit: requires (a) ≥5s elapsed in alarm AND (b) burn < 0.85 × entry-threshold (frozen at entry).
- Returns `{cents, alarmState, sparklineData[60]}`.
- Degraded mode: ccusage missing → returns `{cents: null, alarmState: 'normal', sparklineData: []}` — components render dim placeholder.

Group 1.5 — `lib/tui-stats/index.ts`
- Composes all four sources. Exposes a single `useStats(intervalMs)` React hook that polls every 3s and returns `{hw, pg, ops, cost}`.

**Wave 2 — Components (parallelizable, depends on Wave 1)**

Group 2.1 — `src/tui/components/BottomBar/Sparkline.tsx`
- Reusable. `props: { data: number[]; width: number; color: string }`.
- Renders via `FrameBuffer` using `▁▂▃▄▅▆▇█` block characters.
- Reuses FrameBuffer instance across renders; only redraws when `data` changes.

Group 2.2 — `src/tui/components/BottomBar/PulseRing.tsx`
- Wraps `useTimeline` for opacity tween.
- `props: { rate: 1 | 2; color: string; sampleHz: number; children: ReactNode }`.
- `sampleHz` controls keyframe density; `rate` is the actual cycles/second (preserved at any sample rate).

Group 2.3 — `src/tui/components/BottomBar/TokenBurnMeter.tsx` (the scene-stealer)
- Top-header layout: 4 lines (ascii-font cents/min + sub-line + sparkline).
- Uses `<ascii-font font="tiny">` for the cents/min number; `Sparkline` below for 60s history.
- Color routes through `PulseRing` — mint normal, crimson on alarm.
- Width guard: at first render, query the rendered ascii-font dimensions via opentui's renderable API; if `(asciiWidth + sparklineWidth + padding) > navWidth`, switch to single-line big-text fallback.
- Static `$0.00/min · idle` (no pulse, no alarm) when `cents === 0`.
- Static dim `—¢/min` (no pulse) when `cents === null` (ccusage missing).

Group 2.4 — `src/tui/components/BottomBar/HwPanel.tsx`
- Three lines: CPU/RAM/disk-free. New disk-IO-latency rendered as " io Xms" suffix on the disk line.
- Uses recalibrated `pickColor` (>70 amber, >90 crimson) imported from `genie-tokens`.

Group 2.5 — `src/tui/components/BottomBar/PgServePanel.tsx`
- Two lines: `●healthy 5/20 conn` and `q0 · p50 12ms`.
- Health dot color: green/amber/crimson based on `isAvailable()` + p50 thresholds.
- Degraded "PG offline" rendering when `isAvailable() === false`.

Group 2.6 — `src/tui/components/BottomBar/GenieOpsPanel.tsx`
- Two lines: worker aggregate + (queue + last event).
- Worker glyphs: `●N working ○M idle ⊘K error`.
- Last event format: `last: <kind> <age>s` where kind is event.kind and age is `now - event.timestamp` in seconds.

**Wave 3 — Integration + verification (sequential)**

Group 3.1 — `src/tui/components/SystemStats.tsx` rewrite
- Becomes thin orchestrator: calls `useStats()`, renders the four panels in Layout A order (TokenBurnMeter → divider → GenieOpsPanel → divider → PgServePanel → divider → HwPanel).
- Implements SSH heuristic + `GENIE_TUI_PULSE` parsing per DESIGN "SSH/throttle behavior".
- Backward-compat: keeps the `SystemStats` exported component name; `Nav.tsx` import unchanged.

Group 3.2 — Snapshot tests
- `test/visual/bottom-bar.snapshot.test.tsx` (or extends existing `design-system-severance` Group 6 harness).
- Snapshots required:
  - idle / $0 burn
  - normal burn (cents > 0, no alarm)
  - alarm burn (entry — full + frozen-baseline drift)
  - alarm exit (5s hold + 0.85× entry threshold)
  - ccusage-missing
  - PG-offline
  - pg_stat_statements-missing
  - all-healthy
  - narrow-nav fallback (24 cols)
  - 4Hz SSH sample rate (pulse rate preserved)

Group 3.3 — Documentation
- Update `docs/design-system.md` (created by `design-system-severance` Group 7) to add a "Bottom bar" section describing the four panels, the SS-1 scene-stealer, and the SSH throttle environment variables.

### OUT

- **Multiple animated elements.** Severance restraint: only SS-1 pulses. Snapshot test enforces no rogue `useTimeline` calls outside `TokenBurnMeter` and `Sparkline` components.
- **Per-team token-burn breakdown.** Aggregate cents/min only — drilldown lives in `bare-genie-dashboard`'s Costs panel.
- **Theme variants** (Lumon-MDR / Optics / Breakroom). Defer to `design-system-severance` follow-up.
- **Active-wish or any single-track framing.** Felipe runs many tracks in parallel; singular-wish info is misleading.
- **Layout changes outside the `SystemStats` panel slot.** `Nav.tsx` is untouched.
- **New event-stream ingestion.** Uses existing PG tables only.
- **Replacing `systeminformation`** with a different metrics lib.
- **User-toggleable sections / configurable layouts.** Single canonical Layout A in v1.
- **Duplicating `bare-genie-dashboard` NUMBERS** (agent-hours, streaks, in-flight). Different surface, different purpose.
- **Animating the static panels** (HwPanel / PgServePanel / GenieOpsPanel).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | SS-1 token-burn meter as single scene-stealer in top-header layout | The one number that matters across N parallel teams; cockpit-warning-light philosophy |
| 2 | Hard dep on `design-system-severance` Group 1 (with stub escape hatch) | Avoids hex-literal duplication; stub guarantees we can ship even under schedule pressure |
| 3 | One pulsing element only — Severance restraint | Multiple animations look gimmicky; restraint is the aesthetic |
| 4 | ccusage source for v1, PG once `session-cost-extraction` lands | Honest about gap; matches `bare-genie-dashboard` precedent; adapter pattern at `cost.ts` |
| 5 | Per-section component decomposition | Single-purpose units per Design-for-Isolation; testable; phased shippable |
| 6 | New `lib/tui-stats/` module owns all polling/baseline math | Components stay pure render-from-props; data fetching out of render path |
| 7 | Frozen-baseline + 5s min hold hysteresis (executable `step()` in DESIGN) | Prevents both rapid flip-flop AND drift-induced false exits |
| 8 | SSH heuristic via `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY`; auto-throttle to 4Hz sample rate | Pragmatic; user override `GENIE_TUI_PULSE={off,low,full}` covers misses (mosh/tmate/code-server) |
| 9 | Empirical width guard: query rendered ascii-font dimensions at first render | Font width is font-dependent; assumption-free fallback |
| 10 | No "active wish" framing anywhere | Felipe runs many tracks in parallel |
| 11 | Calm static (no pulse) at $0 burn | Idle ≠ alarm; preserve attention budget |
| 12 | `getServeStats()` lives in `lib/tui-stats/pg.ts`, not `lib/db.ts` | Keeps `db.ts` minimal; TUI-specific shape stays in TUI module |
| 13 | Snapshot tests reuse `design-system-severance` Group 6 visual harness | One regression infra across the design system |
| 14 | Backwards-compat: keep `SystemStats` component name | `Nav.tsx` import stays unchanged; refactor is internal |
| 15 | `pg_stat_statements` extension preferred when present, active-query-age fallback otherwise | Best signal when available, graceful degradation otherwise |

## Success Criteria

- [ ] Bar renders in ≤12 lines × ≥28 cols; gracefully truncates §3 details (not §4 SS-1) on narrower nav.
- [ ] SS-1 ascii-font displays live cents/min from ccusage with 1Hz mint pulse in normal state.
- [ ] SS-1 pulses crimson at 2Hz when 60s burn > (5-min mean + 2σ); reverts to mint only after BOTH (a) ≥5s elapsed in alarm AND (b) burn < 0.85 × entry-threshold (frozen at alarm entry, NOT recomputed against the moving baseline).
- [ ] SS-1 falls back to `—¢/min` dim-static when ccusage unavailable; calm static `$0.00/min · idle` when burn === 0 (no pulse, no alarm).
- [ ] §1 HW shows CPU/RAM/disk-free + disk-IO-latency, colored via recalibrated `pickColor` (>70 amber, >90 crimson) imported from `genie-tokens`.
- [ ] §2 PgServe shows health pulse + active conn / pool max + queue depth + p50 latency per the DESIGN §2 SQL contract; `pg_stat_statements` extension preferred when present, active-query-age fallback otherwise.
- [ ] §2 PgServe degrades to "PG offline" rendering when `isAvailable() === false`.
- [ ] §3 Genie ops shows worker aggregate (across ALL teams), mailbox queue depth, last event kind+age — no singular-wish framing anywhere.
- [ ] Animation auto-throttles sample rate to 4Hz under `SSH_CONNECTION || SSH_CLIENT || SSH_TTY`; pulse rate (1Hz/2Hz) preserved at low sample rate; user override `GENIE_TUI_PULSE={off|low|full}` honored.
- [ ] Width guard: at first render, query rendered ascii-font width via opentui's renderable dimensions API; fallback to single-line big-text when (renderedWidth + sparkline + padding) > navWidth. Snapshots verify fallback at 24 cols, intended layout at 30 cols, luxe layout at 40 cols.
- [ ] All hex literals in new code reference `genie-tokens` (no raw `#xxx` per `design-system-severance` Group 5 success criterion). Stub-token escape hatch invoked only if Wave 0 prerequisite triggered.
- [ ] Snapshot tests cover: idle/$0, normal burn, alarm burn (entry + frozen-baseline drift), alarm exit (5s hold + 0.85× entry threshold), ccusage-missing, PG-offline, pg_stat_statements-missing, all-healthy, narrow-nav fallback (24 cols), 4Hz SSH sample rate.
- [ ] `bun run typecheck && bun run lint && bun run test` all green on the wish branch.
- [ ] No regression in nav scroll/keyboard latency vs current ASCII bar (manual smoke + `bun test test/tui` baseline preserved).

## Execution Strategy

### Wave 0 (conditional — only if hard dep slipped)

| Group | Agent | Description |
|-------|-------|-------------|
| 0 | engineer | Ship `genie-tokens` stub (50 LOC, only the tokens this wish uses); deletes when full Severance wish merges |

### Wave 1 (parallel) — data layer

| Group | Agent | Description |
|-------|-------|-------------|
| 1.1 | engineer | `lib/tui-stats/hw.ts` — systeminformation wrap + disk-IO-latency delta |
| 1.2 | engineer | `lib/tui-stats/pg.ts` — `getServeStats()` per SQL contract + extension probe |
| 1.3 | engineer | `lib/tui-stats/ops.ts` — workers aggregate + mailbox + last event |
| 1.4 | engineer | `lib/tui-stats/cost.ts` — ccusage adapter + ring buffer + `step()` hysteresis |
| 1.5 | engineer | `lib/tui-stats/index.ts` — `useStats(intervalMs)` composing hook |

### Wave 2 (parallel, after Wave 1) — components

| Group | Agent | Description |
|-------|-------|-------------|
| 2.1 | engineer | `BottomBar/Sparkline.tsx` — reusable FrameBuffer block-char sparkline |
| 2.2 | engineer | `BottomBar/PulseRing.tsx` — useTimeline opacity wrapper, sampleHz vs rate split |
| 2.3 | engineer | `BottomBar/TokenBurnMeter.tsx` — SS-1 scene-stealer + width guard + degraded states |
| 2.4 | engineer | `BottomBar/HwPanel.tsx` — §1 with disk + IO latency |
| 2.5 | engineer | `BottomBar/PgServePanel.tsx` — §2 with PG-offline degradation |
| 2.6 | engineer | `BottomBar/GenieOpsPanel.tsx` — §3 multi-track aggregate |

### Wave 3 (sequential, after Wave 2) — integration + verification

| Group | Agent | Description |
|-------|-------|-------------|
| 3.1 | engineer | `SystemStats.tsx` rewrite — orchestrator + SSH heuristic + GENIE_TUI_PULSE parsing |
| 3.2 | engineer | Snapshot tests — 10 named cases per success criteria |
| 3.3 | engineer | Docs — `docs/design-system.md` "Bottom bar" section |
| review | reviewer | Full execution review of all groups against success criteria |

### Wave 4 (after review SHIP)

| Group | Agent | Description |
|-------|-------|-------------|
| qa | qa | Manual smoke: `genie tui` boots with new bar; SS-1 pulses correctly under live ccusage; PG-offline test by stopping pgserve; SSH test by detaching+reattaching with `SSH_CONNECTION` set; capture before/after screenshots for PR |

## Execution Groups

### Group 1.1: HW data source

**Goal:** `lib/tui-stats/hw.ts` exposes `getHwStats()` with CPU/RAM/swap/load/diskFree/diskIoMs.

**Deliverables:**
1. `src/lib/tui-stats/hw.ts` with `getHwStats(): Promise<HwStats>` returning the shape declared in DESIGN.
2. Disk I/O latency calculated as `(rWaitTime_now - rWaitTime_prev + wWaitTime_now - wWaitTime_prev) / (timeDelta_ms)` averaged across the delta window. Module-local previous-tick cache.
3. First call returns `diskIoMs: null` (no delta yet).
4. Unit tests: shape contract, null-on-first-call, delta-on-second-call.

**Acceptance Criteria:**
- [ ] `bun test src/lib/tui-stats/hw.test.ts` passes.
- [ ] Returns valid shape with all 6 fields after second call.
- [ ] `diskIoMs` is `null` on first call, `number` on second.

**Validation:**
```bash
bun test src/lib/tui-stats/hw.test.ts
bun -e "import { getHwStats } from './src/lib/tui-stats/hw.ts'; await getHwStats(); console.log(await getHwStats())"
```

**depends-on:** Wave 0 (if triggered) or `design-system-severance` Group 1 (the `genie-tokens` package must exist).

---

### Group 1.2: PgServe stats

**Goal:** `lib/tui-stats/pg.ts` exposes `getServeStats()` per the SQL contract.

**Deliverables:**
1. `src/lib/tui-stats/pg.ts` with `getServeStats(): Promise<PgStats>` returning `{health, activeConn, poolMax, queueDepth, p50Ms}`.
2. Extension probe `hasPgStatStatements()` cached per TUI session.
3. p50 calculation routes through `pg_stat_statements.mean_exec_time` if extension present, else `percentile_cont` over `query_start` ages.
4. Pool max sourced from `config.json::pgServeMaxConnections` first, then `SHOW max_connections`.
5. Returns `{health: false, ...nullableMetrics}` when `isAvailable() === false`.
6. Unit tests with mocked PG client.

**Acceptance Criteria:**
- [ ] `bun test src/lib/tui-stats/pg.test.ts` passes.
- [ ] Both p50 paths verified (extension-present mock + extension-absent mock).
- [ ] `getServeStats()` returns valid shape under PG-offline mock with `health: false`.

**Validation:**
```bash
bun test src/lib/tui-stats/pg.test.ts
```

**depends-on:** Wave 0 / `design-system-severance` Group 1.

---

### Group 1.3: Genie ops aggregate

**Goal:** `lib/tui-stats/ops.ts` exposes `getOpsStats()` returning workers + queue + last event.

**Deliverables:**
1. `src/lib/tui-stats/ops.ts` with `getOpsStats(): Promise<OpsStats>` returning `{workers: {working, idle, error}, mailboxQueue: number, lastEvent: {kind, ageSeconds} | null}`.
2. Workers aggregate via `agent-registry.listAgents()` (existing) state-counted.
3. Mailbox queue: `SELECT count(*) FROM mailbox WHERE delivered_at IS NULL` (or current schema equivalent — verify).
4. Last event: `SELECT kind, timestamp FROM genie_runtime_events ORDER BY timestamp DESC LIMIT 1`.
5. Unit tests with mocked PG.

**Acceptance Criteria:**
- [ ] `bun test src/lib/tui-stats/ops.test.ts` passes.
- [ ] Returns valid shape under empty-mailbox + no-events mocks.

**Validation:**
```bash
bun test src/lib/tui-stats/ops.test.ts
```

**depends-on:** Wave 0 / `design-system-severance` Group 1.

---

### Group 1.4: Cost adapter + hysteresis

**Goal:** `lib/tui-stats/cost.ts` shells out to ccusage, maintains ring buffer, runs `step()` hysteresis state machine.

**Deliverables:**
1. `src/lib/tui-stats/cost.ts` exposing `getCostStats(): Promise<CostStats>` returning `{cents, alarmState, sparklineData}`.
2. ccusage shell-out behind a swappable adapter interface (one swap point for future PG path).
3. 60-sample circular ring buffer for the rolling 5-min baseline.
4. `step()` function exactly as specified in DESIGN's "Hysteresis spec" — frozen-baseline at entry, 5s min hold, 0.85× exit threshold.
5. Degraded mode: ccusage missing → returns `{cents: null, alarmState: 'normal', sparklineData: []}`.
6. Unit tests:
   - `step()` state transitions: normal→alarm→still-alarm-during-hold→normal-after-hold.
   - Frozen baseline behavior under drift (alarm entered at t=0 with mean=100; at t=10s mean=120; verify exit threshold remains 0.85 × 104, not 0.85 × 124).
   - Min hold prevents exit at t<5s even if burn falls below threshold.
   - Ring buffer rolls correctly at 60+ samples.

**Acceptance Criteria:**
- [ ] `bun test src/lib/tui-stats/cost.test.ts` passes.
- [ ] All 4 hysteresis test cases (entry, hold-during, exit-after, frozen-baseline) green.
- [ ] Returns valid degraded shape when ccusage adapter throws.

**Validation:**
```bash
bun test src/lib/tui-stats/cost.test.ts
```

**depends-on:** Wave 0 / `design-system-severance` Group 1.

---

### Group 1.5: Composition hook

**Goal:** `lib/tui-stats/index.ts` exposes `useStats(intervalMs: number)` that composes all four sources.

**Deliverables:**
1. `src/lib/tui-stats/index.ts` exporting `useStats(intervalMs)` returning `{hw, pg, ops, cost}` updated every `intervalMs`.
2. Promise.all over the four sources; graceful degradation if any throws.
3. Unit tests with mocked sources.

**Acceptance Criteria:**
- [ ] `bun test src/lib/tui-stats/index.test.ts` passes.
- [ ] Hook returns composed shape; updates on interval; cleans up on unmount.

**Validation:**
```bash
bun test src/lib/tui-stats/index.test.ts
```

**depends-on:** Groups 1.1, 1.2, 1.3, 1.4.

---

### Group 2.1: Sparkline component

**Goal:** Reusable `BottomBar/Sparkline.tsx` rendering block-char sparklines via FrameBuffer.

**Deliverables:**
1. `src/tui/components/BottomBar/Sparkline.tsx` with `props: { data: number[]; width: number; color: string }`.
2. Uses `▁▂▃▄▅▆▇█` block characters scaled by max value.
3. FrameBuffer instance reused across renders; only redraws when `data` reference changes.
4. Snapshot tests at widths 8, 16, 30 with sample data.

**Acceptance Criteria:**
- [ ] `bun test src/tui/components/BottomBar/__tests__/Sparkline.test.tsx` passes.
- [ ] Snapshots stable across runs.

**Validation:**
```bash
bun test src/tui/components/BottomBar/__tests__/Sparkline.test.tsx
```

**depends-on:** Wave 0 / `design-system-severance` Group 1.

---

### Group 2.2: PulseRing component

**Goal:** Reusable `BottomBar/PulseRing.tsx` wrapping `useTimeline` opacity tween.

**Deliverables:**
1. `src/tui/components/BottomBar/PulseRing.tsx` with `props: { rate: 1 | 2; color: string; sampleHz: number; children: ReactNode }`.
2. `sampleHz` controls keyframe density; `rate` is preserved at any sample rate.
3. Snapshot tests at sampleHz=4 and sampleHz=60 verifying pulse rate is identical.

**Acceptance Criteria:**
- [ ] `bun test src/tui/components/BottomBar/__tests__/PulseRing.test.tsx` passes.
- [ ] Pulse rate preservation snapshot verified.

**Validation:**
```bash
bun test src/tui/components/BottomBar/__tests__/PulseRing.test.tsx
```

**depends-on:** Wave 0 / `design-system-severance` Group 1.

---

### Group 2.3: TokenBurnMeter (scene-stealer)

**Goal:** SS-1 top-header component with ascii-font + sparkline + width guard + degraded states.

**Deliverables:**
1. `src/tui/components/BottomBar/TokenBurnMeter.tsx` rendering the 4-line top header per Layout A.
2. Uses `<ascii-font font="tiny">` for cents/min; routes color through `PulseRing`.
3. Width guard at first render via opentui renderable dimensions; fallback to single-line big-text when overflow.
4. Three states implemented: normal (mint pulse), alarm (crimson 2Hz), idle ($0 calm static), missing (—¢/min dim).
5. Component unit + snapshot tests for each state.

**Acceptance Criteria:**
- [ ] `bun test src/tui/components/BottomBar/__tests__/TokenBurnMeter.test.tsx` passes.
- [ ] All four states render correctly in snapshots.
- [ ] Width-guard fallback verified at navWidth=24.

**Validation:**
```bash
bun test src/tui/components/BottomBar/__tests__/TokenBurnMeter.test.tsx
```

**depends-on:** Groups 1.4, 1.5, 2.1, 2.2.

---

### Group 2.4: HwPanel

**Goal:** §1 system vitals with new disk-free + disk-IO-latency.

**Deliverables:**
1. `src/tui/components/BottomBar/HwPanel.tsx` rendering CPU/RAM/disk lines per Layout A.
2. Disk line includes `io Xms` suffix using delta from `cost.ts`'s value or `hw.ts` (whichever is the source).
3. Color routes through recalibrated `pickColor` (>70/>90) imported from `genie-tokens`.
4. Snapshot tests at low/medium/high load.

**Acceptance Criteria:**
- [ ] `bun test src/tui/components/BottomBar/__tests__/HwPanel.test.tsx` passes.
- [ ] Snapshots correct color flips at 71% (amber) and 91% (crimson).

**Validation:**
```bash
bun test src/tui/components/BottomBar/__tests__/HwPanel.test.tsx
```

**depends-on:** Group 1.5.

---

### Group 2.5: PgServePanel

**Goal:** §2 with health pulse + conn/pool/queue/p50 + PG-offline degradation.

**Deliverables:**
1. `src/tui/components/BottomBar/PgServePanel.tsx` rendering 2 lines per Layout A.
2. Health dot color: green (healthy + low p50) / amber (slow p50) / crimson (unreachable).
3. PG-offline rendering: single line `pgserve · offline` in `palette.error`.
4. Snapshot tests for healthy/slow/offline.

**Acceptance Criteria:**
- [ ] `bun test src/tui/components/BottomBar/__tests__/PgServePanel.test.tsx` passes.
- [ ] All three health states render correctly.

**Validation:**
```bash
bun test src/tui/components/BottomBar/__tests__/PgServePanel.test.tsx
```

**depends-on:** Group 1.5.

---

### Group 2.6: GenieOpsPanel

**Goal:** §3 multi-track ops aggregate.

**Deliverables:**
1. `src/tui/components/BottomBar/GenieOpsPanel.tsx` rendering 2 lines per Layout A.
2. Worker aggregate `●N working ○M idle ⊘K error` with color tokens from `genie-tokens`.
3. Last event format: `last: <kind> <age>s` with age formatted compactly (e.g., `3s`, `1m`, `5m`).
4. Mailbox queue prefix `q<N> ·`.
5. Snapshot tests for empty/active/all-error states.

**Acceptance Criteria:**
- [ ] `bun test src/tui/components/BottomBar/__tests__/GenieOpsPanel.test.tsx` passes.
- [ ] Multi-track formatting verified: e.g., `●5 working ○3 idle ⊘1` displays distinct counts.

**Validation:**
```bash
bun test src/tui/components/BottomBar/__tests__/GenieOpsPanel.test.tsx
```

**depends-on:** Group 1.5.

---

### Group 3.1: SystemStats orchestrator rewrite

**Goal:** Replace inline metrics rendering in `SystemStats.tsx` with the panel composition + SSH heuristic + env-var parsing.

**Deliverables:**
1. `src/tui/components/SystemStats.tsx` rewritten as orchestrator: calls `useStats(3000)`, renders the four panels in Layout A order with dividers.
2. SSH heuristic: `Boolean(SSH_CONNECTION) || Boolean(SSH_CLIENT) || Boolean(SSH_TTY)`.
3. `GENIE_TUI_PULSE={off|low|full}` parsed; sampleHz computed per DESIGN.
4. Disabled-pulse path: `sampleHz=0` → render `TokenBurnMeter` without `PulseRing`.
5. Backward-compat: exported component name unchanged; `Nav.tsx` import unchanged.
6. Existing `bun test test/tui` baseline still passes.

**Acceptance Criteria:**
- [ ] `bun test test/tui` passes (no regression).
- [ ] `bun run typecheck && bun run lint` green.
- [ ] Manual: `genie tui` boots and renders all four panels.

**Validation:**
```bash
bun test test/tui && bun run typecheck && bun run lint
```

**depends-on:** Groups 2.1–2.6.

---

### Group 3.2: Snapshot test suite

**Goal:** Ten named snapshot cases covering all behaviors.

**Deliverables:**
1. `test/visual/bottom-bar.snapshot.test.tsx` (or extends `design-system-severance` Group 6 harness).
2. Snapshot cases enumerated in Wave 3 group 3.2 above.
3. CI script `bun test test/visual/bottom-bar.snapshot.test.tsx` added to lint workflow.

**Acceptance Criteria:**
- [ ] All 10 snapshots committed and stable across two consecutive runs.
- [ ] Modifying any token causes snapshot diff; regeneration via `-u` is clean.

**Validation:**
```bash
bun test test/visual/bottom-bar.snapshot.test.tsx
```

**depends-on:** Group 3.1.

---

### Group 3.3: Documentation

**Goal:** Add "Bottom bar" section to `docs/design-system.md`.

**Deliverables:**
1. `docs/design-system.md` (created by `design-system-severance` Group 7) gets a new `## Bottom bar` section (~200 words) documenting:
   - Four sections + Layout A diagram
   - SS-1 token-burn meter scene-stealer
   - SSH heuristic + `GENIE_TUI_PULSE` env vars
   - Hysteresis spec link to DESIGN
2. CHANGELOG entry.

**Acceptance Criteria:**
- [ ] `docs/design-system.md` includes the new section.
- [ ] `markdownlint-cli2 docs/design-system.md` passes.
- [ ] CHANGELOG entry present.

**Validation:**
```bash
markdownlint-cli2 docs/design-system.md
grep -q "Bottom bar" docs/design-system.md
```

**depends-on:** Groups 3.1, 3.2; depends on `design-system-severance` Group 7 having merged.

---

## Dependencies

- **depends-on:** `design-system-severance` Group 1 (HARD — `packages/genie-tokens/` must exist before any group in this wish runs). Wave 0 stub-token group exists as fallback if hard dep slips.
- **soft-depends-on:** `session-cost-extraction` (PG cost source — ccusage adapter is the v1 path; v2 swap when extraction lands).
- **adjacent:** `bare-genie-dashboard` (full-screen dashboard — non-overlapping; this wish's bar coexists with that wish's panels).
- **blocks:** future wish `tui-bottom-bar-themes-v2` if/when theme variants land.

## QA Criteria

- [ ] `genie tui` boots and renders the new four-section bar.
- [ ] At idle ($0 burn, < 30% CPU, healthy PG): all colors mint, no crimson, no amber, only SS-1 pulses (slow 1Hz).
- [ ] At forced cost spike (mock ccusage > 2σ): SS-1 flips to crimson 2Hz pulse within one tick; reverts only after 5s + 0.85× threshold.
- [ ] At forced PG outage (`pkill pgserve`): §2 renders `pgserve · offline` in crimson; rest of bar continues.
- [ ] At forced high CPU (`stress-ng --cpu 8 --timeout 30s`): §1 CPU bar flips to crimson at >90%; reverts to mint at <70% (recalibrated thresholds).
- [ ] Detached + reattached over SSH (`ssh genie@host`, `genie tui`): SS-1 pulse rate visibly preserved (1Hz still 1Hz), but visibly less smooth (4Hz sample rate).
- [ ] `GENIE_TUI_PULSE=off genie tui`: no animation anywhere; SS-1 renders static color matching its current state.
- [ ] `GENIE_TUI_PULSE=full genie tui` (over SSH): pulse renders smoothly at 60fps.
- [ ] Narrow nav (force `nav` width to 24 cols): SS-1 falls back to single-line big-text; rest of bar still legible.
- [ ] Multi-track verification: with 3 teams running (e.g., 5 working, 2 idle, 0 error), §3 displays the aggregate; no single-track wish info shown anywhere.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `design-system-severance` Group 1 doesn't ship before this wish dispatches | High | Wave 0 stub-token escape hatch (50 LOC, deletes when full Severance lands) |
| ccusage shell-out missing or slow | Medium | Degraded mode: `cents: null` → dim static `—¢/min`, no pulse, no crash |
| 60fps `useTimeline` thrashes over SSH | Medium | Auto-throttle to 4Hz sample rate; user override `GENIE_TUI_PULSE` |
| ascii-font width overflows terminal | Medium | Empirical width guard at first render; single-line big-text fallback |
| `pg_stat_statements` extension not installed | Low | Active-query-age fallback path (`percentile_cont` over `query_start`) |
| Snapshot tests brittle across opentui versions | Medium | Snapshot the rendered tree, not pixel output; use opentui's render-to-string |
| Animation feels gimmicky if multiple components pulse | Medium | Snapshot test enforces single pulse element; reviewer rejects PRs adding more |
| Hysteresis still flickers in pathological burn patterns | Low | Min-hold + frozen-baseline together cover known patterns; production telemetry can refine |
| ccusage upstream format change | Low | Adapter pattern at `cost.ts` — single swap point |
| Mailbox table schema differs from assumption | Low | Group 1.3 acceptance includes "verify current schema"; SQL adjusted at impl time |
| Width guard's first-render dimension query unsupported by opentui | Medium | If unsupported, fall back to constant assumption (28 cols) + add a test to fail loudly when ascii-font width changes |

---

## Review Results

_Populated by `/review` after this wish is reviewed._

---

## Files to Create/Modify

```
packages/genie-tokens/                              [stub created in Wave 0 IF needed; otherwise pre-exists from design-system-severance]

src/lib/tui-stats/                                  [NEW]
├── hw.ts                                           [Group 1.1]
├── pg.ts                                           [Group 1.2]
├── ops.ts                                          [Group 1.3]
├── cost.ts                                         [Group 1.4]
├── index.ts                                        [Group 1.5]
└── __tests__/
    ├── hw.test.ts
    ├── pg.test.ts
    ├── ops.test.ts
    ├── cost.test.ts
    └── index.test.ts

src/tui/components/BottomBar/                       [NEW]
├── Sparkline.tsx                                   [Group 2.1]
├── PulseRing.tsx                                   [Group 2.2]
├── TokenBurnMeter.tsx                              [Group 2.3]
├── HwPanel.tsx                                     [Group 2.4]
├── PgServePanel.tsx                                [Group 2.5]
├── GenieOpsPanel.tsx                               [Group 2.6]
└── __tests__/
    ├── Sparkline.test.tsx
    ├── PulseRing.test.tsx
    ├── TokenBurnMeter.test.tsx
    ├── HwPanel.test.tsx
    ├── PgServePanel.test.tsx
    └── GenieOpsPanel.test.tsx

src/tui/components/SystemStats.tsx                  [REWRITE — Group 3.1, becomes thin orchestrator]

test/visual/bottom-bar.snapshot.test.tsx            [NEW — Group 3.2]
test/visual/__snapshots__/                          [NEW — 10 snapshot files]

docs/design-system.md                               [MODIFY — Group 3.3, append "Bottom bar" section]
CHANGELOG.md                                        [MODIFY — Group 3.3 entry]
.github/workflows/lint.yml                          [MODIFY — Group 3.2 adds visual snapshot CI]
```
