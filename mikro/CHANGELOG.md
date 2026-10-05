# Changelog

All notable changes to rlmx are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

rlmx uses **calendar versioning**, not semantic versioning. Versions are
`0.YYMMDD.N` — a fixed `0` prefix, the UTC date of the build, and a per-UTC-day
release counter (see `scripts/version.mjs`). A version number therefore
tells you *when* a build was cut, not what compatibility it promises. Breaking
changes are called out under a `### Changed` or `### Removed` heading in the
entry for the release that contains them.

Every merge into `main` cuts a release, and the per-release notes are generated
from conventional commits by `Release Metadata` (see `cliff.toml`). This file
stays hand-curated as the narrative record of *notable* changes, so it
intentionally covers fewer versions than the tag list; the `## [Unreleased]`
section accumulates until it is promoted under a released version heading.

Note that npm is an **SDK-only** distribution channel; the canonical CLI
release is the git commit on `main`. See `docs/release-contract.md`.

## [Unreleased]

### Added

- **Declared tool schemas and truthful default-backend dispatch.** Agents can
  add `tools/<name>.schema.json` beside `.mjs`, `.js`, or `.py` plugins; both
  SDK loaders attach the validated description and JSON Schema parameters.
  The default backend now uses a REPL `tool_request` / `tool_response` bridge,
  while MCP discovery marks agents **UNAVAILABLE** for missing tools, reserved
  REPL names, and `.mikro/TOOLS.md` collisions. Every microagent description
  also reports its `Backend:` and declared `Tools:`.

- **Sampling temperature is now settable, from three surfaces.** A single
  nullable `temperature` flows into the root loop's two model calls — the
  per-iteration completion and the forced final answer — so a run that needs to
  pin sampling drift can. It is absent by default, and absent means *no
  `temperature` key on the wire at all*, not "the provider's documented
  default": an un-pinned run sends byte-for-byte the options object it sent
  before this existed.
  - **`temperature: <0–2>` in `mikro.yaml`, at the top level.** Not under
    `gemini:`. `gemini.thinking-level` is the standing evidence of what that
    nesting costs — pi/ai maps `reasoning` on every api family it supports, and
    the prefix has misled every reader of the key since. `temperature` is mapped
    just as widely and starts un-nested. Out-of-range and non-number values
    throw at load, naming the key.
  - **`temperature:` in `agent.yaml`**, applied by `applyAgent` onto the same
    `config.temperature` field, so an agent's value outranks the project's the
    way its `thinking:` already does. Unlike most type drift in that parser this
    one is a hard error: a `temperature: hot` that quietly inherited the ambient
    value would be indistinguishable from a working pin.
  - **`--temperature <n>`**, which outranks both.
  - **`0` is a value, not an absence.** Greedy decoding is the setting a
    committee gate reaches for first, and it is falsy — so every guard on the
    path is written `!= null` and never truthiness, and each surface has a test
    pinning that an exact zero survives it.
  - **Best-effort per transport.** pi/ai maps `temperature` on every api family
    and drops it only on the `anthropic-messages` api — when a reasoning level
    is set, or when the resolved model declares `compat.supportsTemperature:
    false`. Claude reached via OpenRouter (`openai-completions`) or Bedrock
    (`bedrock-converse-stream`) is *not* subject to that guard, so the model
    family alone does not tell you whether the pin took. A pinned temperature is
    a request, like a thinking level, not a guarantee.
  - Deliberately *not* threaded into `llm_query()` sub-calls, recursive
    children, or the web/fetch/image helpers. Recursive children re-read the
    config at their own cwd, so a `mikro.yaml` temperature propagates to them
    while a CLI or agent value does not.

