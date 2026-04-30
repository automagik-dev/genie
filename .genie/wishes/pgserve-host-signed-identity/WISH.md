# Wish: pgserve Host-Signed Identity

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `pgserve-host-signed-identity` |
| **Date** | 2026-04-30 |
| **Author** | Genie (PM, on behalf of Cezar) |
| **Appetite** | medium |
| **Branch** | `wish/pgserve-host-signed-identity` |
| **Repos touched** | `automagik-dev/genie`, `namastexlabs/pgserve` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Replace pgserve v2's filesystem-bound fingerprint (`sha256(realpath ‖ name ‖ uid)`) with an opt-in host-signed identity that derives the per-package database fingerprint from genie's existing per-host ed25519 keypair (`~/.genie/keys/genie-host.ed25519`). Same package on same host → same database, regardless of cwd or path. Closes the multi-checkout-orphan defect (two `app__automagik_genie_*` DBs visible on the demo host today) and reuses the signing primitive genie already ships for omni handshake + chat-lookup signatures (PRs #1537, #1566) — no new keypair, no new registry, no npm coupling.

## Scope

### IN

- **pgserve `pgserve_meta` schema delta:** add `publisher_name TEXT`, `host_pubkey BYTEA` (32 bytes), `identity_kind TEXT NOT NULL DEFAULT 'path' CHECK (identity_kind IN ('path','host_signed'))`. Unique index on `(publisher_name, host_pubkey) WHERE identity_kind='host_signed'`. Additive migration; existing `path`-kind rows untouched.
- **pgserve fingerprint algorithm extension:** when peer's resolved `package.json` declares `"pgserve": { "identity": "host_signed", "publisher": "<name>" }`, pgserve daemon performs a nonce challenge handshake before routing the connection. On success, fingerprint becomes `sha256(publisher_name ‖ host_pubkey)[:12]`; on failure, connection is denied with a new audit event `host_signed_handshake_failed`. Default (path-kind) behavior unchanged for packages that don't opt in.
- **pgserve handshake protocol:** daemon issues a 32-byte random nonce on first connect from a host_signed peer; peer sends back `{nonce, pubkey, signature}` where `signature = ed25519_sign(privkey, "pgserve-handshake-v1\0" ‖ nonce ‖ publisher_name)`. Daemon verifies signature against the peer's claimed pubkey, then upserts the `(publisher_name, host_pubkey)` row in `pgserve_meta`. Subsequent connects from the same peer skip the handshake (TOFU + `last_handshake_at` timestamp).
- **genie peer integration:** new `src/lib/pgserve-handshake.ts` in genie that participates in the handshake using `~/.genie/keys/genie-host.ed25519` + `host.json#pubkey`. Wired into the existing `_buildConnection()` path in `src/lib/db.ts` so all genie-runtime connections opt in automatically when `@automagik/genie/package.json` declares `pgserve.identity: "host_signed"`.
- **genie CLI:** `genie pgserve handshake` command (mirror of `genie omni handshake`). Manually triggers the handshake against the local pgserve daemon; surfaces the resulting fingerprint + DB name; useful for diagnosis. `genie db status` extended to print `Identity:` line showing kind (path / host_signed) and publisher.
- **genie package.json opt-in:** flip `@automagik/genie` to `pgserve.identity: "host_signed"` after the host-side wiring lands. Two existing `app__automagik_genie_*` DBs collapse into one on first connect.
- **e2e integration test (genie repo):** `tests/pgserve-host-signed-identity.test.ts` — boots an ephemeral pgserve, generates a transient ed25519 keypair, runs the handshake, verifies routing into `app_<publisher>_<pubkey_fp>`, asserts a second connect from a different cwd lands in the same DB.
- **CHANGELOG entries** in both repos describing the protocol + opt-in.
- **Documentation:** pgserve README "Host-signed identity" section (when to use, how the handshake works, security model). Genie docs note explaining the package-flag opt-in.

### OUT

- **Cross-host federation.** Same publisher on two different hosts gets two different DBs (because host_pubkey differs). Federation is a separate wish.
- **Key rotation tooling.** First version assumes the genie host keypair is stable for the host's lifetime. If the keypair is rotated, the operator runs the new `genie pgserve handshake` to register the new pubkey; the old DB stays put with persist=true on its row (operator decides when to migrate or drop). Automated migration is a separate wish.
- **Deprecation of path-kind fingerprints.** Existing `path`-kind rows continue to work indefinitely; this wish only adds `host_signed` as an opt-in. A future cleanup wish can deprecate path-kind once consumers migrate.
- **npm-supply-chain integration (cosign keyless / sigstore).** The wish is host-bound, not publisher-attested. The npm-publish-time signature path is its own wish if/when it's wanted. Per Cezar's note, npm departure is imminent — the host-signed path is what genie controls regardless of registry.
- **Multi-key trust (multiple host keys for one publisher).** First version is one pubkey per `(publisher_name, host)`. Multi-key (e.g., a build agent + a developer machine sharing one DB) is a follow-up.
- **TUI / desktop UX surfaces** beyond the two CLI commands listed. The TUI can surface the same data via the existing `genie db status` view when the field is added.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Opt-in via `pgserve.identity: "host_signed"` in package.json**, not a daemon-level flag | Per-package decision. Same daemon serves both path-kind and host_signed peers without operator coordination. Mirrors how `pgserve.persist: true` already works. |
| D2 | **Reuse `~/.genie/keys/genie-host.ed25519` as the host identity**, not a pgserve-specific keypair | Genie already ships, registers, and signs with this key for omni handshake (PR #1537) and chat-lookup signatures (PR #1566). Adding pgserve as a third consumer is the natural extension; making operators manage two host keys is the worst possible UX. |
| D3 | **TOFU first connect, fail-closed thereafter**, no operator approval flow | Simpler than a manual approval queue and matches what `genie omni handshake` already does. Operator can audit via `pgserve_meta.last_handshake_at` and, if compromise is suspected, DROP the meta row to reset. |
| D4 | **Daemon-issued nonce for replay protection**, not timestamp-based | Timestamps need clock sync; nonces don't. The daemon already has a control-socket protocol where a nonce round-trip is essentially free (one extra message before the route decision). |
| D5 | **Schema additive (new columns), not breaking** | pgserve has live consumers in production today (genie, omni, pgserve dev workspace itself). Existing `path`-kind rows must continue to work without changes. Migrating in place is OUT of scope here. |
| D6 | **`publisher_name` distinct from `package.json#name`** | A publisher can ship multiple packages that should share a DB (e.g., `@automagik/genie` + `@automagik/genie-cli` could both declare `publisher: "@automagik/genie"`). Decoupling allows that without forcing rename. Default behavior: `publisher` defaults to `package.json#name` if not specified. |
| D7 | **Wish is shared across both repos** but execution is split into per-repo groups | pgserve groups (1, 2, 3) ship as a pgserve PR and release. Genie groups (4, 5, 6, 7) ship as a genie PR after the pgserve release lands. Group 7 (e2e test) is the final gate before flipping `@automagik/genie`'s opt-in. |

## Success Criteria

- [ ] **Two-checkout collapse, observed live.** Two checkouts of `@automagik/genie` at distinct cwds (e.g., `/home/genie/workspace/repos/genie` and `/home/genie/workspace/agents/genie-configure/repos/genie`) connect into the SAME `app_<publisher>_<pubkey_fp>` database. Verified via `genie db status` from each cwd.
- [ ] **`genie pgserve handshake` round-trips successfully** on a fresh host, registers the host pubkey in `pgserve_meta`, and prints the resulting database name + fingerprint hex.
- [ ] **Backward compatibility.** A package without `pgserve.identity: "host_signed"` continues to get a path-kind fingerprint exactly as before. Audit log shows `connection_routed` with `mode: "package"` or `"script"` (unchanged event names for the path-kind branch).
- [ ] **Tampered handshake fails closed.** A peer that signs the nonce with the wrong key gets `connection_denied_host_signed_handshake_failed` and is refused; no DB is created.
- [ ] **Reconnection skips handshake.** A peer that already has a row in `pgserve_meta` for `(publisher, pubkey)` reconnects without a new nonce challenge (verified by absence of `host_signed_handshake_started` audit events on the second connect).
- [ ] **e2e test passes** in the genie repo: handshake → route → second connect from different cwd → same DB → verify via `current_database()`.
- [ ] **Audit events emitted:** `host_signed_handshake_started`, `host_signed_handshake_succeeded`, `host_signed_handshake_failed` — at least one of each appears in `~/.pgserve/audit.log` during the e2e test.
- [ ] **`genie db status` surfaces the new identity kind** alongside the existing socket / fingerprint / persist fields.
- [ ] **CHANGELOG entries land** in both repos describing the opt-in flag, the handshake protocol, and the security model (TOFU + fail-closed verification).

## Execution Strategy

Three waves. Pgserve waves 1 and 2 ship in pgserve PRs and a release; wave 3 is genie integration that depends on those releases.

### Wave 1 — pgserve schema + protocol foundation (sequential within pgserve)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer (pgserve) | Schema + accessors: add `publisher_name`, `host_pubkey`, `identity_kind` columns to `pgserve_meta`; new functions `recordHostSignedIdentity`, `findRowByHostSignedKey`. Unit tests against the additive migration. |
| 2 | engineer (pgserve) | Handshake protocol: nonce issue + verify in `daemon-control.js`; new audit events `host_signed_handshake_started/succeeded/failed`; opt-in detection via `findNearestPackageJson` + `pgserve.identity` parse. |

### Wave 2 — pgserve release + genie peer (parallel)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer (pgserve) | Release `pgserve@2.1.0` (or next minor): docs, CHANGELOG, npm publish, release notes. Bumps the pgserve floor in any consumer that wants the feature. |
| 4 | engineer (genie) | New `src/lib/pgserve-handshake.ts` — produces the handshake payload using `~/.genie/keys/genie-host.ed25519` and `host.json#pubkey`. Verifies daemon's `pgserve_handshake_protocol_version` field for forward compat. Unit tests with a mocked daemon socket. |
| 5 | engineer (genie) | Wire handshake into `_buildConnection()` in `src/lib/db.ts`: when the peer's package.json declares `pgserve.identity: "host_signed"`, perform handshake before the postgres handshake. |

### Wave 3 — genie CLI + opt-in flip + e2e gate (sequential, depends on Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer (genie) | `genie pgserve handshake` CLI (mirror of `genie omni handshake`). Extends `genie db status` to print `Identity: host_signed (publisher=…)` when applicable. |
| 7 | engineer (genie) | e2e integration test (`tests/pgserve-host-signed-identity.test.ts`): full round trip including the two-checkout collapse assertion. Last group; gates the next group. |
| 8 | engineer (genie) | Flip `@automagik/genie/package.json` to `pgserve.identity: "host_signed"` (and set `publisher: "@automagik/genie"`). CHANGELOG entry. After this lands and ships, the two existing `app__automagik_genie_*` DBs collapse on next connect. |

## Execution Groups

### Group 1: pgserve schema + accessors

**Goal:** Land the `pgserve_meta` schema delta and the read/write accessors for host-signed identity rows, additive only.

**Deliverables:**
1. Migration in `src/control-db.js` `ensureMetaSchema()`: `ALTER TABLE pgserve_meta ADD COLUMN IF NOT EXISTS publisher_name TEXT`, `ADD COLUMN IF NOT EXISTS host_pubkey BYTEA`, `ADD COLUMN IF NOT EXISTS identity_kind TEXT NOT NULL DEFAULT 'path' CHECK (identity_kind IN ('path','host_signed'))`. Unique partial index `pgserve_meta_publisher_host_idx ON pgserve_meta (publisher_name, host_pubkey) WHERE identity_kind='host_signed'`.
2. Two new exports in `src/control-db.js`: `recordHostSignedIdentity({publisherName, hostPubkey, peerUid, packageRealpath?, livenessPid?}): Promise<{databaseName: string}>` returns the v2-shaped DB name `app_<sanitized_publisher>_<pubkey_fp[:12]>`. `findRowByHostSignedKey({publisherName, hostPubkey}): Promise<MetaRow | null>` for fast re-connect lookup.
3. Helper `computeHostSignedFingerprint(publisherName: string, hostPubkey: Buffer): string` returning the 12-hex prefix of `sha256(publisher_name ‖ host_pubkey)`.
4. Unit tests in `tests/control-db.test.ts` covering: migration is idempotent on a populated path-kind table; `recordHostSignedIdentity` is upsert-safe (second call same key is a no-op); `findRowByHostSignedKey` returns null for unknown keys; partial unique index rejects duplicate `(publisher, pubkey)` for `identity_kind='host_signed'` but allows duplicates for `path`-kind.

**Acceptance Criteria:**
- [ ] `bun test tests/control-db.test.ts` passes (existing + new tests).
- [ ] On a populated v2 dev DB (with path-kind rows), running the daemon with the new schema migrates idempotently.
- [ ] `EXPLAIN` of `SELECT * FROM pgserve_meta WHERE publisher_name='@automagik/genie' AND host_pubkey=...` uses the new index.

**Validation:**
```bash
cd repos/pgserve && bun install && bun test tests/control-db.test.ts
```

**depends-on:** none

---

### Group 2: pgserve handshake protocol + accept-hook integration

**Goal:** Implement the nonce challenge + verify path in the daemon control socket, gated on the peer's `pgserve.identity: "host_signed"` flag.

**Deliverables:**
1. `src/handshake.js` (new) — `issueNonce()`, `verifyHandshake({nonce, pubkey, signature, publisherName}): boolean` using Bun's `crypto.subtle` ed25519 verify. Domain-separator string `"pgserve-handshake-v1\0"` MUST prefix the signed message.
2. New audit events in `src/audit.js`: `HOST_SIGNED_HANDSHAKE_STARTED`, `HOST_SIGNED_HANDSHAKE_SUCCEEDED`, `HOST_SIGNED_HANDSHAKE_FAILED`. Documented in the file header.
3. `src/daemon-control.js` accept-hook extended: when peer's resolved `package.json` declares `pgserve.identity: "host_signed"` AND `pgserve.publisher`, send a nonce frame and await peer response before completing the route. On verify success, call `recordHostSignedIdentity` (Group 1) and route to the resulting DB. On failure, send a denial frame and close the connection. The path-kind code path is unchanged (no nonce, no challenge).
4. Update `findNearestPackageJson` consumer code to also read `pgserve.identity` and `pgserve.publisher` fields.
5. Tests in `tests/handshake.test.js` (new): valid signature → success; wrong signature → fail; replay (same nonce twice) → fail (track issued nonces, dedupe within a sliding window); missing `publisher` field → fall back to `package.json#name`.

**Acceptance Criteria:**
- [ ] `bun test tests/handshake.test.js tests/control-db.test.ts tests/daemon-control.test.ts` all pass.
- [ ] A path-kind peer (no `pgserve.identity` field) routes exactly as before — no audit event regressions, no behavior change.
- [ ] A host_signed peer with a valid keypair completes the handshake and gets routed to `app_<publisher>_<fp>`.
- [ ] A host_signed peer with a tampered signature is denied and `HOST_SIGNED_HANDSHAKE_FAILED` is logged with `pubkey` + `peer_pid`.

**Validation:**
```bash
cd repos/pgserve && bun install && bun test
```

**depends-on:** Group 1

---

### Group 3: pgserve release + docs

**Goal:** Cut a pgserve minor release with the host-signed identity feature, npm-publish, document the protocol + security model.

**Deliverables:**
1. CHANGELOG.md "## 2.1.0 — host-signed identity" section: protocol, opt-in, schema delta, audit events, security model (TOFU + fail-closed verify).
2. README.md "Host-signed identity" section: when to use, package.json opt-in shape, `genie pgserve handshake` reference, recovery path if pubkey is rotated.
3. `package.json` version bump to `2.1.0`.
4. PR to `namastexlabs/pgserve` against `main`. After merge, npm publish via existing release workflow.

**Acceptance Criteria:**
- [ ] `pgserve@2.1.0` exists on npm.
- [ ] GitHub release page lists the new audit events + opt-in flag + schema delta.
- [ ] CHANGELOG-only smoke: `bun add -g pgserve@2.1.0` and run `pgserve --help` shows no protocol-level UX change for path-kind users.

**Validation:**
```bash
npm view pgserve@2.1.0 version
```

**depends-on:** Group 2

---

### Group 4: genie peer signing helper

**Goal:** Self-contained library in genie that produces a valid handshake payload using the existing host keypair.

**Deliverables:**
1. `src/lib/pgserve-handshake.ts` (new) — `signPgserveHandshake({nonce: Uint8Array, publisherName: string}): {pubkey: Uint8Array, signature: Uint8Array}` reads `~/.genie/keys/genie-host.ed25519` and `host.json#pubkey`, signs `"pgserve-handshake-v1\0" ‖ nonce ‖ publisherName` per the protocol.
2. Unit tests in `src/lib/pgserve-handshake.test.ts` — golden-vector test (fixed nonce + fixed key → expected signature), error path (missing keypair → throws clear error pointing at `genie omni handshake`).
3. Re-export from `src/lib/index.ts` if consumers need it.

**Acceptance Criteria:**
- [ ] `bun test src/lib/pgserve-handshake.test.ts` passes including golden vector.
- [ ] Helper throws an actionable error if `~/.genie/keys/genie-host.ed25519` is missing — pointer to `genie omni handshake` to bootstrap the keypair.
- [ ] `bun run typecheck` clean.

**Validation:**
```bash
cd repos/genie && bun test src/lib/pgserve-handshake.test.ts && bun run typecheck
```

**depends-on:** Group 3

---

### Group 5: wire handshake into genie's connection path

**Goal:** All genie-runtime postgres connections automatically participate in the handshake when the consuming package opts in via `pgserve.identity: "host_signed"`.

**Deliverables:**
1. Edit `src/lib/db.ts` `_buildConnection()`: before the postgres-js connect, read the peer's nearest `package.json#pgserve.identity`. If `host_signed`, perform the handshake by sending the nonce frame to the daemon's control socket and awaiting the route. On failure, throw an error that surfaces `pgserve_handshake_failed` with the peer's pubkey hex (no private bytes).
2. Bump `pgserve` floor in `package.json` from `^2.0.8` to `^2.1.0`.
3. Per-process cache: handshake runs at most once per process per (publisher, pubkey). Subsequent connects reuse the routed DB name without a new handshake. Process restart triggers a re-handshake (cache is in-memory only).
4. Tests for the wiring against a live ephemeral pgserve in `src/lib/db.handshake.test.ts`: handshake on first connect, no handshake on second, error path when daemon doesn't speak the protocol (`unsupported_protocol_version`).

**Acceptance Criteria:**
- [ ] `bun test src/lib/db.handshake.test.ts` passes.
- [ ] Existing `bun test` suite passes (no regressions in path-kind behavior).
- [ ] `genie status` from a workspace WITHOUT a `pgserve.identity` field still uses the path-kind branch — no handshake occurs.

**Validation:**
```bash
cd repos/genie && bun install && bun run typecheck && bun test
```

**depends-on:** Group 4

---

### Group 6: `genie pgserve handshake` CLI + `genie db status` extension

**Goal:** Operator-facing surfaces for diagnosis and manual triggering.

**Deliverables:**
1. `src/term-commands/pgserve/handshake.ts` (new) — `genie pgserve handshake` command. Mirrors `genie omni handshake`. Reads the host keypair, sends the handshake to the local daemon, prints `{publisher, pubkey, fingerprint, database_name, last_handshake_at}` on success.
2. Wire into `src/genie.ts`: `registerPgserveNamespace(program)` (mirrors `registerOmniNamespace`).
3. `src/term-commands/db.ts` `dbStatusCommand` extended: when `identity_kind='host_signed'`, print extra lines:
   ```
     Identity:   host_signed
     Publisher:  @automagik/genie
     Pubkey:     vVucvCroLyCIyG4BYwSEXXpavMoYJk2oR6eGJA8FVP0
   ```

**Acceptance Criteria:**
- [ ] `genie pgserve handshake` runs successfully on a live host_signed-aware daemon, prints the four fields, exits 0.
- [ ] `genie pgserve handshake` returns a clear error and exit 1 if the daemon doesn't speak the protocol (`unsupported_protocol_version`).
- [ ] `genie db status` prints the new `Identity:` block when applicable, omits it for path-kind workspaces.

**Validation:**
```bash
cd repos/genie && genie pgserve handshake && genie db status
```

**depends-on:** Group 5

---

### Group 7: e2e integration test (the main gate)

**Goal:** One concrete runnable assertion that proves "two checkouts → one DB" works end-to-end.

**Deliverables:**
1. `tests/pgserve-host-signed-identity.test.ts` — boots an ephemeral pgserve@2.1.0 daemon; generates a transient ed25519 keypair (NOT the real host key — test isolation); writes a temp `.genie/keys/` so the genie peer reads from the test path; performs a handshake from one fake-cwd; performs a second handshake from a DIFFERENT fake-cwd; asserts both routed to the same `app_<publisher>_<fp>` DB; asserts `pgserve_meta` has exactly one row for `(publisher, pubkey)`.
2. Tampered-key assertion: third handshake with a different keypair → routed to a DIFFERENT DB (proves the algorithm is keyed on the pubkey, not the publisher alone).

**Acceptance Criteria:**
- [ ] Test passes in CI on the genie repo's standard runner (Linux x64).
- [ ] Test cleans up its ephemeral daemon + temp dirs even on assertion failure (no orphans).

**Validation:**
```bash
cd repos/genie && bun test tests/pgserve-host-signed-identity.test.ts
```

**depends-on:** Group 6

---

### Group 8: opt-in `@automagik/genie` + final CHANGELOG

**Goal:** Flip the production switch — `@automagik/genie/package.json` declares `pgserve.identity: "host_signed"`. After this lands, the two existing `app__automagik_genie_*` DBs collapse on the next genie invocation.

**Deliverables:**
1. Edit `package.json`: add `"pgserve": { "persist": true, "identity": "host_signed", "publisher": "@automagik/genie" }`. Keeps the existing `persist: true`.
2. CHANGELOG.md — top-line entry under the next release: "Genie now uses host-signed identity for its pgserve connections. Two checkouts of the genie source on the same host now share the same database. Recovery: if the new DB is empty, run `genie db migrate-v1 --source <old-fingerprinted-db>` (extension to the existing migrate-v1 to support arbitrary sources)."
3. Documentation note in `docs/db-isolation.md` (new) explaining the model end-to-end with diagrams.
4. Verify the e2e from Group 7 runs against the actual `@automagik/genie` package.json shape.

**Acceptance Criteria:**
- [ ] After this PR is published as a `@next` release, a fresh dev box that installs both `@automagik/genie@next` and `pgserve@^2.1.0` and runs genie from two distinct paths confirms a single DB via `genie db status` from each cwd.
- [ ] No regression for users who don't upgrade pgserve: if pgserve is still `<2.1.0`, the genie peer detects unsupported protocol and falls back to path-kind without crashing.

**Validation:**
```bash
cd repos/genie && bun run typecheck && bun test && genie pgserve handshake && genie db status
```

**depends-on:** Group 7

---

## Cross-Wish Dependencies

- **Depends on:** none
- **Blocks:** future `pgserve-publisher-federation` wish (cross-host shared DB), future `pgserve-key-rotation` wish (rotate host keypair, migrate DB ownership).

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional:** from `~/workspace/repos/genie` and `~/workspace/agents/genie-configure/repos/genie`, `genie db status` prints the same `Database:` value (currently they print two different `app__automagik_genie_*` names).
- [ ] **Functional:** `genie pgserve handshake` from the same host but against an unrelated package (e.g., `@automagik/omni` checkout) prints a DIFFERENT `app_<publisher>_<fp>` name (proves publisher scoping works).
- [ ] **Integration:** the v1 migration prompt + `genie db migrate-v1` (PR #1564, just shipped) continue to work in the new world. The migrate-v1 target should be the host-signed DB now, not the path-kind DB.
- [ ] **Regression:** packages that don't opt in (omni, pgserve-dev, anon script-mode peers) continue to get path-kind fingerprints with no behavior change. No spurious handshake attempts. No new audit events emitted for them.
- [ ] **Security:** an attacker with read access to the running genie process cannot impersonate it without the private key file (verify by terminating the host private key file mid-test and confirming the next handshake fails closed).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| pgserve protocol version mismatch (genie peer expects `v1`, daemon speaks `v0`) blocks all genie connections | High | Explicit `pgserve_handshake_protocol_version` field exchanged at handshake start. Genie falls back to path-kind silently if version is unsupported (no breaking change). Handshake-failure surface is logged but not fatal. |
| Host keypair leaks (e.g., scraped from `~/.genie/keys/`) — attacker can impersonate the host | Medium | Out of this wish's scope but called out in security-model docs. Existing key file mode is 0600. Future `pgserve-key-rotation` wish addresses revocation. |
| Two genie source clones with same publisher — one collapses, the other "loses" data on first connect | Medium | The migration story: the second clone's first connect with host-signed lands in the existing `(publisher, pubkey)` DB — no data is lost, both clones now share state. If the operator has unique-per-clone state in the v1 path-kind DB, they need to migrate it (`genie db migrate-v1 --source <old-db>`) BEFORE the opt-in flip. CHANGELOG explicitly calls this out. |
| TOFU window race: two concurrent first-handshakes with the same `(publisher, pubkey)` insert competing rows | Low | Unique partial index on `(publisher, pubkey) WHERE identity_kind='host_signed'` blocks the duplicate at the DB layer; second writer gets a serialization error and retries. Daemon transparently surfaces the existing row. |
| Genie tests rely on path-kind behavior implicitly | Medium | Wave 2 keeps path-kind as default; opt-in is package-level; existing tests are unaffected unless they explicitly opt in. New tests live in their own files. |
| Host clock skew makes a future "expire after X" handshake brittle | Low | First version doesn't expire — TOFU + persist forever. Expiration is a follow-up. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# pgserve repo (namastexlabs/pgserve)
src/control-db.js                                  (M — schema + accessors)
src/handshake.js                                   (A — protocol)
src/daemon-control.js                              (M — accept-hook integration)
src/audit.js                                       (M — new event constants)
tests/control-db.test.ts                           (M — coverage for new accessors)
tests/handshake.test.js                            (A — protocol tests)
tests/daemon-control.test.ts                       (M — accept-hook routing)
README.md                                          (M — host-signed identity section)
CHANGELOG.md                                       (M — 2.1.0 entry)
package.json                                       (M — version bump)

# genie repo (automagik-dev/genie)
src/lib/pgserve-handshake.ts                       (A — peer signing helper)
src/lib/pgserve-handshake.test.ts                  (A — golden-vector tests)
src/lib/db.ts                                      (M — handshake wiring in _buildConnection)
src/lib/db.handshake.test.ts                       (A — wiring tests)
src/term-commands/pgserve/handshake.ts             (A — CLI command)
src/term-commands/db.ts                            (M — db status Identity block)
src/genie.ts                                       (M — registerPgserveNamespace)
tests/pgserve-host-signed-identity.test.ts         (A — e2e integration test)
package.json                                       (M — pgserve floor ^2.1.0 + opt-in fields)
docs/db-isolation.md                               (A — new documentation page)
CHANGELOG.md                                       (M — opt-in entry)
```
