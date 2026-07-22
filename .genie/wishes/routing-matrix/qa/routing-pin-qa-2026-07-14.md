# Routing-Matrix Pin — Day-3 Live QA (2026-07-14)

**Analyst run:** 2026-07-14T23:56:24Z; authenticated rerun through 2026-07-15T00:11:05Z  
**Build under test:** published dev `5.260714.8`  
**Verdict:** **FAIL / keep QA open.** Delivery and fresh-client discovery pass, but no role's
`model × effort` fingerprint can be accepted because Claude is logged out. Shared-project LangWatch
authentication now passes, but the bounded post-release window contains zero traces and zero routing
markers, so there is no execution evidence from which to resolve a model ID or effort.

No device login or personal LangWatch workspace was used. `.genie/INDEX.md` was deliberately not
changed to CLOSED.

## Mechanical delivery — PASS

Commands were run from `/Users/feliperosa/workspace/genie` through RTK.

```text
rtk genie --version
=> 5.260714.8

rtk jq '{managedBy, version, files}' ~/.claude/agents/.genie-sync.json
=> managedBy = genie-agent-sync
=> seven file entries, each version = 5.260714.8

rtk shasum -a 256 \
  ~/.claude/agents/{engineer-complex,engineer-standard,engineer-trivial,final-gate,fixer,reviewer,scout}.md
=> all seven hashes exactly match their manifest digests
```

| Agent file | Manifest and on-disk SHA-256 |
|---|---|
| `engineer-complex.md` | `31a2ae845d54f9d1db92bd6d57ebac87d29c5c633e6f03ea6e246e4f7a83ba98` |
| `engineer-standard.md` | `942a6d1567e00aee04d68c882d64831c535d1800240e0902cd2fb590edaee71d` |
| `engineer-trivial.md` | `1a54bf8284e715935ce93289edb493e750e59e1b134bb4661970efccd1cf1d27` |
| `final-gate.md` | `ca8d930c98140877d41f756ade256a9123516e6662477c9950985038a98bbaa0` |
| `fixer.md` | `aeeb68a16ef32d2a70c5a336da2349b021088ba68351d3ce8ba9ce1cc1e45c15` |
| `reviewer.md` | `e5fd9aa2fae3907a6e92a9d2e0ef34d1ae365bb9ee7944acca18d3d8a014fb43` |
| `scout.md` | `e48a678bdd9d3dff52a3dde928da3d6afc210eb391da9e1cd2298c8be1444dce` |

## Fresh supported client discovery — PASS

Claude Code `2.1.210` documents `-p/--print` as its non-interactive fresh-session surface and
`--agent <agent>` as the agent selector. A genuinely new process with a deliberately missing agent
caused Claude's own resolver to enumerate the locally available agents:

```text
rtk claude -p --agent routing-pin-deliberately-missing --output-format json \
  --no-session-persistence --tools "" --max-budget-usd 0.01 "Reply exactly MISSING"

=> --agent 'routing-pin-deliberately-missing' not found. Available agents:
   claude, engineer-complex, engineer-standard, engineer-trivial, final-gate, fixer,
   general-purpose, genie:engineer-complex, genie:engineer-standard,
   genie:engineer-trivial, genie:final-gate, genie:fixer, genie:reviewer,
   genie:scout, omni:omni-automation-builder, omni:omni-bot-framework,
   omni:omni-feature-implementor, reviewer, scout, statusline-setup
```

All seven bare names therefore surface in a fresh supported client process. The simultaneous
`genie:*` names corroborate doctor's duplicate-surface warning.

A known-agent control passed local resolution and reached the authentication boundary:

```text
rtk claude -p --agent scout --output-format json --no-session-persistence \
  --tools "" --max-budget-usd 0.25 "Reply with exactly: ROUTING_PIN_DAY3_20260714_SCOUT"
=> Not logged in · Please run /login

rtk claude auth status
=> {"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}
```

The login-shell override check reported `CLAUDE_CODE_SUBAGENT_MODEL` **ABSENT**.

## Doctor JSON contract — PASS, with warnings

`rtk genie doctor --json` returned `ok: true`. The check named
`agent sync: claude role agents` is deterministically consumable at
`checks[].roleAgents.files[].state`:

- `manifestStatus: managed`
- 7/7 files: `genie-managed-current`
- 0 `present-unmanaged`, 0 `genie-managed-stale`, 0 `missing-from-target`
- `duplicateSurface: true`

Warnings are not hidden:

- `agent sync: claude` reports `0/22 source skills current, 22 stale; council.js current`.
- `agent sync: duplicate role-agent surface` reports the enabled `genie@automagik` plugin and the
  resulting bare-name plus `genie:*` duplicate listings.
- Codex role-agent inventory and Codex hook-review warnings are also present; they do not change the
  Claude role-file classification above.

## LangWatch fingerprint pull — AUTH PASS, execution blocked

The CLI contract was read first with `langwatch --help`, `langwatch analytics query --help`, and
`langwatch trace search --help`. A shared-project API key was supplied only in the command process
environment for the self-hosted endpoint `https://langwatch.khal.ai`; it was never printed or stored.
No device login or personal workspace was used. `langwatch claude` is not an alternative because it
requires the forbidden personal device-login flow.

```text
LANGWATCH_API_KEY=<redacted> LANGWATCH_PROJECT_ID=<shared-project> \
LANGWATCH_ENDPOINT=https://langwatch.khal.ai langwatch status --format json
=> success; project status returned

langwatch trace search \
  --start-date 2026-07-14T23:40:45Z --end-date 2026-07-15T00:09:31Z \
  --limit 2000 --format json
=> 0 traces

langwatch trace search -q ROUTING_PIN_DAY3_20260714 \
  --start-date 2026-07-14T23:40:45Z --end-date 2026-07-15T00:09:31Z \
  --limit 2000 --format json
=> 0 matching traces
```

The lower bound is the release publication time; the upper bound is the actual UTC query time on the
following calendar day. Consequently:

- completed fresh role invocations: **0/7**;
- post-release traces queried: **0**;
- resolved model IDs observed: **0/7**;
- day-3 Fable/Opus/Haiku share and top-3-thread-excluded trend: **not measurable**.

The day-2 methodology remains the intended pull once Claude execution is restored: span-level grouped
metrics for model shares, trace search for effort, resolved model IDs rather than aliases, and the
secondary share trend reported with the top-three threads excluded. No configuration value or
unrelated trace is counted as a fingerprint.

## Per-role fingerprint verdict

The expected values below are aliases from the stamped files, not claimed resolutions.

| Role | Fresh surface | Expected alias × effort | Resolved model ID | Fingerprint verdict |
|---|---|---|---|---|
| `engineer-trivial` | PASS | `opus × low` | unavailable | **FAIL — not observed** |
| `engineer-standard` | PASS | `opus × high` | unavailable | **FAIL — not observed** |
| `engineer-complex` | PASS | `opus × xhigh` | unavailable | **FAIL — not observed** |
| `fixer` | PASS | `opus × medium` | unavailable | **FAIL — not observed** |
| `reviewer` | PASS | `opus × xhigh` | unavailable | **FAIL — not observed** |
| `final-gate` | PASS | `fable × high` | unavailable | **FAIL — not observed** |
| `scout` | PASS | `haiku × low` | unavailable | **FAIL — not observed** |

## Re-run gate

1. Restore a valid Claude Code account session on this host.
2. Re-run one fresh `claude -p --agent <role>` marker per role and the documented shared-project
   LangWatch pull.
3. Record each resolved model ID and effort. Mark routing-matrix QA CLOSED only when all seven
   fingerprints pass.
