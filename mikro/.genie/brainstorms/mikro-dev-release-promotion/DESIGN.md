# Design: Dev and release promotion

| Field | Value |
|---|---|
| **Slug** | `mikro-dev-release-promotion` |
| **Date** | 2026-08-31 |
| **WRS** | 100/100 |

## Problem

The active checkout is highly dirty, remote `dev` is absent, the default-branch rolling-PR workflow can race bootstrap, and release automation may create a metadata child. Mikro needs a clean, identity-bound lane that preserves new `main` work, promotes exactly one reviewed tree, and proves the released installation without rewriting shared history.

## Frozen live identities

These values are inputs, not rediscoverable aliases:

- Repository: `automagik-dev/mikro`.
- Canonical repository URL: `https://github.com/automagik-dev/mikro` (accept the same URL with a terminal `.git` only after normalization for comparison).
- Prime source baseline `H0`: `61993273b1085ba155c05e84e537b3479a92df01`.
- Fresh integration baseline `B0`: `d8aea5ccfd91a9f09251e7eee8c09892197a03d7`, fetched from `refs/remotes/origin/main` and required to remain that value through bootstrap.
- Prime delta: binary `git diff H0 -- <the 14 paths below>`, length `87575` bytes, SHA-256 `46f788caf54f292fdad47673bce7b48f4c00523e8a779e902f06c8628235128e`.
- Reviewed three-way replay tree `P0_TREE`: `035c52db30e0cfc89674ba700a93689f4d417e8c`.

`H0` is an ancestor of `B0`. `B0` independently changes `src/mcp/server.ts` and `dist/src/mcp/server.js`; therefore P0 is **not** a copy of the dirty files. P0 is the conflict-free three-way application of the frozen `H0 → dirty-source` Prime delta onto `B0`, preserving both B0-only server changes and the Prime delta.

### Frozen Prime replay manifest

Every entry is state `modified`, mode `100644`. Digests are SHA-256 of file bytes. The source digest identifies the dirty-review input; the P0 digest identifies the reviewed replay result.

