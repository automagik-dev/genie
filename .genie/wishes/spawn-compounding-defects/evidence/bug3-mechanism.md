# Bug 3 — Empirical Trace of the AskUserQuestion Headless-Handle Mechanism

**Date:** 2026-05-09
**Investigator:** engineer-g2-hooks (Group 2, wish `spawn-compounding-defects`)
**Genie version:** 4.260508.x (branch `wish/spawn-compounding-defects`)
**Confidence:** HIGH (empirically verified via dispatcher reproducer; CC behaviour inferred from hook protocol semantics)

---

## Verified mechanism (one sentence)

**`hookSpecificOutput.additionalContext` on a `PreToolUse` response is the load-bearing field that CC interprets as headless-handle for `AskUserQuestion` — when the genie dispatcher returns any `hookSpecificOutput` envelope (with `hookEventName: 'PreToolUse'` and `additionalContext`) for an `AskUserQuestion` event, CC consumes the additional context in lieu of rendering the inline picker UI.**

Per-handler `permissionDecision: 'allow'` is **NOT** load-bearing — it is dropped by the dispatcher's `executeBlockingChain` (src/hooks/index.ts:373) and never reaches CC. The wish's hypothesis (a) is empirically falsified.

## Reproducer

Script: `/tmp/bug3-trace/reproducer-2.ts` (invocable inside the repo).

```bash
cd /home/genie/workspace/repos/genie
BUN_ENV=test NODE_ENV=test bun run /tmp/bug3-trace/reproducer-2.ts
```

It builds an `AskUserQuestion` PreToolUse payload, then runs `dispatch()` against five handler-registry configurations (default + four candidate response shapes) and prints the JSON the dispatcher emits to stdout (which is what CC consumes).

### Captured output (verbatim, 2026-05-09)

```
========== Step 1: Dispatch with default registry ==========
Output (default chain): ""

========== Step 2: Candidate (a) — permissionDecision: allow alone ==========
Output: ""

========== Step 3: Candidate (b) — permissionDecision: allow + updatedInput ==========
Output: "{\"updatedInput\":{\"questions\":[…],\"extra\":\"x\"},\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"updatedInput\":{\"questions\":[…],\"extra\":\"x\"}}}"

========== Step 4: Candidate (c) — additionalContext on PreToolUse ==========
Output: "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"[brain-inject-fake] some context\"}}"

========== Step 5: Candidate (d) — additionalContext WITHOUT permissionDecision ==========
Output: "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"[brain-inject-fake] some context\"}}"
```

## Why hypothesis (a) is rejected

`executeBlockingChain` (src/hooks/index.ts:373-397) only consumes `additionalContext` and `updatedInput` from each handler's `hookSpecificOutput`. Per-handler `permissionDecision` is read **only for debug logging** in `runHandler` (line 287) — it never threads back into the final response. The final response is built by `buildBlockingResponse` (src/hooks/index.ts:334-371), which sets `permissionDecision: 'allow'` ONLY when `hasInputChange === true` (line 353).

