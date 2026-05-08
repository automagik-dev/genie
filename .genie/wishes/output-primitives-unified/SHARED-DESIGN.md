# SHARED-DESIGN: Unified output primitives across genie + omni CLIs

**Status**: design locked 2026-05-04. Companion wishes: `automagik-dev/genie#output-primitives-unified` + `automagik/omni#output-primitives-unified`. Both wishes share this document byte-identically.

**Goal**: One PR per CLI (against `dev`) that converges genie's and omni's command output on a single shared surface — `output.ts` — with identical function names, identical glyphs, identical color semantics, identical JSON-mode dual-output, identical pipe-flush behavior.

---

## 1. Audit at design time (2026-05-04)

### genie (`automagik-dev/genie`, `origin/dev`)

| Path | Files | console.log/error/warn | ANSI escapes (`\x1b[`) | chalk | ora | Centralized helper |
|------|------:|----------------------:|----------------------:|------:|----:|--------------------|
| `src/genie-commands/*.ts` | 11 | **175+** across 7 files | **115+** across 7 files | 0 | 0 | **none** |
| Worst offenders | — | `setup.ts` (66), `doctor.ts` (62), `update.ts` (46), `uninstall.ts` (28), `perf-check.ts` (20), `session.ts` (17), `shortcuts.ts` (9) | `setup.ts` (38), `doctor.ts` (33), `uninstall.ts` (18), `perf-check.ts` (11), `update.ts` (9), `shortcuts.ts` (6) | — | — | — |

