# Call-Site Inventory — Salvaged from Pre-Council Audit

> Source: pre-council audit (worktree `simplifier-council`, commit `524b10a8`, deleted). Strategy column rewritten to match the council-approved wish (drop `agents.claude_session_id`, single `getResumeSessionId(agentId)` reader joining via `agents.current_executor_id → executors.claude_session_id`, delete name-based resume entirely).
>
> File:line references verified against `repos/genie/src/**` at the time of audit. Spot-check before edits.

## 1. Resume emissions and consumers (23 sites)

Legend for **Today**:
- **Y** — value is a human name (team/agent/window) — must be deleted.
- **N** — value is already a UUID (`claudeSessionId` / executor session id).
- **Mixed** — caller accepts either; needs to be tightened to UUID-only.

| # | File:Line | Today's emission/use | Source of value | Today | Action under wish v2 |
|---|-----------|----------------------|-----------------|-------|----------------------|
| 1 | `lib/team-lead-command.ts:68-69` | `--resume <continueName>` | `options.continueName` | Y | **Delete** `continueName` param + `--resume` emission. Caller passes UUID via different param or none. (Group 4) |
| 2 | `lib/team-lead-command.ts:25-26` | type `continueName?: string` | — | Y | **Delete** field from interface. (Group 4) |
| 3 | `lib/spawn-command.ts:89-92` | `--resume <options.resume>` | `options.resume` | N | **Keep**; value source becomes `getResumeSessionId(agentId)`. (Group 3) |
| 4 | `lib/spawn-command.ts:31-36` | type `resume?: string` | — | N | **Keep** as-is (no rename). (Out of scope) |
| 5 | `lib/provider-adapters.ts:347` | `parts.push('--resume', params.resume)` | `params.resume` | N | **Keep**; UUID-by-caller-contract. (No change) |
| 6 | `lib/provider-adapters.ts:72, 141` | JSDoc + `resume: z.string().optional()` | — | N | **Keep**; no Zod UUID validator (OUT scope). |
| 7 | `lib/providers/app-pty.ts:221` | `resume: ctx.claudeSessionId` | UUID | N | **Keep** — but `ctx.claudeSessionId` source must come from `getResumeSessionId`, not `agents.claude_session_id`. (Group 3) |
| 8 | `lib/providers/claude-code.ts:208` | `resume: ctx.claudeSessionId` | UUID | N | Same as #7. (Group 3) |
| 9 | `services/executors/claude-sdk.ts:481` | `extraOptions.resume = state.claudeSessionId` | UUID from executor state | N | **Keep**. (No change) |
| 10 | `term-commands/agents.ts:975-1011` | `WHERE s.id = $1 OR s.claude_session_id = $1` (accepts agent name **OR** UUID) | `runtimeExtraOptions.resume` | Mixed | **Remove the OR branch**. Accept UUID only; throw `MissingResumeSessionError` if not. (Group 6) |
| 11 | `term-commands/agents.ts:1569` | `extra.resume = options.sdkResume` | CLI `--sdk-resume` | N | **Keep**. (No change) |
| 12 | `term-commands/agents.ts:1921` | `resume: agent.claudeSessionId!` (force-unwrap) | `agents.claude_session_id` column | N (but unsafe) | **Replace** with `await getResumeSessionId(agent.id)` — and remove the `!`. (Group 3) |
| 13 | `term-commands/agents.ts:2037` | spawn rebuild for respawn | uses #12 | N | Auto-fixed by #12. (Group 3) |
| 14 | `lib/protocol-router.ts:160, 176, 212-216` | `resumeSessionId` param | worker registry / suspended worker state | N | **Replace** lookup at `:213` with `await getResumeSessionId(workerId)`. (Group 3) |
| 15 | `lib/protocol-router-spawn.ts:53-66, 214, 264-321` | passthrough | from #14 | N | Audit caller paths; ensure no name leaks in. (Group 3) |
| 16 | `genie.ts:144` | `continueName: hasPriorSession ? name : undefined` | name string | Y | **Replace** with `resumeSessionId: hasPriorSession ? await getResumeSessionId(teamLeadAgentId) : undefined`. (Group 4/5) |
| 17 | `genie-commands/session.ts:102-113` | function takes `continueName?: string` | caller name | Y | **Delete** param. Callers compute UUID upstream. (Group 4) |
| 18 | `genie-commands/session.ts:253-257` | `sanitizeTeamName(windowName)` → `--resume '<name>'` | window name | Y | **Delete** name-based path. Use `getResumeSessionId(teamLeadAgentId)` instead. (Group 5) |
| 19 | `genie-commands/session.ts:297-301` | same pattern, second site | window name | Y | Same as #18. (Group 5) |
| 20 | `genie-commands/session.ts:503-505` | same pattern, third site (resume helper) | window name | Y | Same as #18. (Group 5) |
| 21 | `lib/team-auto-spawn.ts:156, 184` | `continueName: sanitizeTeamName(teamName)` when `shouldResume` | UUID **already in hand** as `sessionId`, but **discarded** | Y (logic bug) | **Standalone bug fix.** UUID is resolved by `resolveOrMintLeadSessionId` but the branch throws it away. Even pre-deletion of name-based resume, this is wrong. (Group 4 — call out explicitly) |
| 22 | `hooks/handlers/auto-spawn.ts:46` | comment only | — | N | No code change. |
| 23 | `lib/claude-native-teams.ts:303` | doc-comment `--resume <teamName>` | — | Y (stale doc) | **Auto-resolved**: the entire `resolveOrMintLeadSessionId` + JSONL scan (~200 LoC at `:222-499`) is deleted in Group 4. Comment vanishes with it. |

