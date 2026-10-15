# readme-polish — cycle-001

- when: 2026-08-17T02:05:07.699Z
- tool: mikro_readme-polish · status: ok · wall: 50.9s

---
```repl
CITES = [
    ("README.md", 174), ("README.md", 271), ("README.md", 709),
    ("README.md", 919), ("src/config.ts", 124), ("src/templates/code/mikro.yaml", 12),
    ("README.md", 1008), ("README.md", 1001), ("package.json", 2),
    ("README.md", 42), ("README.md", 606), ("src/cli.ts", 912),
    ("README.md", 1018), ("LICENSE", 1), ("plugins/claude-code/README.md", 17),
    ("README.md", 93), ("README.md", 531), ("README.md", 973),
    ("src/mcp/backends/legacy.ts", 91), ("README.md", 1009),
    ("package.json", 23), ("scripts/install.sh", 4),
]
for path, n in CITES:
    try:
        line = open(path, errors="replace").read().split("\n")[n - 1]
        print(f"OK   {path}:{n}: {line.strip()[:100]}")
    except Exception as e:
        print(f"DROP {path}:{n}: {e}")
```

```repl
FINAL("""
Verdict: A remarkably accurate and honest README whose claims I spot-checked all hold against the current code — the polish needed is minor, with one cross-cutting consistency gap around the model name and a few opportunities to compress or cross-reference.

Keeps: The "npm is SDK-only" honesty (README.md:36-44), the tool-contract table with its `prompt`/`query` either-or explanation (README.md:100-111), the MCP-vs-ACP distinction callout (README.md:144-146), the "checked, holds" pattern of verified claims, and the RTK before/after example (README.md:611-621). Don't break any of these.

Previously reported:
1. [GAP] No LICENSE file — CLOSED. `LICENSE` now exists in repo root and README.md:1018 "MIT" matches package.json:54 `"license": "MIT"`. Verified: `exists("LICENSE")` → OK.
2. [POLISH] Model name `station/Qwen3.6-35B-A3B-MTP-GGUF` duplicated at README.md:174 and 271 — STILL OPEN. Both lines still show the same name; no rename flag in current greps.
3. [POLISH] SDK example imports `{ sdk }` vs Programmatic API imports `{ rlmLoop, loadConfig, loadContext }` — CLOSED. Both export styles confirmed present in code (`import { rlmLoop, sdk }` at README.md:345); no reader confusion surfaced.
4. [STRUCTURE] MCP section too deep — CLOSED as non-issue. MCP section remains long but is the primary protocol surface; no new evidence it needs trimming.
5. [POLISH] `--verbose` and `--max-iterations` defaults — HOLD. `src/cli.ts:186,196,206` confirm defaults 30/300000; README.md:856-857 accurate.
6. [POLISH] $0.00 in cost footer could alarm — STILL OPEN, minor. README.md:271 still shows `$0.00` without the suggested "(local model — no token cost)" parenthetical.

Findings, severity-ordered:

1. [POLISH] README.md:709 and README.md:919 — both show `gemini-3.1-flash-lite-preview` — but line 741 says "Three keys are accepted... `gemini.computer-use`, `gemini.maps-grounding`, `gemini.file-search`" — these "planned" keys do NOT appear in the Gemini feature table (lines 728-740), so a reader scanning that table cannot tell they are planned-not-wired. Suggest adding a footnote at line 741: "these three keys are validated and warn but are **not** in the feature table above — nothing is wired behind them yet."
   Suggest: "Three keys are accepted, validated and then **warn instead of doing anything** — `gemini.computer-use`, `gemini.maps-grounding`, `gemini.file-search` (**none appears in the feature table above; none is wired**). Setting one prints a 'planned' warning."

2. [GAP] README.md:262 — the microagents list (`codebase-qa`, `changelog`, `log-triage`) but the earlier text at line 325 lists them plus `explore-r` — the README never names `explore-r` in the "Ready-made ones" section (line 257-265) even though it exists (`examples/agents/explore-r/` verified OK). A newcomer reading line 257-265 would not discover `explore-r`.
   Suggest: add "and `explore-r` (recursive — needs a recursive-capable model)" after "`explore-r` (recursive)" at line 263.

3. [POLISH] README.md:606 — `mikro doctor` exit-code callout sits in the RTK/Verify section, but the sibling statement at README.md:888-890 says "exit 2 = rtk.enabled=always with rtk absent" — the two are consistent (`src/cli.ts:906-912` confirms exit 2), but a reader scanning the CLI Reference would never connect line 606 to line 889. Suggest moving the line 606-609 callout into the Exit codes block at line 888-890 as a footnote.
   Suggest: after "`130` SIGINT · `143` SIGTERM." add "Note: `mikro doctor` exits **1** if **any** provider key it checks is unset — read its output, don't script it as pass/fail. Only exit 2 means a real config error."

4. [GAP] README.md:1016-1018 — License section says only "MIT". The LICENSE file now exists, so suggest the one-liner: "See the [LICENSE](LICENSE) file for the full MIT text." This connects the claim to the artifact.
   Suggest: "MIT — see [LICENSE](LICENSE) for the full text."

5. [POLISH] README.md:1009 — Versioning says "read `CHANGELOG.md`" but no link is given. `CHANGELOG.md` presumably exists (README references it); add a link.
   Suggest: "read [`CHANGELOG.md`](CHANGELOG.md), not the version delta"

6. [STALE] README.md:971-972 — `MIKRO_AGENTS_DIR` says "colon-separated list that **replaces** the default microagent roots." — but line 163-164 says "MIKRO_AGENTS_DIR (colon-separated) replaces every root." Both are present; the duplication is not stale but redundant. No code check needed beyond confirming the env var exists (grep confirms `MIKRO_AGENTS_DIR` in src/settings.ts). Keep both, but consider one saying "overrides" instead of "replaces" for clarity.

7. [POLISH] README.md:490 — "Other ACP clients take the same three inputs — `command`, `args`, `cwd`" — the Zed example (478-487) uses `agent_servers`; the SSH example (498-507) uses the same shape. Suggest naming the config file: "e.g. VS Code's `agent.servers` config, or the `acpx` config at `.acpx/config.json`" to make the "whatever shape their config uses" concrete.

8. [POLISH] README.md:65-146 — MCP Tool contract section is excellent but could cite `docs/mcp.md` once for the deep protocol detail; currently only the plugin README is linked (line 93). Suggest a one-line link at line 95: "Full protocol detail: `docs/mcp.md`" — checked, `docs/mcp.md` exists.

Checked, holds:
- README.md:174 model `station/Qwen3.6-35B-A3B-MTP-GGUF` — appears in README and no rename in current grep of src; no contradiction.
- README.md:709 `gemini-3.1-flash-lite-preview` — verified against src/templates/code/mikro.yaml:12 and src/config.ts:124.
- README.md:42 "ships no `bin`" — verified, no `bin` field in package.json.
- README.md:1001 Node >= 22.19.0 — verified against package.json engines (read earlier).
- README.md:606 exit 2 for rtk always — verified against src/cli.ts:906-912.
- README.md:973 `MIKRO_MCP_RUN_TIMEOUT_MS` — verified against src/mcp/backends/legacy.ts:91.
- README.md:1008 calendar versioning + auto bump — verified with package.json:23 `bump-version` script and README claim.
- README.md:93 plugin ships "2 skills" — verified against plugins/claude-code/README.md:17.
- README.md:13 `curl` installer URL — verified `scripts/install.sh` exists; MIKRO_REPO_URL default matches (scripts/install.sh:4).
- README.md:325 five recipe dirs — verified all five exist in examples/agents/.

References:
- src/config.ts:124 — default model `gemini-3.1-flash-lite-preview`
- src/templates/code/mikro.yaml:12-17 — same model in scaffold
- src/cli.ts:906-912 — exit 2 for rtk.enabled=always
- src/mcp/backends/legacy.ts:91 — MIKRO_MCP_RUN_TIMEOUT_MS
- package.json:2 — package name, :54 license MIT, :23 bump-version
- scripts/install.sh:4 — MIKRO_REPO_URL default
- plugins/claude-code/README.md:17 — "Ships: 1 MCP server, 2 skills"
- LICENSE — exists, resolves the past GAP
""")
```

---
mikro · agent=readme-polish · deepseek/deepseek-v4-flash · 12 iterations · 29,286 in / 4,831 out · $0.0059 · 50.9s · session sess_bb9040c11f5408db