**Pattern in genie today** (literal from `src/genie-commands/update.ts`):
```ts
function log(message: string): void {
  console.log(`\x1b[32m▸\x1b[0m ${message}`);
}
function success(message: string): void {
  console.log(`\x1b[32m✔\x1b[0m ${message}`);
}
function error(message: string): void {
  console.log(`\x1b[31m✖\x1b[0m ${message}`);
}
```

Each command file has its own variant. No `--json` mode. No `NO_COLOR` honoring. No pipe-buffer drain. Glyph drift between files (some use `▸`, others `→`, others bare text).

### omni (`automagik/omni`, `origin/dev`)

| Path | Files | uses `output.*` already | direct chalk | direct ora | bare ANSI |
|------|------:|------------------------:|-------------:|-----------:|----------:|
| `packages/cli/src/commands/*.ts` | 54 | **47 files** | `update.ts` (5 calls) | `update.ts` (5), `install.ts` (3), `providers-setup.ts` (1), `film.ts` (1) | 0 |
| Helper file | 1 | — | — | — | — |

**Existing `packages/cli/src/output.ts`** (322 LOC, 11 exports):
- `success(msg, data?)`, `error(msg, details?, exitCode?)`, `warn(msg)`, `tip(msg)`, `info(msg)`
- `data(value)` — auto-detects array → `printTable`, object → `printObject`, primitive → `String(...)`.
- `list(items, opts?)` — table render with empty-message fallback.
- `keyValue(key, value)`, `header(title)`, `dim(text)`, `raw(text)`.
- `disableColors()`, `areColorsEnabled()`, `getCurrentFormat() → 'human' | 'json'`.
- `flushStdout()` — pipe-buffer drain via `process.stdout.write(chunk, cb)` so `omni xxx --json | cat > file.json` doesn't truncate at 64KB on Linux.

**Already canonical**. The 9 direct `chalk`/`ora` usages in `update.ts` and `install.ts` are the outliers — explained by the fact that `output.ts` does not yet expose `step` / `spinner` / `banner` / `progress` / `divider` primitives that those flows need.

---

## 2. The asymmetry — what each wish actually has to do

| Work | genie | omni |
|------|-------|------|
| Create `output.ts` from scratch | **YES** (new file) | NO (already exists, 322 LOC) |
| Add `chalk` + `ora` deps to `package.json` | **YES** (zero today) | NO (both already in `packages/cli/package.json`) |
| Add `boxen` + `cli-progress` deps | YES | YES |
| Migrate 7 command files from bare ANSI / `console.log` to `output.*` | **YES** (~290 call sites) | NO (already migrated) |
| Migrate `update.ts` direct chalk/ora to `output.*` | YES (Group 5 of `update-unify-stages` already proposes this; this wish closes the loop) | YES (5 chalk + 5 ora call sites) |
| Migrate `install.ts` direct ora to `output.spinner` | YES (when it lands) | YES (3 ora call sites) |
| Migrate `providers-setup.ts` direct ora | — | YES (1 ora call site) |
| Migrate `film.ts` direct ora | — | YES (1 ora call site) |
| Add `step` / `spinner` / `banner` / `progress` / `divider` to `output.ts` surface | YES | YES |
| JSON mode behavior | YES (new) | already there |
| `NO_COLOR` / TTY auto-detect | YES (new) | already there |
| Pipe-buffer drain (`flushStdout`) | YES (new — Bun on Linux truncates >64KB pipe writes) | already there |

Estimate: genie ≈ 4-6 engineer-days; omni ≈ 1-2 engineer-days.

---

## 3. The shared surface — what `output.ts` exports in BOTH repos

**Existing in omni (preserved byte-identically)**:
```ts
export function success(message: string, data?: unknown): void;
export function error(message: string, details?: unknown, exitCode?: number): never;
export function warn(message: string): void;
export function tip(message: string): void;
export function info(message: string): void;
export function data(value: unknown): void;
export function list<T>(items: T[], options?: { emptyMessage?: string; rawData?: unknown[] }): void;
export function keyValue(key: string, value: unknown): void;
export function header(title: string): void;
export function dim(text: string): void;
export function raw(text: string): void;
export function disableColors(): void;
export function areColorsEnabled(): boolean;
export function getCurrentFormat(): 'human' | 'json';
export function flushStdout(): Promise<void>;
export function setMaxCellWidth(width: number): void;
```

**NEW additions (both repos add these — identical signatures)**:
```ts
/**
 * Print a stage divider — bold cyan ▸ + bold message + newline above.
 * In JSON mode: emits `{ step: "<msg>" }` to stderr.
 * Replaces ad-hoc `console.log("\n\x1b[1;36m▸ <msg>\x1b[0m\n")` patterns.
 */
export function step(message: string): void;

/**
 * Wrap an `ora` spinner with format-awareness.
 * - Human mode: returns a thin proxy over the real `ora` spinner.
 * - JSON mode: returns a stub that emits `{ spinner: "start", text }` /
 *   `{ spinner: "succeed", text }` to stderr but never writes to stdout.
 *   Stdout stays clean for JSON consumers.
 * - Non-TTY (`--no-color`, piped, CI): the spinner degrades to plain
 *   `info(text)` on start and `success(text)` on succeed; no \r animation.
 */
export interface OutputSpinner {
  start(): OutputSpinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  set text(value: string);
}
export function spinner(text: string): OutputSpinner;

/**
 * Print a boxed banner (boxen wrapper). Used for "Updated to vX.Y.Z"
 * release-style announcements. Single-line input is centered; multi-line
 * is left-aligned. Honors NO_COLOR (degrades to ASCII box). In JSON mode
 * emits `{ banner: "<msg>" }` to stderr.
 */
export interface BannerOptions {
  title?: string;
  borderStyle?: 'single' | 'double' | 'round' | 'bold';
  borderColor?: 'green' | 'red' | 'yellow' | 'blue' | 'cyan';
  padding?: number;
}
export function banner(message: string | string[], options?: BannerOptions): void;

/**
 * Wrap `cli-progress` with format-awareness.
 * - Human mode TTY: returns the real `cli-progress.SingleBar`.
 * - JSON mode / non-TTY: returns a stub that emits one
 *   `{ progress: 0.42, total: 8000000, downloaded: 3360000 }` line per
 *   second (rate-limited) to stderr; never animates.
 */
export interface OutputProgress {
  start(total: number, startValue?: number): void;
  update(current: number): void;
  increment(delta?: number): void;
  stop(): void;
}
export function progress(label: string): OutputProgress;

/**
 * Print a horizontal divider — `─` × terminal width (or 80 if non-TTY).
 * In JSON mode: no-op (dividers are decoration; consumers don't need them).
 */
export function divider(): void;
```

**Glyph table (locked)**:

| Severity | Glyph | Color | Usage |
|----------|-------|-------|-------|
| step | ▸ | bold cyan | section headers in install/update/setup pipelines |
| info | ℹ | blue | informational lines (channel, version, path) |
| ok / success | ✓ | green | step-completed line |
| warn | ⚠ | yellow | recoverable issue |
| fail / error | ✗ | red | terminal failure |
| tip | 💡 | cyan | always-stderr nudges (non-blocking) |
| dim | — | dim grey | secondary text (paths, dates, timestamps) |

`figures` (transitive dep via `ora`) provides the cross-platform fallback. `boxen` provides the borders. `cli-progress` provides the bars.

---

## 4. New deps both repos add (locked versions)

| Dep | Version | Why | Bundle cost |
|-----|---------|-----|-------------|
| `chalk` | `^5.4.0` | Already in omni; genie adds. Same major. | ~22 KB |
| `ora` | `^8.1.1` | Already in omni; genie adds. Same major. | ~37 KB (includes figures) |
| `boxen` | `^7.1.1` | Banner rendering with locked border styles. | ~24 KB |
| `cli-progress` | `^3.12.0` | Download progress bar (used by self-update / install when fetching binaries). | ~18 KB |

All four are pure-JS, zero native deps, ESM-compatible. Combined: ~100 KB additional install size. Both CLIs already weigh several MB; this is rounding error.

**Optional** (deferred, not in v1):
- `terminal-link` — clickable hyperlinks in iTerm/kitty/wezterm. Add only when a concrete use case appears.

---

## 5. JSON mode contract

When `getCurrentFormat() === 'json'`:
- `success` writes valid JSON to stdout.
- `error` writes valid JSON to stderr; exits non-zero.
- `warn`, `info`, `tip` write valid JSON to **stderr** (so a `--json | jq` consumer of stdout still parses).
- `step`, `spinner.start/succeed/fail/warn/info`, `banner` emit `{ step|spinner|banner: "..." }` to **stderr**.
- `progress` emits `{ progress: 0.0–1.0, total, downloaded }` to **stderr** at most once per second.
- `divider`, `dim`, `header` are **no-ops**.
- `data`, `list`, `keyValue` write canonical JSON to stdout.

This is the contract omni already implements; genie adopts byte-for-byte.

---

## 6. NO_COLOR / TTY contract

- `NO_COLOR=1` env var → `disableColors()` called at startup; chalk auto-detects via its own NO_COLOR support.
- `process.stdout.isTTY === false` (piped output) → spinners degrade to `info` lines; progress bars degrade to per-second JSON lines.
- `--no-color` CLI flag → calls `disableColors()` on each command.
- `FORCE_COLOR=1` → forces colors even on non-TTY (useful for CI logs that render ANSI). Honored by chalk natively.

---

## 7. Migration order (within each repo)

1. **Land `output.ts` extensions first** (`step`, `spinner`, `banner`, `progress`, `divider`) — additive, no caller changes.
2. **Migrate the highest-traffic command** (genie: `update.ts` ; omni: `update.ts`) — proves the API in production.
3. **Migrate the install path** (genie: `install.ts`, `setup.ts` ; omni: `install.ts`).
4. **Migrate doctor + setup-adjacent commands** (`doctor.ts`, `perf-check.ts`, `uninstall.ts`, `shortcuts.ts`).
5. **Lint rule** — add a Biome / ESLint custom rule that fails on `console.log` / `console.error` / `console.warn` outside of `output.ts` itself (genie wish G6 ; omni already has an analogous rule via comment-based suppressions, formalize it).

---

## 8. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Independent implementations per repo (no shared package) | Same as `update-unify-stages` — coupling cost > duplication cost. |
| 2 | omni's existing `output.ts` is the reference; genie absorbs byte-for-byte | omni has 322 LOC of battle-tested code (JSON mode, pipe-flush, table render). Don't reinvent. |
| 3 | Add `step`, `spinner`, `banner`, `progress`, `divider` to BOTH `output.ts` files in the same wish | Locks the surface; prevents future drift. |
| 4 | Glyphs locked in §3 table | Operators learn one set; cross-CLI muscle memory. |
| 5 | JSON-mode emits stderr breadcrumbs for spinners/banners/progress | Stdout stays clean for `--json | jq` consumers; observability not lost. |
| 6 | `figures` (transitive via ora) handles cross-platform glyph fallback | No additional dep needed; macOS/Linux/Windows behave consistently. |
| 7 | Lint rule banning bare `console.log` outside `output.ts` lands in v1 | Without enforcement, drift returns. |
| 8 | `terminal-link` deferred to v2 | Optional polish; no current use case justifies the dep. |
| 9 | Glyph + color choices map 1:1 to the bash `install.sh` helpers | bash and TS sides should look identical to the operator. |
| 10 | `flushStdout()` is exported and called from each CLI's main entry on exit | Otherwise large `--json` payloads truncate at 64KB on Linux pipes. |

---

## 9. Exit code contract (additive — does not modify existing exit codes)

- `output.error(...)` exits 1 by default; takes optional `exitCode` parameter.
- `output.spinner(text).fail(...)` does NOT exit on its own; caller chooses.
- All other output functions never exit.

---

## 10. Tests both repos must ship

- `output.success` / `error` / `warn` / `info` / `tip` shape in human + JSON modes (snapshot or string-match).
- `output.step` glyph + color + JSON-mode stderr emission.
- `output.spinner` returns the right type per format mode; non-TTY degradation path.
- `output.banner` border styles render; multi-line input handled; JSON-mode stderr.
- `output.progress` rate-limited stderr in JSON mode; TTY animation path.
- `output.divider` no-op in JSON mode; correct width on TTY.
- `disableColors()` flips `areColorsEnabled()` and chalk respects it.
- `flushStdout()` drains pending writes before resolving.
- Lint rule (Biome custom or grep-based) catches a regression bare-console-log added to a non-`output.ts` file.

---

## 11. Out of scope

- Ink. Not adding. Output is streaming linear; Ink is for componentized TUIs.
- OpenTUI for non-TUI commands. Not adding. Same reason.
- Internationalization. Glyphs and color are universal; messages are English-only (matches both CLIs today).
- Telemetry hooks on output. Separate concern.
- Replacing `commander`'s built-in help text styling. Help text is commander's surface; not this wish.
- Cross-CLI shared package. Per Decision #1.

---

## 12. Definition of done (cross-repo)

- Both PRs merged to their respective `dev` branches.
- `output.ts` exports the same surface in both repos (`diff <(grep -E "^export" genie/output.ts) <(grep -E "^export" omni/output.ts)` is empty modulo path-only differences).
- Glyph table from §3 produces byte-identical lines for the same logical event in both CLIs.
- `genie update --json | jq` and `omni update --json | jq` both parse cleanly with no stderr leakage to stdout.
- Lint rule active in both CLIs; PRs touching command files cannot bypass without explicit `// biome-ignore` comment.
