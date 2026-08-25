# SPIKE — Omni Runner Port, Group 1: Approval-capture feasibility

**Question:** Can a stock Claude Code hook HOLD a permission request while an external
process resolves it, then return the decision — so remote approve/deny works without
running the agent through the claude-agent-sdk?

**Date:** 2026-07-02 · **Worker:** g1-spike · **CC version:** 2.1.198 (`claude`, arm64)

## Verdict: GO

A stock Claude Code hook **can** block synchronously while an external process
resolves an approval, and Claude Code **obeys** the returned decision. Proven live,
three ways, against real Claude Code. There is one important correction to the wish's
hypothesis about *which* event to use — see "Contract correction" — but it makes the
mechanism *stronger* (works headless AND interactive), not weaker.

> **NO-GO fallback (not needed, documented per acceptance criteria):** had this failed,
> the fallback was "remote approvals only for SDK-launched agents" — reviving v4's
> `claude-agent-sdk` `canUseTool` interception for agents genie launches itself, and
> accepting that stock interactive `claude` panes get local-only prompts. We do NOT
> need this fallback; stock hooks work.

---

## Contract correction — the wish's hypothesis was half-right

The wish assumed **PermissionRequest** returns `permissionDecision: allow|deny|ask`.
Reading the actual 2.1.198 binary (embedded zod schemas) plus live runs shows the
allow/deny/ask envelope belongs to **PreToolUse**, and the two events are distinct:

| | **PreToolUse** (use this) | **PermissionRequest** |
|---|---|---|
| Fires in headless `claude -p` | **Yes** (proven live) | **No** — never fired headless |
| Fires in interactive panes | Yes (binary has an explicit interactive-mode branch) | Yes (only when a dialog would appear) |
| Fires for | every matched tool call, pre-execution | only when approval is genuinely needed (not pre-allowlisted) |
| Output envelope | `hookSpecificOutput.permissionDecision: "allow"\|"deny"\|"ask"\|"defer"` | `hookSpecificOutput.decision.{behavior:"allow"\|"deny"}` (no `ask`) |
| Timeout / passthrough | emit `permissionDecision:"ask"` → normal flow | emit nothing → normal flow |

**Recommendation for Group 3: intercept on `PreToolUse`.** It is the universal,
headless-capable event, and its `permissionDecision` envelope is exactly what the wish
(and the WISH.md validation grep) already expects. `PermissionRequest` is interactive-only
and its envelope differs; supporting it is optional polish, not the core path.

Why PreToolUse is the right call for genie: v5 spawns agents both as headless one-shots
(`claude -p`, the omni inbound path — Group 4) and as interactive tmux panes. Only
PreToolUse covers **both**. Binary confirmation that PreToolUse runs interactively too:
the executable logs `"Hook … returned permissionDecision=defer in interactive mode;
ignoring (defer is print-mode only)"` — an interactive-mode PreToolUse branch that only
exists because these hooks fire there.

> Caveat surfaced by the spike: this machine's global `~/.claude/settings.json` sets
> `"defaultMode":"auto"`, which auto-approves everything so **no** permission event
> fires at all. Genie must launch approval-gated agents in `--permission-mode default`
> (not `auto`/`bypassPermissions`) or the whole feature is a no-op. All live runs below
> used `--permission-mode default`.

---

## Three-run live evidence

Harness: a scratch git repo at `/tmp/genie-spike-proj.*` with a project-local
`.claude/settings.json` wiring `PreToolUse` (matcher `Bash`) to
`spike/hook.sh`. The hook writes a pending row to a **scratch** sqlite file
(`.claude/run-approvals.db`, NOT genie.db), then polls. A second process
(`spike/wait-resolve.sh`, the simulated "phone") waits for the pending row to appear,
then writes the decision. Driver: `claude -p "<bash-requiring prompt>" --permission-mode default`.

### Run A — resolver ALLOWs before timeout → CC runs the tool
```
[hook 17:26:40] event=PreToolUse tool=Bash id=run-a cwd=/private/tmp/genie-spike-proj.55EzJz
[hook 17:26:40] tool_input={"command":"echo hello > proof_a.txt","description":"Write hello to proof_a.txt"}
[hook 17:26:40] enqueued pending row id=run-a; polling every 250ms for up to 20s
[hook 17:26:41] poll finished: status=approved
[hook 17:26:41] emitted PreToolUse permissionDecision=allow
resolver: wait-resolve: id=run-a decision=approved rows_changed=1 (WON)
```
CC result (elapsed 15s): model replied `DONE`; **`proof_a.txt` created, contents `hello`.**
→ Hook held the request, external process approved, `permissionDecision:"allow"` returned,
**tool executed.**

