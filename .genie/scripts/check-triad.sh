#!/bin/bash
# Self-validating triad checker
# Validates STATE.md (required) + TODO.md/USERCONTEXT.md (optional per-user files)
#
# Natural Context Acquisition:
# - STATE.md = Shared repository state (ALWAYS validated, committed)
# - TODO.md = Your work queue (validated if exists, gitignored)
# - USERCONTEXT.md = Your preferences (validated if exists, gitignored)
#
# First time setup:
#   cp .genie/TODO.template.md .genie/TODO.md
#   cp .genie/USERCONTEXT.template.md .genie/USERCONTEXT.md
#
# These files load automatically via @ in CLAUDE.md for natural context

set -e

NEEDS_UPDATE=0

echo "🔍 Validating triad files..."

# Helper: Extract metadata value
extract_metadata() {
  local file=$1
  local key=$2
  grep "^${key}:" "$file" | head -1 | cut -d: -f2- | xargs
}

# Helper: Extract and run validation commands from metadata
check_file() {
  local file=$1
  local name=$(basename "$file")

  if [[ ! -f "$file" ]]; then
    echo "⚠️  $name not found"
    return 1
  fi

  echo "Checking $name..."

  # Special check for STATE.md: version consistency
  if [[ "$name" == "STATE.md" ]]; then
    local meta_version=$(extract_metadata "$file" "last_version")
    local pkg_version=$(jq -r .version package.json 2>/dev/null || echo "")

    if [[ -n "$pkg_version" && "$meta_version" != "$pkg_version" ]]; then
      echo "  ❌ version_match failed (metadata: $meta_version, package.json: $pkg_version)"
      NEEDS_UPDATE=1
    else
      echo "  ✅ version_match passed"
    fi
  fi

  # Extract validation commands from HTML comment block
  local in_validation=0
  while IFS= read -r line; do
    # Start of validation block
    if [[ "$line" =~ validation_commands: ]]; then
      in_validation=1
      continue
    fi

    # End of comment block
    if [[ "$line" =~ ^[[:space:]]*--\> ]]; then
      break
    fi

    # Process validation command
    if [[ $in_validation -eq 1 && "$line" =~ ^[[:space:]]*([a-z_]+):[[:space:]]*(.+)$ ]]; then
      local check_name="${BASH_REMATCH[1]}"
      local command="${BASH_REMATCH[2]}"

      # Evaluate command
      if ! eval "$command" 2>/dev/null; then
        echo "  ❌ $check_name failed"
        NEEDS_UPDATE=1
      else
        echo "  ✅ $check_name passed"
      fi
    fi
  done < "$file"

  return 0
}

# Check STATE.md (REQUIRED - shared repository state)
if ! check_file ".genie/STATE.md"; then
  NEEDS_UPDATE=1
fi

echo ""

# Check TODO.md (OPTIONAL - per-user work queue)
if [[ -f ".genie/TODO.md" ]]; then
  if ! check_file ".genie/TODO.md"; then
    NEEDS_UPDATE=1
  fi
  echo ""
else
  echo "ℹ️  TODO.md not found (optional per-user file)"
  echo "   Initialize: cp .genie/TODO.template.md .genie/TODO.md"
  echo ""
fi

# Check USERCONTEXT.md (OPTIONAL - per-user preferences)
if [[ -f ".genie/USERCONTEXT.md" ]]; then
  echo "ℹ️  USERCONTEXT.md found (optional, not validated by default)"
  echo ""
fi

if [[ $NEEDS_UPDATE -eq 1 ]]; then
  echo "❌ Triad validation failed"
  echo ""
  echo "Fix with:"
  echo "  1. Update .genie/STATE.md (version, commits)"
  echo "  2. Update .genie/TODO.md (mark tasks COMPLETE) [if you have one]"
  echo "  3. Run: git add .genie/STATE.md"
  echo "  4. Retry commit"
  echo ""
  echo "First time setup:"
  echo "  cp .genie/TODO.template.md .genie/TODO.md"
  echo "  cp .genie/USERCONTEXT.template.md .genie/USERCONTEXT.md"
  exit 1
else
  echo "✅ Triad validation passed"
  exit 0
fi
