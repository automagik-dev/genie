# Group 1 evidence — plugin skeleton + install (B1)

Host: this machine (Ryzen AI station), `~/prod/rlmx` on
`wish/rlmx-microagent-plugin`, 2026-07-27. Claude Code **2.1.220**
(`claude --version`).

Section 1 (format research) was written **before** any file under
`plugins/claude-code/` existed, per wish decision 7 and the Group 1
deliverable ordering. Sections 2–4 record what was then built and proved.

No secret appears in this file or in any file this group wrote.

---

## 1. Plugin format research (live docs, 2026-07-27)

Sources fetched today:

| # | URL | Used for |
|---|-----|----------|
| S1 | <https://code.claude.com/docs/en/plugins-reference> | manifest schema, component locations, `.mcp.json` shape, path variables, caching, CLI reference |
| S2 | <https://code.claude.com/docs/en/plugins> | plugin structure overview, `--plugin-dir` testing, skills layout |
| S3 | <https://code.claude.com/docs/en/plugin-marketplaces> | `marketplace.json` schema, relative-path plugin sources, local-directory install walkthrough |
| S4 | `claude plugin --help`, `claude plugin install --help`, `claude plugin marketplace add --help`, `claude plugin validate --help`, `claude plugin list --help` on 2.1.220 | the installed CLI's own contract, cross-checked against S1–S3 |

### 1.1 Manifest

- Location: **`.claude-plugin/plugin.json`** at the plugin root (S1,
  "File locations reference"). The manifest is *optional*; when omitted,
  components are auto-discovered in default locations and the plugin name
  is derived from the directory name.
- Only `name` is required. `name` is kebab-case and is the **namespace** for
  every component the plugin ships (S1, "Required fields").
- Verbatim from S1, "Complete schema":

  ```json
  {
    "name": "plugin-name",
    "displayName": "Plugin Name",
    "version": "1.2.0",
    "description": "Brief plugin description",
    "author": { "name": "Author Name", "email": "author@example.com", "url": "https://github.com/author" },
    "homepage": "https://docs.example.com/plugin",
    "repository": "https://github.com/author/plugin",
    "license": "MIT",
    "keywords": ["keyword1", "keyword2"],
    "skills": "./custom/skills/",
    "commands": ["./custom/commands/special.md"],
    "agents": ["./custom/agents/reviewer.md"],
    "hooks": "./config/hooks.json",
    "mcpServers": "./mcp-config.json",
    "outputStyles": "./styles/",
    "lspServers": "./.lsp.json",
    "experimental": { "themes": "./themes/", "monitors": "./monitors.json" },
    "dependencies": ["helper-lib", { "name": "secrets-vault", "version": "~2.1.0" }]
  }
  ```

- `version` is optional. Setting it pins the plugin to that string so users
  only receive updates when it is bumped; omitting it makes every git commit
  a new version (S1, "Metadata fields").
- **Warning carried over verbatim** (S2): "Don't put `commands/`, `agents/`,
  `skills/`, or `hooks/` inside the `.claude-plugin/` directory. Only
  `plugin.json` goes inside `.claude-plugin/`."

### 1.2 Bundled MCP servers

- Location: **`.mcp.json` at the plugin root**, or inline under
  `mcpServers` in `plugin.json` (S1, "MCP servers"). Format is standard MCP
  server configuration. Verbatim example from S1:

  ```json
  {
    "mcpServers": {
      "plugin-database": {
        "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
        "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
        "env": { "DB_PATH": "${CLAUDE_PLUGIN_ROOT}/data" }
      }
    }
  }
  ```