| Path | H0 digest | B0 digest | Dirty source digest | P0 digest |
|---|---|---|---|---|
| `dist/src/mcp/backends/prime-sdk.d.ts` | `3635244f350b21409993421d2808da2d852df929e9147d99f209f3bb10715edc` | `3635244f350b21409993421d2808da2d852df929e9147d99f209f3bb10715edc` | `621a3e5f1e52f316b3805843cd6a79adc4b9ab2e401d41dfe9139ccb65bf3810` | `621a3e5f1e52f316b3805843cd6a79adc4b9ab2e401d41dfe9139ccb65bf3810` |
| `dist/src/mcp/backends/prime-sdk.js` | `e31f13c6a182a05ecc7dd38ba4857bb81e053fc7571d87f521eb38b1b356b7be` | `e31f13c6a182a05ecc7dd38ba4857bb81e053fc7571d87f521eb38b1b356b7be` | `330e44c7d159b7bc8042e6106be6e4665a4b462ab1d038128159b4481295f253` | `330e44c7d159b7bc8042e6106be6e4665a4b462ab1d038128159b4481295f253` |
| `dist/src/mcp/backends/prime.d.ts` | `6b0fd02b182c3a990d9366f4b595e5f4421e0ae13cb6a5066c72f74b6ce7bf19` | `6b0fd02b182c3a990d9366f4b595e5f4421e0ae13cb6a5066c72f74b6ce7bf19` | `91fdbe8463877df211b4372e51907453cde8dfcf57d2992881a97ecfbcd721fe` | `91fdbe8463877df211b4372e51907453cde8dfcf57d2992881a97ecfbcd721fe` |
| `dist/src/mcp/backends/prime.js` | `1fd77e722d29aba0624d14f89bdfa35d8bdb75afeac71311894aa1f6a0458367` | `1fd77e722d29aba0624d14f89bdfa35d8bdb75afeac71311894aa1f6a0458367` | `5eec2acd6a2d6a48a4cd5b55ffdf9a1c4c7b9f528d0624e11941c9d0070d4033` | `5eec2acd6a2d6a48a4cd5b55ffdf9a1c4c7b9f528d0624e11941c9d0070d4033` |
| `dist/src/mcp/server.js` | `083b3fdad60f21416eebed72d982b12ff37e09eaec30934b34e0d1c33c567827` | `bb0a9c94c9988ca94d80d73ca40b8014a4e90863e94c5126b64af5923c11a64e` | `1c61966b7df7310cded904799f299b0745e2740548b698321ba49b4046c6731b` | `2b5b4bcc6ee17b101c9b926c9bc40f20cc2a66380e43303a77764c19c1f4e2ec` |
| `dist/tests/backend-contract.test.js` | `6e3a9c41b9e3e9e3e1842f47f69247527bb88fb3b0736af8bb54867d89eb2c1e` | `6e3a9c41b9e3e9e3e1842f47f69247527bb88fb3b0736af8bb54867d89eb2c1e` | `76d5191e4405c3755c1f6735b76a392000ab6a6ea37f3f92dd1c113f882bd5e7` | `76d5191e4405c3755c1f6735b76a392000ab6a6ea37f3f92dd1c113f882bd5e7` |
| `dist/tests/prime-backend.test.js` | `c66d9e8014992acc5459dc566a484d6e279bf48db3d23ac517aa95c614b1a9dc` | `c66d9e8014992acc5459dc566a484d6e279bf48db3d23ac517aa95c614b1a9dc` | `259ce962c57787385889dfe553f46ce6791505a7f1e51132c75cd1a017bf63f8` | `259ce962c57787385889dfe553f46ce6791505a7f1e51132c75cd1a017bf63f8` |
| `dist/tests/prime-sdk-backend.test.js` | `59784033a55cc6853b7cafb742a7329979b48b982fc14e7f5f4119da05eeab18` | `59784033a55cc6853b7cafb742a7329979b48b982fc14e7f5f4119da05eeab18` | `689953fb64cc77329f0e60437c4ee1f230b0d430ed21bf23175aa216351ce669` | `689953fb64cc77329f0e60437c4ee1f230b0d430ed21bf23175aa216351ce669` |
| `src/mcp/backends/prime-sdk.ts` | `918e603cd6ff4edaa81e1e04f6e51c5a461342303f246175e5bc7bf2ef37f87f` | `918e603cd6ff4edaa81e1e04f6e51c5a461342303f246175e5bc7bf2ef37f87f` | `baafeabd6686a9d473f5f0e9a0300f8d79b718137d8299f7e882f2cc16f6b571` | `baafeabd6686a9d473f5f0e9a0300f8d79b718137d8299f7e882f2cc16f6b571` |
| `src/mcp/backends/prime.ts` | `be54b3ef75a5a1d28d479835c3dd83b6521c7a8bf706c61bd07f13c06be23a1f` | `be54b3ef75a5a1d28d479835c3dd83b6521c7a8bf706c61bd07f13c06be23a1f` | `ebe4870ca01fb3669e5a0128b9c7eff31d274009baea092bb6f564426bc52b97` | `ebe4870ca01fb3669e5a0128b9c7eff31d274009baea092bb6f564426bc52b97` |
| `src/mcp/server.ts` | `8af73c302f796ae5a384c10d5b5edf3dfc27e35505a24cc7521bc957a64b90ec` | `33076c44150742a93a75c1e3e28e49d6c9e7f8b6da149dbe81004053f1e0396b` | `8f7dbd4a54ba208bdad897f2f9db0d56731914506a6d2c600a19c1da45184bd9` | `67ecc2b02a1097b0a8e8737f8bd4f724d7dd1507f658e0554dd7b8e1bfb54fa1` |
| `tests/backend-contract.test.ts` | `12bca82920dbcbf1539ccf5cdb1927ef450028828bd5f9a190da09b7e3a8ca40` | `12bca82920dbcbf1539ccf5cdb1927ef450028828bd5f9a190da09b7e3a8ca40` | `0056a7e2a10b1ce9075403a63f6ed10d8d94f76d8a558c2b8c3cca0dd65635b1` | `0056a7e2a10b1ce9075403a63f6ed10d8d94f76d8a558c2b8c3cca0dd65635b1` |
| `tests/prime-backend.test.ts` | `ae5e3ef715cfd9ebd08501951dc525b672eeaf9b52e5dc3a79bf0e7d1aae26f0` | `ae5e3ef715cfd9ebd08501951dc525b672eeaf9b52e5dc3a79bf0e7d1aae26f0` | `1e996a787d9cf9cb0d5eba81e1f4fdda4f447d7bbb4dd7c2472aea4a2cd3bc78` | `1e996a787d9cf9cb0d5eba81e1f4fdda4f447d7bbb4dd7c2472aea4a2cd3bc78` |
| `tests/prime-sdk-backend.test.ts` | `85746c789d64d3a7b3f86550ece894cec1f90c52532f928da1f19f94c7ba71e1` | `85746c789d64d3a7b3f86550ece894cec1f90c52532f928da1f19f94c7ba71e1` | `e64e85f2e60d79c0175d5aae5172b2ee46e628a3fd3ab1a2a41a013b9c48b7dd` | `e64e85f2e60d79c0175d5aae5172b2ee46e628a3fd3ab1a2a41a013b9c48b7dd` |

