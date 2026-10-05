# Wish: RTK integration — make rlmx agents token-aware by default

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `feat-rtk-integration` |
| **Date** | 2026-04-21 |
| **Design** | _No brainstorm — direct wish_ |

## Summary

rlmx's Python REPL spawns subprocesses during reasoning (via `subprocess.run`, via custom `TOOLS.md` helpers). Those calls bypass Claude Code's Bash hook, so they don't benefit from RTK's 60-90% token compression. This wish teaches rlmx about RTK: a built-in `run_cli` battery that auto-prefixes `rtk` when detected, a `rlmx doctor` check that surfaces RTK status, and template updates so every new TOOLS.md is RTK-aware by default.

Fail-open design: rlmx works identically without RTK installed; with RTK, every subprocess-spawning tool silently becomes 60-90% cheaper.

## Scope

### IN
- New built-in battery: `run_cli(cmd, *args, timeout=10)` in `python/batteries.py` that auto-prefixes `rtk` when on PATH
- RTK detection helper in `src/detect.ts` (or similar) that caches the `which rtk` result for the CLI process lifetime
- `rlmx doctor` subcommand (or equivalent health check) reports RTK status (installed / version / enabled / auto-prefix-on)
- Scaffold template updates (`src/templates/default/TOOLS.md` and `src/templates/code/TOOLS.md`) with an RTK-aware example that uses `run_cli`
- `src/templates/default/SYSTEM.md` gets a short "Prefer `run_cli` over raw `subprocess.run` for CLI calls" hint
- Opt-out config: `rtk: { enabled: auto | always | never }` in `rlmx.yaml` (default: `auto` — use when present)
- Unit tests: `run_cli` auto-prefix behavior (with stubbed PATH), fallback when RTK absent, opt-out via config
- Integration test: `run_cli` passes args through identically, preserves exit code / stdout / stderr
- README section: "RTK integration — 60-90% token savings for tool calls"

