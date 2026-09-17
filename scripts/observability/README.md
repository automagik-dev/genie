# Claude Code observability (operator tooling)

Repo-local tooling that turns Claude Code session transcripts into Phoenix traces, scores each
session with code-computed friction and waste annotations, and feeds a weekly review that
**proposes** rule changes. Nothing here ships in the genie binary, the skills tree or a plugin.

```
backfill.ts    transcript (+ subagents) -> Phoenix spans in project cc-<repo>
annotate.ts    per-session CODE annotations, identifier code-annotator/v1
px-queries.sh  read-only Phoenix CLI (px) queries over the cc-* projects
../../.claude/workflows/observability-review.js   weekly, proposal-only review over those annotations
```

## Span tree

One trace per user turn, with deterministic ids (sha256 of the record uuids), so converting the
same transcript twice yields identical trace and span ids:

```
turn (CHAIN)
└─ skill:<name> (AGENT)            contiguous run of one attributionSkill inside the turn
   └─ <model> (LLM)                one per API response (records grouped by message.id)
      └─ <tool> (TOOL)             tool_use -> tool_result, ERROR on is_error
         └─ subagent:<type> (AGENT)  reconstructed from <session>/subagents/agent-*.jsonl
```

A bare skill name that genie ships is canonicalised to `genie:<name>`. The roster is derived from
`skills/*/SKILL.md` through `scanRepoSkills` (`scripts/skills-inventory-parity.ts`), never
hand-listed; `backfill.test.ts` pins it to the tree.

Content defaults to `--content metadata` (names, counts, tokens, the first token of a Bash command;
no prompt text, no tool arguments, no tool output). `head` and `full` add bounded, secret-scrubbed
text; `full` is refused against a non-loopback Phoenix without `PHOENIX_API_KEY`.

## Run

```bash
export PHOENIX_ENDPOINT=http://127.0.0.1:6006

# convert only, post nothing
bun scripts/observability/backfill.ts --dry-run <session.jsonl>

# ship one session and wait until Phoenix has stored all of it
bun scripts/observability/backfill.ts --incremental --verify <session.jsonl>

# rebuild a session from scratch
bun scripts/observability/backfill.ts --replace --batch 200 --pace-ms 250 --verify <session.jsonl>

# annotate sessions modified in the last 3 days (only after --verify reported them complete)
bun scripts/observability/annotate.ts --since 3

# ask Phoenix
scripts/observability/px-queries.sh cc-genie
```

The review runs as the saved workflow `observability-review` with
`{phoenix, rulesPath, projectPrefix?, since?, timestamp?}`. The endpoint, the rules file and the
cc-* project prefix always arrive through args.

Annotations: `polling_share`, `tool_error_rate`, `interrupts`, `max_context`, `compactions`,
`rework`, `waste_usd`, `total_usd`. The pricing table version rides in each annotation's metadata.

## Ingestion truths

These are the semantics every mode relies on. Each one was learned from a lost or rejected backfill.

1. **`POST /v1/projects/<project>/spans` returns 202 from an in-memory queue.** A 202 means queued,
   not stored: Phoenix inserts later, in bounded transactions. Counting stored spans right after a
   post reads as loss when it is only lag.
2. **A Phoenix restart discards that queue.** Anything accepted but not yet inserted is gone. Never
   restart Phoenix while the stored span count is still moving.
3. **A batch containing any already-known span id is rejected whole with 400.** Deterministic ids
   make re-runs safe only through `--incremental` (post only the ids Phoenix does not hold) or
   `--replace` (delete the session's stored traces first). A plain re-run skips a session that is
   already present.
4. **Postgres rejects NUL in text.** Binary-ish tool output carries NUL bytes, so the converter
   strips NUL from every string attribute, span name and status message before posting.
5. **A backfill is done only when the stored span count equals the expected count, per session.**
   `--verify` polls Phoenix until stored equals expected for every session it posted and exits 1
   on a shortfall after `--verify-timeout` seconds. Annotate only after that.