Replay is executable only in a clean detached B0 worktree/index: verify the patch digest, run `git apply --3way --index`, and fail on any nonzero exit, conflict stage (`git ls-files -u` non-empty), `.rej`, conflict marker, path/mode outside the table, digest mismatch, or tree other than `P0_TREE`. Commit that index once as `P0_SHA`, then require `P0_SHA^{tree}=P0_TREE`, one parent exactly `[B0]`, and changed paths exactly the 14-row manifest. Dirty-source digest equality is intentionally **not** required for the two server files; their frozen P0 digests above are the preservation oracle.

### Complete Prime-source disposition

The 14 rows above are the complete **retained Prime v2 product replay**. The following dirty-source artifacts are deliberately **rejected as superseded Prime v1 benchmark machinery**, are not retained, and must be absent from both P0 and A0. They are not deferred work and cannot support a no-loss claim:

| Path | Disposition | Replacement evidence contract |
|---|---|---|
| `scripts/benchmark-prime-runtimes.mjs` | rejected / superseded v1 | frozen Prime v2 backend contract and child evidence |
| `tests/prime-runtime-benchmark.test.ts` | rejected / superseded v1 | frozen Prime v2 backend contract and child evidence |
| `dist/tests/prime-runtime-benchmark.test.js` | rejected / superseded v1 | generated Prime v2 backend contract and child evidence |
| `dist/tests/prime-runtime-benchmark.test.d.ts` | rejected / superseded v1 | generated Prime v2 backend contract and child evidence |

The source-disposition oracle is therefore exactly 18 paths: 14 retained rows plus these four rejected rows. A candidate containing any rejected path fails admission.

## Scope

### IN
- Use only fresh B0 and the frozen H0-based Prime delta to produce P0.
- Fence the scheduled rolling workflow before creating `dev`; create/adopt exactly one draft `dev → main` PR; restore automation only after fail-closed read-back. Separately fence the release workflow before merge, run the post-merge oracle while it remains disabled, then re-enable/read back and explicitly dispatch the bound release.
- Integrate named child wishes through one CAS-only, fast-forward `dev` owner with exact manifests and wave gates.
- Bind dev CI, final merge, release run, release child, installer bytes, installed repository, versions, and executable journey to exact identities.
- Revert or forward-fix through new commits/releases only.

### OUT
- Product implementation from other children, dirty-checkout integration, feature PRs, an extra PR against `main`, force-push/history rewrite, tag movement/deletion, npm publishing, remote-ref cleanup, or legacy Prime deletion.

## Executable bootstrap fence and CAS protocol

The delivery integrator is the sole writer. Before remote `dev` exists or any P0 push:

1. Resolve `.github/workflows/rolling-pr.yml` in `automagik-dev/mikro`, freeze its workflow ID/path, call `gh workflow disable rolling-pr.yml --repo automagik-dev/mikro`, and read the Actions workflow API until `state == disabled_manually`. Any other state blocks bootstrap.
2. Query **all open PRs**, filter exact base repository `automagik-dev/mikro`, base ref `main`, head repository `automagik-dev/mikro`, head ref `dev`, and reject more than one match. Reject any open PR from `dev` to a different base and any same-title substitute; aliases are not adopted.
3. Immediately pre-read `refs/heads/dev` with `git ls-remote --heads origin refs/heads/dev` and require zero rows. Create it with `git push --porcelain --force-with-lease=refs/heads/dev: origin B0:refs/heads/dev`. Parse the porcelain ref-status record and require exactly one destination `refs/heads/dev` record with status `*` and summary `[new branch]`; reject `=` / `[up to date]`, any missing/extra ref record, or any other status even when the command exits zero. Re-read and require exactly B0.
4. Build and commit P0 locally from only the frozen patch. Require `P0_SHA^{tree}=P0_TREE`, sole parent `[B0]`, and exactly the 14 product paths. Advance `dev` B0 → P0 through the normal CAS protocol below.
5. Materialize the already frozen external admission bundle byte-for-byte and commit it once as `A0_SHA`, with sole parent `[P0_SHA]` and only the four planning paths specified below. Require P0 remains A0's first-parent product ancestor, P0 itself is unchanged, and `A0_SHA^{tree}` equals the tree independently reconstructed from P0 plus the four digest-checked files. Advance `dev` P0 → A0 through the same CAS protocol.
6. Re-query exact PRs. If zero, create one with `gh pr create --repo automagik-dev/mikro --base main --head dev --draft ...`. If one exists, adopt it only if its repository/base/head tuple is exact and convert it to draft if needed. If more than one exists, stop; never select the first.
7. Read back exactly one PR number and require `isDraft=true`, no auto-merge request, base=`main`, head=`dev`, head SHA=`A0_SHA`, and GitHub's draft merge prohibition. No actor may mark ready, enqueue, or call merge before the final promotion gate. The draft state is the active unmergeable fence.
8. Only now restore scheduling with `gh workflow enable rolling-pr.yml --repo automagik-dev/mikro`; read back workflow `state == active`, then re-read the exact-one PR tuple and draft/no-auto-merge state. Restoration changes repository workflow state only: it creates no commit and no extra PR against `main`. The existing workflow must observe the canonical open PR and exit; every later gate repeats duplicate rejection.

