# Wish: Per-host ed25519 fingerprint trust between genie and omni (D5 follow-up)

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `omni-host-fingerprint-trust` |
| **Date** | 2026-04-29 |
| **Author** | genie-configure |
| **Appetite** | large |
| **Branch** | `wish/omni-host-fingerprint-trust` |
| **Repos touched** | `automagik-dev/genie`, `automagik-dev/omni`, `namastexlabs/genie-configure` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Today, every genie host authenticates to omni with a shared `omni_sk_…` bearer token from `~/.omni/config.json`. There is no per-host identity, no per-host scope/revocation, and no audit trail tying API calls to a specific genie installation. This wish introduces an ed25519-based per-host fingerprint: each genie host generates a keypair on first use, registers the public key with the local omni server via a one-time handshake, and signs every subsequent API request. omni keeps a `genie_hosts` table with public keys, scopes, and revocation timestamps; bearer-token auth stays as a fallback so the migration is invisible. Deferred from `canonical-genie-omni-wiring` (D5); needs a security review before code lands.

## Scope

### IN

- New `genie omni handshake` command — generates `~/.genie/keys/genie-host.{ed25519,ed25519.pub}` (perms `0600`) on first run, POSTs `{ pubkey, hostname, capabilities }` to `omni://api/v2/trust/handshake`, persists the returned `host_id` locally.
- Drizzle migration for omni `genie_hosts` table (id, pubkey, hostname, scopes, last_seen, revoked_at).
- Omni endpoint `POST /api/v2/trust/handshake` — idempotent on pubkey.
- Omni CLI: `omni trust list / get / update --scope … / revoke <id>`.
- Genie-side request signing helper in `lib/omni-registration.ts`: every outgoing fetch attaches `X-Genie-Signature` (ed25519 over `timestamp + sha256(body)`) and `X-Genie-Host-Id`. Bearer fallback when no key file exists.
- Omni-side verification middleware in the Hono pipeline: validates signature against the registered pubkey, enforces ±60s replay window, attaches resolved host to request context, records to `audit_events`.
- Per-host scopes (initial set): `agents:write`, `providers:write`, `instances:write`, `routes:write`, `keys:read`. Default on first handshake = all writes (backward-compatible); admins narrow via `omni trust update <id> --scope <list>`.
- Optional per-instance enforcement opt-in: `omni instances update <id> --require-genie-signature`. Once flipped, bearer-only writes from registered host pubkeys are rejected.
- Rotation: `genie omni handshake --rotate` issues a new keypair and revokes the old in a single audit-event pair.
- Brain entries in `genie-configure/brain/`: trust map, rotation runbook, ADR superseding the bearer-only decision.

### OUT

- Cross-host fingerprint federation (multiple genie hosts trusting each other directly). Per-host trust against a single omni only; cross-genie is a separate problem.
- Replacing the bearer token entirely. Bearer stays for tooling that doesn't speak the signature protocol.
- Hardware-backed key storage (TPM, YubiKey). Keys live in `~/.genie/keys/` with `0600` perms.
- Encrypting `~/.omni/config.json` itself. Key file is what we protect; bearer token continues to use existing fs protections.
- Cross-machine trust (genie host on a different machine than omni). Loopback-only initially; cross-machine adds key distribution + TLS concerns and is a follow-up wish.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | ed25519 over RSA / ecdsa | Smallest signatures, no parameter footguns, native in `node:crypto`, matches the modern auth ecosystem. |
| 2 | Sign `timestamp + sha256(body)` (not the whole body) | Allows large bodies (agent register POST) without re-buffering. Replay-protected by the ±60s timestamp window enforced server-side. |
| 3 | Per-host pubkey, not per-agent | A genie installation is the unit that talks to omni. Per-agent keys multiply key management N-fold for no real RBAC gain (agents already have per-agent scopes via `omni agents create`). |
| 4 | Loopback-only initially | Both genie and omni run on the same host today (`localhost:8882`). Cross-machine is a real future need but adds key distribution + TLS scope. |
| 5 | Bearer fallback stays on by default | Migration must be invisible. Operators opt into `--require-genie-signature` per instance. |
| 6 | One key per genie host, generated on first `genie omni handshake` | Simplest mental model. Rotation handled by `--rotate`. |

