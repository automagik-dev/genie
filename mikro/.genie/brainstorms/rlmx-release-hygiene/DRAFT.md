# DRAFT — rlmx-release-hygiene

Wish 1 of 3 in the rlmx stable-release program.
**Program record + full exploration:** `../rlmx-stable-release/DRAFT.md`
(decisions D1–D8, benchmark strategy, roadmap for wishes 2 and 3).

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

## Why this is its own wish

Owner decision **D6** (2026-07-25): three sequenced wishes, hygiene ships
first. Everything here is independent of benchmark work, so a **high-severity
production advisory does not have to wait multi-days** for a 900-run benchmark
campaign to finish.

## Seed facts (all verified on disk 2026-07-25)

- `origin/main` = `d7f1878`; ACP work merged as **PR #112** (the handoff's
  "stranded branch" was a stale-fetch artifact — nothing was lost).
- Gate on main: **build clean, 420 tests pass / 0 fail**, exit 0.
- `npm audit --omit=dev`: **js-yaml high** (DoS via merge-key alias chains) and
  **protobufjs moderate**, both in the **production** tree, both fixable.
- Only live stale semver claim in tracked source: **`CHANGELOG.md:6`**.
- `docs/release-contract.md` is stale in four verified ways (no `dev` branch,
  `drogo/*` convention obsolete, `drogo/prod-rlmx` exists despite the doc
  forbidding it, wrong `/home/genie/` path).
- `package.json` has **no `bin`** — npm is SDK-only by contract, so
  `npx rlmx` cannot work and must not be a release check.
- `scripts/version.mjs` documents UTC but uses local-time getters.
- npm dist-tags: `next` (`0.260528.1`) is **older** than `latest`
  (`0.260528.2`).
- Open issues: #29, #13, #6, #2. #6 ("v0.3 requirement: Explicit TTL cache
  control") may already be delivered by `feat-cache-ttl-control` +
  `docs/TTL_CONTROL.md` — verify before closing.

Crystallized to `DESIGN.md` 2026-07-25.