- **`VALIDATE.md` is now enforced on the `FINAL` channel.** The pure validate
  primitives (`src/sdk/validate.ts`) had been wired only into the SDK's
  `runAgent()`; the core loop that serves the CLI *and* the default MCP backend
  never validated anything, so a pack's `VALIDATE.md` was inert there and the
  first `FINAL` won whether it matched the schema or not. `rlmLoop` now:
  - **Discloses the schema.** When the pack ships a readable `VALIDATE.md`,
    both prompt builders append an `## Output Schema` section — the schema
    block verbatim plus the two idioms the channel can actually read back:
    `FINAL(<compact single-line JSON>)` (the FINAL parser is line-based, so a
    pretty-printed payload is lost) or `FINAL_VAR` of a `json.dumps(...)`
    **string**. Never a bare Python dict, whose `str()` repr is single-quoted
    and is not JSON. The section is appended last, after the stop-protocol and
    criteria sections.
  - **Retries once, on shape only.** A payload that misses the schema buys one
    in-band retry: the shape errors and the schema are handed back as the next
    iteration's user turn and the run continues. The hint never contains
    content or fixture guidance. A retry is granted only when another iteration
    is genuinely available — the iteration cap, the cost/token budget and the
    wall-clock abort are all checked first — and is capped at
    `MAX_VALIDATE_ATTEMPTS` (2).
  - **Fails open with a flag.** A second failure returns the last payload with
    `validation_failed: true` rather than erroring: the downstream consumer
    wants the payload and decides for itself. The flag reaches `--output json`
    and the `mikro mcp` cost footer (` · validation_failed: true`). MCP
    `structuredContent` is unchanged — still exactly `{answer, session_id}`.
  - **Flag semantics.** `validation_failed` means "the returned *model answer*
    does not conform to the declared schema", whatever the cause. A run that
    exhausts its budget or iterations still produces a forced final answer,
    which is validated and flagged but never retried — the budget a retry would
    spend is exactly what ran out. The two designed aborts (three consecutive
    empty responses, wall-clock timeout) return runtime-error text rather than
    a payload and are never flagged; use `budgetHit` / `iterations` to tell
    exhaustion from a shape miss.
  - **Unvalidated packs are untouched.** No `VALIDATE.md`, or one whose fenced
    block does not parse, means no disclosure, no validation and no retry —
    byte-for-byte the previous behaviour.
  - This is a deliberate divergence from the SDK's `runAgent()`, which stays
    fail-*closed* (a terminal `ValidationFailed` error) for its typed-event
    consumers. Both surfaces share the same primitives; only the terminal
    policy differs, and each is pinned by its own tests.

