# Design: Cache contract truth

| Field | Value |
|---|---|
| **Slug** | `mikro-cache-contract-truth` |
| **Date** | 2026-08-31 |
| **WRS** | 100/100 |

## Problem

Mikro accepts and displays `cache.ttl` and `cache.expire-time` even though neither reaches providers, causing upgraded users to believe an inert cache lifetime is enforced. The public contract must expose only the working retention presets: `cache.retention: short` and `cache.retention: long`.

## Scope

### IN
- Remove `cache.ttl` and `cache.expire-time` from config types, parser output, templates, schema/help, cache estimates, tests, docs, and examples.
- Detect either obsolete key and hard-fail configuration before provider/cache work. The error must say that `mikro migrate` cannot choose for the user and print both individually valid alternatives: `cache.retention: short` and `cache.retention: long`.
- State explicitly that `mikro migrate` does not translate these keys; migration is a human semantic choice.
- Preserve existing retention preset behavior and add changelog `Removed`/`Changed` guidance.
- Prove feature-specific local and exact-SHA remote-dev read-back.

### OUT
- Automatic migration, warnings-only compatibility, arbitrary seconds, Google explicit cached-resource lifecycle, provider TTL plumbing, or stale-branch ports.
- Changes to retention preset semantics.

## Approach

Fail closed when obsolete keys are present, naming the key and the only supported replacement shape. Do not guess whether a historical number/timestamp meant short or long. Remove every advertised/read-back surface while retaining the existing preset path unchanged. Warning-and-ignore and auto-migration were rejected because both can silently change semantics.

### Path ownership boundary

The child wish must freeze the exact allowlist covering cache fields/parser in `src/config.ts`, cache display/use in `src/cli.ts`, relevant schema/templates, cache-focused tests, README/cache docs/examples/changelog, and generated counterparts produced by the build. Shared CLI/schema/docs paths are exclusively owned in its program wave.

## Simplicity Case

- **Simplest complete design:** reject two false keys and document the already-working preset.
- **Added machinery:** one obsolete-key validation branch, paid for by deterministic upgrade behavior.
- **Deferred until measured:** arbitrary TTL requires a provider lifecycle design and evidence.
- **Complexity removed:** silent inert values and semantic migration guesses.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Old keys hard-fail | Ignoring them repeats the false contract. |
| 2 | Error guidance prints `cache.retention: short` and `cache.retention: long` as two separate alternatives | Each line is valid configuration that can be copied as written. |
| 3 | No auto-migration | Seconds and timestamps cannot be mapped to presets without guessing intent. |
| 4 | Validation occurs before provider work | Invalid config must have zero spend and side effects. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Parser silently drops unknown nested keys | High | Focused tests invoke both exact obsolete spellings and assert nonzero exit and zero provider calls. |
| 2 | Docs leave an old example discoverable | High | Repository search contract plus changelog and migration guidance. |
| 3 | Retention behavior regresses | Medium | Golden tests compare preset provider arguments before/after. |

## Success Criteria

- [ ] Config containing `cache.ttl` satisfies every rejection oracle below for both config-discovery paths.
- [ ] Config containing `cache.expire-time` satisfies every rejection oracle below for both config-discovery paths.
- [ ] `mikro migrate --apply` preserves each obsolete key and value byte-for-byte while renaming the legacy config, and the migrated config continues to hard-fail until a human selects one preset.
- [ ] Supported `short` and `long` journeys each reach `completeSimple` once and preserve the configured preset in the provider arguments exactly as specified below.
- [ ] Help/schema/templates/docs/examples/changelog and generated outputs contain no live obsolete contract except explicit migration/removal prose.
- [ ] Exact-SHA remote-dev read-back runs every rejection, migration, and supported-preset journey with the complete remote/CI/install identity gate below immediately before and after that journey.

### Executable contract oracles

#### One suite identity, selected before any journey

The suite has exactly one expected commit, not one commit per journey. Before creating fixtures or running any journey, select and freeze it from `dev`, validate that it is exactly 40 lowercase hexadecimal characters, and select one successful `CI` push run for that same SHA:

