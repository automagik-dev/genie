#!/bin/bash
# Genie Status Line — meta-programmable agent lifecycle daemon
#
# Runs on every assistant message (debounce 300ms).
# Reads agent-specific triggers from ~/.genie/statusline/<agent>.json
# Falls back to ~/.genie/statusline/_defaults.json
#
# SELF-MODIFIABLE: Agents can edit their own trigger config at runtime:
#   echo '{"triggers":[...]}' > ~/.genie/statusline/$GENIE_AGENT_NAME.json
#
# Trigger format:
#   {
#     "id": "unique-id",
#     "when": "context_pct >= 75",    # condition: context_pct, cost, duration_min
#     "action": "send",               # send = genie send to self
#     "message": "Context at {pct}%", # {pct}, {cost}, {model}, {agent}, {branch}
#     "cooldown_seconds": 300,        # min seconds between fires
#     "enabled": true
#   }

input=$(cat)

# === Parse session data ===
MODEL=$(echo "$input" | jq -r '.model.display_name // "?"')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
TOKENS_USED=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
TOKENS_MAX=$(echo "$input" | jq -r '.context_window.context_window_size // 200000')
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
DURATION_MS=$(echo "$input" | jq -r '.cost.total_duration_ms // 0')
AGENT_NAME="${GENIE_AGENT_NAME:-}"
WORKTREE=$(echo "$input" | jq -r '.worktree.name // empty')

DURATION_MIN=$((DURATION_MS / 60000))
COST_FMT=$(printf '$%.2f' "$COST")

# === Format token counts (e.g. 45k, 120k, 1.2M) ===
fmt_tokens() {
  local n=$1
  if [ "$n" -ge 1000000 ]; then
    local m=$((n / 1000))
    printf '%s.%sM' "$((m / 1000))" "$(( (m % 1000) / 100 ))"
  elif [ "$n" -ge 1000 ]; then
    printf '%sk' "$((n / 1000))"
  else
    printf '%s' "$n"
  fi
}

USED_FMT=$(fmt_tokens "$TOKENS_USED")
MAX_FMT=$(fmt_tokens "$TOKENS_MAX")

# === Colors ===
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
CYAN='\033[36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# === Context bar (token-based) ===
BAR_WIDTH=12
if [ "$TOKENS_MAX" -gt 0 ]; then
  FILLED=$((TOKENS_USED * BAR_WIDTH / TOKENS_MAX))
else
  FILLED=0
fi
[ "$FILLED" -gt "$BAR_WIDTH" ] && FILLED=$BAR_WIDTH
EMPTY=$((BAR_WIDTH - FILLED))
BAR=$(printf "%${FILLED}s" | tr ' ' '=')
[ "$EMPTY" -gt 0 ] && BAR="${BAR}$(printf "%${EMPTY}s" | tr ' ' '-')"

if [ "$TOKENS_USED" -ge $((TOKENS_MAX * 80 / 100)) ]; then BAR_COLOR="$RED"
elif [ "$TOKENS_USED" -ge $((TOKENS_MAX * 50 / 100)) ]; then BAR_COLOR="$YELLOW"
else BAR_COLOR="$GREEN"; fi

# === Git branch ===
BRANCH=""
if git rev-parse --git-dir > /dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null)
fi

# === Active agents ===
AGENTS_COUNT=0
REGISTRY="$HOME/.genie/workers.json"
if [ -f "$REGISTRY" ]; then
  AGENTS_COUNT=$(jq '[.[] | select(.state == "working" or .state == "idle" or .state == "spawning")] | length' "$REGISTRY" 2>/dev/null || echo 0)
fi

# === Build display line ===
LINE="${BOLD}${MODEL}${RESET}"
LINE="${LINE} ${DIM}|${RESET} ${BAR_COLOR}[${BAR}] ${USED_FMT}/${MAX_FMT}${RESET}"

[ "$AGENTS_COUNT" -gt 0 ] && LINE="${LINE} ${DIM}|${RESET} ${CYAN}${AGENTS_COUNT} agents${RESET}"
[ -n "$AGENT_NAME" ] && LINE="${LINE} ${DIM}|${RESET} ${CYAN}@${AGENT_NAME}${RESET}"

if [ -n "$WORKTREE" ]; then
  LINE="${LINE} ${DIM}|${RESET} ${YELLOW}${WORKTREE}${RESET}"
elif [ -n "$BRANCH" ]; then
  LINE="${LINE} ${DIM}|${RESET} ${GREEN}${BRANCH}${RESET}"
fi

echo -e "$LINE"