## Success Criteria

- [ ] `genie omni handshake` on a fresh host generates a keypair, registers it, writes `~/.genie/keys/genie-host.*` with `0600` perms.
- [ ] After handshake, every outgoing genie→omni request carries `X-Genie-Signature` and `X-Genie-Host-Id`; omni audit events show the resolved host on each write.
- [ ] `omni trust list` shows registered genie hosts with hostname, scopes, last-seen.
- [ ] `omni trust update <id> --scope agents:write,providers:write` narrows a host; broader writes return 403 with a clear `host scope insufficient` message.
- [ ] `omni instances update <id> --require-genie-signature` flips per-instance enforcement; bearer-only writes against that instance return 403; signed writes from registered hosts continue to succeed.
- [ ] `genie omni handshake --rotate` issues a new keypair and atomically revokes the old; both visible in audit events.
- [ ] All existing tests still pass; new tests cover signing, verification, replay-window enforcement, scope-insufficient rejection, and rotation.
- [ ] Brain entries land: `Configuration & Routing/genie-omni-trust.md`, `Runbooks/rotate-host-key.md`, ADR superseding the bearer-only section of `2026-04-29-canonical-wiring.md`.

## Execution Strategy

### Wave 1 — schema + handshake foundation (parallel)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Omni: `genie_hosts` table migration, `POST /api/v2/trust/handshake` endpoint, `omni trust` CLI commands. |
| 2 | engineer | Genie: `genie omni handshake` command — keygen, fs perms, POST handshake, persist `host_id`. |

### Wave 2 — signing in-line (depends on Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Genie: signing middleware in `lib/omni-registration.ts` and the bridge's outgoing publish path. Bearer fallback when no key. |
| 4 | engineer | Omni: verification middleware in the Hono pipeline. ±60s replay window. Audit event records the resolved host. |

### Wave 3 — scopes + enforcement + docs

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Per-host scopes — initial set `agents:write`, `providers:write`, `instances:write`, `routes:write`, `keys:read`. CLI to list/update. |
| 6 | engineer | Per-instance opt-in enforcement (`--require-genie-signature` on `omni instances update`). |
| 7 | docs | Brain entries (trust map + rotation runbook) + ADR superseding the bearer-only decision. |

## Execution Groups

### Group 1: Omni handshake schema + endpoint

**Goal:** persist host trust records on the omni side and expose an idempotent registration endpoint.

**Deliverables:**
1. Drizzle migration for `genie_hosts` (id, pubkey, hostname, scopes jsonb, last_seen, revoked_at).
2. `POST /api/v2/trust/handshake` (Hono route). Idempotent on pubkey: returns existing `host_id` for the same pubkey.
3. `omni trust list / get / update / revoke` CLI commands under a new `trust` namespace.
4. Tests for endpoint + CLI.

**Acceptance Criteria:**
- [ ] Migration applies on fresh + existing dev DBs.
- [ ] Handshake accepts a valid ed25519 pubkey, returns `host_id`.
- [ ] Re-registering same pubkey returns same `host_id`.
- [ ] `omni trust list` shows the registered host.

**Validation:**
```bash
cd <omni-clone>
make typecheck && bun test packages/api/src/routes/trust.test.ts packages/cli/src/__tests__/trust.test.ts
```

**depends-on:** none

---

### Group 2: Genie handshake command

**Goal:** generate the keypair on the genie side and complete the handshake.

**Deliverables:**
1. `genie omni handshake` command in a new `genie omni` namespace.
2. Key generation via `node:crypto.generateKeyPairSync('ed25519')`. Files at `~/.genie/keys/genie-host.{ed25519,ed25519.pub}` with `0600` perms; `host.json` carries the registered `host_id`.
3. Sanity check: refuse to write keys inside a git working tree.
4. `genie omni handshake --rotate` — new keypair + revoke old in a single round-trip.