```bash
set -euo pipefail
REMOTE=https://github.com/automagik-dev/mikro.git
REPO=automagik-dev/mikro
INSTALLED_CHECKOUT="$WORK/mikro-installed"
MIKRO_BIN="$WORK/bin/mikro"
EXPECTED_SHA="$(git ls-remote "$REMOTE" refs/heads/dev | cut -f1)"
case "$EXPECTED_SHA" in (*[!0-9a-f]*|'') exit 90;; esac
[ "${#EXPECTED_SHA}" -eq 40 ] || exit 90
gh api "repos/$REPO/actions/workflows/ci.yml/runs?branch=dev&event=push&status=success&per_page=100" >"$WORK/ci-runs.json"
CI_RUN_ID="$(jq -er --arg sha "$EXPECTED_SHA" '[.workflow_runs[] | select(.head_sha == $sha and .conclusion == "success")] | sort_by(.created_at) | last | .id' "$WORK/ci-runs.json")"
gh api "repos/$REPO/actions/runs/$CI_RUN_ID" >"$WORK/ci-selected.json"
jq -e --arg sha "$EXPECTED_SHA" '.head_sha == $sha and .head_branch == "dev" and .event == "push" and .conclusion == "success"' "$WORK/ci-selected.json" >/dev/null
```

Record `EXPECTED_SHA`, `CI_RUN_ID`, `.html_url`, and `.workflow_id` from `ci-selected.json` as suite evidence. Install that exact detached commit rather than installing a moving branch:

```bash
git clone --no-checkout "$REMOTE" "$INSTALLED_CHECKOUT"
git -C "$INSTALLED_CHECKOUT" fetch origin "$EXPECTED_SHA"
git -C "$INSTALLED_CHECKOUT" checkout --detach "$EXPECTED_SHA"
npm --prefix "$INSTALLED_CHECKOUT" ci --include=dev --no-audit --no-fund
npm --prefix "$INSTALLED_CHECKOUT" run build
mkdir -p "$(dirname "$MIKRO_BIN")"
ln -s "$INSTALLED_CHECKOUT/bin/mikro.mjs" "$MIKRO_BIN"
[ "$(readlink -f "$MIKRO_BIN")" = "$INSTALLED_CHECKOUT/bin/mikro.mjs" ]
```

No later step may reassign `EXPECTED_SHA` or `CI_RUN_ID`.

#### Exact config and context fixtures

Every isolated project has `context.txt` containing exactly `fixture context\n`. Rejection and migration fixtures use one of these complete YAML documents, replacing `<RETENTION_LINE>` with exactly one obsolete line:

```yaml
model:
  provider: google
  model: fixture-model
  sub-call-model: fixture-model
cache:
  enabled: true
  strategy: full
  <RETENTION_LINE>
rtk:
  enabled: never
```

The two substitutions are `ttl: 300` and `expire-time: "2030-01-01T00:00:00Z"`. Place the resulting bytes at either `.mikro/mikro.yaml` or `.rlmx/rlmx.yaml`; those directories are mutually exclusive. Supported-preset fixtures use the same document with `<RETENTION_LINE>` replaced by `retention: short` or `retention: long`.

#### Installed-executable capture harness

Use Node's synchronous ESM registration hook; do not edit the installed checkout or replace `mikro` with a test wrapper. Set `NODE_OPTIONS=--import=$HARNESS/register.mjs` on the real installed executable. `register.mjs` is exactly:

```js
import { registerHooks } from "node:module";
const target = "@earendil-works/pi-ai/providers/all";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === target) {
      return { url: new URL("./provider.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
```

`provider.mjs` is exactly:

