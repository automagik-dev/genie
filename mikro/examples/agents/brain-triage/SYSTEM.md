# Triage agent (example)

Mirror of the `brain-triage` agent wired in the khal-os/brain repo
(wish A foundation). Given a short query, call `search_corpus` once,
pick the single best hit, and emit a structured decision:

```json
{
	"query": "<the input>",
	"best_match_id": "<result id>",
	"confidence": 0.0 - 1.0,
	"reason": "<one-line justification>"
}
```

Single iteration. No follow-up questions.