For every subsequent `expected_old → new` dev transition:

1. Reject unless `git merge-base --is-ancestor expected_old new` succeeds. A non-fast-forward candidate is rejected even when the lease would match.
2. Fetch/read `refs/heads/dev` and require it equals `expected_old` exactly.
3. Push `git push --porcelain --force-with-lease=refs/heads/dev:<expected_old> origin <new>:refs/heads/dev`. Parse exactly one ref-status record for destination `refs/heads/dev`; require the porcelain fast-forward update status (leading status byte is a literal space) and a non-empty `<old>..<new>` summary. Status `=`, `[up to date]`, `*`, `+`, `!`, or any absent/extra record is failure even when Git exits zero. Because ancestry is already required, a forced-update `+` is never acceptable.
4. Re-read the remote and require exactly `new`; a failed push, no-op porcelain result, absent/multiple result, or different SHA blocks integration. This post-read proves the accepted update remained visible; it does not turn a rejected no-op into success.

No revision-range refspec such as `expected_old..new` is used. The empty lease is permitted only for initial absent-ref creation; every later lease carries the full 40-character expected SHA. Every transition therefore has all five gates: ancestry, exact pre-read, exact lease, an actual created/updated porcelain status, and exact post-read. If another writer reaches `new` first, the resulting up-to-date/no-op record is rejected rather than misreported as this integrator's CAS success.

### External admission bundle and A0

P0 consumes no in-repository planning path. Before P0 is built, the completed wish/admission process must already have emitted an immutable canonical-JSON admission record outside the candidate Git tree. That record is content-addressed by SHA-256, records the DESIGN digest and SHIP review identity, and records the relative path, byte length, mode `100644`, and SHA-256 for each of these exact files:

1. `.genie/wishes/mikro-dev-release-promotion/WISH.md`
2. `.genie/wishes/mikro-dev-release-promotion/manifests/p0-paths.txt`
3. `.genie/wishes/mikro-dev-release-promotion/manifests/delivery-paths.txt`
4. `.genie/wishes/mikro-dev-release-promotion/reviews/design-review.json`

The external record and four blobs must pre-exist P0, be independently retrievable by their frozen digests, and remain read-only throughout replay. The external `p0-paths.txt` is the authority used to check P0's exact 14 paths; it is not part of P0. After P0 passes its parent/tree/path oracle, copy those same four reviewed blobs without regeneration or timestamp rewriting into a clean P0 index and commit only them as planning/admission commit A0. Reject any byte/digest/mode change, any fifth path, an A0 parent other than P0, a P0 tree/path change, or an A0 tree unequal to the independently built expected tree. Product execution begins only at A0; A0 changes planning evidence only.

## Children, waves, manifests, and overlap ownership

Except for P0's externally frozen manifest and A0's admission bundle, each named artifact is a newline-sorted exact path manifest committed by that child wish before its first implementation commit. P0 is the first product implementation commit and is authorized by the pre-existing external record; A0 then commits that reviewed record unchanged before any later product child begins. Directories/globs/category prose are invalid. A candidate is rejected for an absent authority, a path not in it, a predecessor mismatch, or an overlap whose named owner has not handed off through the predecessor SHA.