```js
import { appendFileSync } from "node:fs";
let calls = 0;
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
export function builtinModels() {
  return {
    setProvider() {},
    getProvider(provider) { return { id: provider }; },
    getModel(provider, id) {
      return { id, provider, api: "google-generative-ai", name: id,
        reasoning: false, input: ["text"], contextWindow: 1048576,
        maxTokens: 8192, cost };
    },
    async completeSimple(model, context, options) {
      calls += 1;
      const capture = {
        call: calls,
        model: { provider: model.provider, id: model.id },
        options: {
          keys: Object.keys(options).sort(),
          maxTokens: options.maxTokens,
          signal: options.signal instanceof AbortSignal ? "<AbortSignal>" : null,
          cacheRetention: options.cacheRetention,
          sessionId: options.sessionId,
        },
        context: { messageCount: context.messages.length, hasSystemPrompt: typeof context.systemPrompt === "string" },
      };
      appendFileSync(process.env.MIKRO_CAPTURE, JSON.stringify(capture) + "\n", { flag: "a" });
      if (calls !== 1) throw new Error(`fixture completeSimple called ${calls} times`);
      return {
        role: "assistant",
        content: [{ type: "text", text: "FINAL(retention-witness-ok)" }],
        api: "google-generative-ai",
        provider: model.provider,
        model: model.id,
        responseModel: model.id,
        usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 11, totalTokens: 14, cost },
        stopReason: "stop",
        timestamp: 0,
      };
    },
  };
}
```

This is a deterministic provider response at the actual imported `models.completeSimple` boundary. The hook records the third argument before returning the parser-valid `FINAL(retention-witness-ok)` signal; a second call records itself and then fails. A missing `MIKRO_CAPTURE` is a harness error. The prescribed hook and response have also been smoke-executed against the installed launcher shape: exit `0`, empty stderr, one JSON response with answer `retention-witness-ok`, and one capture record.

#### Obsolete-key rejection matrix

For all four cells, run this exact installed command from the fixture project root (`CONFIG_KIND` determines which mutually exclusive config path was created):

```bash
rm -f "$CAPTURE" "$STDOUT" "$STDERR"
set +e
HOME="$ISOLATED_HOME" MIKRO_NO_SELF_HEAL=1 \
NODE_OPTIONS="--import=$HARNESS/register.mjs" MIKRO_CAPTURE="$CAPTURE" \
"$MIKRO_BIN" cache --context "$PROJECT/context.txt" --estimate >"$STDOUT" 2>"$STDERR"
status=$?
set -e
```

For `.mikro/mikro.yaml`, assert `status == 1`, `STDOUT` is zero bytes, `CAPTURE` does not exist, and stderr is exactly (including final newline):

```text
mikro: obsolete configuration key `<KEY>` is not supported; `mikro migrate` cannot choose a retention preset for you. Choose exactly one of:
  cache.retention: short
  cache.retention: long
```

For `.rlmx/rlmx.yaml`, the same assertions apply except stderr is exactly:

```text
mikro: reading legacy config from <ABS_PROJECT>/.rlmx — run `mikro migrate --apply` to rename it to .mikro/mikro.yaml
mikro: obsolete configuration key `<KEY>` is not supported; `mikro migrate` cannot choose a retention preset for you. Choose exactly one of:
  cache.retention: short
  cache.retention: long
```

Substitute `<KEY>` with exactly `cache.ttl` or `cache.expire-time`. A nonexistent capture file proves zero `completeSimple` calls; the production change must also retain focused unit instrumentation proving zero calls to every other provider-boundary function.

#### `migrate --apply` preservation and continued failure

For each obsolete-key legacy fixture, save `cp .rlmx/rlmx.yaml "$WORK/before.yaml"` and its parsed key/value, then execute exactly:

```bash
HOME="$ISOLATED_HOME" MIKRO_NO_SELF_HEAL=1 "$MIKRO_BIN" migrate --apply --root "$PROJECT"
cmp -s "$WORK/before.yaml" "$PROJECT/.mikro/mikro.yaml"
test ! -e "$PROJECT/.rlmx/rlmx.yaml"
```

Assert migration exit `0`, byte equality, exact parsed obsolete key/value, and absence of `cache.retention`. Then run the exact rejection command above and require the `.mikro` exit-`1`, empty-stdout, exact-stderr, and absent-capture oracle. The migration and its post-migration rejection are one journey enclosed by one before/after identity pair.

#### Supported-preset provider witnesses

For `RETENTION=short` and `RETENTION=long`, run the real top-level query path—not `mikro cache`, whose warmup currently catches provider errors—and invoke exactly from the fixture project root:

