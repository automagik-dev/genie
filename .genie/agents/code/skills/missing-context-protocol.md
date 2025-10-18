---
name: Genie Missing Context Protocol
description: Provide Files Needed block when critical context is missing
---

# Genie Missing Context Protocol

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
When critical technical context is missing (files, specs), provide a Files Needed block instead of speculative output.

## Files Needed (use when necessary)

```
status: files_required_to_continue
mandatory_instructions: <what is needed and why>
files_needed: [ path/or/folder, ... ]
```

Use only for technical implementation gaps, not for business/strategy questions.
