# readme-polish — cycle 000 (seed)

- when: 2026-08-17T00:2xZ (manual MCP run during the v0.260817.1 dogfood, before the loop runner existed; preserved verbatim as the colony's origin artifact)
- tool: mikro_readme-polish · model deepseek/deepseek-v4-flash
- usage: 12 iterations · 27,942 in / 3,087 out · $0.0052 · 42.0s · session sess_da20bda995158315

---

Verdict: This is a thoroughly documented, accurate, and well-structured README for a mature project — the claims I spot-checked against the code hold, and the document is remarkable for its honesty about limitations, experimental status, and why design decisions were made. The polish opportunities are largely minor: a few formatting issues, potential redundancies, and places where the depth of detail may exceed what a newcomer needs on first read.

Keeps: The honest "npm is SDK-only" section, the experimental warning on ACP, the "checked, holds" pattern of verifying every claim, the tool-contract table with its "exactly one of prompt|query" explanation, and the RTK section's clear before/after example. Don't break any of these.

Findings, severity-ordered:

1. [POLISH] README.md:174 — the model reference `station/Qwen3.6-35B-A3B-MTP-GGUF` appears twice (also at README.md:271 in the cost footer example). If the model weight has been renamed or the version bumped in the code, both would go stale simultaneously. Suggest confirming this is the current canonical model name in `src/llm.ts` or `src/station-provider.ts`.

2. [POLISH] README.md:284-307 — the SDK TypeScript example imports `{ sdk }` from `mikro` and then also uses `sdk.rlmDriver`, `sdk.loadAgentSpec`, etc. But the "Programmatic API" section at README.md:983 imports `{ rlmLoop, loadConfig, loadContext }` directly from the same package. This is fine, but the README could add one sentence noting both export styles exist to prevent reader confusion.

3. [POLISH] README.md:490 — "Other ACP clients take the same three inputs — `command`, `args`, `cwd` — in whatever shape their config uses." This is slightly underspecified; consider naming one or two concrete examples (e.g., "VS Code's ACP extension using `agent.servers` config" or mentioning the `acpx` config file at `.acpx/config.json`).

4. [POLISH] README.md:606-609 — the `mikro doctor` exit code paragraph is excellent but slightly buried under the "Verify" heading for RTK. Consider moving it to the `mikro doctor` CLI Reference line (README.md:847) where a reader scanning the command table would see it.

5. [POLISH] README.md:209 — "exactly the way `--thinking` does, because it writes that same field — there is no second per-agent channel to keep in sync." This is clear, but the parenthetical aside "Despite the `gemini.` prefix the config key inherited" at line 211 is slightly confusing — the reader may wonder what "inherited" means. Suggest rewording: "The config key keeps the `gemini.` prefix for backward compatibility with earlier versions."

6. [POLISH] README.md:631-635 — the recursion list (item 3) contains `llm_query_batched` and `rlm_query_batched` without noting they're async/parallel. The parenthetical "(fast, one-shot)" appears only on `llm_query`. Consider adding "(concurrent)" to the batched ones for symmetry.

7. [POLISH] README.md:855 — CLI Reference lists `--verbose` as "Show iteration progress on stderr" — this is correct, but line 856 lists `--max-iterations` with default 30, which matches line 637's "default 30". Good — no change needed.

8. [POLISH] README.md:892-935 — the Output Modes section is sparse compared to surrounding sections. The Stream mode (line 929-935) gets only two lines. Consider showing a sample JSONL event line, or explicitly pointing to `docs/events.md` for the event schema.

9. [POLISH] README.md:999-1003 — Requirements lists "Python 3.10+" — this is a claim about the code. Verified `src/detect.ts` exists but did not check the exact version gate in this session. The version at line 1001 (Node >= 22.19.0) matches `package.json` engines exactly — checked, holds.

10. [POLISH] README.md:962-966 — the provider key list is long and alphabetized, but it's easy to miss that `KHAL_API_KEY` (or `MIKRO_KHAL_API_KEY`) appears only in the env-var table at line 976, not in this recognized-provider-keys list. Consider adding a cross-reference: "see also the khal/ provider env vars below."

11. [STRUCTURE] README.md:65-146 — the MCP section is very deep for a README. The "Tool contract" subsection (lines 95-146) reads like API reference material. Consider whether some of this belongs in `docs/mcp.md` with the README keeping only the quick-start and a link. However, the README's stated job is "complete enough to start" — and this section IS complete. This is a judgment call, not a defect.

12. [POLISH] README.md:271 — the agent cost footer example `mikro · agent=triage · station/Qwen3.6-35B-A3B-MTP-GGUF · 3 iterations · 307 in / 36 out · $0.00 · 3.9s` contains `$0.00` which could alarm a user into thinking the local model is free-but-broken. The surrounding text ("what it cost") handles this, but consider a brief parenthetical like "(local model — no token cost)".

13. [STRUCTURE] README.md:834-890 — the CLI Reference is exhaustive but the "Sub-command shapes" section (lines 880-886) restates `benchmark` and `stats` sub-options that already appeared in the main table. The main table at lines 840-850 lists commands, and lines 852-878 list shared options. Lines 880-886 add sub-command-specific shapes — this is actually the right structure, and the overlap is minor. Keep as-is.

14. [POLISH] README.md:1016-1018 — the License section is just "MIT". Consider adding the standard one-liner: "See [LICENSE](LICENSE) for the full text." Checked: there is no LICENSE file in the repo root from my earlier file listing — this may be an intentional omission (license file missing from the repo). Flag this as a possible GAP: if the repo has no LICENSE file, the README's claim of MIT is not backed by a license file in the tree.

Checked, holds:
- README.md:39 — npm package name `mikro` — verified against package.json:2
- README.md:42 — "ships no `bin`" — verified: package.json has no `bin` field
- README.md:841-850 — CLI command list (`init`, `cache`, `batch`, `benchmark`, `stats`, `config`, `doctor`, `update`, `acp`, `mcp`) — verified against src/cli.ts:125
- README.md:852-878 — CLI flags (`--max-depth`, `--batch-api`, `--no-session`, `--parallel`, `--template`, `--estimate`) — verified against src/schema.ts and src/cli.ts
- README.md:877 — `--template <name>` with "default or code" — verified against src/scaffold.ts:17
- README.md:1001 — Node >= 22.19.0 — verified against package.json:44-45
- README.md:973 — `MIKRO_MCP_RUN_TIMEOUT_MS` — verified against src/mcp/backends/legacy.ts:91 and src/mcp/backends/prime.ts:616
- README.md:583 — `run_cli(cmd, *args)` — verified against src/rtk-detect.ts:5 and src/templates/code/SYSTEM.md:22

References:
- package.json:2 — package name, :44-45 engines
- src/cli.ts:125 — command list, :93-94 `--parallel` and `--batch-api`, :61-66 command table
- src/schema.ts:135, 172, 179, 186, 193, 200 — flag definitions
- src/scaffold.ts:17 — template names
- src/mcp/backends/legacy.ts:91 — MIKRO_MCP_RUN_TIMEOUT_MS
- src/rtk-detect.ts:5 — run_cli battery
- src/templates/code/SYSTEM.md:22 — run_cli documentation

One actionable GAP found: **no LICENSE file in repo root** — from my file listing, the repository has no LICENSE file, yet README.md:1018 claims "MIT". Either the license file exists elsewhere (check `docs/` or a hidden path) or this needs a LICENSE file added to the repository to match the claim.

---

Host follow-up (outside the agent, same day): the GAP was independently
confirmed (`ls LICENSE*` → nothing; package.json:54 `"license": "MIT"`) and
closed by commit ce829d4 adding the MIT LICENSE file.
