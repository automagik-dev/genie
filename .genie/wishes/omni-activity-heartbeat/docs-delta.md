# Docs Delta — omni-activity-heartbeat

This file captures docs changes that live **outside** the wish worktree and
must be applied by the operator (the file lives in this server's
`agents/genie-configure/.claude/rules/`, not in either repo).

## Target

`/home/genie/workspace/agents/genie-configure/.claude/rules/omni-reference.md`

## Patch

In the **Event Types** table, append a new row at the bottom:

```diff
 | `agent.dispatched` | Agent invoked |
 | `agent.replied` | Agent responded |
+| `agent.heartbeat` | Genie publishes every ~30s while a Claude Code session is busy on `omni.agent.heartbeat.{instanceId}.{chatId}`. Omni resets `lastActivityAt` on receipt so the 120s nudge timer never trips for actively-working agents. Payload: `{ turnId, instanceId, chatId, timestamp }`. |
```

Immediately after the Event Types table (before the `## API` section), insert
this operational subsection:

```markdown
### Verifying heartbeats (debugging)

While a Claude Code agent is mid-turn, you should see one heartbeat per active
session every ~30s:

\```bash
nats sub 'omni.agent.heartbeat.>'
\```

If `omni events --type turn.nudge` shows nudges firing during real work, check
this stream first — silence here means the publisher is not running (older
genie client, executor crash, or `OMNI_HEARTBEAT_INTERVAL_MS=0`). A nudge at
~120s with zero heartbeats is the genuinely-idle path and is expected.
```

(Replace the escaped backticks `\``` with real triple backticks when applying.)

## Why this delta is staged here

The wish-omni-heartbeat worktree's permission policy blocks edits to
`/home/genie/workspace/agents/...` as scope escalation. The change is small
(one table row + one short subsection) and operator-applied so it does not
need to ship in either repo's PR.