# === Trigger engine ===
# Skip if no agent name (can't send to self)
[ -z "$AGENT_NAME" ] && exit 0

# Load agent-specific config: team/agent.json → team/_defaults.json → _defaults.json
TEAM="${GENIE_TEAM:-default}"
CONFIG="$HOME/.genie/statusline/${TEAM}/${AGENT_NAME}.json"
[ ! -f "$CONFIG" ] && CONFIG="$HOME/.genie/statusline/${TEAM}/_defaults.json"
[ ! -f "$CONFIG" ] && CONFIG="$HOME/.genie/statusline/_defaults.json"
[ ! -f "$CONFIG" ] && exit 0

COOLDOWN_DIR="$HOME/.genie/statusline/.cooldowns"
mkdir -p "$COOLDOWN_DIR"
NOW=$(date +%s)

# Process each trigger
echo "$input" | jq -c '.triggers = []' > /dev/null 2>&1  # validate jq works
TRIGGERS=$(jq -c '.triggers[]? | select(.enabled == true)' "$CONFIG" 2>/dev/null)

while IFS= read -r trigger; do
  [ -z "$trigger" ] && continue

  ID=$(echo "$trigger" | jq -r '.id')
  WHEN=$(echo "$trigger" | jq -r '.when')
  ACTION=$(echo "$trigger" | jq -r '.action')
  MSG=$(echo "$trigger" | jq -r '.message')
  COOLDOWN=$(echo "$trigger" | jq -r '.cooldown_seconds // 300')

  # Check cooldown
  COOLDOWN_FILE="$COOLDOWN_DIR/${AGENT_NAME}_${ID}"
  if [ -f "$COOLDOWN_FILE" ]; then
    LAST_FIRE=$(cat "$COOLDOWN_FILE")
    ELAPSED=$((NOW - LAST_FIRE))
    [ "$ELAPSED" -lt "$COOLDOWN" ] && continue
  fi

  # Evaluate condition
  FIRED=false
  case "$WHEN" in
    *context_pct*)
      THRESHOLD=$(echo "$WHEN" | grep -oE '[0-9]+')
      OP=$(echo "$WHEN" | grep -oE '>=|<=|>|<|==')
      case "$OP" in
        ">=") [ "$PCT" -ge "$THRESHOLD" ] && FIRED=true ;;
        ">")  [ "$PCT" -gt "$THRESHOLD" ] && FIRED=true ;;
        "<=") [ "$PCT" -le "$THRESHOLD" ] && FIRED=true ;;
        "<")  [ "$PCT" -lt "$THRESHOLD" ] && FIRED=true ;;
        "==") [ "$PCT" -eq "$THRESHOLD" ] && FIRED=true ;;
      esac
      ;;
    *cost*)
      THRESHOLD=$(echo "$WHEN" | grep -oE '[0-9.]+')
      # Compare as integers (cents)
      COST_CENTS=$(printf '%.0f' "$(echo "$COST * 100" | bc 2>/dev/null || echo 0)")
      THRESH_CENTS=$(printf '%.0f' "$(echo "$THRESHOLD * 100" | bc 2>/dev/null || echo 0)")
      [ "$COST_CENTS" -ge "$THRESH_CENTS" ] 2>/dev/null && FIRED=true
      ;;
    *duration_min*)
      THRESHOLD=$(echo "$WHEN" | grep -oE '[0-9]+')
      [ "$DURATION_MIN" -ge "$THRESHOLD" ] && FIRED=true
      ;;
  esac

  if [ "$FIRED" = true ]; then
    # Interpolate message using awk to avoid sed injection from untrusted variables
    MSG=$(printf '%s' "$MSG" | awk \
      -v pct="$PCT" \
      -v cost="$COST_FMT" \
      -v model="$MODEL" \
      -v agent="$AGENT_NAME" \
      -v team="$TEAM" \
      -v branch="$BRANCH" \
      -v duration="${DURATION_MIN}m" \
      '{
        gsub(/{pct}/, pct)
        gsub(/{cost}/, cost)
        gsub(/{model}/, model)
        gsub(/{agent}/, agent)
        gsub(/{team}/, team)
        gsub(/{branch}/, branch)
        gsub(/{duration}/, duration)
        print
      }')

    # Execute action
    case "$ACTION" in
      send)
        genie send --to "$AGENT_NAME" "$MSG" > /dev/null 2>&1 &
        ;;
    esac

    # Record cooldown
    echo "$NOW" > "$COOLDOWN_FILE"
  fi
done <<< "$TRIGGERS"

exit 0
