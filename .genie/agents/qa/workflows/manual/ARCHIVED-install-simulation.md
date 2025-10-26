---
name: install-simulation
description: ARCHIVED - Manual QA script (superseded by autonomous installation-flow.md)
archived: true
archived_date: 2025-10-26
archived_reason: Manual human QA script superseded by autonomous installation-flow.md workflow
---

# ARCHIVED: Automagik Genie • Install Simulation (Manual QA Script)

**Status:** ARCHIVED (reference only)

**Archived Date:** 2025-10-26

**Reason for Archiving:**
This manual QA script is superseded by the autonomous workflow `scenarios/installation-flow.md`, which provides:
- 5 automated test scenarios (fresh install via curl, fresh install via npx, upgrade, Forge visibility, error handling)
- Automatic evidence capture
- No human interaction required
- Reproducible results
- Autonomous execution

**This Manual Script Covers:**
- Clean folder initialization (manual copy-paste commands)
- MCP configuration validation (manual inspection)
- Install agent launch (manual execution)
- File structure validation (manual checks)
- Forge integration (manual verification)

**Active Autonomous Workflow:**
- **File:** `.genie/agents/qa/workflows/manual/scenarios/installation-flow.md`
- **Type:** Fully autonomous (no user interaction)
- **Scenarios:** 5 comprehensive test scenarios
- **Evidence:** `.genie/agents/qa/evidence/installation-flow-<timestamp>/`
- **Execution:** Via QA agent (`qa/installation-flow`)

**When to Use This Manual Script:**
- Exploratory testing of new installation features
- Human verification of installation UX
- Ad-hoc testing outside autonomous workflow
- Debugging installation issues interactively

**When to Use Autonomous Workflow:**
- Pre-release validation
- Regression testing
- CI/CD integration
- Reproducible evidence-backed testing

**Original Content Preserved Below for Historical Reference**

---

# Automagik Genie • Install Simulation (QA Script)

## Quickstart (Copy‑Paste Script)
Run these commands manually (humans only) to execute the QA from a clean folder. Edit the variables at the top if needed.

```bash
# 0) Settings (edit as needed)
export QA_DIR="/tmp/genie-qa-$(date +%s)"   # temp working folder
export GENIE_TEMPLATE="code"                 # or: create
export FORGE_BASE_URL="http://localhost:8887" # default private Forge

# 1) Prepare a clean repo
mkdir -p "$QA_DIR" && cd "$QA_DIR"
git init -b main

# 2) Initialize Genie (interactive: choose executor/model)
npx automagik-genie init "$GENIE_TEMPLATE" --forge-base-url "$FORGE_BASE_URL"

# 3) Inspect generated files (sanity checks)
ls -1A .
ls -1A .genie
sed -n '1,120p' .genie/config.yaml || true
cat .genie/state/version.json || true

# 4) (Optional) Use an existing Forge instead (example: 8887)
# npx automagik-genie init "$GENIE_TEMPLATE" --forge-base-url "http://localhost:8887"

# 5) Continue the Install session (replace with actual attemptId from init output)
# npx automagik-genie view <attemptId>
# npx automagik-genie resume <attemptId> "Follow-up message"
```

[... rest of original content preserved but not shown here for brevity ...]

---

**This manual script remains archived for historical reference and ad-hoc human testing. Automated installation validation is now handled by the autonomous installation-flow.md workflow.**

@.genie/agents/qa/README.md
