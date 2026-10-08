# Explicit Juice projects and manual extraction

Juice is disabled until you configure a project. There is no compiled gateway,
project, credential, model or JEV endpoint default. Ordinary Mikro runs do not
provision keys, fetch Keeper snapshots, or run JEV. These manual commands bypass
global settings/API-key injection and never change `process.env` or operator
settings.

## Project configuration

In a project's `.mikro/mikro.yaml`, configure reference-only identity:

```yaml
juice:
  origin: https://juice.labs.khal.ai
  project: genie
  key-alias: genie-engine-experiment
  key-epoch: epoch-1
  key-file: /home/genie/.local/share/mikro-engine-split/juice/genie.key
```

Use a separate key file and identity for each project (for example, brain).
The origin is an HTTPS origin, not `/v1` or `/keeper`; URL credentials,
query parameters and fragments are rejected. HTTP is accepted only on loopback
for isolated protocol tests. Never store keys inside a Git repository, even an
ignored directory. Key storage refuses enclosing `.git` markers and symlink
aliases. The containing directory must be owned by the invoking user, exactly
0700; the regular, single-link key file must be owned by that user, exactly
0600. Existing permissive files are rejected rather than silently changing
operator permissions. Key-file references must be absolute. Parent directories
must already exist; provision creates only the immediate private directory.

Provision explicitly, using a private management credential reference:

```sh
mikro juice provision --dir /path/to/genie --management-key-env JUICE_MANAGEMENT_KEY
mikro juice catalog --dir /path/to/genie
```

Alternatively use `--management-key-file` with the same private-file rules.
Never pass a credential value in argv. Provision creates a 32-byte random
`sk-juice-` key locally, then makes exactly one atomic PATCH to
`/v0/management/api-keys` with `{old: key, new: key}`. The supported operation
appends when absent and is idempotent when present; it never replaces the
whole list or deletes unrelated keys. If management fails, the local private
key stays available for the next explicit invocation, which reuses it. No
automatic provisioning retry, operator configuration write, or revocation
operation is provided. Successful output contains identity and references only.

All four Juice commands also support a complete explicit flag binding instead
of `--dir`: `--origin`, `--project`, `--key-alias`, `--key-epoch`, and `--key-file`.
A partial binding or mixing it with `--dir` is rejected. Management flags are
accepted only by `provision`; range flags only by `usage` and `analyze`.

## Catalog and inference

`catalog` authenticates `/v1/models` with only the selected project key. Its
version-1 JSON retains each exact advertised `id` and `owned_by` (as `ownedBy`,
null when unavailable), fetch URL/time, project/key identity and SHA-256 of the
sanitized catalog. It does not fabricate capabilities, price coverage,
provider ownership or model aliases. Freeze the actual returned IDs before
selecting candidates; a missing candidate is unavailable, not a renamed model.
An unknown owner stays unknown; GPT or an unknown owner is not evidence of
open-source provenance.

Use the existing `providers.juice` convention to declare the exact advertised
model IDs and their independently established context/output limits, sampling
capabilities and prices. Set `base-url` to the configured origin plus `/v1`;
`juice.key-file` supplies the credential reference. Then select
`model.provider: juice` and the literal advertised model ID. No catalog request
or routing inference runs during ordinary model resolution. Missing or partial
custom-provider input/output prices remain unknown; Pi rejects them before
inference. Explicit finite zero rates may describe genuinely free service.
Numeric SDK compatibility defaults are not billing evidence: configure verified
prices before making a canonical cost comparison.

The Juice project binding rejects mismatched endpoints/files, env-key fallback
and provider/model headers. Other genuine custom providers may directly use
`api-key-file` (or camel-case `apiKeyFile`) instead of `api-key-env`. Those
references are resolved through Pi 1.0.2's public `auth.apiKey.resolve` on each
invocation, including headless Pi SDK sessions. Keys are not stored in
`ModelConfig`, serialized provider configuration, or an ambient credential
store. Independent project provider arrays remain isolated and file rotation
is observed by the next invocation. File-auth provider diagnostics are omitted
at the completion boundary to prevent an upstream error from reflecting the
opaque key; stop reason and observed usage remain available. This intentionally
trades provider diagnostic detail for secret safety.
Pi denies both `juice.key-file` and provider `api-key-file` references through
lexical and real paths, even if an explicit context names the credential file.

## Manual viewer aggregates

```sh
mikro juice usage --dir /path/to/genie --range 24h
mikro juice analyze --dir /path/to/genie --range custom --unit day --start 2026-10-01 --end 2026-10-04
```