- **Custom system prompts now carry the termination protocol.** A pack's own
  `SYSTEM.md` *replaces* the scaffolded template rather than extending it, and
  the ```` ```repl ```` fence contract plus the `FINAL()` / `FINAL_VAR()`
  contract lived only in `src/templates/default/SYSTEM.md`. An agent with a
  hand-written prompt was therefore never told how to stop: it answered in
  prose, `detectFinal` never fired, and every run burned to `max_iterations`.
  Both prompt builders — `buildSystemPrompt` (REPL path) and
  `buildCachedSystemPrompt` (`--cache` path) — now append a shared runtime
  section (`src/stop-protocol.ts`) just before the criteria block.
  - Skipped when the prompt already teaches the protocol: the section is
    appended only when `config.system` does not already contain `FINAL(`, so
    the shared termination section is not appended to either shipped template
    (`buildSystemPrompt` still substitutes `{custom_tools_section}` as before).
  - Skipped in structured output mode (`output.schema` with a Google
    provider): the run loop finalizes the schema-constrained JSON response
    directly and never parses `FINAL()`, so teaching the protocol there would
    demand two mutually exclusive output shapes.
  - Opt out with `prompt.append-stop-protocol: false` in `mikro.yaml`, or per
    agent with the same key in `agent.yaml` (the agent's declaration wins).
    Either restores the previous output byte-for-byte.
  - The section is a minimal termination contract, not a REPL tour: it
    deliberately omits `SHOW_VARS()`, which the template mentions but which is
    a debugging convenience rather than part of stopping.
  - **Baseline shift:** a zero-config run (no `SYSTEM.md`) previously went out
    with an *empty* system prompt and now gets the bare protocol section.
    Benchmark numbers taken against the old zero-config baseline are not
    directly comparable to new ones.

- **`rlmx mcp` — stdio MCP server.** The native way to drive rlmx from Claude
  Code, Codex, or Hermes: `claude mcp add rlmx -- rlmx mcp`. Exposes an
  `rlmx_query` tool plus **one tool per `agent.yaml` microagent** discovered
  under `~/.rlmx/agents/`, `<project>/.agents/`, or `<project>/.rlmx/agents/`
  (project shadows global; `RLMX_AGENTS_DIR` overrides). Each agent runs on the
  model its `agent.yaml` names, which is how repeatable work moves off an
  expensive host model.
  - Every result carries a token/cost footer, so the offload is visible in the
    transcript rather than taken on faith.
  - Emits `notifications/progress` per iteration. This is load-bearing: MCP
    clients time requests out (the reference client defaults to 60s) and a
    delegated recursive run on a local model routinely exceeds that.
  - `RLMX_MCP_RUN_TIMEOUT_MS` lifts rlmx's own wall-clock cap.
  - A failing tool call fails only that call, never the server process.
  - Gate: `scripts/smoke-mcp.mjs` drives the real server with the MCP SDK's own
    client — handshake, `tools/list`, per-agent tools, and error isolation.

### Changed

- **Removed built-in RTK integration (breaking SDK/Python API change).**
  `run_cli` executes commands directly and returns only `returncode`, `stdout`,
  and `stderr`; the `rtk_prefixed` result field is removed. The SDK no longer
  exports `registerRtkTool` or its option/argument/result types, config no longer
  exposes `RtkConfig` / `DEFAULT_RTK_CONFIG`, and `REPLStartOptions.rtkEnabled`
  is removed. Existing `rtk:` YAML sections are ignored. `mikro doctor` no
  longer probes or reports RTK, and its RTK-specific exit code 2 is removed.
  Remove these API references from consumers; use `run_cli` or a custom tool
  plugin for command execution.

- **`rlmDriver` now rejects an empty model-facing tool set** (SDK public API).
  Previously, supplying `tools` when every selected handler lacked a schema
  silently chose one-shot execution. It now throws the exported
  `NoExposableToolsError` at construction when no tool remaining after
  `expose` has a schema. Add `tools/<name>.schema.json`, register the handler
  with a `ToolSchema`, or omit `tools` when one-shot execution is intentional.

- **Microagents no longer inherit the ambient project schema.** `applyAgent`
  now assigns `validate` unconditionally, so an agent that ships no
  `VALIDATE.md` is uncontracted even when invoked inside a repo that ships one.
  Previously the agent's file could only *raise* a contract, never clear one —
  harmless while nothing enforced it, but with enforcement live it would judge
  (and flag) an uncontracted agent against a schema its author never wrote,
  purely because of which repo the MCP server was started in. CLI runs are
  unaffected and still read `.mikro/VALIDATE.md`.
- **`buildRetryHint` takes an optional surface argument** (SDK public API,
  re-exported from `mikro/sdk`). The addition is backward compatible: with the
  argument omitted the output is byte-identical to before. Passing
  `RETRY_HINT_FINAL` swaps the two `emit_done`-specific lines — the opening
  line and the closing re-emit instruction — for their `FINAL()` equivalents.

### Security

- Adding `@modelcontextprotocol/sdk` pulled in `@hono/node-server` 1.x, which
  carries a moderate advisory (path traversal in `serve-static` on Windows via
  encoded backslash, GHSA-frvp-7c67-39w9). Pinned to `^2.0.11` via a
  `package.json` `overrides` entry; `npm audit --omit=dev` reports zero
  vulnerabilities again. rlmx uses only the SDK's **stdio** transport, so the
  affected `serve-static` path is never loaded.
  **Caveat:** npm `overrides` apply to this repo's install, not to consumers of
  the published SDK package — a downstream tree may still resolve the
  vulnerable transitive version until the upstream SDK bumps its own range.

### khal provider

- **`khal/<model>` — the khal LiteLLM gateway as a first-class provider.**
  Every model the gateway serves (`llm.khal.ai`, override `KHAL_BASE_URL`)
  resolves on both the CLI and SDK paths, the same seam `station/<model>` uses.
  The key is env-only: `KHAL_API_KEY`, falling back to `RLMX_KHAL_API_KEY`.
  - The catalog is built from LiteLLM's `/model/info`, which quotes prices
    **per token** where pi-ai's `Model.cost` is **per million** — so prices are
    converted ×1e6 on the way in. Without that conversion every khal run would
    report `$0.0000`; a fixture test pins it (`deepseek-v4-flash` at
    `1e-7`/token → `$0.10`/Mtok).
  - Aliases that front several gateway deployments fold into one model, taking
    the highest quoted price, so reported cost never depends on `/model/info`
    ordering and never under-reports against `--max-cost`. **Reported cost is
    therefore an upper bound for multi-deployment aliases**: on the live
    gateway `khal/kimi-k2.6` fronts deployments at 7.5e-7 / 9.5e-7 / 1.2e-6
    per input token, so a run billed at the cheapest deployment reports up to
    ~60% high. Single-deployment and uniformly-priced aliases — including the
    `deepseek-v4-flash` default — are exact.
  - `/model/info` being down does not block resolution: models come from
    `/v1/models` with cost 0, plus one warning on stderr — emitted only once
    that fallback has actually answered, so the warning never promises a
    resolution that did not happen. If neither endpoint answers, the warning
    names both failures instead.
  - Every khal-specific failure is named at the resolution hook, because
    `resolveModel` downstream has one error for all of them ("unknown model"),
    which is true of none of them: no key → `khal provider requires
    KHAL_API_KEY`; key rejected (401/403) → `khal gateway rejected
    KHAL_API_KEY (HTTP 401) …`, naming whichever env var supplied it; gateway
    up but serving no catalog → `khal catalog unavailable (/model/info: …;
    /models: …)`. A rejected key is never retried against the fallback
    endpoint — it answers the same 401 — and never degrades into an empty
    catalog.

### MCP

- **The `rlmx mcp` tool set is now live.** Every `tools/list` *and* every
  `tools/call` re-scans the agent roots, and the advertised list plus the call
  lookup are rebuilt from that one scan — so an `agent.yaml` folder authored
  mid-session is listed **and callable** without reconnecting, and one deleted
  mid-session stops dispatching even while a client's cached list still shows
  it. `notifications/tools/list_changed` fires when the set actually changes
  (never for an edited spec, which is not a set change), and
  `tools.listChanged` is declared only because it is genuinely emitted.
- **The tool surface now mirrors the host's native Agent tool**, so delegating
  to rlmx needs no new interaction pattern:
  - `prompt` is the primary input; `query` remains as a deprecated alias. Both
    are optional in the schema (`required: []`) with the exactly-one rule
    enforced at runtime and every error naming `prompt` — deliberately not
    `anyOf`, which MCP hosts surface to models inconsistently.
  - Descriptions read as spawn instructions (what it is, that it runs to
    completion and cannot ask follow-up questions, what comes back).
  - Every result carries `answer` **and** `session_id` in `structuredContent` —
    backed by a declared `{answer: string, session_id: string}` `outputSchema`
    so both are a contract rather than an undocumented extra — and echoes the
    session id in the prose footer for hosts that render only text. `answer` is
    the text block byte for byte, footer included: declaring an `outputSchema`
    also permits a client to read `structuredContent` *instead of* `content`, so
    the answer has to be in it or the whole delegated run is invisible to that
    host. A failed call puts its error message in `answer`.
  - A run that fails **without throwing** is now reported as `isError`. rlmx's
    two designed aborts — three consecutive empty LLM responses, and the
    wall-clock timeout — return their reason as the answer rather than raising,
    so they used to arrive as successful results and the host model read the
    abort reason as the agent's report. Each is matched by its own exact signal
    — the abort by `budgetHit === "empty_responses"` (the same field `src/cli.ts`
    keys its exit code off, now one shared constant in `src/rlm.ts`), the
    timeout by its verbatim answer — and deliberately **not** by testing the
    answer for an `Error:` prefix: `answer` is the model's own text, and a
    report that quotes the failing line out of a log starts that way as a matter
    of course (that is the shipped `log-triage` recipe's whole job). A genuine
    `max-cost`/`max-tokens`/`max-depth` budget hit still forces a real final
    answer and stays a success — shorter, not failed.
  - Passing that `session_id` back **continues the conversation**: the
    session's bounded turn history is replayed into the new prompt, the same
    mechanism `rlmx acp` uses. Each call still runs a fresh `rlmLoop` with a
    fresh Python REPL, so **live REPL state is explicitly not preserved across
    a resume** — conversation is, interpreter variables are not.
  - Sessions live in-process with a TTL, a size cap with LRU eviction, and a
    per-session turn cap; they are advisory, so losing one costs a fresh start
    and never correctness. An unknown or expired `session_id` is a clear error,
    never a silent fresh start; a concurrent call on the same session is
    rejected as "session busy"; a `session_id` is bound to the tool that
    created it and is not portable to another; and an agent deleted mid-session
    answers "Unknown tool" while its orphaned sessions are evicted.
  - `rlmx_query` participates fully (prompt, session_id, resume) and keeps its
    `model` override.
- **`.proposed` is now a reserved agent-directory suffix, and discovery skips
  it silently.** `discoverAgents` ignores any directory under an agent root
  whose name ends `.proposed`, matched **case-insensitively** (`X.Proposed` is
  skipped like `x.proposed`). This changes discovery for **every** `rlmx mcp`
  user, not only plugin users.
  - The skip is applied before the spec is parsed and before the tool list is
    built, and `tools/call` dispatches from that same scan, so a draft is
    **neither listed nor callable** — calling it by its would-be name answers
    `Unknown tool: rlmx_<name>_proposed`. Renaming the directory publishes it
    on the next request, live, with no reconnect; renaming it back withdraws
    it just as fast.
  - It exists so `/rlmx:microagent-create` can write a draft agent to disk
    without that agent becoming callable. The rename is the approval step, and
    it only means something if an un-renamed draft can do nothing at all.
  - **The cost, stated because the error surface is silence:** an agent you
    legitimately wanted to name `foo.proposed` loads fine on its own and simply
    never appears — no warning, no log line. If an agent you wrote is missing
    from `tools/list`, check its directory name for the suffix first. Reserved
    in every casing. Documented in `docs/agent-yaml-schema.md`,
    `plugins/claude-code/README.md`, and the skill.
- **`rlmx mcp --dir <path>`** chdirs to a validated directory before starting,
  making agent discovery, `loadConfig`, relative `context` paths, and the REPL's
  working directory agree on one root instead of on wherever the host happened
  to spawn the server. Reuses the existing `--dir` flag — no second
  directory-flag convention.
- Gate: `scripts/smoke-mcp.mjs` now drives a **real workspace root** through the
  ordinary discovery precedence (temp cwd, no `RLMX_AGENTS_DIR` override) with
  the server spawned from a different directory and pointed at it by `--dir`.
  It proves create-then-list-then-call mid-session, the `list_changed`
  notification (and its absence while the set is static), the new input schema,
  a resume round-trip, and the unknown-session / session-busy / cross-tool
  errors. Live turns run against the local station gateway — keyless, same
  convention as `smoke-acp.mjs`; `--no-live` gates the protocol surface alone.
- **Optional `thinking:` in `agent.yaml`** — `minimal` | `low` | `medium` |
  `high`, so an agent pins its own reasoning effort instead of inheriting the
  ambient `gemini.thinking-level`. Validated at parse time, which is discovery
  time under `rlmx mcp`, with a named error listing the legal values; unknown
  levels no longer land silently on `extras`. `applyAgent` writes the one field
  `--thinking` already writes (`config.gemini.thinkingLevel` →
  `llmComplete({ thinkingLevel })` → pi/ai `reasoning`), so there is no second
  per-agent channel to keep in sync.
  - On a **cloud** model this is a **correctness fix, not tuning**: pi/ai
    explicitly *disables* reasoning when no level is passed, so a microagent on
    Google / OpenAI / Anthropic had been running with reasoning off and had no
    way to ask for it. Verified by capturing built request payloads (no
    network) — `high` becomes `thinkingConfig.thinkingLevel: HIGH` on Google,
    `reasoning.effort: "high"` on OpenAI Responses, and
    `thinking.budget_tokens: 16384` on Anthropic. The knob is **not**
    Google-only despite the `gemini.` config prefix.
  - **`station/` models are the exception, and there reasoning-off is
    deliberate.** They declare `supportsReasoningEffort: false`, so no
    `reasoning_effort` is sent and the levels do not grade — the only thing a
    declared level changes is `chat_template_kwargs.enable_thinking`, which
    pi/ai derives from *whether* a level was requested. Off is the QA'd
    baseline that makes `Qwen3.6-35B-A3B-MTP-GGUF` answer at all; on, it
    streams into `reasoning_content`, never emits a `content` delta, and three
    such turns abort the run (see `src/station-provider.ts`). So `thinking:` is
    a footgun on local Qwen GGUF models and every shipped `station/` recipe
    omits it. Documented in `README.md` and
    `docs/agent-yaml-schema.md#station-models-leave-thinking-unset`.
  - The level is a request, not a guarantee: pi/ai clamps to the levels the
    resolved model declares and searches *upward* first, so `minimal` on a model
    with a higher floor comes back raised.
  - `rlmx mcp` now emits one stderr line per unloadable agent directory (deduped;
    a directory with no `agent.yaml` stays silent). Discovery previously caught
    and discarded every parse error, so a typo'd value presented as the agent
    silently vanishing from `tools/list` with nothing to debug. Broken agents are
    still skipped rather than taking down the server.

### explore microagent

- **`examples/agents/explore/`** — the reference microagent, and the first
  recipe in what becomes the canonical `examples/agents/` subtree. It answers a
  question about the repository it runs in and returns the answer with
  `file:line` citations that resolve. Install it as
  `<project>/.rlmx/agents/explore/` and a host sees `rlmx_explore`.
  - `shape: loop` with `budget.max_iterations`, never `single-step`: the tree
    is on the filesystem, not in the prompt, so a single pass answers from
    memory before opening a file. The system prompt is built around that —
    print-or-see-nothing REPL discipline, search-for-literals, and a citation
    contract (line numbers come from executed code, never a dump, "not found"
    over a guess).
  - Default model `khal/deepseek-v4-flash`; any `station/<model>` works too.
- **`scripts/smoke-explore.mjs`** — the recipe's own gate, distinct from
  `smoke-mcp.mjs`'s synthetic fixture: it installs the shipped agent into this
  checkout, drives `rlmx mcp --dir <checkout>` over MCP, asks a fixed question
  about this repo, and mechanically resolves the citations that come back
  against the same tree. Station arm by default (keyless, `RLMX_SMOKE_MODEL`
  overrides); the khal arm runs the shipped model when `KHAL_API_KEY` is set.
- **`docs/parity-explore.md`** — the parity gate, run and reported. Six mined
  tasks driven through `rlmx_explore` over the real MCP path and scored against
  native Explore by a fixed rubric, across the full escalation ladder
  (`deepseek-v4-flash` → `mimo-v2.5` → `kimi-code` → `claude-haiku`): 15 rounds,
  90 runs, every tuning change logged. **Verdict `Gate: FAIL`** — 0 of 6 tasks
  passed on any tier, against a bar of 5 of 6. Citation hygiene was not the
  problem (the final flash round fabricates nothing across all six tasks); fact
  coverage was, at best 7 of 10 required facts where 9 were needed. The token
  side is reported and unambiguous — 366×–2,110× less premium context per task,
  $0.14 of gateway spend for the suite — and was never allowed to be the gate.
  Wish B (`rlmx-microagent-plugin`) does not start.
- **`examples/agents/explore/` tuning** from the gate, kept because each fixed
  something measurable: the answer is returned as `FINAL("""…""")` written out
  inline rather than through a variable name (`FINAL(answer)` submits the
  literal word and silently discards the run); a last-iteration override that
  answers in plain prose, which is what `src/rlm.ts` actually asks for; a
  verification block that re-opens every line before citing it; and
  `budget.max_cost` 0.25 → 2.00, because 0.25 was one model's price and it
  truncated every run on a pricier one.
- **`scripts/mine-explore-tasks.mjs`** — builds the explore parity suite out of
  real work rather than invented questions: it reads this host's Claude Code
  transcripts, lifts out read-only question→search→answer segments, and
  verifies each claim against the repository the session ran in. Verification
  is content-anchored, so a claim whose code moved is re-anchored to where it
  lives today and one whose symbols are gone is excluded from scoring. Every
  verbatim excerpt is redacted for credentials on the way out.

### plugin

- **`plugins/claude-code/`** — rlmx as a Claude Code plugin. One copy-paste
  installs it from a clone, with no npm in the path:

  ```bash
  claude plugin marketplace add ~/.rlmx/rlmx && claude plugin install rlmx@rlmx
  ```

  The clone is the marketplace (`.claude-plugin/marketplace.json` at the
  repository root, plugin entry `./plugins/claude-code`), which is why no
  second repository and no registry is involved.
  - The bundled MCP registration is `rlmx mcp --dir ${CLAUDE_PROJECT_DIR}`, so
    the server's working directory is the project you have open rather than
    whatever directory the host spawned it from. Agent discovery, `loadConfig`,
    relative `context` arguments and the REPL cwd then all agree on one root
    (`src/cli.ts:1039-1054`). A workspace with `.rlmx/agents/explore-r/` gets
    `rlmx_explore-r` without a per-project `claude mcp add`.
  - Plugin tools are namespaced `mcp__plugin_rlmx_rlmx__<tool>`, distinct from
    a bare `claude mcp add rlmx` registration's `mcp__rlmx__<tool>`. Both can
    coexist.
  - `rlmx` must be on `PATH`: installed plugins are copied into
    `~/.claude/plugins/cache` and cannot reference files outside their own
    directory, so the plugin cannot point at a `dist/` inside the clone it
    shipped from. `scripts/install.sh` linking `~/.local/bin/rlmx` is what
    makes it resolve.
  - **Two bundled skills, both with content.** Neither loads until its trigger
    fires, so an idle session pays only for their two description lines.
    - **`/rlmx:offload-guidance`** — a routing rule. An explore-class question
      about a repository not already in context goes to `rlmx_explore-r`
      *before* Grep/Glob/Read and before an Explore subagent; its citations are
      leads to verify, not findings. Carries the three escalation triggers
      taken from measured failure modes rather than invented heuristics —
      citations that do not resolve, an errored or timed-out run, and work
      where completeness outranks cost — plus the call shape and `session_id`
      resume.
    - **`/rlmx:microagent-create`** — propose-only. Streams this host's
      last-24h Claude Code transcripts through a bundled scanner
      (`scan-transcripts.mjs`, which labels MEASURED usage-block counts apart
      from ~ESTIMATED character-derived ones and never blurs them), ranks
      recurring work into offload families by the context each returns, picks
      at most one candidate against five stated rules — proposing nothing when
      none clears them — and writes a draft `agent.yaml` + `SYSTEM.md` +
      `EVIDENCE.md` into `.rlmx/agents/<name>.proposed/`. Then it stops and
      hands the user the `mv`. It cannot activate anything; see the
      `.proposed` reserved suffix under **MCP**.
  - Positioning is unchanged by this entry: the explore parity gate's
    `Gate: FAIL` stands. The plugin ships `explore-r` as a **first-pass**
    explorer under the design's Amendment 2026-07-27, and
    `plugins/claude-code/README.md` carries the report's own scoping —
    out-of-sample coverage 0.714 against 0.853–0.912 in-sample, zero fabricated
    citations **in the frozen configuration only** (earlier rounds fabricated),
    and 1,077× aggregate premium-token reduction for $0.22 in that same frozen
    configuration — not round 1's 921×/$0.14, which is a different, non-shipping
    configuration. No parity claim is made anywhere in the plugin.

### docs

- **`docs/worker-models.md`** — which model to run a microagent on, with the
  round-2 evidence consolidated into one table and each number's scope attached
  to it. The default stays **`khal/deepseek-v4-flash`**, and the page says why
  in the only terms the evidence supports: it is 8.7×–18.8× cheaper per round
  than every arm measured and it finished every run, **not** that it was
  measured as the most accurate — flash's published 32/34 failed to reproduce
  (three live task-4 replicates scored 3/6, 5/6, 4/6 against 6/6) and the arm is
  corrected to **29–31/34**, which puts its margin over `qwen3.7-max` at +1..+3,
  inside the ±3-fact run-to-run spread measured on flash itself. Carries per-arm
  catalog pricing, UTC run dates, the n=1 noise caveat, and the standing
  scoping: out-of-sample coverage **0.714** against **0.853–0.912** in-sample,
  zero fabricated citations **in the frozen configuration only** (earlier rounds
  fabricated), **1,077×** premium-token reduction for **$0.22** in that same
  configuration, four generations evaluated and a fifth rejected, and the
  recursion product fixes at commit **`6ec4822`**.
- **A `station/<model>` arm on the training suite, n = 2, marked
  not-rank-comparable.** Records under
  `parity/round2/optimizer/station-arm/`, run with the same recipe, suite and
  scorer as the four khal arms, `--concurrency 1` because one local gateway
  cannot host two tasks' worth of streams. Two replicates buy feasibility, a $0
  cost figure and a replicate spread on one model — **not** a rank against the
  n=1 cloud arms, and the row says so. It ran on `station/qwen3.5-2b-FLM`
  because that was **the only station model that would serve on this host that
  day**: five larger candidates were tried first and every one failed to load,
  one of them wedging the gateway's loader for ~31 minutes. A 2 B model is
  below the capability floor this recipe was written for, so the arm's coverage
  number is a floor for the station provider and not an estimate of it — the
  arm's README and the docs page both say so, and the run is re-runnable
  against a larger model with one flag.
- **`examples/agents/` is now the single microagent recipe tree.** The flat
  `examples/hello-world/`, `examples/research-agent/` and
  `examples/brain-triage/` entries moved under it (their tests moved with
  them), so one tree holds every `agent.yaml` recipe and `examples/` holds only
  `rlmx.yaml` configuration examples. New
  [`examples/agents/README.md`](examples/agents/README.md) indexes them with
  what gates each one — including the three that nothing gates.
- **Three legacy agents archived as recipes** — `changelog`, `codebase-qa` and
  `log-triage`, copied byte-for-byte out of this host's `~/.rlmx/agents/`
  (sha256 in each README) and verified to load through `loadAgentSpec` by
  `tests/examples-agents-recipes.test.ts`, which also pins every recipe in the
  tree to load. **`codebase-qa` is kept deliberately**: "`explore-r` replaces
  it" is positioning, not a result — the explore gate scored 0 of 6 tasks
  against a bar of 5 of 6 in both rounds, and no run anywhere in this
  repository compares the two. The **host-side removal is a documented user
  step and this change never performs it**; nothing in rlmx deletes a file from
  your home directory.

## [0.260725.1] — 2026-07-25

First release since `0.260528.2`. Lands the ACP agent, the recursion event
stream, the pi-ai 0.80 Models runtime, and the local `station` provider, and
clears the production dependency tree of known advisories.

### Added

- **`rlmx acp` — stdio ACP agent (experimental).** Exposes rlmx over the
  [Agent Client Protocol](https://agentclientprotocol.com). The intended use is
  driving rlmx as a sub-agent from Claude Code, Codex, Hermes, or the CLI via a
  headless ACP client such as `acpx`; ACP editor clients (Zed) can spawn it
  directly. Translates the instrumented
  `rlmLoop` event stream into live ACP session updates, mapping recursion into
  tool-call nodes. Includes durable multi-turn sessions, MCP advertisement, and
  disconnect handling. **Experimental:** the protocol surface may change, and
  v1 serializes prompt turns within a single active session. (#112)
- **Recursion event stream.** `rlmLoop({ emitter })` is now a contractual seam
  emitting `RecurseEvent`s with per-node tokens, cost, latency, and
  `correlationId` ancestry — making a recursive run observable rather than
  opaque. Documented in `docs/events.md`. (#107)
- **`station` provider.** First-class local Lemonade gateway registered at both
  resolution sites, addressable as `station/<model>`, for running agents
  against local models over an OpenAI-compatible endpoint. (#110)
- **CLI schema exposure** and hardened model routes. (#101)
- `run_cli` Python REPL battery (auto-prefixes `rtk` when available, for 60-90%
  token savings on tool output)
- `rlmx doctor` reports RTK install status + config mode
- `rtk.enabled: auto | always | never` in `rlmx.yaml`
- Scaffold templates (default + code) now include RTK-aware examples

### Changed

- **pi-ai upgraded to 0.80.10 (Models runtime).** Multi-provider support
  (Anthropic / OpenAI / Google and others) via the Models API, bringing
  `uuidv7` identifiers, `contentText`, and `Usage.reasoning` /
  `responseModel`. (#107)

### Fixed

- Bound the station `fetchModels` discovery request with a 5s abort timeout so
  model discovery cannot hang. (#111)
- Event-stream QA follow-ups from the `rlmx-live-tui` final gate. (#109, #108)
- Emit Langfuse generations for root RLM calls, closing a gap where only child
  runs were traced. (#99)
- Keep GitHub releases tied to the package version, and enforce the release
  channel contract in CI. (#102, #103, #104)
- Harden the rolling PR workflow and its token handling. (#105, #106)

### Security

- Resolved a **high-severity `js-yaml` advisory** (quadratic-complexity DoS via
  repeated merge-key aliases — GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m) and a
  moderate `protobufjs` advisory, both present in the production dependency
  tree. rlmx parses user-authored `agent.yaml` / `rlmx.yaml`, so the js-yaml
  issue was directly in scope. `npm audit --omit=dev` now reports zero
  vulnerabilities.
- ACP hardening shipped with #112: redaction input is length-bounded to
  eliminate a ReDoS path in `sanitizeText`, tool-call payloads are bounded and
  redacted at the translator boundary, and non-UUID `sessionId`s are rejected
  to close a session-store path-traversal vector.
