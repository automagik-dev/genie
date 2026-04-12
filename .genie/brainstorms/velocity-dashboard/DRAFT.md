# Brainstorm: velocity-dashboard

| Field | Value |
|-------|-------|
| **Started** | 2026-04-12 |
| **WRS** | 20/100 |
| **Status** | Raw |

## Problem
The current metrics-updater agent reports shallow vanity metrics (releases/24h on main, merged PRs/7d, avg merge time, SHIP rate) that drastically undercount genie's real development velocity. The actual numbers tell a much more compelling story.

## Real velocity (snapshot 2026-04-12)

| Metric | Value | Current agent reports? |
|--------|-------|-----------------------|
| Commits/7d (all branches) | **273** | No (only main/dev) |
| @next npm publishes/7d | **~20** (up to 14 in one day) | No |
| Total releases (all-time tags) | **768** | No |
| LoC added/7d (net) | **+1 101** | No |
| Unique contributors/7d | **10** (humans + AI agents) | No |
| Daily peak commits | **111** (Apr 5) | No |
| Avg daily commits | **~55** | No |

## Open questions
- Where should this live? README only? Dedicated page? Dashboard?
- Static markdown tables vs rendered charts (SVG/image)?
- Historical depth: 7d? 30d? All-time?
- Should AI vs human contribution be broken out?