**Acceptance Criteria:**
- [ ] First-run handshake creates keypair with `0600` perms, registers with omni.
- [ ] Re-running without `--rotate` is idempotent.
- [ ] `--rotate` produces a new keypair and the old appears as `revoked_at` in `omni trust list`.

**Validation:**
```bash
cd <genie-clone>
bun run typecheck && bun test src/term-commands/omni/handshake.test.ts
```

**depends-on:** Group 1

---

### Group 3: Genie request signing

**Goal:** every genie→omni HTTP write carries a signature header.

**Deliverables:**
1. Helper `signOmniRequest(method, path, body) → Headers` in `src/lib/omni-registration.ts`.
2. Wire helper into `registerAgentInOmni` and the bridge's outbound publish path.
3. Bearer-fallback branch when `~/.genie/keys/host.json` is missing; warn once on stderr.
4. Tests with a golden signature vector for a known input.

**Acceptance Criteria:**
- [ ] Every request from registration paths and the bridge has `X-Genie-Signature` + `X-Genie-Host-Id` when keys exist.
- [ ] Golden vector test passes.
- [ ] Missing keys → bearer fallback path; one-time stderr warning per process.

**Validation:**
```bash
cd <genie-clone>
bun run typecheck && bun test src/lib/omni-registration.test.ts
```

**depends-on:** Group 2

---

### Group 4: Omni signature verification middleware

**Goal:** validate signatures on incoming writes; attach host context to the audit trail.

**Deliverables:**
1. Hono middleware before write routes. Pubkey lookup via `genie_hosts.pubkey`.
2. ±60s replay window enforcement.
3. On success, attach `request.signedBy = host_id`; downstream audit events include it.
4. Failure modes: invalid signature → 401; tampered body → 401; stale timestamp → 401; unknown host_id → 401.

**Acceptance Criteria:**
- [ ] Valid signature → write succeeds, audit event has `signedBy`.
- [ ] Stale (>60s), tampered, or unknown signature → 401 with clear message.

**Validation:**
```bash
cd <omni-clone>
make typecheck && bun test packages/api/src/middleware/genie-signature.test.ts
```

**depends-on:** Group 1

---

### Group 5: Per-host scopes

**Goal:** narrow what each genie host can do.

**Deliverables:**
1. Use `genie_hosts.scopes` (jsonb array of strings).
2. Middleware enforces scope→route mapping (`agents:write`, `providers:write`, `instances:write`, `routes:write`, `keys:read`).
3. `omni trust update <id> --scope <comma-list>` CLI.
4. Tests covering allow/deny matrix per route × scope.

**Acceptance Criteria:**
- [ ] Default first-handshake scope = all writes (backward compat).
- [ ] Narrowed scope → broader writes return 403 with `host scope insufficient`.

**Validation:**
```bash
cd <omni-clone>
bun test packages/api/src/middleware/genie-signature.test.ts
```

**depends-on:** Group 4

---

### Group 6: Per-instance enforcement opt-in

**Goal:** allow operators to require signed writes per instance.

**Deliverables:**
1. New instance column `requireGenieSignature` (boolean, default false).
2. CLI flag on `omni instances update` to flip it.
3. Middleware checks the flag — when on, bearer-only writes from registered host pubkeys are rejected.

**Acceptance Criteria:**
- [ ] Default false → existing bearer behavior unchanged.
- [ ] Flag flipped → bearer writes against that instance return 403; signed writes still succeed.

**Validation:**
```bash
cd <omni-clone>
bun test packages/api/src/middleware/genie-signature.test.ts
```

**depends-on:** Group 4, Group 5

---

### Group 7: Docs + brain

**Goal:** persist the trust model in operator-facing docs and the genie-configure brain.

**Deliverables:**
1. `genie-configure/brain/Configuration & Routing/genie-omni-trust.md` — keypair location, signing protocol, audit trail.
2. `genie-configure/brain/Runbooks/rotate-host-key.md` — rotation playbook + recovery if a key is lost.
3. New ADR `genie-configure/brain/_decisions/<date>-omni-host-fingerprint-trust.md` superseding the bearer-only section of `2026-04-29-canonical-wiring.md`.

