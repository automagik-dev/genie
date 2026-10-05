# Design: Repeated CLI context roots

| Field | Value |
|---|---|
| **Slug** | `mikro-repeated-cli-context-roots` |
| **Date** | 2026-08-31 |
| **WRS** | 100/100 |

## Problem

Repeated CLI `--context` currently collapses to one value, preventing query, cache, and batch from combining disjoint roots and leaving automation unable to discover repeatability. Multi-root behavior must be deterministic, globally collision-safe, and cache-correct without changing singleton bytes.

## Scope

### IN
- Accept repeated `--context <path>` occurrences for query, cache, and batch. Each occurrence is one path; commas are literal path characters and are never separators.
- Publish the exact repeatability contract in `mikro --schema`, distinct from comma-list flags such as `--ext`, and prove schema/parser parity.
- Preserve declaration order; canonicalize each root with realpath, deduplicate by canonical realpath keeping the first occurrence, and hard-fail any missing/unreadable root before provider or cache work.
- Reuse existing global extension/exclude filters for every root and perform one aggregate size/budget validation.
- Keep the zero-root and one-unique-root paths on their existing branches. A singleton retains its existing `LoadedContext` type and exact parsing, content, metadata, hash, prompt/output/citation, cache, and persisted-session representation.
- For multiple unique roots, normalize every existing `LoadedContext` shape into one ordered item union, apply stable collision prefixes, and deterministically reject any collision that remains after prefix closure.
- Define order-sensitive multi-root hashing, cache session identity, and persisted root representation.
- Prove exact query, cache/estimate/warmup, batch, mixed-root, collision-closure, schema, and bounded singleton oracles.

### OUT
- YAML context arrays/schema, roles, priorities, per-root filters, ACP/MCP multi-root contracts, hardlink dedupe beyond canonical-root identity, escaping post-prefix collisions, or any new singleton framing.

## Approach

Parse occurrences into an ordered list, completely preflight and canonicalize all roots, discard later canonical duplicates, then load each first occurrence with the existing global filters. Zero or one unique root takes the exact old branch. Two or more unique roots use the normalization, naming, ordering, hashing, and persistence contracts below. No provider, cache warmup, batch question, or session write begins until all roots pass preflight and the final item identities are proven injective.

### CLI and machine-readable schema contract

`parseArgs` declares `context: { type: "string", multiple: true }`. The parsed application value is always `string[]`: `[]` for no occurrence, one element for one occurrence, and all values in argv occurrence order otherwise. `--context a,b` contributes the single literal value `a,b`; it is not split.

Add `repeatable?: boolean` to `CliFlagSchema`. The exact `MIKRO_CLI_SCHEMA.flags` entry is:

```json
{
  "name": "--context",
  "type": "string",
  "repeatable": true,
  "default": [],
  "description": "Repeatable path to a context directory or file loaded for a query, cache warmup, or batch run. Repeat the flag for multiple roots; commas are literal.",
  "appliesTo": ["query", "cache", "batch"]
}
```

This does not reuse `type: "list"`: in schema version 1, `type: "list"` continues to mean one comma-separated string value parsed into elements, as used by `--ext`, while `type: "string", repeatable: true` means repeated argv occurrences with no comma splitting. `--ext` remains unchanged. A schema-to-parser parity test must derive the `--context` schema entry and assert parser results for zero, one, repeated, and comma-containing occurrences, including declaration order; it must also assert that `--ext md,txt` retains comma-list behavior.

### Root records and declaration indexes

For each argv occurrence, resolve the spelling to an absolute `path`, compute `canonicalPath` with realpath, and retain its 1-based original `declarationIndex`. Canonical dedupe keeps the first record and does not renumber later records, so `--context A --context A-link --context B` produces retained indexes 1 and 3. Those exact indexes supply `root-1/` and `root-3/` if naming needs prefixes.

Preflight covers every declared occurrence before loading any content: resolution/realpath, existence, supported file-or-directory kind, and readability. The first error in declaration order is reported, but only after no external/provider/cache/session side effect has occurred.