Supported rolling ranges are 5h–24h and 1d–30d, plus `today`, `yesterday`, and
`custom`. Custom ranges require explicit `unit`, `start`, and `end`; days use
`YYYY-MM-DD`, hours use hour-aligned RFC3339 timestamps. The server enforces its
current retention/calendar constraints and returns any conflict as an error.
No client timezone is silently invented: retain returned timezone and bounds;
missing bounds/timezone are null. Overview/latency responses without range
bounds do not acquire fabricated bounds from the query. A rolling query can
advance between fetches; use explicit custom bounds for comparisons.

The command POSTs the project inference key to
`/keeper/api/v1/auth/api-key-login`, with
`X-CPA-Usage-Keeper-Request: fetch`. It keeps only the standard viewer cookie
in memory, verifies `auth/session` reports `api_key_viewer`, and reads the
viewer-authorized `/version`. `usage` reads `/key-overview`; `analyze` also reads
`/key-analysis` and `/key-analysis/latency`. The cookie is logged out in a
`finally` block, including a failed fetch or invalid viewer role, with a fresh
bounded logout request even after the caller cancels. A failed logout prevents
a successful command result. No management credential is used for viewer
retrieval. No client-supplied key ID, admin route, request event, payload,
conversation or request-log export is available.

Version-1 snapshots contain exact URLs/queries, local project/key alias/epoch,
fetch times, server version, returned timezone/range, sanitized aggregate data,
and per-source/combined-sources SHA-256. Per-source hashes cover sanitized data;
the snapshot hash covers the emitted `sources` array including URL/time/range
provenance, not a secret-containing raw response. Credential/payload/source-identity fields
and reflected key/cookie values are omitted/redacted. Unknown costs are null
when `cost_available` is absent/false; unsupported or empty-sample latency metrics
remain null, not zero. These snapshots are observational aggregate views, **never canonical
runtime billing**; do not add them to call costs or invent request IDs. Responses
are bounded to 1 MiB, redirects fail closed, and HTTP failures expose only a
status, never request/header/response contents.

## Manual configured JEV

JEV is a separate explicit command using the existing `extractWithJev` adapter.
The caller must sanction the endpoint and sanitize a bounded JSON input before
invocation. The known official API is documented at
[TypeSafe API](https://docs.typesafe.ai/api) and
[TypeSafe models](https://docs.typesafe.ai/models); the known Brain lab explicitly
configured `https://api.typesafe.ai/v1/systemone` and `jev-1.13.0`. This is not
proof of a local deployed service or a reason to substitute a cloud endpoint.
The CLI always requires endpoint/model/auth reference; it has no fallback.

```sh
mikro jev --endpoint https://api.typesafe.ai/v1/systemone --model jev-1.13.0 --key-env TYPESAFE_API_KEY --input sanitized.json
```

`--key-file` is an alternative to `--key-env`. Exactly one auth reference is
required. The endpoint must explicitly end in `/v1/systemone` without URL
credentials/query/fragment, and HTTPS is required except loopback tests. Input
is at most 1 MiB and has this shape:

```json
{
  "sanitized": true,
  "state": "Public source facts to evaluate",
  "candidates": [
    {"id": "supported", "text": "Exact source-linked candidate span", "source": "public-source#lines-1-2"}
  ]
}
```

`sanitized: true` is the caller's deliberate approval, not automatic evidence of
redaction. Known credential patterns and the resolved credential are rejected in
every decoded JSON key/string, including Unicode-escaped input. The caller remains
responsible for removing private/unrecognized sensitive content.
Optional `noul: {instructions, criteria?: {true?, false?}}` and
`score: {instructions, criteria: [string, ...]}` are sent in the **same call**.
The module enforces candidate/answer bounds and always adds abstention.

Exactly one POST occurs, bounded to 60 seconds, with no retry/cache/translation,
ordinary-run hook, automatic Keeper upload or source mutation. Output retains
typed raw answers/distributions/confidence, requested and actual versioned model,
explicit endpoint/credential reference, fetch time, reported input/output tokens,
exact local candidates and their source references. The local source snapshot
reattaches input filename/SHA-256 and the evaluated state; this local provenance
is not sent to JEV. Source files are never rewritten.
`--help` and `-h` return before project/configuration or credential access.
Failures return nonzero exit status and sanitized stderr, not fake empty
selection. Source/code readiness is not proof that provisioning, real project
inference, deployed viewer/logout, or actual configured JEV extraction ran.

## Source authority

- Management semantics: `khal-platform/services/khal-engine/src/adapters/http-juice-keeper.ts`.
- Viewer routes/schema: [Willxup/cpa-usage-keeper revision 58a1ee2](https://github.com/Willxup/cpa-usage-keeper/tree/58a1ee2b19c78df62ba4536b8e8e67f824cf14ee), especially `internal/api/auth.go`, `router.go`, `usage_overview.go`, `usage_analysis.go`, and `internal/timeutil/usage_query_range.go`.
- Coordinator must separately prove actual project provisioning, authenticated catalog/call, viewer version/range/logout, permissions and configured manual extraction after build/review. No deployed proof is claimed here.