| Wave | Child / unit | Required predecessor | Exact manifest artifact | Overlap owner and rejection rule |
|---|---|---|---|---|
| 0P | `mikro-dev-release-promotion` product replay P0 | `B0` | pre-existing external, content-addressed `p0-paths.txt` | Delivery integrator owns exactly the frozen 14-path replay during P0; P0 has sole parent B0 and tree `P0_TREE`; reject every other path, including all planning and four rejected benchmark paths. |
| 0A | `mikro-dev-release-promotion` planning/admission A0 | `P0_SHA` | pre-existing external admission record for the exact four planning blobs | A0 commits the unchanged WISH, two manifests, and review JSON only; reject product changes, regenerated metadata, wrong parent, digest/mode drift, or a fifth path. |
| 1 | `mikro-npm-only-toolchain` | `A0_SHA` | `.genie/wishes/mikro-npm-only-toolchain/manifests/paths.txt` | npm child owns lock/install-entry paths for this wave. Any delivery overlap listed below transfers back only after this child’s accepted SHA; undeclared overlap rejects. |
| 1/4 | `mikro-prime-081-reconciliation` evidence; optional default mutation | Evidence candidate is `A0_SHA`; mutation predecessor is the accepted context-root SHA | `.genie/wishes/mikro-prime-081-reconciliation/manifests/paths.txt` | Prime owns its frozen backend/tests/evidence paths. Evidence may be read-only in waves 1–4. Any mutation before context handoff or any package/CLI/delivery overlap not named in both manifests rejects. |
| 2a | `mikro-cache-contract-truth` | accepted npm SHA | `.genie/wishes/mikro-cache-contract-truth/manifests/paths.txt` | Cache owns its CLI/config/schema/docs/tests/dist overlap until accepted. Orchestration cannot start from an earlier SHA or touch a cache-owned path concurrently. |
| 2b | `mikro-orchestration-cli-truth` | accepted cache SHA | `.genie/wishes/mikro-orchestration-cli-truth/manifests/paths.txt` | Orchestration receives the shared CLI/schema/docs/tests/dist seam after cache. Any diff that reverts cache or is absent from its own manifest rejects. |
| 3a | ACP `root-result` unit | accepted orchestration SHA | `.genie/wishes/mikro-acp-correctness-direct-mode/manifests/01-root-result.txt` | ACP child owns its declared root-result seam; later ACP units and context work wait. |
| 3b | ACP `direct-error` unit | accepted ACP root-result SHA | `.genie/wishes/mikro-acp-correctness-direct-mode/manifests/02-direct-error.txt` | Same ACP owner; reject squashing/reordering or paths absent from this unit manifest. |
| 3c | ACP `transactional-store` unit | accepted ACP direct-error SHA | `.genie/wishes/mikro-acp-correctness-direct-mode/manifests/03-transactional-store.txt` | Same ACP owner; reject prior-stage rollback or context-root changes. |
| 3d | ACP `protocol-gate` unit | accepted ACP transactional-store SHA | `.genie/wishes/mikro-acp-correctness-direct-mode/manifests/04-protocol-gate.txt` | Same ACP owner; this handoff closes ACP ownership before context starts. |
| 4 | `mikro-repeated-cli-context-roots` | accepted ACP protocol-gate SHA | `.genie/wishes/mikro-repeated-cli-context-roots/manifests/paths.txt` | Context child owns shared CLI/context/cache/batch/docs/tests/dist seam. Any ACP semantic drift or pre-handoff work rejects. |
| 5 | `mikro-dev-release-promotion` final delivery | accepted context SHA, or accepted post-context Prime default-mutation SHA when explicitly approved; all six product children complete | `.genie/wishes/mikro-dev-release-promotion/manifests/delivery-paths.txt` | Delivery owns only the exact paths below. Product-path edits, unresolved overlap, or a predecessor other than the last accepted child rejects. |

One path may appear in consecutive manifests only as an explicit serialized handoff; the later child must preserve all predecessor oracles. A path may never be owned by two in-flight children. Generated source/dist pairs move together under the current owner. Manifest expansion invalidates the child’s review and requires a new review before acceptance.

### Frozen delivery-owned paths

The delivery manifest may contain only these known paths. The four A0 planning paths are admitted only by A0 and are not mutable final-delivery paths:

- `.github/workflows/ci.yml`
- `.github/workflows/rolling-pr.yml`
- `.github/workflows/release.yml`
- `scripts/install.sh`
- `scripts/smoke-install-update.sh`
- `docs/release-contract.md`
- `README.md`
- `.genie/wishes/mikro-dev-release-promotion/evidence/dev-ci.json`
- `.genie/wishes/mikro-dev-release-promotion/evidence/promotion.json`
- `.genie/wishes/mikro-dev-release-promotion/evidence/release.json`
- `.genie/wishes/mikro-dev-release-promotion/evidence/install-journey.json`

The npm child owns any permitted changes to the five shared install/workflow/doc paths first; final delivery receives them only through its accepted predecessor. Any newly discovered delivery path requires renewed scouting, manifest amendment, and design review.

After every accepted unit/wave: clean `npm ci`, production audit, typecheck, clean build, full tests, generated source/dist plus mode equality, focused child tests, all cumulative journeys, exact-one draft PR read-back, and the CI identity gate below.