### Multi-root `LoadedContext` normalization

Normalization runs only when at least two canonical roots remain. It emits `ContextItem` union entries with a root record, a root-local candidate path, and exact content:

| Loaded root | Emitted candidate item(s) |
|---|---|
| Directory (`type: "list"`) | Each existing directory item, in the loader's existing sorted order; candidate path and content are unchanged. |
| Ordinary/non-array file (`type: "string"`) | One item whose candidate path is `basename(canonicalPath)` and whose content is the exact loaded string. |
| JSON object/scalar file (`type: "dict"`) | One item whose candidate path is `basename(canonicalPath)` and whose content is the exact existing pretty-printed dict/scalar content. |
| JSON-array file (`type: "list"`, file root) | One item per existing `[n]` entry, in numeric loader order, with candidate path `basename(canonicalPath)/[n]` and unchanged entry content. Empty arrays emit no items. |

Whether a `type: "list"` came from a directory or a JSON-array file is taken from the preflighted root kind, not inferred from item names. Paths use the existing normalized `/` public separator at the union boundary; basenames are the canonical root basename. The union order is retained-root declaration order, then each root's row-defined item order. Renaming never reorders items. Aggregate metadata is generated once from the final ordered union.

### Globally injective naming and collision closure

1. Group normalized items by exact candidate path.
2. A candidate occurring once keeps that path.
3. Every item in a candidate group occurring more than once is renamed to `root-<declarationIndex>/<candidate>`. This applies to the entire duplicate group. Duplicate candidates from the same root are invalid loader output and enter the same closure/check rather than silently overwriting.
4. After all prefixes are assigned, group the complete item set by final path again. If any final path has more than one item, reject the entire invocation deterministically before aggregate validation or external work. There is no recursive prefixing or escaping.
5. The error sorts offending final paths by Unicode code-point order and, within each path, contributors by declaration index then root-local item order. It reports each final path and contributor's declaration index, canonical root, and candidate path.

The second pass is the collision-prefix closure. Therefore every accepted multi-root union has pairwise-distinct final paths; rejection, rather than best-effort naming, guarantees global injectivity.

**Adversarial oracle:** root 1 contains `same.md` and `root-1/same.md`; root 2 contains `same.md`. The duplicate candidate `same.md` becomes `root-1/same.md` and `root-2/same.md`, colliding with root 1's unchanged `root-1/same.md`. The command rejects with `root-1/same.md` and both ordered contributors, and query provider, cache estimate/warmup provider request, batch questions, and session persistence observe zero side effects.

### Order and hash framing

The final union's declaration-derived order is observable in REPL context, cached prompt bytes, verbose metadata/citations, and every batch question. Multi-root order is significant; roots with otherwise unique names do not become order-independent merely because final paths differ.

`computeContentHash` keeps its exact legacy implementation for a singleton. For two or more unique roots it hashes this unambiguous byte stream with SHA-256 and returns the existing first 12 lowercase hex characters:

```text
UTF8("mikro-context-union-v1\0")
U64BE(itemCount)
for each final union item in union order:
  U64BE(byteLength(UTF8(finalPath))) || UTF8(finalPath)
  U64BE(byteLength(UTF8(content)))   || UTF8(content)
```

`U64BE` is an unsigned 64-bit big-endian integer. No locale sort, canonical path, timestamp, run ID, or delimiter-based concatenation enters this framing. Lengths are UTF-8 byte lengths, not JavaScript character counts. Consequently root reordering changes the hash whenever it changes final ordered prompt items, while byte-identical ordered unions share a hash.

Cache `sessionId` remains exactly `buildSessionId(config.cache.sessionPrefix, contentHash)`. Thus multi-root cache identity is the configured prefix plus the new order-sensitive framed hash, and singleton cache identity is unchanged. Estimate and warmup use the same finalized union and content hash as query cache mode.

### Persisted multi-root representation

No context persists as the existing `contextPath: null`. One unique root persists through the legacy branch as the existing sole `contextPath` property and does not add a new key.

