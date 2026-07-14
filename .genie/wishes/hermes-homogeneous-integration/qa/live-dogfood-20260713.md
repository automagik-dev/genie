# Live dogfood — real host, isit profile — 2026-07-13

Operator-authorized post-merge QA ("i merged, move forward"). Release `v5.260713.2`
(dev channel, contains merge `40512016` of PR #2565) installed via the real
`genie update --dev -y` path on the aarch64 OrbStack host. Safety copy of the
profile config taken before the run; genie's own backup-first writes verified.

## Result: PASS — homogeneous triangle live — 2 follow-up defects filed

| QA criterion (wish) | Result | Evidence |
|---|---|---|
| `/wish`-style product skills invocable | **PASS** | `hermes skills list`: all 23 product skills (`architecture` … `work`) enabled as first-class `local` skills on the isit profile |
| `mcp_servers.genie` answers board/task queries | **PASS (structural)** | `profiles/isit/config.yaml:712-718`: managed-marker block, absolute `~/.genie/bin/genie` + `args: [mcp]`; doctor MCP leg green |
| Bounded context without `tmux capture-pane` | **PASS (payload)** | `~/.genie/plugins/hermes-genie` refreshed from the v5.260713.2 tarball — contains `session_context.py` + `pre_llm_call` registration; unit coverage merged |
| Claude/Codex lanes unchanged | **PASS** | update log: `claude — unchanged 22`, `codex — unchanged 23`, both plugin/hooks refreshed normally |
| Mutation gates intact | **PASS** | payload identical to reviewed merge; no mutation surface shipped |

Doctor after update — all four hermes legs green:

```
✔ agent sync: hermes — linked → ~/.genie/plugins/hermes-genie
✔ agent sync: hermes mcp — mcp_servers.genie → ~/.genie/bin/genie
✔ agent sync: hermes skills — external_dirs → ~/.genie/skills
✔ agent sync: hermes plugin enabled — genie enabled
```

Sticky-profile handling confirmed: writes landed in `profiles/isit/config.yaml`
(the live profile), with two distinct timestamped backups
(`config.yaml.genie-backup-2026-07-13T08-55-49-984Z` / `…50-984Z`) — the +1s
offset design working as reviewed.

## Defects found (filed as follow-up tasks)

### D1 — MEDIUM: duplicate nested `external_dirs` key written to the profile config

`mergeSkillsExternalDir` appended a managed `external_dirs:` block at the end of
the existing `skills:` block **without replacing the pre-existing inline child**
`external_dirs: []` (profile config line 423 vs managed block at 430-431). The
`skills:` mapping now carries two `external_dirs` keys — spec-invalid duplicate-key
YAML that works only because PyYAML resolves last-wins (managed entry wins;
skills load, doctor green). This is the nested-level sibling of the top-level
inline-key class the G2 review caught: the guard covers top-level `skills:`
inline values but not an inline child inside a block-style `skills:`.

Fix direction: when the `skills:` block exists, locate an existing
`external_dirs` child (inline `[]` or block) and replace/merge it in place
instead of appending a second key. Regression test: config with block `skills:`
+ inline `external_dirs: []` → exactly one `external_dirs` key after merge.

### D2 — MEDIUM: release auto-version bump skips `plugin.yaml`

The `[auto-version]` pipeline commit (`a4a8793d`) rewrites only the five JSON
manifests (package.json ×2, plugin.json ×2, marketplace.json) — it does not run
the new YAML sync wired into `scripts/version.ts` (G5). Shipped
`plugins/hermes-genie/plugin.yaml` is therefore pinned at `5.260712.2` while
genie is `5.260713.2`; `hermes plugins list` shows the stale version and the
wish's version-parity criterion only holds for the at-merge value. The smoke
script's version check would correctly FAIL on this host.

Fix direction: make the auto-version workflow invoke `synchronizeVersionFiles`
(or add plugin.yaml to its file list) so YAML manifests bump with the JSON ones.

## Notes

- Host channel switched `stable → dev` to receive the release (operator may
  revert with `genie update --stable -y`, which rolls the binary back to the
  stable manifest).
- Session-level `pre_llm_call` observation deliberately not scripted here — it
  fires on the next real Hermes turn inside a `.genie/` repo; unit coverage and
  payload presence verified.