## Remote, CI, and installed-dev identity

For each accepted `expected_sha`, freeze one evidence tuple and reject partial or cross-repository matches:

- repository full name `automagik-dev/mikro` and canonical URL `https://github.com/automagik-dev/mikro`;
- workflow path `.github/workflows/ci.yml`, workflow ID, and workflow-file blob digest at `expected_sha`;
- Actions run database ID and run attempt;
- event exactly `push`, head branch exactly `dev`, head repository exactly `automagik-dev/mikro`, and head SHA exactly `expected_sha`;
- status exactly `completed` and conclusion exactly `success` for that same run attempt.

A rerun is a new attempt and must replace the entire bound run tuple; success from another attempt/head/event/workflow/repository is irrelevant. Before and after each child-specific journey, re-read remote `refs/heads/dev == expected_sha` and the same selected run tuple.

Dev install/read-back uses installer bytes fetched from the exact dev SHA, records installer source SHA and SHA-256, and sets both `MIKRO_REPO_URL=https://github.com/automagik-dev/mikro` **and** `MIKRO_FALLBACK_REPO_URL=https://github.com/automagik-dev/mikro`, plus `MIKRO_BRANCH=dev` and isolated install/bin/home paths explicitly. Because both probes are mechanically bound to the same canonical URL, the installer cannot contact the legacy repository even if the primary probe fails. Evidence records both environment values, normalized equality, installed `remote.origin.url`, branch `dev`, `HEAD=expected_sha`, all committed version surfaces, `mikro --version`, and the named child journey inputs/outputs. Any observed URL outside the canonical normalized value fails. Generic health is not a substitute for the child journey.

## Pre-merge and post-merge identity

The oracle is split because merge identity does not exist before GitHub creates it.

### Pre-merge freeze

After all child gates and the final independent review, freeze only:

- canonical rolling `pr_number`;
- `base_main_sha` from fresh remote `main`;
- `reviewed_dev_sha` from the PR head and remote `dev`;
- `reviewed_tree = reviewed_dev_sha^{tree}`.

Re-read repository/base/head/draft tuple, reject duplicate PRs, and require remote main/dev still equal the frozen values. In a clean object database run `git merge-tree --write-tree base_main_sha reviewed_dev_sha`; require a conflict-free result exactly equal to `reviewed_tree`.

Before the PR may be marked ready, resolve `.github/workflows/release.yml` in `automagik-dev/mikro` and freeze its workflow ID/path plus the workflow-file blob digest at `reviewed_dev_sha`. The live workflow currently supports both `push: main` and `workflow_dispatch`; the accepted blob must still expose an active `workflow_dispatch` capability or promotion stops for renewed design. Query release runs and require no queued/in-progress run that can mutate `main`, call `gh workflow disable release.yml --repo automagik-dev/mikro`, and read the Actions workflow API until the frozen workflow ID reports `state == disabled_manually`. Re-read remote main=`base_main_sha` and the unchanged PR tuple. Any disable failure, mismatched ID/path/blob, active state, or mutation blocks merge.

Only behind that disabled release fence may the canonical PR be marked ready. Re-read required checks, approval, no auto-merge request unless explicitly authorized by the gate, unchanged tuple, release workflow still `disabled_manually`, and remote main still `base_main_sha` immediately before invoking merge-commit mode. No parent order or `merge_sha` claim is made pre-merge.

### Post-merge freeze

Keep the release workflow disabled. Read the merged PR and fresh remote main, then freeze `merge_sha`. Before any release mutation require:

- PR merge commit OID and remote `refs/heads/main` both equal `merge_sha`;
- `git rev-list --parents -n 1 merge_sha` has exactly two ordered parents `[base_main_sha, reviewed_dev_sha]`;
- `merge_sha^{tree} == reviewed_tree`;
- the merged PR number/base/head/repository equals the pre-merge tuple;
- the frozen release workflow ID/path is still `disabled_manually`, its blob at `merge_sha` equals the reviewed release-workflow blob, no release run exists for `merge_sha`, and remote main remains `merge_sha` after all checks.

Any squash/rebase merge, octopus/one-parent commit, parent reversal, tree drift, main drift, or unbound PR blocks release.

Only after the full post-merge oracle passes, call `gh workflow enable release.yml --repo automagik-dev/mikro`, read back the same workflow ID/path with `state == active`, and re-read remote main=`merge_sha`. Then explicitly dispatch exactly once with `gh workflow run release.yml --repo automagik-dev/mikro --ref main`. Capture the dispatch boundary time and select exactly one new run for the frozen workflow ID with event `workflow_dispatch`, branch `main`, and head SHA `merge_sha`; zero or multiple candidates fail closed. Do not synthesize a second push, empty commit, or tag to wake the push trigger. If the accepted workflow ever lacks `workflow_dispatch`, stop before merge and redesign the activation mechanism rather than merging into an untriggerable fence.