Only for two or more retained roots, `meta.json` contains `contextPath: null` plus this additional property in retained declaration order:

```json
"contextRoots": [
  {
    "declarationIndex": 1,
    "path": "/absolute/resolved/argv/path",
    "canonicalPath": "/absolute/realpath"
  }
]
```

`path` is the absolute resolved first-occurrence spelling before realpath; `canonicalPath` is the canonical absolute realpath. Duplicate occurrences are absent, declaration indexes are not renumbered, JSON key order inside each record is exactly `declarationIndex`, `path`, `canonicalPath`, and array order is retained declaration order. In multi-root `meta.json`, `contextRoots` is inserted immediately after `contextPath` and before `timestamp`; all other top-level key order and formatting stay unchanged. Session APIs may add the optional records needed to write this shape, but must preserve the zero/singleton serialized shape exactly.

### Exact observable oracles

- **Query directory collision:** two roots containing distinct files plus the same relative filename expose unique files unchanged and both collisions as their declaration-indexed `root-N/<path>` identities in context, citations, and verbose metadata. A canonical duplicate adds nothing. No provider call occurs for a missing/unreadable root or failed collision closure.
- **Mixed ordinary-file + directory:** an ordinary file root named `notes.md` plus a directory root containing `notes.md` normalize to duplicate `notes.md` candidates and expose `root-<file-index>/notes.md` and `root-<dir-index>/notes.md`, with exact original contents and declaration order.
- **Mixed dict + JSON array:** `config.json` object emits `config.json`; `data.json` array emits `data.json/[0]`, `data.json/[1]`. Two array-file roots with the same basename collide entry-by-entry and receive root prefixes. Reversing roots reverses union order and changes the framed hash/cache session ID.
- **File + file unique:** two ordinary/dict files with distinct basenames each emit one unprefixed item in root order; identical basenames are both prefixed. Their persisted `contextRoots` records preserve first-occurrence path, realpath, and original declaration index.
- **Collision-prefix closure:** the adversarial `same.md`/`root-1/same.md` fixture above is rejected with stable diagnostics and zero external side effects.
- **Cache:** estimate and warmup consume the same finalized ordered union, identities, aggregate token count, framing, and one aggregate validation. The provider cache request observes all contents in union order. Reordered roots cannot reuse a cache session ID unless the final ordered union bytes are identical.
- **Batch:** every question receives the same finalized ordered union and names; question order and sequential execution remain unchanged.
- **Schema/parser:** emitted JSON exactly matches the repeatable-string entry above; parser results are `[]`, `["a"]`, `["a","b"]`, and `["a,b"]` for the corresponding invocations, while `--ext md,txt` remains a comma-list.

### Bounded singleton golden bytes

The singleton regression fixture invokes the pre-change and changed builds with the same one-root fixture, fake deterministic provider response, fixed run ID, fixed clock, fixed package version, fixed config/usage/log inputs, isolated HOME, and no ANSI/TTY variability. It compares only these byte subjects:

1. serialized `LoadedContext` content and metadata returned by the legacy branch;
2. normal and cached system-prompt strings, content hash, and cache session ID;
3. captured stdout/stderr for one text query and one JSON query, including deterministic citations/verbose output;
4. the named session files `meta.json`, `usage.json`, `answer.txt`, `config.yaml`, and `trajectory.jsonl`.

The session directory pathname, filesystem metadata/order, wall-clock duration, real provider output, random IDs, ambient package version, and unstubbed timestamps are explicitly outside the golden. Any value from those categories that appears inside a compared named file or stream must be injected/fixed as listed before comparison. The fixture first captures the baseline bytes from the parent commit, then runs the changed build against that immutable fixture; it does not regenerate expected bytes from the changed implementation.

## Path ownership boundary

The child wish freezes exact CLI parser/schema, context loader/union, query/cache/batch call sites, focused context/CLI/cache/batch/session tests, help/README/changelog, and generated paths. It starts only after ACP and exclusively owns shared CLI/context paths in this wave.

## Simplicity Case