### Run B — resolver DENIEs → CC refuses the tool
```
[hook 17:27:08] event=PreToolUse tool=Bash id=run-b cwd=/private/tmp/genie-spike-proj.55EzJz
[hook 17:27:08] tool_input={"command":"echo hello > proof_b.txt",...}
[hook 17:27:08] enqueued pending row id=run-b; polling every 250ms for up to 20s
[hook 17:27:09] poll finished: status=denied
[hook 17:27:09] emitted PreToolUse permissionDecision=deny
resolver: wait-resolve: id=run-b decision=denied rows_changed=1 (WON)
```
CC result (elapsed 16s): model said *"The command was denied via remote approval, so
`proof_b.txt` was not created. I won't retry it"*; **`proof_b.txt` absent.**
→ `permissionDecision:"deny"` (plus `permissionDecisionReason`) blocked the tool; the
reason string surfaced to the model, and it did **not** retry.

### Run C — no resolver, hook hits its poll budget → `ask` → CC does NOT run the tool
```
[hook 17:27:43] event=PreToolUse tool=Bash id=run-c cwd=/private/tmp/genie-spike-proj.55EzJz
[hook 17:27:43] tool_input={"command":"echo hello > proof_c.txt",...}
[hook 17:27:43] enqueued pending row id=run-c; polling every 250ms for up to 6s
[hook 17:27:49] poll finished: status=timeout
[hook 17:27:49] emitted PreToolUse permissionDecision=ask (timeout fallback)
```
CC result (elapsed 26s): model said *"a PreToolUse hook intercepted the Bash call and
requested confirmation, which wasn't granted in this session, so `proof_c.txt` was not
created"*; **`proof_c.txt` absent**, approval row stayed `pending`.
→ On timeout the hook emits `permissionDecision:"ask"`, which forces the normal prompt.
Headless has no one to prompt, so the tool is refused — **never auto-allowed** (the
fail-safe from Decision 2). In an interactive pane the same `ask` yields the local
approval dialog.

**Synchronous-hold proof:** in a prior run the hook was configured with a 20s poll
budget and no resolver; the hook logged `enqueued … 17:25:21` then
`poll finished: status=timeout … 17:25:41` — exactly 20 seconds later — and CC's
completion did not arrive until after that. Claude Code genuinely **waits** for the hook.

### Interactive PermissionRequest — attempted, not landed (honest)
I also tried to drive a *real interactive* session through a PTY (`spike/pty_drive.py`)
to fire `PermissionRequest` and hold/resolve it the same way. The session launched and
reached the REPL, but reliably submitting the prefilled prompt into the Fable-5 TUI
(and its high-effort latency) was too flaky to produce a clean transcript in-budget — the
hook never fired because the prompt never submitted. This does **not** weaken the verdict:
the blocking mechanism is proven on the universal event (PreToolUse), and PermissionRequest
shares the identical synchronous hook executor — only the output envelope differs, and that
envelope is pinned from the binary schema below. Group 3 should standardize on PreToolUse
regardless, so this gap is immaterial.

---

## Exact contract Group 3 must implement

### Hook input (stdin JSON) — captured live from a real PreToolUse event
```json
{
  "session_id": "ef8679ab-18a1-49aa-9095-4dafae4feb63",
  "transcript_path": "/Users/.../<session>.jsonl",
  "cwd": "/private/tmp/genie-spike-proj.55EzJz",
  "prompt_id": "d7d73610-99d1-4aa4-874a-fa988f8a878b",
  "permission_mode": "default",
  "effort": { "level": "high" },
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "…", "description": "…" },
  "tool_use_id": "toolu_01TGHA5qrr3V4LjHRo98dfxw"
}
```
Fields Group 3's `approvals` row should capture: `tool_name`, a summary of `tool_input`,
`cwd` (→ repo), `session_id` + `prompt_id` + `tool_use_id` (correlation / idempotency),
`transcript_path` (optional context). `permission_mode` lets the handler no-op when it is
`auto`/`bypassPermissions` (no approval needed) — cheap guard.

### Hook output (stdout JSON) — literal envelopes, exit 0 in all cases