## Release child and exact metadata whitelist

`released_sha` is either `merge_sha` or exactly one direct child whose sole parent is `merge_sha`. If it is a child, its changed-path set must be a **non-empty subset** of exactly these five paths, with no mode changes:

1. `package.json`
2. `package-lock.json`
3. `src/version.ts`
4. `dist/src/version.js`
5. `dist/src/version.d.ts`

No second child is allowed. Any release-workflow change invalidates this whitelist and requires renewed scouting and design review.

Bind the release Actions evidence as one tuple: repository name/URL; workflow path `.github/workflows/release.yml`, frozen workflow ID, and blob digest at `merge_sha`; disable-state read-back before merge; active-state read-back after the oracle; explicit dispatch boundary; run database ID and attempt; event exactly `workflow_dispatch`; branch `main`; head SHA exactly `merge_sha`; status `completed`; conclusion `success`; and the workflow-resolved source and release target SHAs. The resolved source must equal `merge_sha`; the target is either `merge_sha` or its one permitted metadata child. A resumed/rerun attempt must be rebound in full and still resolve the same source. Push-event runs, pre-enable runs, runs with another head, or a merely successful enable are irrelevant. Require remote main=`released_sha`, tag commit=`released_sha`, GitHub Release target=`released_sha`, and GitHub Release repository=`automagik-dev/mikro`.

## Canonical public installer and journey

Freeze all of the following in `evidence/install-journey.json`:

- installer source SHA=`released_sha`;
- canonical installer URL=`https://raw.githubusercontent.com/automagik-dev/mikro/<released_sha>/scripts/install.sh` with `<released_sha>` replaced by the full frozen SHA;
- SHA-256 of the downloaded bytes, equal to `scripts/install.sh` from `released_sha`;
- explicit `MIKRO_REPO_URL=https://github.com/automagik-dev/mikro`, `MIKRO_FALLBACK_REPO_URL=https://github.com/automagik-dev/mikro`, and `MIKRO_BRANCH=main` plus isolated home/install/bin paths; normalize both repository variables and require equality before execution;
- no URL outside the canonical repository in installer inputs/output or installed remotes; because primary and fallback are identical, even the fallback probe is mechanically confined to the canonical repository;
- installed `remote.origin.url` normalized exactly to the canonical URL, installed branch=`main`, and installed `HEAD=released_sha`;
- one version value equal across `package.json`, `package-lock.json`, `src/version.ts`, `dist/src/version.js`, `dist/src/version.d.ts`, tag `v<version>`, GitHub Release name/target, and `mikro --version`;
- journey ID `public-install-update`: fresh install from the verified pinned installer, `mikro --version`, `mikro --schema`, `scripts/smoke-install-update.sh`, then `mikro update`, followed by the same origin/branch/HEAD/version checks.

Read remote main and release/tag identities immediately before and after the journey. Any URL redirect to another owner/repository, noncanonical fallback value/access, digest drift, origin mismatch, head drift, version disagreement, journey failure, or release-run mismatch fails promotion.

## Rollback

A bad dev integration is reverted by a new revert commit on dev, pushed through the same ancestry-plus-exact-lease CAS protocol, followed by the full cumulative gate and identity read-back. Dev is never rewritten. A production defect uses a revert or forward-fix PR into main and a new release/tag with all pre/post merge, release-run, and public-installer gates; an existing tag or release is never deleted or moved.

## Simplicity Case

