# G8 — v4 Footprint Inventory (keep / rewrite / delete)

Grounded in a read-only audit of a real machine (2026-07-04) carrying both v4 and v5 caches.
Implementation: `src/genie-commands/legacy-v4.ts` (shared manifest + `detectV4Install` + `cleanupV4`),
invoked by `genie install` (install.sh handoff) and post-swap by `genie update`; consumed by `genie uninstall`.

## Audited ground truth

```
~/.claude/plugins/cache/automagik/genie/
  4.260428.3/   .orphaned_at=1783194185996   2.2M
  4.260509.9/   .orphaned_at=1783192004937   2.4M
  5.260703.5/   (no .orphaned_at — live)     364K
```

`4.260509.9/` contents (the canonical v4 plugin shape):
`.claude-plugin/ .in_use/ agents/ hooks/ references/ rules/ scripts/ skills/` +
`README.md genie.ts index.ts package.json settings.json`; `rules/genie-orchestration.md` (2.5K)
is the source of the globally installed copy.

Also present: `~/.claude/rules/genie-orchestration.md` (2.5K, carries both v4 markers) and a
`~/.claude/settings.json` hook entry `"command": "genie hook dispatch"`.

## Classification

| # | Artifact | Verdict | Gate / mechanism |
|---|----------|---------|------------------|
| 1 | `~/.claude/rules/genie-orchestration.md` with v4 markers (`genie spawn` / `genie team create` — dead daemon CLI) | **DELETE** | Content-marker gate → backup to `~/.genie/state-backups/v4-cleanup-<ts>/` (home-relative structure preserved) → remove → log. Wish Decision 10: delete, not rewrite — v5 plugin skills carry orchestration guidance now; a rewritten global file would duplicate and drift. |
| 2 | Same path, content WITHOUT v4 markers | **KEEP + warn** | Not provably genie-installed → never removed; warned on stdout, listed in `~/.genie/logs/v4-cleanup.log`. |
| 3 | `plugins/cache/automagik/genie/4.*` **with** `.orphaned_at` (both dirs above) | **DELETE** | Double gate: `4.` version prefix AND orphan marker. Manifest listing (file list + orphan timestamp) backed up instead of the ~2MB payload — re-downloadable plugin content. ~4.6MB reclaimed on the audited machine. |
| 4 | `plugins/cache/automagik/genie/4.*` **without** marker | **KEEP** | Not provably orphaned; reported as `kept-cache-unmarked` (informational). |
| 5 | `plugins/cache/automagik/genie/5.*` (live v5, e.g. `5.260703.5`) | **KEEP** | Outside the manifest's version prefix; never enters the detection report. |
| 6 | Any other plugin's cache dirs (`automagik/<other>/…`) | **NEVER TOUCHED** | Outside the `automagik/genie` namespace; cleanup cannot reach them (test-locked). |
| 7 | v4 payload dirs inside a removed cache version (`rules/ agents/ hooks/ references/ scripts/ skills/`) | **DELETE (transitively)** | Removed with their parent version dir; no per-file handling. |
| 8 | `~/.claude/settings.json` hook entry `genie hook dispatch` | **KEEP (audit-only)** | `genie hook` is live v5. v1 policy: hook entries are audit/log-only — settings.json is never modified; byte-identical survival is test-locked. |
| 9 | Non-genie files under `~/.claude/` (`rules/*.md` siblings, `CLAUDE.md`, `settings.json`, …) | **NEVER TOUCHED** | Cleanup addresses only manifest paths; test-locked. |

**Rewrite column: empty by design** — the only rewrite candidate (the global rules file) got a
DELETE verdict (Wish Decision 10, user-confirmed "mostly old… even deleted too").

## Safety properties (all test-locked in `legacy-v4.test.ts`)

- Backup **before** delete: a failed backup keeps the relic and records an `error` action.
- Unwritable `GENIE_HOME` degrades gracefully: stderr warning, no throw, cleanup step exits 0.
- Idempotent: clean machine is a strict no-op (nothing printed, nothing written); second run adds nothing.
- Symlinks in the cache root are skipped — cleanup can never follow a link out of genie's namespace.
- Opt-out: `--skip-v4-cleanup` on `genie install` (forwarded by install.sh); `genie update` path is non-fatal by contract (`runV4CleanupSafe`).
