#!/usr/bin/env bash
# Smoke fixture for issue #1406 / wish fix-wish-parser-slug-prefix.
#
# Synthesizes a temporary two-group wish using canonical `<slug>#N` depends-on
# syntax. Pre-fix: `genie wish status` throws "non-existent group <slug>#1".
# Post-fix: `genie wish status` exits 0.
#
# Lives in a sidecar so the literal `**depends-on:**` strings inside the
# heredoc don't trip parseWishGroups when it scans the parent WISH.md.
set -euo pipefail

# Resolve genie binary: prefer locally-built dist (so we test this checkout),
# fall back to PATH for environments without a local build.
REPO_ROOT="$(git rev-parse --show-toplevel)"
if [[ -f "$REPO_ROOT/dist/genie.js" ]]; then
  GENIE=("bun" "run" "$REPO_ROOT/dist/genie.js")
else
  GENIE=("genie")
fi

SMOKE_SLUG="smoke-slug-prefix-test-$$"
"${GENIE[@]}" wish new "$SMOKE_SLUG"

python3 - <<EOF
from pathlib import Path
import re
path = Path(f".genie/wishes/$SMOKE_SLUG/WISH.md")
content = path.read_text()
two_groups = '''### Group 1: First group

**Goal:** First.

**Deliverables:**
1. Stub

**Acceptance Criteria:**
- [ ] Stub

**Validation:**
\`\`\`bash
echo ok
\`\`\`

**depends-on:** none

---

### Group 2: Second group

**Goal:** Second.

**Deliverables:**
1. Stub

**Acceptance Criteria:**
- [ ] Stub

**Validation:**
\`\`\`bash
echo ok
\`\`\`

**depends-on:** $SMOKE_SLUG#1
'''
content = re.sub(r"### Group 1:.*?(?=---\n\n## QA Criteria|\Z)", two_groups, content, flags=re.DOTALL)
path.write_text(content)
EOF

# Pre-fix this throws "Group 2 depends on non-existent group <slug>#1"
# Post-fix this exits 0
set +e
"${GENIE[@]}" wish status "$SMOKE_SLUG"
status=$?
set -e

# Cleanup
rm -rf ".genie/wishes/$SMOKE_SLUG"

exit $status