- **Simplest complete design:** one clean B0, one reviewed P0 tree, one dev owner, one draft rolling PR, one immutable reviewed merge tree.
- **Added machinery:** exact leases, identity tuples, wave manifests, and release/install read-back pay for concurrent remote writers and an automated release child.
- **Deferred until measured:** branch-protection redesign and additional release channels.
- **Complexity removed:** dirty-base integration, feature PR fan-out, a bootstrap PR against main, force-push recovery, and tag deletion.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | H0 and B0 are distinct frozen baselines; P0 is a three-way delta replay | Preserves B0 temperature changes without losing the 14 retained reviewed Prime v2 paths; four superseded v1 benchmark paths are explicitly rejected. |
| 2 | Disable/read-back rolling automation before dev; restore after exact-one draft PR read-back | Removes the scheduled non-draft creation race without an extra main PR. |
| 3 | `--force-with-lease` is CAS only when porcelain proves an actual update | Ancestry, pre-read, lease, created/updated status, and post-read reject both non-FF and successful no-op ambiguity. |
| 4 | P0 stays the exact B0-parent product replay; A0 separately admits immutable planning evidence | External content addressing authorizes P0 without contaminating its 14-path tree, while WISH/manifests/review evidence become durable before child execution. |
| 5 | Every child/unit has a named predecessor, exact manifest artifact, and serialized overlap owner | Stale or broad integration cannot hide in category prose. |
| 6 | Merge identity is split pre/post creation and release is disabled across that boundary | Parent order and merge SHA are verified only after they exist and before release can mutate main. |
| 7 | Release child has exactly five possible metadata paths and is started by bound explicit dispatch | Current live `workflow_dispatch` capability makes post-oracle activation executable without a synthetic push. |
| 8 | CI, release, installer, repository, version, and journey identities are one bound chain | Matching a SHA alone cannot select the wrong workflow, repository, attempt, or installer source. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Prime replay erases B0 server changes | High | Frozen H0/B0/source/P0 digests, three-way application, conflict rejection, exact P0 tree. |
| 2 | Rolling workflow creates a non-draft or duplicate PR | High | Disable/read-back before dev, exact duplicate query, draft proof, gated restore, repeated exact-one checks. |
| 3 | Lease permits a non-FF candidate or reports success for a no-op | High | Independent ancestry and exact pre-read precede every lease; porcelain must report an actual creation/update; exact post-read follows it. |
| 4 | Main or PR changes around merge | High | Separate pre/post identity freezes and immediate remote/PR read-backs. |
| 5 | Release mutates main before merge identity is proven | High | Disable/read back the exact release workflow before ready/merge; run post-merge oracle while disabled; enable/read back and explicitly dispatch afterward. |
| 6 | Release or installer evidence comes from the wrong source | High | Full repo/workflow/run/attempt/dispatch-event/branch/head/conclusion and source/digest/origin binding; set both installer repository variables to canonical. |
| 7 | Shared paths silently overwrite prior child behavior | High | Named manifests, single overlap owner, exact predecessor, cumulative gates. |

## Success Criteria

- [ ] H0, B0, 14-path source manifest, Prime delta digest, P0 manifest, and `P0_TREE` match the frozen values; replay is conflict-free and preserves B0 server changes.
- [ ] Rolling workflow is disabled and read back before dev creation; exactly one canonical draft/unmergeable `dev → main` PR is created/adopted; workflow restoration is read back; delivery creates no additional PR against main.
- [ ] Initial creation and every later dev push pass ancestry, exact pre-read, exact lease, actual `git push --porcelain` created/updated status, and exact post-read; all non-FF and up-to-date/no-op results are rejected.
- [ ] P0 has sole parent B0, exact `P0_TREE`, and exactly 14 retained paths; the four v1 benchmark artifacts are rejected/superseded; A0 has sole parent P0 and commits only the four unchanged digest-bound WISH/manifest/review blobs; every later child starts from the updated predecessor chain.
- [ ] Every named child/unit uses its named predecessor and exact manifest artifact; overlap ownership is serialized and delivery touches only its frozen paths.
- [ ] Each dev gate binds canonical repository plus exact CI workflow/run/attempt/push/dev/head/completed/success identity and exact installed dev source/origin/head/version/journey evidence.
- [ ] Release workflow is disabled/read back before ready/merge; pre-merge base/head/tree and conflict-free merge-tree equality pass; post-merge SHA, exactly two ordered parents, tree, PR, remote main, and still-disabled workflow equality pass before release mutation; workflow is then enabled/read back and explicitly dispatched.
- [ ] `released_sha` is merge SHA or one direct child with a non-empty diff subset of the exact five metadata paths; the bound `workflow_dispatch` run has head/source `merge_sha`, succeeds, and tag/release/main agree.
- [ ] Pinned installer URL/source/digest, explicit canonical primary and fallback repository/main, installed origin/head, all version surfaces, and `public-install-update` journey agree before and after update; no legacy URL can be probed.
- [ ] Rollback uses new revert/forward-fix commits and full re-gates; no branch rewrite or tag/release movement occurs.

## Next Step

Run independent design review on this corrected DESIGN. Only after SHIP evidence is recorded and verified, run `wish` for `mikro-dev-release-promotion` only.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `7ea5b075b97eac066225da32a041fe93fb9484e3351d46c8a551fe74a1d61a78`
- **Reviewer:** `openai-codex:gpt-5.6-sol-900k`
- **Reviewed at:** `2026-08-31T22:00:14Z`
<!-- genie-design-review:end -->