- **Simplest complete design:** an ordered list around the existing loader, deterministic post-prefix rejection, and one domain-separated multi-root hash.
- **Added machinery:** canonical-root dedupe, shape normalization, collision closure, and order-sensitive identity are required for correctness.
- **Deferred until measured:** escaping, roles, priorities, per-root filters, and non-CLI transports.
- **Complexity removed:** no recursive collision naming, new config language, or singleton framing.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Schema is `type: "string", repeatable: true, default: []` | Repeated argv occurrences must be machine-distinct from comma-list semantics. |
| 2 | First canonical realpath wins without renumbering | Deterministic dedupe preserves declaration intent and stable root labels. |
| 3 | Missing/unreadable root hard-fails before external work | Partial context is unsafe and spendful. |
| 4 | Normalize every multi-root loader shape explicitly | File+file and file+directory unions need stable identities. |
| 5 | Prefix candidate collisions, then reject closure collisions | A finite deterministic check guarantees injective accepted identities. |
| 6 | Multi-root hash is framed and order-sensitive; singleton hash is legacy | Cache identity must follow prompt bytes without singleton drift. |
| 7 | Persist explicit root records only for multi-root sessions | Multi-root provenance is recoverable while zero/singleton bytes remain exact. |
| 8 | One aggregate validation | Per-root acceptance could exceed the actual run budget. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Singleton bytes drift through the new collection path | High | Dedicated legacy branch plus bounded, nondeterminism-fixed byte goldens. |
| 2 | Prefixing creates a second collision | High | Mandatory closure pass and deterministic whole-invocation rejection. |
| 3 | Query/cache/batch normalize or order differently | High | One union helper and cross-command mixed-root golden fixture. |
| 4 | Reordered roots share cache identity despite different prompt bytes | High | Domain-separated, length-framed, order-sensitive multi-root hash. |
| 5 | Symlink duplicates reorder roots | Medium | Complete realpath preflight, first-occurrence records, and explicit symlink test. |
| 6 | Missing later root causes partial provider work | High | Complete preflight and closure before loading/execution side effects. |
| 7 | Session provenance cannot reconstruct labels | Medium | Persist original declaration index plus resolved and canonical paths. |

## Success Criteria

- [ ] `mikro --schema` emits the exact repeatable-string JSON entry; schema/parser parity proves zero/one/many/comma cases and unchanged `--ext` comma-list semantics.
- [ ] Canonical-realpath duplicates retain only the first occurrence and original declaration index; missing/unreadable roots hard-fail before provider/cache/session calls.
- [ ] Multi-root directory, ordinary string file, dict/JSON-scalar file, and JSON-array file shapes normalize exactly as specified, including all mixed-root oracles.
- [ ] Every accepted final identity is globally unique; the adversarial prefix-closure fixture rejects deterministically with zero external side effects.
- [ ] Union order is root declaration order plus loader item order; the exact framed hash and derived cache session ID change with meaningful root reordering and are shared by query/estimate/warmup/batch consumers.
- [ ] Multi-root `meta.json` writes exact ordered `contextRoots` records; zero/singleton serialized shape is unchanged.
- [ ] Bounded singleton fixtures are byte-identical for all listed subjects with run ID, clock, provider, version, config/usage/log, HOME, and terminal variability fixed or excluded.
- [ ] Query, cache estimate/warmup, and batch pass the exact oracles above with one aggregate validation.
- [ ] Exact-SHA remote-dev install repeats collision, mixed-root, duplicate, missing-root, reorder/hash, and closure-rejection journeys with remote ref, CI `headSha`, and installed HEAD equality before and after.

## Next Step

After this planning fix is validated, return the updated DESIGN/DRAFT to the parent workflow; do not expand implementation scope in this loop.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `d8df1dfc4adacc9e70d3ea4b53ec09e632988c949828dd90a54cab7a909840ed`
- **Reviewer:** `openai-codex:gpt-5.6-sol-900k`
- **Reviewed at:** `2026-08-31T21:36:28Z`
<!-- genie-design-review:end -->
