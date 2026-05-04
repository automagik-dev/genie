# Wish: Unify the genie update interface and absorb omni parity

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `update-unify-stages` |
| **Date** | 2026-05-04 |
| **Author** | Felipe Rosa <felipe@namastex.ai> |
| **Appetite** | medium |
| **Branch** | `wish/update-unify-stages` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — direct wish_ |

> **Companion document:** [SHARED-DESIGN.md](./SHARED-DESIGN.md) — cross-repo unification spec (byte-identical to `automagik/omni#update-unify-stages` SHARED-DESIGN.md).
> Sibling wish: [`automagik/omni#update-unify-stages`](../../../../omni/.genie/wishes/update-unify-stages/WISH.md) — both wishes ship in parallel, target their respective `dev` branches. Each repo owns its own implementation; only the public shape (flags, `VerifyResult`, `LegacyArtifact`, diagnostics schema) is shared.

## Summary

`genie update` (`src/genie-commands/update.ts`, ~1059 LOC) ships rich install logic — multi-installer detection (`source` / `npm` / `bun`), plugin-cache sync, tmux config refresh, post-update maintenance, diagnostics JSON capture. It is **smart about the install** but **dumb about the result**: no pre-flight registry version check (always reinstalls), no confirmation prompt, no health probe of the running daemon stack post-install, no testable verification decision function. The omni-side `update.ts` solved exactly these gaps with a pure `decideUpdateVerify` tagged-union, hermetic restart env, 3-step verification, and a documented sidecar cleanup.

This wish absorbs omni's good ideas into `genie update` without losing any current capability. The reference for the shared shape lives in [SHARED-DESIGN.md](./SHARED-DESIGN.md) §4.

## Scope

### IN