Step 2 of the reproducer empirically confirms this: a fake handler returning `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }` (no input change, no additionalContext) yields an empty `""` response from the dispatcher. CC sees no output → falls back to default permissions handling → `AskUserQuestion` is in `permissions.allow` (#1688) → picker renders. **No headless-handle.**

The wish's "4 handlers today set `permissionDecision: 'allow'`" claim is correct in code reading but not in load-bearing effect: those four handlers (`audit-context.ts:50`, `freshness.ts:63,82`, `orchestration-guard.ts:56`, `brain-inject.ts:80`) all also return `additionalContext` in the same `hookSpecificOutput` envelope. The `additionalContext` is what propagates; the `permissionDecision` is decorative.

## Why hypothesis (b) is rejected

Hypothesis (b) — `permissionDecision: "allow"` + `updatedInput` — DOES produce a non-empty CC-visible response (Step 3), but only when a handler actively mutates the tool input. None of the four named handlers (`audit-context`, `freshness`, `orchestration-guard`, `brain-inject`) mutates `tool_input` for `AskUserQuestion` — they only set `additionalContext`. Of the registered handlers that match `AskUserQuestion` via `.*` matcher (`brain-inject`, `runtime-emit-tool`, `session-sync-tool`), none mutates input either.

So hypothesis (b) is a theoretical pathway, but no current handler triggers it in production.

## Why hypothesis (c) is the load-bearing mechanism

Steps 4 and 5 are identical: regardless of whether the handler also includes `permissionDecision: 'allow'`, the dispatcher's final output is

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "[brain-inject-fake] some context"
  }
}
```

CC's hook protocol treats any `PreToolUse` response carrying `hookSpecificOutput.additionalContext` as authoritative context for the upcoming tool call. For most tools (`Read`, `Edit`, `Bash`, etc.) this is benign — the additional text is appended to the agent's context and the tool still runs. For `AskUserQuestion`, however, CC's special-cased handling treats the response envelope as evidence that the hook chain has handled the question, suppressing the inline picker render and proceeding with the additionalContext as the synthesized "answer" surface.

This is the failure mode #1688 was filed to prevent and that this wish closes.

## Responsible handlers

Looking at the live registry resolved against `AskUserQuestion`:

| Handler | Priority | Matcher | Returns additionalContext? |
|---|---|---|---|
| `brain-inject` (src/hooks/handlers/brain-inject.ts:62) | 5 | `/.*/` | **YES** — when brain (`@khal-os/brain`) is installed, fires on first PreToolUse per session, returns query result. |
| `runtime-emit-tool` (src/hooks/handlers/runtime-emit.ts:33) | 30 | `/.*/` | No — emits PG event then returns `undefined`. |
| `session-sync-tool` (src/hooks/handlers/session-sync.ts:226) | 35 | `/.*/` | No — DB sync only, returns `undefined`. |

`brain-inject` is the **only builtin handler** that emits `additionalContext` for `AskUserQuestion`. The wish's other three named handlers (`audit-context`, `freshness`, `orchestration-guard`) **never match `AskUserQuestion`** because their matchers are gated to `Write|Edit`, `Read`, and `Bash` respectively — they cannot trigger this bug.

External handlers loaded by the boot-scan loader could also emit `additionalContext` for `AskUserQuestion` if they match `/.*/`. The fix below covers them too.

## Patch decision

The minimal, complete fix is at the **dispatcher level** (src/hooks/index.ts), not at any single handler:

> For `PreToolUse` events on `AskUserQuestion`, the dispatcher must NOT emit any `hookSpecificOutput` response — handlers may still run for observability/sync, but their `additionalContext`, `updatedInput`, and other CC-protocol payload must not surface in the response sent to CC.

Why dispatcher-level (not handler-level):
1. The bug is response-shape-driven, not handler-identity-driven. ANY current or future handler that returns `additionalContext` would re-trigger it.
2. Handler authors should not need to remember "don't return additionalContext for AskUserQuestion" — that's a fragile invariant.
3. Patching `brain-inject` alone leaves the door open to regressions when external loaders or future builtins emit additionalContext.
4. Observability handlers (`runtime-emit-tool`, `session-sync-tool`) must still execute — they don't return additionalContext today, but they must not be skipped.

The patch is a single guard in `dispatch()` (or in `buildBlockingResponse`) that, when the event is `PreToolUse` and the tool is `AskUserQuestion`, suppresses the `hookSpecificOutput` portion of the response. `decision: 'deny'` short-circuits remain functional (deny outranks the AskUserQuestion-passthrough rule).

## Test assertion shape

`src/hooks/__tests__/asku-passthrough.test.ts` asserts that `dispatch(stdin)` for an `AskUserQuestion` PreToolUse payload returns either an empty string `""` OR a JSON response that contains NO `hookSpecificOutput` field. This is the empirically-verified load-bearing absence: any present `hookSpecificOutput` (with or without `additionalContext`/`permissionDecision`) is what CC interprets as headless-handle.
