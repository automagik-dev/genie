# Forge API Integration Report
**Timestamp:** $(date -u '+%Y-%m-%d %H:%M:%S UTC')

## 1. Executor Profiles
- Endpoint: `GET /api/profiles`
- Action: Added variant `QA_CHECKLIST` under `OPENCODE` executor.
- Request:
  ```json
  PUT /api/profiles
  {
    "executors": {
      "...": "existing entries",
      "OPENCODE": {
        "DEFAULT": { "OPENCODE": { "append_prompt": null } },
        "QA_CHECKLIST": { "OPENCODE": { "append_prompt": null } }
      }
    }
  }
  ```
- Confirmation:
  ```json
  {
    "DEFAULT": { "OPENCODE": { "append_prompt": null } },
    "QA_CHECKLIST": { "OPENCODE": { "append_prompt": null } }
  }
  ```

## 2. Task Template Registration
- Endpoint: `POST /api/templates`
- Template ID: `5f224193-5dfd-4121-994a-2a94f9b77a89`
- Title: `Genie Wish: QA Codex Automation Checklist`
- Description sourced from `.genie/create/agents/wish.md` (full markdown stored in Forge template).
- Sample response:
  ```json
  {
    "id": "5f224193-5dfd-4121-994a-2a94f9b77a89",
    "template_name": "genie-wish-qa-codex",
    "title": "Genie Wish: QA Codex Automation Checklist",
    "project_id": null,
    "created_at": "2025-10-20T17:24:27.754Z"
  }
  ```

## Notes
- Executing `genie run --executor opencode --mode default` now passes `{ executor: "OPENCODE", variant: "DEFAULT" }` to Forge. Variant `QA_CHECKLIST` can be targeted via front-matter (`genie.executorProfile: QA_CHECKLIST`).
- Templates are global; future sync can iterate over `.genie/{code,create}/agents` and upsert template definitions per collective.