### Sites that are NOT resume emissions (context only)
- `lib/agent-registry.ts:111` — `auto_resume` column (boolean, orthogonal).
- `lib/executor-registry.ts:223` — JSDoc about lazy resume (reads executors).
- `lib/pg-seed.ts:130` — seeds `auto_resume` boolean.
- `term-commands/agents.ts:1531, 1820, 2145` — UI strings / comments about resume lifecycle.

## 2. Tests asserting name-based `--resume` strings

These test the wrong contract; rewrite under Group 4:

| File:Line | Current assertion | Action |
|-----------|-------------------|--------|
| `genie-commands/__tests__/session.test.ts:78` | `not.toContain('--resume')` | **Keep** — negative assertion still valid. |
| `genie-commands/__tests__/session.test.ts:81-83` | undefined `continueName` → no `--resume` | Drop param entirely; assertion still valid. |
| `genie-commands/__tests__/session.test.ts:86-88` | `--resume 'my-team'` | **Rewrite** — assert UUID-shaped resume from seeded executor row. |
| `lib/team-lead-command.test.ts:141-143` | omits `--resume` when undefined | Drop param; assertion still valid. |
| `lib/team-lead-command.test.ts:147-149` | `--resume 'test-team'` | **Rewrite** — pass UUID; assert UUID. |
| `lib/team-lead-command.test.ts:153-156` | `--resume and --name can have same value` | **Delete or rewrite** — semantics changed; `--name` stays a name, `--resume` is always UUID. |
| `lib/team-lead-command.test.ts:159-162` | `sessionId takes precedence when no continueName` | Drop `continueName`; assert UUID precedence rules. |
| `term-commands/msg.test.ts:255-258` | `buildTeamLeadCommand('genie', { continueName: 'genie' })` | **Rewrite** — drop `continueName`, pass UUID. |
| `lib/spawn-command.test.ts:81-82` | `{ resume: 'abc-123' }` → `--resume 'abc-123'` | **Keep** — value is already UUID-shaped; field name stays `resume`. |
| `lib/spawn-command.test.ts:117` | `resume: 'resume-value'` fixture | **Keep**. |
| `lib/providers/claude-code.test.ts:206-209` | produces `--resume` | Verify fixture uses UUID-shaped `ctx.claudeSessionId`. |
| `__tests__/resume.test.ts:109-232` | manual/auto-resume flow tests | **Add** "missing-session → typed error" case (Group 6); ensure spawn params pull UUID via `getResumeSessionId`. |
| `lib/protocol-router.test.ts:61` | mock `spawnWorkerFromTemplate(template, _resumeSessionId?)` | **Keep** — already UUID-typed. |

## 3. Summary

- Total emission sites: **23**
- Name-based to delete: **9** (#1, #2, #16, #17, #18, #19, #20, #21, #23)
- Mixed (UUID-only after fix): **1** (#10)
- Already UUID, keep: **13**
- Tests requiring rewrites: **6 positive assertions**

## 4. Standalone bug callout

**Row #21 (`team-auto-spawn.ts:156, 184`):** `resolveOrMintLeadSessionId` returns `{ sessionId, shouldResume }`. When `shouldResume=true`, the code passes `continueName: sanitizeTeamName(teamName)` to the spawn — discarding the resolved UUID and substituting a name. Even if name-based resume worked, this branch is silently dropping the correct value. Group 4 must explicitly fix this when deleting `resolveOrMintLeadSessionId`: extract `sessionId` first, pass it forward, then delete the resolver.