```bash
rm -f "$CAPTURE" "$STDOUT" "$STDERR"
HOME="$ISOLATED_HOME" MIKRO_NO_SELF_HEAL=1 \
NODE_OPTIONS="--import=$HARNESS/register.mjs" MIKRO_CAPTURE="$CAPTURE" \
"$MIKRO_BIN" "return the deterministic witness" --context "$PROJECT/context.txt" \
  --cache --max-iterations 1 --output json >"$STDOUT" 2>"$STDERR"
```

Require exit `0`; parse stdout as JSON and require answer `retention-witness-ok`; require stderr empty; parse capture as JSONL and require exactly one record with `call: 1`, `model: {provider:"google",id:"fixture-model"}`, `options.keys` exactly `['cacheRetention','maxTokens','sessionId','signal']`, `options.maxTokens: 16384`, `options.signal: '<AbortSignal>'`, a nonempty string `options.sessionId`, and `options.cacheRetention` exactly equal to the fixture's parsed `cache.retention`. Normalize only `options.sessionId` to `<SESSION_ID>` when comparing witnesses; after that normalization, short and long captures must differ only at `options.cacheRetention`. Because this command uses the normal query path, a thrown/rejected `completeSimple` call propagates to a nonzero CLI exit rather than being swallowed by cache warmup.

#### Remote-dev identity gate around every journey

The suite contains exactly eight identity-enclosed journeys: four obsolete-key rejection cells, two migration-plus-post-failure journeys, and two supported-preset provider witnesses. Immediately before and immediately after each journey, call a gate that performs fresh reads and appends one JSON evidence record:

```bash
identity_gate() {
  phase="$1" journey="$2"
  remote_sha="$(git ls-remote "$REMOTE" refs/heads/dev | cut -f1)"
  gh api "repos/$REPO/actions/runs/$CI_RUN_ID" >"$WORK/ci-now.json"
  ci_sha="$(jq -er '.head_sha' "$WORK/ci-now.json")"
  installed_sha="$(git -C "$INSTALLED_CHECKOUT" rev-parse HEAD)"
  resolved_bin="$(readlink -f "$MIKRO_BIN")"
  [ "$remote_sha" = "$EXPECTED_SHA" ]
  [ "$ci_sha" = "$EXPECTED_SHA" ]
  [ "$installed_sha" = "$EXPECTED_SHA" ]
  jq -e --arg sha "$EXPECTED_SHA" '.head_sha == $sha and .head_branch == "dev" and .event == "push" and .conclusion == "success"' "$WORK/ci-now.json" >/dev/null
  case "$resolved_bin" in ("$INSTALLED_CHECKOUT"/*) ;; (*) exit 91;; esac
  jq -nc --arg phase "$phase" --arg journey "$journey" --arg expected "$EXPECTED_SHA" \
    --arg remote "$remote_sha" --arg ci "$ci_sha" --arg installed "$installed_sha" \
    --arg bin "$resolved_bin" --argjson run "$CI_RUN_ID" \
    '{phase:$phase,journey:$journey,expected:$expected,remote:$remote,ci:$ci,installed:$installed,bin:$bin,ciRun:$run}' \
    >>"$WORK/identity.jsonl"
}
```

The runner must execute `identity_gate before "$journey"`, then the journey and all of its assertions, then `identity_gate after "$journey"`; a failed journey must not emit an `after` success record or reuse its evidence. Across all eight journeys, every before/after remote ref, selected-CI `head_sha`, and installed `HEAD` must equal the same suite-wide `EXPECTED_SHA`. Any ref movement, CI mismatch/failure, installed mismatch, or executable outside the installed checkout fails the suite.

## Next Step

After an independent review of this DESIGN returns SHIP and its evidence verifies, run `wish` for `mikro-cache-contract-truth` only.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `de0ebef73bfd9546c37a2dc2c8436d944def71ad9ff9e5e3b92669b3421d101b`
- **Reviewer:** `openai-codex:gpt-5.6-sol-900k`
- **Reviewed at:** `2026-08-31T22:03:39Z`
<!-- genie-design-review:end -->
