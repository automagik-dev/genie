# Output schema

The agent must emit a JSON payload shaped like:

```json
{
	"type": "object",
	"required": ["summary", "citations"],
	"properties": {
		"summary": { "type": "string" },
		"citations": {
			"type": "array",
			"items": {
				"type": "object",
				"required": ["url", "note"],
				"properties": {
					"url": { "type": "string" },
					"note": { "type": "string" }
				}
			}
		}
	}
}
```

`summary` is a single paragraph (~3-5 sentences). `citations` lists the
URLs consulted with a one-line note per citation. Emit an empty
citations array only when `summary === "insufficient evidence"`.