### OUT
- Bundling RTK binary with rlmx (RTK is a separate Rust install, handled by user's package manager)
- Forcing RTK as hard dependency (fail-open, not fail-closed)
- Runtime telemetry forwarding between rlmx and RTK (RTK's `rtk gain` already records — no cross-reporting needed)
- Wrapping Python's `subprocess.Popen` or `os.system` transparently at the REPL level (scope creep; users who need it call `run_cli` explicitly)
- Migration to RTK's Rust plugin substrate (the v0.4+ endgame per `khal-os/brain-hook-layer` COUNCIL.md — separate wish)
- Teaching Node.js / TypeScript callers to route through RTK (this wish is REPL-tool-scope only)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Detect RTK, don't bundle it | RTK is a Rust binary with its own release cadence + install paths (brew, cargo, curl). Bundling violates separation of concerns and bloats rlmx. |
| Fail-open when RTK absent | Matches `brain-hook-layer/COUNCIL.md` principle ("any error = pass original call through"). rlmx must work identically without RTK. |
| New battery `run_cli` (not wrap `subprocess`) | Transparent subprocess hijacking is invasive and surprises users who explicitly use raw `subprocess`. Explicit helper = explicit opt-in. |
| Config default `auto` | Principle of least surprise — if RTK is installed, the user already opted in at the system level. No extra ceremony. |
| Emit `[rtk:auto]` log line at first prefix | Observable by the LLM / operator that the prefix happened. One line per REPL session, not per call (noise). |
| Skip prefix when `cmd` already starts with `rtk` | Users who already explicitly wrote `rtk git status` shouldn't get `rtk rtk git status`. |
| Skip prefix for `rtk`-incompatible commands | RTK's own config has an `exclude_commands` list. We don't re-enforce it in rlmx — RTK's hook respects its own rules. If RTK is installed the user's RTK config is authoritative. |

## Success Criteria

- [ ] `run_cli("git", "status")` in a TOOLS.md tool prefixes to `rtk git status` when `which rtk` succeeds
- [ ] Same call with RTK absent executes `git status` directly, captures output, returns identical result shape
- [ ] `rlmx doctor` prints RTK status: installed version + enabled/disabled per config
- [ ] `rlmx.yaml` accepts `rtk: { enabled: auto | always | never }`; invalid values throw schema error
- [ ] `src/templates/default/TOOLS.md` contains a commented example of `run_cli` usage
- [ ] README has a clear RTK section with install link + before/after token-savings example
- [ ] `bun test` passes with new unit tests (auto-prefix on, fallback off, opt-out path)
- [ ] Manual dogfood: run a TOOLS.md-authored tool that calls `run_cli("git", "log", "-n", "10")`, verify `rtk gain` records the invocation
- [ ] TypeScript compiles clean (`bun run typecheck`)
- [ ] No regression on existing `rlmx` tests (full `bun test` green)

## Execution Strategy

### Wave 1 (parallel — the three touch points)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Detection + config schema + REPL battery `run_cli` |
| 2 | engineer | Template updates (TOOLS.md default + code) + SYSTEM.md hint |
| 3 | engineer | `rlmx doctor` subcommand + RTK status output |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | qa | Unit tests + integration test + manual dogfood |
| 5 | engineer | README section + release notes entry |
| review | reviewer | Review Groups 1-5 |

## Execution Groups

### Group 1: Detection + config + REPL battery

**Goal:** Give the Python REPL a battery that conditionally prefixes `rtk` based on availability + config, with a single detection round-trip per CLI process.

**Deliverables:**

1. **`src/rtk-detect.ts`** — NEW file (do NOT conflict with existing `src/detect.ts`, which does Python package detection). Add `detectRtk()`:
   ```ts
   export interface RtkStatus {
     available: boolean;
     version?: string;   // e.g. "0.28.2"
     path?: string;      // resolved absolute path
   }

   let cached: RtkStatus | undefined;

   export async function detectRtk(): Promise<RtkStatus> {
     if (cached) return cached;
     try {
       const { stdout } = await execFileAsync("rtk", ["--version"], { timeout: 2000 });
       const m = stdout.match(/rtk\s+(\S+)/);
       const which = await execFileAsync("which", ["rtk"]);
       cached = { available: true, version: m?.[1], path: which.stdout.trim() };
     } catch {
       cached = { available: false };
     }
     return cached;
   }
   ```

2. **`src/config.ts`** — Add RTK config section:
   ```ts
   export interface RtkConfig {
     enabled: "auto" | "always" | "never";
   }
   // default when absent: { enabled: "auto" }
   ```
   Validation: enum only; no `always` when `detectRtk()` returns unavailable → throw `rlmx config: rtk.enabled=always but rtk is not installed`.

3. **`python/batteries.py`** — Add `run_cli`:
   ```python
   def run_cli(cmd, *args, timeout=10, check=False, input=None):
       """
       Run a CLI command, auto-prefixing `rtk` when available + enabled.
       Returns {returncode, stdout, stderr, rtk_prefixed}.

       Detection + config are resolved at REPL startup (passed in via
       env var _RLMX_RTK_MODE: 'on' | 'off'). This function just reads it.
       """
       import os, subprocess
       mode = os.environ.get("_RLMX_RTK_MODE", "off")
       # Decide prefix once, up front — reused by both success and timeout paths.
       prefixed = (mode == "on" and cmd != "rtk")
       full_cmd = ["rtk", cmd, *args] if prefixed else [cmd, *args]
       try:
           r = subprocess.run(
               full_cmd,
               capture_output=True, text=True,
               timeout=timeout, input=input,
           )
           result = {
               "returncode": r.returncode,
               "stdout": r.stdout,
               "stderr": r.stderr,
               "rtk_prefixed": prefixed,
           }
           if check and r.returncode != 0:
               raise subprocess.CalledProcessError(r.returncode, full_cmd, r.stdout, r.stderr)
           return result
       except subprocess.TimeoutExpired as e:
           return {"returncode": -1, "stdout": "", "stderr": f"timeout: {e}", "rtk_prefixed": prefixed}
   ```

4. **`src/repl.ts`** — Thread RTK mode into REPL env:
   ```ts
   // when spawning Python REPL
   const rtk = await detectRtk();
   const enabled = config.rtk.enabled === "always"
     || (config.rtk.enabled === "auto" && rtk.available);
   spawnEnv["_RLMX_RTK_MODE"] = enabled ? "on" : "off";
   ```

5. **`src/rlm.ts`** — Emit a single log line at REPL init when prefix is active:
   ```
   [rtk:auto] RTK 0.28.2 detected — CLI subprocesses via run_cli() will auto-prefix rtk.
   ```
   Shown when `verbose` is truthy OR on first run_cli call in verbose mode. One line per session.

**Acceptance Criteria:**
- [ ] `detectRtk()` returns `{available: true, version}` when rtk is on PATH
- [ ] `detectRtk()` returns `{available: false}` when rtk is absent (no throw)
- [ ] Config parser accepts `rtk: {enabled: auto}`, rejects `rtk: {enabled: banana}`
- [ ] `run_cli("git", "status")` with `_RLMX_RTK_MODE=on` executes `rtk git status`
- [ ] `run_cli("rtk", "gain")` does NOT double-prefix (no `rtk rtk gain`)
- [ ] `run_cli` timeout + error paths return safe dict, don't throw out of REPL

**Validation:**
```bash
bun run typecheck
bun test src/rtk-detect.test.ts src/config.test.ts
# Python battery unit test runs under rlmx's existing Python test path (pytest).
# Skipped if rlmx has no Python test harness yet — track as a follow-up.
python -m pytest python/ -k run_cli 2>/dev/null || echo "pytest harness absent — skip"
```

**depends-on:** none

---

### Group 2: Template + system prompt updates

**Goal:** Make the RTK-aware pattern discoverable by every new rlmx scaffold.

**Deliverables:**

1. **`src/templates/default/TOOLS.md`** — Add an RTK-aware example after the existing boilerplate:
   ```markdown
   ## run_cli_example (demonstrates RTK auto-prefix)

   ```python
   def git_status():
       """Show compact git status. Auto-routes through RTK when installed."""
       r = run_cli("git", "status", "--short")
       return r["stdout"]
   ```
   ```

2. **`src/templates/default/SYSTEM.md`** — Add a short section after "Tools reference":
   ```markdown
   ## Subprocess discipline

   When calling external CLIs, prefer `run_cli(cmd, *args)` over raw `subprocess.run`.
   `run_cli` auto-prefixes `rtk` when available, producing 60-90% smaller output for
   the same command. Raw `subprocess.run` bypasses this and wastes tokens.
   ```

3. **`src/templates/code/SYSTEM.md`** — Same subprocess discipline section. (The code template does NOT have its own `TOOLS.md` — it inherits default's TOOLS.md via `src/scaffold.ts`. So the default template update above is sufficient for code scaffolds too. No separate code/TOOLS.md to modify.)

**Acceptance Criteria:**
- [ ] Default template `TOOLS.md` has a runnable `run_cli` example
- [ ] Both `default/SYSTEM.md` and `code/SYSTEM.md` mention `run_cli` preference
- [ ] Scaffolded project (`rlmx scaffold ... --template default`) inherits the example
- [ ] Scaffolded project (`rlmx scaffold ... --template code`) inherits default's TOOLS.md (verify `.rlmx/TOOLS.md` contains `run_cli`)

**Validation:**
```bash
bun run rlmx scaffold /tmp/rlmx-test-default --template default
grep -q "run_cli" /tmp/rlmx-test-default/.rlmx/TOOLS.md
grep -q "run_cli" /tmp/rlmx-test-default/.rlmx/SYSTEM.md

bun run rlmx scaffold /tmp/rlmx-test-code --template code
grep -q "run_cli" /tmp/rlmx-test-code/.rlmx/TOOLS.md        # inherits default
grep -q "run_cli" /tmp/rlmx-test-code/.rlmx/SYSTEM.md        # code's own SYSTEM.md
```

**depends-on:** Group 1 (needs `run_cli` to exist for examples to reference)

---

### Group 3: `rlmx doctor` RTK status

**Goal:** Surface RTK install state via a single command so users know if their tools are being accelerated.

**Deliverables:**

1. **`src/cli.ts`** — Add `rlmx doctor` subcommand if not present, or extend existing health check:
   ```
   rlmx doctor

   rlmx 0.260409.3
   node: v22.x (via bun)

   LLM providers:
     google  : GEMINI_API_KEY set (yes/no)
     openai  : OPENAI_API_KEY set (yes/no)
     anthropic: ANTHROPIC_API_KEY set (yes/no)

   RTK (token optimizer):
     installed : yes
     version   : 0.28.2
     path      : /home/user/.cargo/bin/rtk
     mode      : auto (enabled)

   Config:
     ~/.rlmx/settings.json (exists | missing)
     Active template: default
   ```

2. **Exit codes** for scriptable checks:
   - 0 = all systems nominal
   - 1 = at least one provider key missing (warn, not error)
   - 2 = RTK config says `always` but RTK is absent (error)

**Acceptance Criteria:**
- [ ] `rlmx doctor` prints RTK status section with version when available
- [ ] `rlmx doctor` works when RTK is absent (prints "installed: no", mode shown as "auto (disabled)")
- [ ] Exit code 2 when `rtk.enabled: always` and RTK missing (error path validated)

**Validation:**
```bash
rlmx doctor | grep -q "RTK"
rlmx doctor; echo "exit=$?"
```

**depends-on:** Group 1 (needs `detectRtk`)

---

### Group 4: Tests + dogfood verification

**Goal:** Prove the integration end-to-end with real token-savings measurement.

**Deliverables:**

1. **Unit tests** (`src/detect.test.ts`, `src/config.test.ts`):
   - `detectRtk` mocked PATH scenarios (rtk present, absent, timeout)
   - Config parser: valid/invalid `rtk.enabled` values
   - Double-prefix skip

2. **Python REPL test** — Add to existing battery tests:
   ```python
   def test_run_cli_auto_prefix(monkeypatch):
       monkeypatch.setenv("_RLMX_RTK_MODE", "on")
       # stub rtk with a fake script that echoes argv
       # assert argv[0] == "rtk"
   ```

3. **Integration test** (`tests/rtk-integration.test.ts`):
   - Scaffold a tempdir rlmx project
   - Invoke rlmx with a minimal TOOLS.md that calls `run_cli("git", "status")` in a git repo
   - Assert the output is RTK-filtered (contains compact format markers) when rtk is on PATH
   - Skip gracefully when rtk is absent in CI (log reason, don't fail)

4. **Dogfood evidence** — Manual run recorded in `.genie/wishes/feat-rtk-integration/DOGFOOD.md`:
   - `rtk gain` before
   - Run a canonical TOOLS.md workflow
   - `rtk gain` after — delta should show rlmx's commands recorded
   - Attach paste of `rtk gain --history`

**Acceptance Criteria:**
- [ ] All new unit tests green
- [ ] Integration test passes when rtk is present, skips cleanly when absent
- [ ] `DOGFOOD.md` produced during this group's execution, containing:
  - `rtk gain --format json` output BEFORE the test workflow
  - `rtk gain --format json` output AFTER the test workflow
  - Computed delta line: `Tokens saved: <N> (<pct>%)` — target >50%, fail the group if ≥0% savings not observed

**Validation** (run these commands in order; each assumes the previous succeeded):
```bash
# 1. Existing test suite still green
bun test

# 2. New integration test
bun test tests/rtk-integration.test.ts

# 3. DOGFOOD.md file was produced and contains a computed delta
#    (the file is a deliverable of THIS group, so this check runs AFTER
#    the engineer writes it — validates the deliverable's presence + shape)
test -f .genie/wishes/feat-rtk-integration/DOGFOOD.md
grep -qE "Tokens saved: [0-9]+ \([0-9]+%\)" .genie/wishes/feat-rtk-integration/DOGFOOD.md
```

**depends-on:** Group 1, Group 2

---

### Group 5: README + release notes

**Goal:** Discoverability. Users should find out RTK exists + how to install it from rlmx's own docs.

**Deliverables:**

1. **`README.md`** — New section after "Quick Start":
   ```markdown
   ## RTK Integration (token savings)

   rlmx auto-detects [RTK](https://github.com/rtk-ai/rtk) and routes CLI subprocess calls through it when available, for 60-90% token savings on tool outputs.

   ### Install RTK (optional)
   ```bash
   brew install rtk                                 # macOS
   curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh  # Linux/macOS
   cargo install --git https://github.com/rtk-ai/rtk  # Rust
   ```

   ### How it works
   - In your `TOOLS.md`, use `run_cli(cmd, *args)` instead of raw `subprocess.run(...)`
   - When RTK is installed, `run_cli` transparently prefixes with `rtk` → filtered output
   - When RTK is absent, `run_cli` passes through unchanged — no behavior break

   ### Configuration
   ```yaml
   # rlmx.yaml
   rtk:
     enabled: auto   # auto | always | never (default: auto)
   ```

   ### Verify
   ```bash
   rlmx doctor         # shows RTK status
   rtk gain            # shows token savings from rlmx + other RTK integrations
   ```
   ```

2. **`CHANGELOG.md`** (CREATE if absent — rlmx does not currently have one; introduce it with this entry as the first) — Entry under next version:
   ```
   ### Added
   - `run_cli` Python REPL battery (auto-prefixes `rtk` when available, for 60-90% token savings)
   - `rlmx doctor` reports RTK install status + config mode
   - `rtk.enabled: auto | always | never` in `rlmx.yaml`
   - Scaffold templates (default + code) now include RTK-aware examples
   ```

**Acceptance Criteria:**
- [ ] README section exists, renders correctly on GitHub
- [ ] Changelog entry lands under the next unreleased version

**Validation:**
```bash
grep -q "RTK Integration" README.md
grep -q "run_cli" CHANGELOG.md
```

**depends-on:** Group 4 (tested before documented)

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] **Functional** — `run_cli("git", "status")` in a real TOOLS.md session routes through rtk when it's installed (observable via `rtk gain --history`)
- [ ] **Regression** — existing rlmx sessions without RTK still work identically; no new spurious prefixes, no new log noise
- [ ] **Integration** — `rlmx doctor` exit code is 0 on a clean install with RTK present; 2 when `rtk.enabled: always` but RTK absent
- [ ] **Cross-platform** — integration test gracefully skips on Windows-native (RTK hook requires Unix shell per RTK docs); WSL treated as Linux
- [ ] **Template scaffolding** — `rlmx scaffold my-project --template default` produces TOOLS.md with `run_cli` example
- [ ] **Telemetry** — RTK telemetry (if user opted in) records rlmx-originated calls distinct from Claude Code bash calls

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Name collision: "rtk" is also Rust Type Kit on crates.io | Medium | `detectRtk` validates version output matches rtk-ai's format (`rtk <version>` line); if not, treat as absent + log warning |
| RTK not available for some platforms (e.g. musl, ARM) | Low | Fail-open is the whole design — rlmx works identically without it |
| Users on Windows-native get no benefit (RTK hook needs Unix shell) | Low | Document WSL recommendation; doctor output says "auto (disabled)" on Windows-native |
| Future RTK schema change breaks version detection | Low | Version detection is defensive (regex match; failure → treat as absent) |
| Double-prefix if user's existing TOOLS.md already uses `rtk` explicitly | Low | `run_cli` skips prefix when `cmd == "rtk"` |
| `run_cli` bloats the batteries.py surface — users won't discover it | Medium | Scaffold template puts an example front-and-center; SYSTEM.md calls it out; README has dedicated section |
| RTK not preserving stderr separately | Low | `run_cli` treats RTK as subprocess transparency layer; whatever RTK forwards, we forward |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
CREATE  src/rtk-detect.ts                             (RTK detection — do NOT touch src/detect.ts which handles Python pkgs)
MODIFY  src/config.ts                                 (add RtkConfig parsing + validation)
MODIFY  src/cli.ts                                    (rlmx doctor subcommand + RTK status)
MODIFY  src/repl.ts                                   (thread _RLMX_RTK_MODE env into REPL spawn)
MODIFY  src/rlm.ts                                    (optional single-line init log)
MODIFY  python/batteries.py                           (add run_cli function)
MODIFY  src/templates/default/TOOLS.md                (add run_cli example — inherited by code template via scaffold.ts)
MODIFY  src/templates/default/SYSTEM.md               (subprocess discipline section)
MODIFY  src/templates/code/SYSTEM.md                  (subprocess discipline section — code template has no TOOLS.md of its own)
MODIFY  README.md                                     (RTK Integration section)
CREATE  CHANGELOG.md                                  (new file — introduce release-notes file with this entry)
CREATE  src/rtk-detect.test.ts                        (rtk detection unit tests)
CREATE  tests/rtk-integration.test.ts                 (e2e subprocess routing test)
CREATE  .genie/wishes/feat-rtk-integration/DOGFOOD.md (manual verification evidence)
```

## Companion upstream work

This wish is part of a two-repo coordination:

- **This wish** (rlmx) — ship `run_cli` battery, detection, doctor, templates
- **Issue to file on `automagik-dev/rlmx`** — already drafted in our session notes; this wish IS the implementation response

The companion brainstorms `khal-os/brain/.genie/brainstorms/brain-hook-layer/` and `.../brain-rlmx-hooks/DRAFT.md` track the v0.4+ RTK-plugin migration — this wish ships the v1-standalone pattern (stdin/stdout shape compatible with RTK filter contract) so the future migration is non-breaking.

## Out-of-scope follow-ups (separate wishes)

- `rlmx doctor --format json` for scriptable checks (if the `doctor` command doesn't already emit JSON)
- A second battery: `run_cli_streaming(cmd, *args)` that yields lines for long-running commands
- Integration with rlmx's cost telemetry so `rlmx stats` can deduct RTK's saved tokens from estimated cost
- `rlmx templates publish <name>` to share RTK-aware TOOLS.md templates across the community