- **Pre-flight registry version check + early "already up to date" exit** — call `bunx npm view @automagik/genie@<channel> version`, compare against running binary, short-circuit when equal. Reuses `normalizeVersion` (next item).
- **`normalizeVersion` helper** — strip `+gitsha` suffix everywhere a version is compared (parity with omni's `normalizeVersion` in `packages/cli/src/commands/update.ts`).
- **TTY confirmation prompt + `--yes` / `-y` flag + `GENIE_UPDATE_YES` env** — match omni's behavior. Non-TTY auto-confirms.
- **Extract `decideVerify` pure function with tagged-union `VerifyResult`** — same shape as omni:
  ```ts
  type VerifyResult =
    | { kind: 'ok'; cliVersion: string; serverVersion: string | null }
    | { kind: 'health-unreachable'; endpoint: string }
    | { kind: 'version-mismatch'; cliVersion: string; serverVersion: string | null }
    | { kind: 'auth-invalid' }
    | { kind: 'skipped'; reason: 'no-restart' | 'no-running-services' | 'no-verify-flag' };
  ```
  Genie has no auth model today, so `auth-invalid` is reserved (always `null` for now); the variant exists for shape parity.
- **Post-restart health probe** — call `genie doctor --json` (or a thin pgserve/scheduler probe) and feed its result through `decideVerify`. Gated by `--no-verify`.
- **`--no-restart` flag** — skip post-update maintenance and verification. Useful for CI / scripted reinstalls.
- **`--no-verify` flag** — restart services but skip the post-restart probe (escape hatch when probe is broken in a release).
- **`--no-sidecar-cleanup` accepted as no-op** — for cross-CLI portability with omni; logged and ignored.
- **Migrate ANSI prints to `ora` spinners + `chalk` banner** — fall back gracefully when `NO_COLOR` is set. Single-dep cost; omni already ships with this.
- **`verify` block added to diagnostics JSON; `schemaVersion` bump 1 → 2** — preserves backwards-compat readers via the `schemaVersion` field; omni wish stays at `1` per `SHARED-DESIGN.md` decision #4 (asymmetric numbers OK).
- **Tests:**
  - `decideVerify` branches (every `kind` variant including `skipped`).
  - `normalizeVersion` cases (`+gitsha`, missing patch, dev tag).
  - Channel resolution legacy values (matches omni's existing pin tests).
  - Exit codes per the shared exit-code contract (`SHARED-DESIGN.md` §4.5).
- **Cleanup registry primitive (`cleanupLegacyArtifacts()`)** — defined in this wish, omni's wish copies the type signatures (per `SHARED-DESIGN.md` decision #3 — independent implementations, identical shape):
  ```ts
  interface LegacyArtifact {
    readonly name: string;
    detect(): Promise<boolean>;
    cleanup(): Promise<{ removed: string[]; warnings: string[] }>;
    summary(): string;
  }
  export const REGISTRY: LegacyArtifact[];
  export async function cleanupLegacyArtifacts(skipList: Set<string>): Promise<CleanupReport>;
  ```
  Day-one registry is empty for genie (no known legacy artifacts to clean up — omni's day-one is `nats-reply-sidecar`). The interface lives here to be the canonical reference omni absorbs.

### OUT

- **No new auth model.** `auth-invalid` variant is reserved; genie has no API key story today.
- **No source-install path removal.** The existing `source` installer (git fetch + bun install + bun build + symlink) stays as-is. This wish only touches the post-install verification + diagnostics path.
- **No npm install path removal.** Dual-install detection stays.
- **No plugin cache sync changes.** Existing `~/.claude/plugins/cache/...` sync logic untouched.
- **No tmux config refresh changes.** Existing tmux scripts/config/theme refresh untouched.
- **No post-update maintenance behavior changes.** `runPostUpdateMaintenance` keeps its current contract; the verify block is layered _on top_, not in place of, maintenance.
- **No omni or pgserve code in this PR.**
- **No shared package between repos** (per `SHARED-DESIGN.md` decision #3 — independent implementations, identical shape).
- **No removal of the existing `UPDATE_DIAGNOSTIC_SCHEMA_VERSION = 1`-keyed file shape.** New `verify` field is additive; consumers reading the old shape continue to parse.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Reuse the shared `VerifyResult` shape verbatim from omni's wish | One mental model across both CLIs; reviewers/operators learn it once. |
| 2 | `auth-invalid` variant present but unused (always reserved-null) | Future-proofs the shape for when genie eventually adds an API key model; avoids a breaking type change later. |
| 3 | `runDoctor` JSON dry-run is the verify probe | `genie doctor` already has a structured output mode; we feed its return value through `decideVerify` rather than re-implementing health checks. |
| 4 | Diagnostics `schemaVersion: 1 → 2` (asymmetric with omni's `1`) | Per `SHARED-DESIGN.md` decision #4: each repo evolves its own schema; aligned numbers would be a false coupling signal. Forward-compatible via the `schemaVersion` discriminator. |
| 5 | `cleanupLegacyArtifacts` lands here first; omni wish absorbs the type signatures | Genie has the bigger surface area in its `update.ts`; landing the primitive here gives omni a stable shape to copy. Independent implementations per decision #3. |
| 6 | `--no-sidecar-cleanup` accepted as a no-op for portability | An operator running a script that targets either CLI shouldn't have to branch on which is invoked. Genie has no sidecar; the flag is logged and ignored. |
| 7 | `--yes` matches omni's flag (not `--non-interactive`) | Cross-CLI consistency; `--yes` is the established pattern (apt, brew, npm). |
| 8 | Confirmation prompt added (genie today is silent) | Risky as a reflexive `genie update` — operators benefit from a "v4.260427 → v4.260504, proceed?" prompt; CI uses `--yes` / `GENIE_UPDATE_YES=1`. |
| 9 | `ora` + `chalk` over bare ANSI | Already a transitive dep via the existing CLI stack; the polish is uniform with omni; `NO_COLOR` is honored. |
| 10 | Verification poll deadline = 15s | Genie's daemon stack (pgserve, scheduler, tmux) takes longer to bounce than pm2-managed processes; 10s isn't enough on slower hosts. `--no-verify` is the escape hatch. |

## Success Criteria

- [ ] `genie update` on a current install with no available update exits 0 in <2s with the locked "Already up to date" line; no install attempted; no diagnostics file written.
- [ ] `genie update` on an install with an update available prompts (TTY) or auto-confirms (`--yes`); installs; restarts; verifies; writes diagnostics.
- [ ] `decideVerify` is exported as a pure function returning the tagged-union `VerifyResult`; covered by unit tests for every `kind`.
- [ ] `normalizeVersion('4.260504.21+abc1234')` returns `'4.260504.21'`; comparison against published-string equality is byte-identical post-strip.
- [ ] `genie update --yes` skips the prompt; `GENIE_UPDATE_YES=1 genie update` does the same.
- [ ] `genie update --no-verify` restarts services but emits `Server: v… (skipped)` in the banner; diagnostics shows `verify: { kind: 'skipped', reason: 'no-verify-flag' }`.
- [ ] `genie update --no-restart` skips both restart and verify; diagnostics shows `verify: { kind: 'skipped', reason: 'no-restart' }`.
- [ ] `genie update --no-sidecar-cleanup` is accepted with a one-line "(no-op for genie, retained for cross-CLI portability)" notice.
- [ ] Diagnostics JSON now contains a top-level `verify: <VerifyResult>` block; `schemaVersion: 2`; existing fields (`update`, `runtime`, `maintenance`, `recentLogSignals`, `paths`) preserved byte-identically.
- [ ] `cleanupLegacyArtifacts(new Set())` runs against the empty default registry, returns `{ entries: [] }`, and is consumed by omni-side wish without modification to the type signature.
- [ ] All existing tests in `__tests__/update.test.ts` continue to pass byte-identically (locked source-string for "post-update maintenance does not auto-start pgserve" stays green).
- [ ] `bun run check` (typecheck + lint + dead-code + skills:lint + wishes:lint + lint:emit + tests) passes on the wish branch.
- [ ] Fresh-box smoke: install via `install.sh` → `genie update --yes` → `genie update --yes` (second run = "already up to date") → diagnostics file contains both runs' verify blocks (one `ok`, one `skipped` for `no-running-services` if no daemons were up).

## Execution Strategy

This wish ships in two waves. Wave 1 lands the data shapes; Wave 2 wires them into the user-facing surface.

### Wave 1 — Shared shapes (parallel)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Extract `decideVerify` pure function + `VerifyResult` tagged-union; add `skipped` variant; tests pin every branch. |
| 2 | engineer | New `cleanupLegacyArtifacts()` registry + `LegacyArtifact` interface; empty day-one registry; tests cover detect/cleanup/skip even with empty list. |

### Wave 2 — Integration (sequential after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Pre-flight registry version check + `normalizeVersion` + TTY confirm + `--yes` / `GENIE_UPDATE_YES`. |
| 4 | engineer | Post-restart health probe via `genie doctor --json` → `decideVerify`; `--no-verify` + `--no-restart` flags. |
| 5 | engineer | Diagnostics JSON `verify` block + `schemaVersion: 2` bump; `ora` + `chalk` migration; `--no-sidecar-cleanup` accepted-no-op. |

## Execution Groups

### Group 1: Extract `decideVerify` + `VerifyResult` tagged-union

**Goal:** Land the pure decision function and tagged-union shape so omni's wish has a stable type to copy. All current behavior preserved; the function is testable in isolation.

**Deliverables:**
1. New canonical export from `src/genie-commands/update.ts`:
   ```ts
   export type VerifyResult =
     | { kind: 'ok'; cliVersion: string; serverVersion: string | null }
     | { kind: 'health-unreachable'; endpoint: string }
     | { kind: 'version-mismatch'; cliVersion: string; serverVersion: string | null }
     | { kind: 'auth-invalid' }
     | { kind: 'skipped'; reason: 'no-restart' | 'no-running-services' | 'no-verify-flag' };
   ```
2. `decideVerify(args): VerifyResult` — pure function, no I/O. Inputs: `cliVersion`, `serverHealthBody | null`, `skipReason | null`. Outputs: the tagged-union variant.
3. `normalizeVersion(s: string): string` — strips `+gitsha` (and any trailing build metadata) and returns the SemVer-comparable string. Mirror omni's existing helper.
4. Tests at `src/genie-commands/__tests__/update.test.ts`:
   - Every `kind` variant (5 cases).
   - `normalizeVersion` boundary cases (`+gitsha`, no metadata, leading whitespace, RC tag).
   - All current cases stay green.

**Acceptance Criteria:**
- [ ] `decideVerify({ skipReason: 'no-restart' })` returns `{ kind: 'skipped', reason: 'no-restart' }`.
- [ ] `decideVerify({ skipReason: 'no-verify-flag' })` returns `{ kind: 'skipped', reason: 'no-verify-flag' }`.
- [ ] `decideVerify({ cliVersion, serverHealthBody: null })` returns `{ kind: 'health-unreachable', endpoint: '...' }`.
- [ ] `decideVerify({ cliVersion: '1.0.0', serverHealthBody: { version: '0.9.0+abc' } })` returns `{ kind: 'version-mismatch', ... }` with normalized strings.
- [ ] `decideVerify({ cliVersion: '1.0.0', serverHealthBody: { version: '1.0.0+abc1234' } })` returns `{ kind: 'ok', ... }` (normalize stripped the gitsha).
- [ ] All current `__tests__/update.test.ts` cases pass byte-identically.

**Validation:**
```bash
bun test src/genie-commands/__tests__/update.test.ts
```

**depends-on:** none

---

### Group 2: `cleanupLegacyArtifacts()` registry + `LegacyArtifact` interface

**Goal:** Land the registry primitive so omni's wish has a stable interface to copy. Genie's day-one registry is empty (no known legacy artifacts), but the plumbing is in place for future cleanups (e.g. orphaned tmux configs, stale plugin caches if a future migration needs them).

**Deliverables:**
1. New module `src/genie-commands/legacy-cleanup.ts`:
   ```ts
   export interface LegacyArtifact {
     readonly name: string;
     detect(): Promise<boolean>;
     cleanup(): Promise<{ removed: string[]; warnings: string[] }>;
     summary(): string;
   }
   export interface CleanupReport {
     entries: Array<{ name: string; outcome: 'cleaned' | 'skipped' | 'absent'; removed: string[]; warnings: string[] }>;
   }
   export const REGISTRY: LegacyArtifact[] = [];  // empty for genie day-one
   export async function cleanupLegacyArtifacts(skipList: Set<string>): Promise<CleanupReport>;
   ```
2. Wire `cleanupLegacyArtifacts(skipList)` into `runUpdate` after the install completes and before the verify probe runs. With an empty registry the call is a no-op that returns `{ entries: [] }` — tested.
3. CLI flag `--skip-cleanup=<comma,separated,names>` parses into the `skipList`. `--no-sidecar-cleanup` is accepted, mapped to `skipList.add('nats-reply-sidecar')` (a no-op against the empty registry).
4. Tests at `src/genie-commands/__tests__/legacy-cleanup.test.ts`:
   - Empty registry → `cleanupLegacyArtifacts(new Set())` returns `{ entries: [] }`.
   - Synthetic artifact via dependency injection (test-only) → detect, cleanup, summary all called in order.
   - `skipList` honored: synthetic artifact present + `skipList = new Set(['name'])` → `outcome: 'skipped'`.

**Acceptance Criteria:**
- [ ] `cleanupLegacyArtifacts(new Set())` with default REGISTRY returns `{ entries: [] }`.
- [ ] `cleanupLegacyArtifacts(new Set(['x']))` with a synthetic injected REGISTRY containing artifact `x` returns `{ entries: [{ name: 'x', outcome: 'skipped', ... }] }`.
- [ ] `--skip-cleanup=a,b,c` populates the skipList correctly.
- [ ] `--no-sidecar-cleanup` is accepted, prints "(no-op for genie, retained for cross-CLI portability)" once, and adds `'nats-reply-sidecar'` to the skipList.

**Validation:**
```bash
bun test src/genie-commands/__tests__/legacy-cleanup.test.ts
```

**depends-on:** none

---

### Group 3: Pre-flight version check + confirm prompt + `--yes`

**Goal:** Stop reinstalling when already on latest; ask before mutating; allow CI to bypass.

**Deliverables:**
1. `fetchLatestVersion(channel: 'latest' | 'next'): Promise<string>` — calls `bunx npm view @automagik/genie@<channel> version` with a 5s timeout. Failure (network, parse) returns `null` (caller treats as "proceed with install" — defensive against the operator being offline mid-update).
2. `shortCircuitIfCurrent(currentVersion, latestVersion): boolean` — pure function; uses `normalizeVersion` from Group 1. Returns true → caller logs "Already up to date (vX.Y.Z, channel <c>)" and exits 0.
3. TTY confirmation prompt (`promptConfirm("Update vX → vY?")`) — same pattern as omni's `update.ts`. Non-TTY environments auto-confirm.
4. `--yes` / `-y` flag and `GENIE_UPDATE_YES` env (matching `GENIE_UPDATE_*` env-var convention).
5. Tests:
   - `shortCircuitIfCurrent` boundary cases (equal, ahead, behind, missing latest).
   - `--yes` skips prompt.
   - `GENIE_UPDATE_YES=1` skips prompt.
   - Non-TTY auto-confirms.

**Acceptance Criteria:**
- [ ] `genie update` when already on latest exits 0 in <2s with the line `Already up to date (v<version>, channel <c>)`.
- [ ] Network failure during `fetchLatestVersion` does NOT block the update — proceeds with install (defensive).
- [ ] TTY prompt appears for an actual update; declining returns exit 0 with "Update declined".
- [ ] `--yes` and `GENIE_UPDATE_YES=1` both skip the prompt.

**Validation:**
```bash
bun test src/genie-commands/__tests__/update.test.ts -t "shortCircuit\|prompt\|yes"
```

**depends-on:** Group 1

---

### Group 4: Post-restart health probe + `--no-verify` + `--no-restart`

**Goal:** After `runPostUpdateMaintenance`, run the daemon health probe through `decideVerify` and surface the result. Operators get either a green banner or an actionable error.

**Deliverables:**
1. New helper `runVerifyProbe(opts): Promise<VerifyResult>` in `update.ts`:
   - Calls `genie doctor --json` (existing structured-output mode) with a 15s deadline + 500ms poll interval.
   - Feeds the parsed `DoctorReport` into `decideVerify`.
   - On parse failure or timeout → returns `{ kind: 'health-unreachable', endpoint: '<doctor cmd>' }`.
2. Wire into the success path of `runPostUpdateMaintenance` after maintenance completes.
3. CLI flags:
   - `--no-restart` — skip both restart-equivalent (post-update maintenance) AND the verify probe; diagnostics records `kind: 'skipped', reason: 'no-restart'`.
   - `--no-verify` — run maintenance, but skip the probe; records `kind: 'skipped', reason: 'no-verify-flag'`.
4. Banner shape (same 3-line as omni): `✓ CLI: v<latest>` / `✓ Server: v<server> (healthy)` or `(skipped)`. Auth row absent for genie (no auth model).
5. Tests:
   - `--no-restart` → `verify.kind === 'skipped'` with `reason: 'no-restart'`.
   - `--no-verify` → `verify.kind === 'skipped'` with `reason: 'no-verify-flag'`.
   - Probe timeout → `verify.kind === 'health-unreachable'`.
   - Successful probe → `verify.kind === 'ok'` with cli + server versions.

**Acceptance Criteria:**
- [ ] `genie update --no-restart` exits 0; banner shows `Server: v… (skipped)`; diagnostics records the skipped variant.
- [ ] `genie update --no-verify` runs maintenance but emits `Server: v… (skipped)` for the probe; exit 0.
- [ ] On a healthy box, `genie update` shows `Server: v<latest> (healthy)` (assuming the daemon stack is up).
- [ ] On a box with no daemons running, `verify.kind === 'skipped'` with `reason: 'no-running-services'` and exit 0.
- [ ] Probe timeout (artificially induced via mocked `doctor` invocation) yields `verify.kind === 'health-unreachable'` and exit 1 (unless `--no-verify` set).

**Validation:**
```bash
bun test src/genie-commands/__tests__/update.test.ts -t "verify\|probe\|no-restart\|no-verify"
```

**depends-on:** Group 1

---

### Group 5: Diagnostics `verify` block + schema bump + `ora`/`chalk` polish + `--no-sidecar-cleanup`

**Goal:** Capture the verify result in the diagnostics JSON, bump the schema version, and finish the cosmetic polish.

**Deliverables:**
1. Diagnostics JSON now contains:
   ```jsonc
   {
     "schemaVersion": 2,        // bumped from 1
     "verify": <VerifyResult>,  // NEW
     "cleanups": <CleanupReport>, // NEW from Group 2
     // existing fields unchanged:
     "generatedAt": "...",
     "cli": "genie",
     "update": { ... },
     "runtime": { ... },
     "maintenance": { ... },
     "recentLogSignals": { ... },
     "paths": { ... }
   }
   ```
2. JSDoc top-of-file documents the schema-bump policy ("bump on every additive change; consumers branch on `schemaVersion`").
3. ANSI prints replaced with `ora` spinners + `chalk` banner. Honors `NO_COLOR`.
4. `--no-sidecar-cleanup` flag accepted — prints "(no-op for genie, retained for cross-CLI portability)" once and adds `'nats-reply-sidecar'` to the skipList. Confirmed no-op against the empty default REGISTRY.
5. Help text in `createUpdateCommand` lists every flag including `--no-sidecar-cleanup`.
6. Tests:
   - Diagnostics file shape — `schemaVersion: 2`, `verify` and `cleanups` blocks present.
   - `--no-sidecar-cleanup` accepted-no-op.
   - Help text snapshot (lock the surface).

**Acceptance Criteria:**
- [ ] After every `genie update` invocation (success or declined), exactly one `~/.genie/logs/update-diagnostics-*.json` is written.
- [ ] File parses as valid JSON; contains `schemaVersion: 2`, `verify`, `cleanups` keys.
- [ ] All ANSI prints in `update.ts` migrated to `ora` / `chalk`; `NO_COLOR=1` produces clean unstyled output.
- [ ] `genie update --no-sidecar-cleanup` is accepted with the one-line notice; behavior identical to without the flag.
- [ ] `genie update --help` lists all of: `--yes`, `--no-restart`, `--no-verify`, `--no-sidecar-cleanup`, `--skip-cleanup`, `--skip-maintenance`, `--next`, `--stable`.

**Validation:**
```bash
bun test src/genie-commands/__tests__/update.test.ts
genie update --help
NO_COLOR=1 genie update --dry-run | head -20
```

**depends-on:** Group 4

---

## Cross-wish dependencies

- **paired-with** [`automagik/omni#update-unify-stages`](../../../../omni/.genie/wishes/update-unify-stages/WISH.md) — both wishes ship in parallel against their respective `dev` branches. Each repo owns its implementation; the public shape (`VerifyResult`, `LegacyArtifact`, flags, exit codes, diagnostics schema discriminator) is shared verbatim.
- **not-paired-with** `pgserve#autopg-upgrade-command` — different domain (DB lifecycle migration, not CLI installer UX); no shared dependencies.

## QA Criteria

_What must be verified on `dev` after merge. The QA agent tests each criterion._

- [ ] Functional — `genie update` on a current machine exits 0 in <2s with the locked "Already up to date" line.
- [ ] Functional — `genie update --yes` on an actual update path completes install + restart + verify; banner is correct; diagnostics file is well-formed.
- [ ] Functional — `genie update --no-restart` skips maintenance + verify; diagnostics shows `kind: 'skipped', reason: 'no-restart'`.
- [ ] Functional — `genie update --no-verify` runs maintenance, skips probe; diagnostics shows `kind: 'skipped', reason: 'no-verify-flag'`.
- [ ] Functional — `genie update --no-sidecar-cleanup` accepted with one-line notice; behaves identically.
- [ ] Integration — Diagnostics file written on every invocation (success, declined, `--no-restart`, error path).
- [ ] Integration — `verify` block in diagnostics matches the runtime `VerifyResult` exactly across all five variants.
- [ ] Regression — All current `__tests__/update.test.ts` cases pass byte-identically.
- [ ] Regression — Source-install path still works on a fresh clone (`GENIE_SRC=/path/to/genie genie update`).
- [ ] Regression — Bun + npm dual-install detection unchanged.
- [ ] Regression — Plugin cache sync, tmux config refresh, post-update maintenance unchanged.
- [ ] Regression — `UPDATE_DIAGNOSTIC_SCHEMA_VERSION` legacy consumers reading `schemaVersion: 1` files still parse (forward-compat).
- [ ] Cross-CLI parity — `decideVerify` shape matches omni's byte-for-byte (verified by spot-check against omni's `update-verify.test.ts`).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `genie doctor --json` doesn't exist or doesn't expose what `decideVerify` needs | High | Group 4 audits doctor's output first; if it doesn't have the shape, this wish adds a thin probe (`src/lib/health-probe.ts`) that synthesizes the doctor result. Worst case: Group 4 BLOCKS until doctor is upgraded — escalate to a sibling micro-wish. |
| Verification probe is slower than 15s on a healthy host with long pgserve bounce | Medium | Poll up to 15s, then `--no-verify` is the escape hatch; document on first failure. |
| Diagnostics consumers reading `schemaVersion: 1` break on the bump to 2 | Low | Schema bump is additive (only new fields). Consumers MUST branch on `schemaVersion`; the contract was always "additive bumps". Tests pin both schema versions can be parsed. |
| Confirmation prompt surprises operators who expected silent update (today's behavior) | Low | Documented in CHANGELOG; `--yes` / `GENIE_UPDATE_YES=1` is the bypass; CI gets the env var via existing infra. |
| `cleanupLegacyArtifacts` empty default registry feels like dead code | Low | Day-one entry-point for future cleanups; matches the pattern omni uses; cost is one file. |
| Cross-channel network failure mid-`fetchLatestVersion` | Low | Defensive: returns `null`; caller proceeds with install (no false-block on transient network). |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Modify
src/genie-commands/update.ts                              # absorb decideVerify + normalizeVersion + flags + verify + schema bump
src/genie-commands/__tests__/update.test.ts               # extend with new branches

# Create
src/genie-commands/legacy-cleanup.ts                      # registry + LegacyArtifact interface
src/genie-commands/__tests__/legacy-cleanup.test.ts       # registry tests

# Reference (read-only, do not modify)
.genie/wishes/update-unify-stages/SHARED-DESIGN.md         # cross-repo unification spec (byte-identical to omni's)
```