- Plugin MCP servers start automatically when the plugin is enabled.
- Scoped tool name for a plugin-bundled server is
  **`mcp__plugin_<plugin-name>_<server-name>__<tool>`** (S1, "Hooks" →
  "Hooks that target the plugin's own bundled MCP server must use its scoped
  names"). The MCP-level tool name the server itself advertises is unchanged.

### 1.3 The project-dir variable — it exists

This is the load-bearing finding for B1. S1, "Environment variables":

| Variable | Resolves to |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | Absolute path to the plugin's installation directory |
| `${CLAUDE_PLUGIN_DATA}` | Persistent directory that survives plugin updates |
| `${CLAUDE_PROJECT_DIR}` | **The project root** |

and, verbatim, the substitution matrix row that matters:

> | MCP `stdio` servers | `command`, `args`, `env` |

So `${CLAUDE_PROJECT_DIR}` **does** substitute inside an stdio MCP server's
`args`. The design's D10 `--dir` contract therefore has a first-class
expression in the plugin format, and the wish's fallback branch ("otherwise
document the fallback … Claude Code spawns stdio servers in the project cwd")
is **not** the path taken. The probe artifact
`.genie/brainstorms/rlmx-claude-plugin/probe-cwd-2026-07-26.md` (cwd = project
dir on 2.1.220) remains the *belt* under the `--dir` *braces*: it is what makes
the registration still correct if a future release changed variable handling,
and it is why nothing here depends on it.

### 1.4 Bundled skills

- Location: **`skills/<name>/SKILL.md`** at the plugin root (S1/S2). Skills
  are **auto-discovered**; there is no per-skill registration list in the
  manifest. S1, "Skills": "Skills and commands are automatically discovered
  when the plugin is installed."
- `SKILL.md` is YAML frontmatter + markdown body. `description` is the field
  Claude reads to decide when to use the skill (S2).
- Plugin skills are always namespaced: `/<plugin-name>:<skill-name>` (S2).
- Manifest `skills` is a **skill-root** field with *add* semantics, not
  *replace*: S1, "Path behavior rules" — "**Adds to the default**: `skills`.
  The default `skills/` directory is always scanned, and directories listed
  in `skills` are loaded alongside it." A path may point at a directory that
  contains `SKILL.md` directly, in which case the frontmatter `name` wins.

Consequence for the Group 1 deliverable "both skill entries pre-registered in
the manifest": in this format a literal per-skill manifest list is either a
no-op or a double-scan, because `skills/` is always scanned *in addition to*
anything listed. Both spellings were measured on this host before choosing —
see §3.1. The deliverable's stated purpose ("so Wave 2 groups only add skill
files and never edit the manifest concurrently") is met either way; §3.1
records which spelling was shipped and why.

### 1.5 Marketplace — the only install path that is an install

- `claude --plugin-dir <dir>` loads a plugin **for one session only** (S2).
  It is a development affordance, not an install, so it cannot satisfy
  "installs in one documented command … a *fresh* session sees the tool".
- A real install needs a marketplace. Location: **`.claude-plugin/marketplace.json`
  at the repository root** (S3, "Create the marketplace file"). Required
  fields: `name`, `owner`, `plugins`.
- A plugin entry needs `name` + `source`. A **relative path** source is
  supported and is the monorepo pattern (S3, "Relative paths"): "For plugins
  in the same repository, use a path starting with `./` … Paths resolve
  relative to the marketplace root, which is the directory containing
  `.claude-plugin/`."
- Local-directory add is supported and documented (S3, "Test locally before
  distribution"): `/plugin marketplace add ./my-marketplace`. The 2.1.220 CLI
  states the same: `claude plugin marketplace add <source>` — "Add a
  marketplace from a URL, path, or GitHub repo" (S4).
- Marketplace **names are global per user** (S3): "adding a second marketplace
  with the same name replaces the first." This host already has marketplaces
  named `automagik`, `brain`, `camofox`, `alexgreensh-token-optimizer`,
  `claude-plugins-official` (`claude plugin marketplace list`). `rlmx` is free,
  and using `automagik` would have silently replaced the user's genie
  marketplace. Marketplace name = `rlmx`.
- Reserved names (S3) do not include `rlmx`.

### 1.6 Caching — why the plugin cannot reach the repo it ships in

S1, "Plugin caching and file resolution": marketplace plugins are **copied**
into `~/.claude/plugins/cache`, and "Installed plugins cannot reference files
outside their directory. Paths that traverse outside the plugin root (such as
`../shared-utils`) will not work after installation."

So `plugins/claude-code/.mcp.json` **cannot** point at `../../dist/src/cli.js`.
The MCP `command` must be a name resolved on `PATH` — `rlmx` — which is exactly
what `scripts/install.sh` provides (`ln -sfn "$RLMX_INSTALL_DIR/dist/src/cli.js"
"$RLMX_BIN_DIR/rlmx"`, default `~/.local/bin/rlmx`). This makes the rlmx CLI a
documented **prerequisite** of the plugin rather than something the plugin can
bundle, and it is why the README leads with `scripts/install.sh`.

### 1.7 CLI surface used (2.1.220, from `--help`, S4)

```
claude plugin marketplace add <source> [--scope user|project|local] [--sparse <paths...>]
claude plugin install <plugin>[@<marketplace>] [-s|--scope user|project|local]
claude plugin list [--json] [--available]
claude plugin details <name>
claude plugin validate <path> [--strict]
claude plugin uninstall <plugin>
```

`claude plugin install` takes a plugin **name**, not a path — there is no
single CLI verb that registers a local marketplace and installs from it in one
call. See §3.3 for how "one documented command" is honoured, and its limit.

---

## 2. What was built

```
.claude-plugin/marketplace.json                      (new — repo root = marketplace root)
plugins/claude-code/.claude-plugin/plugin.json       (new — manifest)
plugins/claude-code/.mcp.json                        (new — rlmx mcp --dir ${CLAUDE_PROJECT_DIR})
plugins/claude-code/skills/offload-guidance/SKILL.md (new — placeholder, Group 2 owns content)
plugins/claude-code/skills/microagent-create/SKILL.md(new — placeholder, Group 3 owns content)
plugins/claude-code/README.md                        (new — install path)
CHANGELOG.md                                         (modified — [Unreleased] ### plugin)
```

Names: plugin `rlmx`, marketplace `rlmx`, MCP server key `rlmx`, install id
`rlmx@rlmx`, skills `/rlmx:offload-guidance` and `/rlmx:microagent-create`,
scoped MCP tools `mcp__plugin_rlmx_rlmx__<tool>`.

The `.mcp.json` entry, verbatim:

```json
{
  "mcpServers": {
    "rlmx": {
      "command": "rlmx",
      "args": ["mcp", "--dir", "${CLAUDE_PROJECT_DIR}"]
    }
  }
}
```

`--dir` is parsed at `src/cli.ts:1039-1054`: it is validated as an existing
directory and `process.chdir`-ed into before `runMcp()`, which is what makes
agent discovery (`~/.rlmx/agents`, `<cwd>/.agents`, `<cwd>/.rlmx/agents` —
`src/mcp/agents.ts:1-18`) resolve against the user's project rather than
against whatever directory the host happened to spawn the server from.

---

## 3. Measurements on this host

All outputs below are verbatim.

### 3.0 Both manifests validate, including `--strict`

```
$ claude plugin validate ./plugins/claude-code --strict
Validating plugin manifest: /home/namastex/prod/rlmx/plugins/claude-code/.claude-plugin/plugin.json

✔ Validation passed

$ claude plugin validate . --strict
Validating marketplace manifest: /home/namastex/prod/rlmx/.claude-plugin/marketplace.json

✔ Validation passed
```

### 3.1 The `skills` manifest spelling — measured, not assumed

§1.4 left one question open: with `skills/` always scanned, does *also* naming
both skills in the manifest duplicate them? Measured by installing the plugin
twice, once per spelling, and reading `claude plugin details rlmx`.

**Spelling A — no `skills` key** (auto-discovery only):

```
Component inventory
  Skills (2)  microagent-create, offload-guidance
  Agents (0)
  Hooks (0)
  MCP servers (1)  rlmx  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~209 tok   added to every session
```

**Spelling B — `"skills": ["./skills/offload-guidance", "./skills/microagent-create"]`**
(each path a directory containing `SKILL.md` directly, the form S1's path rules
permit):

```
Component inventory
  Skills (2)  microagent-create, offload-guidance
  Agents (0)
  Hooks (0)
  MCP servers (1)  rlmx  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~209 tok   added to every session
```

**Byte-identical inventories and identical token cost — no duplication.** So on
2.1.220 the explicit list is a measured no-op, and `--strict` accepts it.
Spelling B ships: it costs nothing, and it makes the Wave 2 concurrency
contract self-evident in the file that would otherwise be the contended one —
the manifest already names both skills, so neither Group 2 nor Group 3 has any
reason to open it. The auto-discovery in Spelling A is the safety net
underneath: if a manifest path ever went stale, `skills/` is still scanned.

### 3.2 Install, on this host, from this clone

```
$ claude plugin marketplace add /home/namastex/prod/rlmx
Adding marketplace…✔ Successfully added marketplace: rlmx (declared in user settings)

$ claude plugin install rlmx@rlmx
Installing plugin "rlmx@rlmx"...✔ Successfully installed plugin: rlmx@rlmx (scope: user)

$ claude plugin list
  ❯ rlmx@rlmx
    Version: 0.1.0
    Scope: user
    Status: ✔ enabled
```

Everything in §3.2–§3.4 was re-run end to end against the **final** tree after
the last edit (uninstall → clear cache → `marketplace update` → install), so no
capture here describes an intermediate state.

The cache copy confirms §1.6 — five files, nothing from the repository around
them, and in particular no `dist/`:

```
$ find ~/.claude/plugins/cache/rlmx -type f | sort
/home/namastex/.claude/plugins/cache/rlmx/rlmx/0.1.0/.claude-plugin/plugin.json
/home/namastex/.claude/plugins/cache/rlmx/rlmx/0.1.0/.mcp.json
/home/namastex/.claude/plugins/cache/rlmx/rlmx/0.1.0/README.md
/home/namastex/.claude/plugins/cache/rlmx/rlmx/0.1.0/skills/microagent-create/SKILL.md
/home/namastex/.claude/plugins/cache/rlmx/rlmx/0.1.0/skills/offload-guidance/SKILL.md
```

The repo-root `.claude-plugin/marketplace.json` is *not* in that list: it stays
in the clone, which is what makes the clone the marketplace rather than part of
the plugin.

The CLI prerequisite was satisfied the way the README documents it —
`~/.local/bin/rlmx` symlinked at the clone's `dist/src/cli.js`, which is what
`scripts/install.sh` does:

```
$ rlmx --version
rlmx v0.260725.1
```

### 3.3 `${CLAUDE_PROJECT_DIR}` resolves — the B1 proof

Proof workspace, containing exactly one project microagent:

```
$ find $W -type f | sort
…/proof-workspace/.rlmx/agents/explore-r/SYSTEM.md
…/proof-workspace/.rlmx/agents/explore-r/agent.yaml
```

`claude mcp list`, run from inside it:

```
$ cd $W && claude mcp list
Checking MCP server health…

claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:genie:genie: node /home/namastex/.genie/plugins/genie/scripts/mcp-launcher.cjs - ✔ Connected
plugin:brain-khortex:brain-khortex: bash -lc exec "$HOME/.brain/bin/brain-khortex-mcp" - ✔ Connected
plugin:rlmx:rlmx: rlmx mcp --dir /tmp/claude-1000/-home-namastex-workspace/2cbc9745-3e7e-4191-b818-43ee1074af44/scratchpad/proof-workspace - ✔ Connected
plugin:camofox:camofox: /usr/bin/camofox-mcp  - ✔ Connected
rlmx: node /home/namastex/prod/rlmx/dist/src/cli.js mcp - ✔ Connected
```

The `plugin:rlmx:rlmx` line is the whole finding: the variable substituted to
the session's project directory, and the server connected. This is measured
behaviour on 2.1.220, not a doc claim.

(The last line, `rlmx: node …/cli.js mcp`, is the user's pre-existing
user-scoped registration from the 2026-07-26 cwd probe. It is *not* the
plugin's, it carries no `--dir`, and nothing in this group depends on it. It
does incidentally re-confirm the probe artifact: it still reaches the workspace
agents through cwd alone.)

### 3.4 A fresh session lists `rlmx_explore-r`

Headless session, fresh, run in the proof workspace:

```
$ cd $W && claude -p "Do not use any tool. List, one per line and nothing else, \
    the exact names of every tool available to you whose name contains 'rlmx'." --model sonnet
mcp__plugin_rlmx_rlmx__rlmx_changelog
mcp__plugin_rlmx_rlmx__rlmx_codebase-qa
mcp__plugin_rlmx_rlmx__rlmx_explore-r
mcp__plugin_rlmx_rlmx__rlmx_log-triage
mcp__plugin_rlmx_rlmx__rlmx_query
mcp__rlmx__rlmx_changelog
mcp__rlmx__rlmx_codebase-qa
mcp__rlmx__rlmx_explore-r
mcp__rlmx__rlmx_log-triage
mcp__rlmx__rlmx_query
```

`mcp__plugin_rlmx_rlmx__rlmx_explore-r` is the plugin's registration exposing
`rlmx_explore-r`; the `mcp__rlmx__*` block is the pre-existing bare server. The
`mcp__plugin_<plugin>_<server>__` prefix is exactly the scoped-name rule from
§1.2, so the two are never confusable.

`changelog`, `codebase-qa` and `log-triage` come from this host's
`~/.rlmx/agents/` (global root). Only `explore-r` comes from the workspace.

### 3.5 A/B control — `--dir` is what carries workspace discovery

Speaking MCP directly to the exact command the plugin registers, from a client
cwd of `/` so cwd cannot be the explanation. Only the `--dir` value differs:

```
### A: --dir = the proof workspace
rlmx mcp: 4 microagents discovered (changelog, codebase-qa, explore-r, log-triage)
server: {"name":"rlmx","version":"0.260725.1"}
cwd of client: /
tool: rlmx_query
tool: rlmx_changelog
tool: rlmx_codebase-qa
tool: rlmx_explore-r
tool: rlmx_log-triage

### B: --dir = an empty directory (control)
rlmx mcp: 3 microagents discovered (changelog, codebase-qa, log-triage)
server: {"name":"rlmx","version":"0.260725.1"}
cwd of client: /
tool: rlmx_query
tool: rlmx_changelog
tool: rlmx_codebase-qa
tool: rlmx_log-triage
```

`rlmx_explore-r` appears in A and not in B, with everything else held fixed.
The three global agents appear in both. So the workspace tool is attributable
to `--dir` and to nothing else.

Client used: `tools-list.mjs` in the session scratchpad (throwaway; ~40 lines
of `initialize` + `tools/list` over stdio). It is not committed — the committed
regression floor for this behaviour is `scripts/smoke-mcp.mjs`, which already
asserts it (`✓ --dir workspace discovered (.rlmx/agents/smoke-echo →
rlmx_smoke-echo)`).

### 3.6 Regression floor

```
$ npm run check
> tsc --noEmit
CHECK_EXIT=0

$ npm run build
BUILD_EXIT=0

$ test -f plugins/claude-code/README.md && echo "README present: OK"
README present: OK

$ npm test
# tests 517
# suites 118
# pass 517
# fail 0
# cancelled 0
# skipped 0
# todo 0

$ node scripts/smoke-mcp.mjs
SMOKE PASS: handshake + --dir workspace + Agent-tool schema + live refresh (create/delete + list_changed) + sessions (resume, busy, cross-tool) + error isolation all verified.
SMOKE_EXIT=0

$ npm audit --omit=dev
found 0 vulnerabilities
```

Frozen paths untouched:

```
$ git status --short -- .genie/wishes/rlmx-explore-offload/tasks/ \
                        .genie/wishes/rlmx-explore-offload/parity/runs/
(no output)
```

---

## 4. Acceptance criteria

**AC1 — "Install command from README works on this host from the repo clone."
MET.** §3.2. `claude plugin marketplace add <clone> && claude plugin install
rlmx@rlmx`, both succeeding, plugin listed `✔ enabled` at version 0.1.0. No npm
anywhere in the path.

*Stated limit, not hidden:* this is **one copy-paste line, two CLI verbs.**
2.1.220 has no single command that registers a local marketplace and installs
from it — `claude plugin install` takes a plugin name and never a path (§1.7).
The README says so in as many words rather than calling a chained line "one
command" and leaving the reader to discover otherwise.

**AC2 — "Fresh Claude Code session lists `rlmx_explore-r`." MET.** §3.4 is a
real fresh session in a workspace whose only project agent is `explore-r`,
naming `mcp__plugin_rlmx_rlmx__rlmx_explore-r`. §3.3 shows the plugin's own
registration resolved to `rlmx mcp --dir <that workspace>` and connected. §3.5
is the A/B control proving the workspace tool is attributable to `--dir`.

**AC3 — "Plugin format claims match the researched docs (links recorded)."
MET.** §1, written before any plugin file existed, with the four sources
tabulated and the load-bearing passages quoted verbatim. Every format claim in
`plugins/claude-code/README.md` and in the CHANGELOG `### plugin` entry maps to
a numbered subsection here, and the three that could have been taken on trust
were measured instead: the `skills` spelling (§3.1), `${CLAUDE_PROJECT_DIR}`
substitution (§3.3), and the cache's path-traversal limit (§3.2).

### Numbers in user-facing text, traced

The README's "Honest positioning" section is the only place this group states a
measured number. Each traces to `docs/parity-explore.md` at that report's own
scoping, and none is rounded up:

| Claim in README | Report anchor | Note |
|---|---|---|
| out-of-sample coverage **0.714** (10/14) on the holdout | `docs/parity-explore.md:1047` | the report's word for the holdout is "run once, after the recipe and model were chosen, never fed back" |
| **0.853–0.912** on the fitness set, "a real drop of 0.14–0.20" | `docs/parity-explore.md:1047-1048` | quoted as in-sample, never merged with the holdout figure |
| "215 citations, zero unresolvable, zero fabricated" | `docs/parity-explore.md:827-828` | scoped **to the frozen configuration only** |
| earlier rounds fabricated | `docs/parity-explore.md:426-427` | the haiku run that burned 24 iterations and cited `src/lib/providers.ts:9`, which does not exist |
| the verification block is what fixed it | `docs/parity-explore.md:685` | "fabrications fell sharply wherever it ran" |
| **1,077×** aggregate, **530×–1,835×** per task, **$0.22** — frozen configuration | `docs/parity-explore.md:960-970` | the frozen shot's own total row (line 968) |
| 921× for $0.14 — `r15-flash-control`, named as a different, non-shipping configuration | `docs/parity-explore.md:554-562` | round 1's control-round total row (line 562) |
| "It still buys an answer that fails the quality bar, which is why this column was never allowed to be the gate." | `docs/parity-explore.md:972-974` | quoted, so the cost number never travels alone |
| four generations evaluated, a fifth rejected, and why | `docs/parity-explore.md:1049-1055` | gen-4: "four training anchoring terms sit verbatim in its own prompt" |
| recursion product fixes = `6ec4822` | `git log -1 6ec4822` → *"fix(recursion): child model pinning, rlm_query model arg, loud child failure"* | product fixes live in git, not in the report |

**On the token number — a mis-scoping this pass caught in its own draft.** The
wish text says "~1000× premium-token reduction". The report has **two**
aggregate ratios, and they belong to different configurations:

- **921×, $0.14** — round 1's `r15-flash-control` (line 562). Not what ships.
- **1,077×, $0.22** — the frozen shot, i.e. the recursion configuration
  `explore-r` actually is (line 968). The report puts them side by side itself:
  *"1,077× against round 1's 921×, for 22 cents"* (line 970).

The first README draft cited 921× on the reasoning that it is the lower, more
conservative figure. That was wrong for a reason worth recording: every other
claim in the same paragraph (215 citations, zero fabricated) is scoped to the
**frozen shot**, so pairing them with a control round's economics attributes
one configuration's cost profile to another. Conservatism is not a licence to
mis-scope. The README now carries **1,077× for the frozen configuration** and
names 921× explicitly as the other round's, non-shipping.

Neither figure is rounded, in either direction: "~1000×" is not used.

---

## 5. Deviations

1. **`.claude-plugin/marketplace.json` at the repository root is a new file the
   wish's Files list does not name.** It is unavoidable: without a marketplace
   there is no install, only `claude --plugin-dir`, which lasts one session
   (§1.5) and cannot satisfy "a *fresh* session sees the tool". Repository root
   rather than under `plugins/` because relative plugin sources resolve from
   the marketplace root, and root is what makes the eventual public one-liner
   `claude plugin marketplace add automagik-dev/rlmx` work unchanged. It is
   disjoint from every other group's files. `package.json` `files` is an
   allowlist that excludes both new directories, so npm packaging is unaffected.

2. **"MCP server entry running `rlmx mcp --dir` against the project dir (use
   the format's variable if it exists; otherwise document the fallback)" — the
   variable exists, so the fallback branch is not taken.** `${CLAUDE_PROJECT_DIR}`
   substitutes into stdio `args` (§1.3) and was measured doing so (§3.3). The
   cwd probe (`.genie/brainstorms/rlmx-claude-plugin/probe-cwd-2026-07-26.md`)
   is recorded here as corroboration only; nothing depends on it.

3. **"Both skill entries pre-registered in the manifest" is honoured, but the
   format does not need it.** Skills are auto-discovered from `skills/`; the
   manifest `skills` key *adds to* that scan rather than replacing it (§1.4).
   Measured, the explicit list changes nothing (§3.1). It ships anyway, because
   the deliverable's stated purpose is that Wave 2 never opens the manifest, and
   a manifest that already names both skills is the clearest possible statement
   of that.

4. **The CHANGELOG's existing `### explore microagent` entry ends "Wish B
   (`rlmx-microagent-plugin`) does not start."** — written before the design's
   Amendment 2026-07-27. It is another group's text and was **not edited**. The
   new `### plugin` entry resolves the contradiction from its own side: it
   states that `Gate: FAIL` stands and that the plugin ships `explore-r` as a
   first-pass explorer under the amendment, making no parity claim. Flagged for
   whoever owns that section.

5. **Host state changed, deliberately and reversibly.** `~/.local/bin/rlmx` now
   symlinks the clone's `dist/src/cli.js` (what `scripts/install.sh` does), and
   marketplace `rlmx` + plugin `rlmx@rlmx` are installed at user scope. Both
   were required to prove AC1/AC2 on this host. Undo:
   `claude plugin uninstall rlmx && claude plugin marketplace remove rlmx`.