Allow:
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
```
Deny (reason is shown to the model; it did not retry):
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Denied via remote approval"}}
```
Timeout / phone unreachable → fall through to the normal local prompt (fail-safe, never auto-allow):
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}
```
The binary validates `permissionDecision` against exactly `allow | deny | ask | defer`
and **throws** on anything else (`Unknown hook permissionDecision type`). Do not invent
values. `defer` is print-mode-only (ignored, with a warning, in interactive mode and when
>1 tool call is in the batch) — use `ask`, not `defer`, for the timeout fallback so the
behavior is identical in both modes.

### PermissionRequest envelope (only if Group 3 later wants the interactive-surgical path)
From the 2.1.198 zod schema (`O3f`/`L3f`):
```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"…","interrupt":false}}}
```
`decision.behavior` is `allow|deny` only — there is **no** `ask`; to defer to the normal
dialog, emit no `decision`. Input adds `permission_suggestions` and omits nothing from the
PreToolUse base. `interrupt:true` aborts the whole turn (avoid for approvals).

### Exit-code semantics (both events)
- **exit 0** → parse stdout JSON; absent/empty → defer to normal flow.
- **exit 2** → blocking error; stdout JSON ignored, stderr becomes the message.
- **other non-zero** → non-blocking error; decision ignored, turn continues.
Group 3 must always `exit 0` and put the decision in stdout.

---

## Timing findings & budget

- **Max block:** the hook can block for the whole per-hook **`timeout`** window set in
  `settings.json`. Empirically a 20-second hold completed under `"timeout": 30`, and a
  6-second hold under a 30s timeout — so the `timeout` field is in **seconds** (30ms would
  have killed the 20s hold; it did not). CC's internal default is 600000 ms (= 600 s / 10
  min); the zod bound is `min 0 … max 600000`. **Set `timeout` explicitly** in the omni
  hook config; do not rely on the default.
- **On timeout:** CC cancels the hook process; with no emitted decision that means "defer
  to normal flow" — i.e. a local prompt (interactive) or refusal (headless). It never
  auto-allows. Our handler should **self-time-out first** and emit `ask`, rather than let
  CC kill it, so the behavior is explicit and logged.
- **Latency is pure polling** — the sqlite port has no `LISTEN/NOTIFY`. Observed
  resolution-to-decision latency was ≤ one **poll interval** (hook logged `approved` within
  ~1 s of the resolver writing, at a 250 ms interval).
- **Recommended budget:**
  - **poll interval:** 250–500 ms (250 ms proven; 500 ms is fine and lighter on sqlite).
  - **hook `timeout`:** size to the human SLA for answering a phone — e.g. **120 s**.
  - **poll budget (hook self-timeout):** `timeout` minus a safety margin, e.g. **110 s**
    for a 120 s `timeout`. The poll budget must be **strictly less than** the hook
    `timeout`; otherwise CC kills the hook mid-poll and you lose the explicit `ask`.
  - Expire the `pending` row (status → `expired`) when the hook self-times-out so the
    runner/phone stops trying to resolve a request the agent already abandoned.

## Risks

- **UI freeze — YES, by design.** Blocking the hook blocks that agent's turn synchronously
  for the whole hold. Headless: the run simply takes longer (proven — runs lasted as long
  as the hold). Interactive pane: the tool call sits pending (spinner) for the hold; that
  agent cannot proceed until the hook returns. This is acceptable for an approval gate (the
  agent *should* wait), but a long hold against an unreachable phone freezes that agent up
  to the poll budget — hence the bounded budget + `ask` fallback above. Scope of the freeze
  is **one tool call in one agent's turn**; other agents/panes are separate processes and
  unaffected.
- **`defaultMode:auto` makes approvals a silent no-op** — genie must launch approval-gated
  agents in `--permission-mode default`. Add an explicit check/doc in Group 3/5.
- **Batch tool calls:** if the model emits >1 tool call in one turn, `defer` is ignored;
  `ask`/`allow`/`deny` are unaffected. Not a concern for the `ask` fallback we chose.

## Files (throwaway prototype, under `spike/`)
- `hook.sh` — the PreToolUse/PermissionRequest hook: enqueue → poll (bounded) → emit envelope.
- `store.sh` — scratch sqlite `approvals` helpers (init/enqueue/status/resolve; clean stdout).
- `resolve.sh` / `wait-resolve.sh` — the simulated phone (resolve immediately / wait-for-row-then-resolve).
- `pty_drive.py` — interactive-session PTY harness (attempted PermissionRequest drive).
- `scratch-*.db|.log` — transient run artifacts (safe to delete).