**Acceptance Criteria:**
- [ ] All three files exist and link back to this wish + the merged PRs.
- [ ] Old ADR (`2026-04-29-canonical-wiring.md`) gets a "Superseded by …" pointer to the new ADR.

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure
test -f "./brain/Configuration & Routing/genie-omni-trust.md" \
  && test -f "./brain/Runbooks/rotate-host-key.md"
```

**depends-on:** Group 6

---

## Dependencies

| Wave / Group | Depends on |
|---|---|
| Wave 1 / Group 1 | none |
| Wave 1 / Group 2 | Group 1 |
| Wave 2 / Group 3 | Group 2 |
| Wave 2 / Group 4 | Group 1 |
| Wave 3 / Group 5 | Group 4 |
| Wave 3 / Group 6 | Group 4, Group 5 |
| Wave 3 / Group 7 | Group 6 |

Cross-wish:
- **Depends on:** `canonical-genie-omni-wiring` (SHIPPED).
- **Blocks:** none.

## QA Criteria

- [ ] **Functional**: fresh operator runs `genie omni handshake`; every subsequent genie→omni write carries the signature; `omni trust list` shows the new host.
- [ ] **Security**: tampered body / stale timestamp / unknown host_id all rejected with the right status codes; replay attacks (re-sending a stolen signed request after 60s) rejected.
- [ ] **Backward compat**: omni instances without `--require-genie-signature` continue to accept bearer-only writes from clients that never handshook.
- [ ] **Rotation**: `genie omni handshake --rotate` produces a new key + revokes the old in a single audit-event pair.
- [ ] **Regression**: existing test suites pass; no new biome/typecheck regressions in either repo.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Loopback-only assumption breaks if someone runs genie and omni on different hosts | Medium | Documented explicitly; cross-machine is a follow-up wish. |
| Operators lose their `~/.genie/keys/` (rm -rf, OS reinstall) | Medium | `genie omni handshake` is idempotent on pubkey, so a fresh keypair just registers as a new host; old host can be revoked via `omni trust revoke`. Runbook covers this. |
| Bearer model becomes orphaned tech debt | Low | Bearer stays as documented fallback; no removal date set. Operators that want strict enforcement opt in per instance. |
| Performance overhead per signed request | Low | ed25519 sign + verify ~30µs each. Negligible against typical omni request budgets (DB write 1-10ms). |
| Key file accidentally committed to git | Medium | Standard `.gitignore` rule + handshake command refuses to write keys to a path inside a git working tree (sanity check). |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
automagik-dev/omni  (Groups 1, 4, 5, 6)
  packages/db/src/schema.ts                                     [modify — genie_hosts table + instances.requireGenieSignature]
  packages/db/drizzle/<NNNN>_genie_hosts.sql                    [new — migration]
  packages/api/src/routes/trust.ts                              [new]
  packages/api/src/routes/trust.test.ts                         [new]
  packages/api/src/middleware/genie-signature.ts                [new]
  packages/api/src/middleware/genie-signature.test.ts           [new]
  packages/cli/src/commands/trust.ts                            [new]
  packages/cli/src/__tests__/trust.test.ts                      [new]
  packages/cli/src/commands/instances.ts                        [modify — --require-genie-signature flag]

automagik-dev/genie  (Groups 2, 3)
  src/term-commands/omni/handshake.ts                           [new]
  src/term-commands/omni/handshake.test.ts                      [new]
  src/lib/omni-registration.ts                                  [modify — sign every fetch]
  src/lib/omni-registration.test.ts                             [modify — golden signature vector]
  src/services/omni-bridge.ts                                   [modify — sign outbound publish if applicable]

namastexlabs/genie-configure  (Group 7)
  brain/Configuration & Routing/genie-omni-trust.md             [new]
  brain/Runbooks/rotate-host-key.md                             [new]
  brain/_decisions/<date>-omni-host-fingerprint-trust.md        [new]
```
