# DRAFT — khal-app-kit-identity

**Date:** 2026-07-23
**Status:** Simmering (second in the Felipe-confirmed order Theme → Identity → SSH)
**Target repo:** khal-os/genie-desktop (`~/prod/genie-ui-ab/dash-fork`)
**Shared research:** [khal-native-desktop umbrella](../khal-native-desktop/DRAFT.md)

## Problem

Genie desktop has no identity at all — no login, no users, no roles (only an anonymous telemetry `instanceId`; drizzle schema has zero owner columns). To become multiuser with agent collaboration it needs real KHAL identity: login via the khal platform, `KhalAuth` in the renderer, role-gated actions, and an org-scoped realtime channel.

## Felipe's locked decisions

- **Standalone + khal login** — the app embeds `@khal-os/sdk` directly (bundled dep, not a pack; `window.__KHAL_SHARED__` irrelevant); users authenticate against the khal platform (WorkOS-backed).
- Collab v1 shape: **define after research** — research is in; v1 proposal below awaits his pick.

## What the SDK gives us / makes us build (explorer evidence)

**Given:** `useKhalAuth()` + `KhalAuth` type; role hierarchy `member < platform-dev < platform-admin < platform-owner` with `hasMinRole`; `useNats`/`useService` org-scoped realtime; subject families incl. `notify.user/broadcast`, `desktop.{userId}.cmd/event.*`, `os.auth.role-changed|membership-revoked`, `pty.*`, `fs.*`; `BrowserNatsClient` (kernel WS `/ws/nats`, `bearer.<jwt>` subprotocol, injectable config reader); device-code login endpoints (`/v1/auth/device` + `/token`), session-exchange; `~/.khal-os/credentials.json` conventions (khal CLI already installed = possible credential reuse).

**We must build:** the `KhalAuthProvider` (SDK ships none — context is empty); the Electron login flow (device-code in-app, or reuse khal CLI credentials); the NATS config injection (`getNatsClient({readBrowserConfig})`); any enforcement (client gating is cosmetic — the omni handoff's lesson: the service boundary is the policy enforcement point; for genie desktop the "service boundary" question is what a second user is even allowed to reach — ties into remote-ssh).

**Not in the SDK:** presence, shared docs/CRDT, agent-to-agent messaging — collab is built app-side over org-scoped pub/sub.

## Collab v1 candidate shapes (for Felipe)

1. **Shared visibility** — all org members see live boards/roster/agent activity (publish genie state changes to `khal.{orgId}.genie.events.*`).
2. **Shared control** — + role-gated hire/unhire/steer (`minRole` per action).
3. **Presence + handoff** — see who's online, hand a session over.

## Open decisions

- Login UX: in-app device-code flow vs piggyback on `khal login` CLI credentials (`~/.khal-os/credentials.json` exists on dev boxes).
- Where multiuser state lives: local sqlite stays per-install; what becomes org-shared (boards? roster? task metadata?) and via what backend (NATS-only ephemeral vs a platform service).
- Enforcement point: what mutations does a non-owner get, and what enforces it (the app itself is local-first — real enforcement only matters once remote-ssh/shared backends exist).
- Whether `orgId` scoping maps to Felipe's actual team structure (Namastex org on platform.khal.ai?).
- Offline behavior: app must keep working logged-out/offline (today's single-user mode) — is logged-out a first-class mode or a degraded one?

## Risks

- Platform dependency: login requires reachable `platform.khal.ai` (or configured instance); offline-first Electron app must not brick.
- The `genie` app slug already exists in app-kit's registry (`natsPrefix: 'genie'`, `minRole: platform-dev`) — coordinate so subjects/permissions don't collide.
- Security surface: this crosses the standing STOP-AND-PLAN fence (security surface / read-only wall) — every enforcement decision needs explicit Felipe sign-off.
- localStorage settings (~30 keys) are per-install; per-user settings migration is a hidden scope trap.

## Acceptance criteria (to firm up)

- [ ] Login screen (khal device-code) → `useKhalAuth()` returns real `KhalAuth`; logout works; token refresh/expiry handled (`ConnectError` taxonomy).
- [ ] Role visible in UI; at least one action role-gated end-to-end.
- [ ] NATS connected as the logged-in user (org-scoped subject proof).
- [ ] Logged-out mode preserves today's full local single-user behavior.

## WRS

```
WRS: ██████░░░░ 60/100
 Problem ✅ | Scope ░ | Decisions ░ | Risks ✅ | Criteria ✅(draft)
```
Blocked on: collab v1 pick, login UX pick, shared-state boundary. Starts after khal-native-theme.
